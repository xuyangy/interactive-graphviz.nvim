local M = {}

local function trim(s)
  return tostring(s or ""):match("^%s*(.-)%s*$")
end

-- Split an `open_cmd` string into an argv list, honoring single/double quoted
-- groups so multi-word arguments survive intact. A naive whitespace split breaks
-- commands like `open -a "Google Chrome"`; this keeps the quoted token whole:
--   open -a "Google Chrome"  ->  { "open", "-a", "Google Chrome" }
-- Quotes are removed; adjacent quoted/unquoted runs concatenate shell-style
-- (`--flag="a b"` -> `--flag=a b`). Returns {} for an empty/whitespace string.
local function tokenize_cmd(s)
  local args = {}
  local i, n = 1, #s
  while i <= n do
    if s:sub(i, i):match("%s") then
      i = i + 1
    else
      local buf = {}
      while i <= n do
        local c = s:sub(i, i)
        if c:match("%s") then
          break
        elseif c == '"' or c == "'" then
          i = i + 1
          while i <= n and s:sub(i, i) ~= c do
            table.insert(buf, s:sub(i, i))
            i = i + 1
          end
          i = i + 1 -- skip the closing quote (no-op if unterminated at EOS)
        else
          table.insert(buf, c)
          i = i + 1
        end
      end
      table.insert(args, table.concat(buf))
    end
  end
  return args
end

-- Test seam: exercised directly by commands_spec without a real vim.
M._tokenize_cmd = tokenize_cmd

-- Build the full preview URL for a buffer from the live server state and the
-- current config. Returns nil when the server has not announced port/token yet.
-- The interactivity config rides along as query params (always all of them,
-- even at defaults — deterministic URLs, no absent-vs-default ambiguity).
-- config validation guarantees every key exists with an enum/boolean value, so
-- the values are URL-safe as-is; booleans travel as 1/0. The frontend parses
-- these at startup and feeds its clamping setters — config applies when a
-- preview opens (re-open to change).
local function preview_url(bufnr)
  local server = require("interactive-graphviz.server")
  local config = require("interactive-graphviz.config")

  local port = server.state.port
  local token = server.state.token
  if not port or not token then
    return nil
  end

  local cfg = config.get()
  local function b01(v)
    return v and "1" or "0"
  end
  return string.format(
    "http://127.0.0.1:%d/?sessionId=%d&token=%s"
      .. "&preserve_view=%s&highlight_mode=%s&animate=%s"
      .. "&search_scope=%s&search_case=%s&search_regex=%s"
      .. "&sync_jump_on_click=%s",
    port,
    bufnr,
    token,
    b01(cfg.preserve_view),
    cfg.highlight_mode,
    b01(cfg.animate),
    cfg.search.scope,
    b01(cfg.search.case_sensitive),
    b01(cfg.search.regex),
    b01(cfg.sync.jump_on_click)
  )
end

-- Returns true if the given buffer contains DOT/Graphviz content.
local function is_dot_buffer(bufnr)
  -- Guard against invalid buffers (e.g. after BufDelete, re-open scenarios).
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return false
  end
  if vim.bo[bufnr].filetype == "dot" then
    return true
  end
  -- Defensive fallback: filetype may be empty for a new unsaved buffer.
  local name = vim.api.nvim_buf_get_name(bufnr)
  return name:match("%.dot$") ~= nil or name:match("%.gv$") ~= nil
end

local function reconcile_cursor_watch(bufnr, sync_cfg, log)
  local ok_mod, sync = pcall(require, "interactive-graphviz.sync")
  if not ok_mod then
    log.warn("GraphvizPreview: failed to load cursor-sync module: " .. tostring(sync))
    return
  end
  local enabled = sync_cfg and sync_cfg.highlight_on_cursor == true

  -- Always clear a stale watcher first. This keeps repeated :GraphvizPreview
  -- calls aligned with the current config, including true->false toggles.
  local ok_stop, stop_err = pcall(sync.stop_cursor_watch, bufnr)
  if not ok_stop then
    log.warn("GraphvizPreview: failed to stop cursor-sync autocmd: " .. tostring(stop_err))
  end
  if not enabled then
    return
  end

  local ok_sync, sync_err = pcall(sync.start_cursor_watch, bufnr)
  if not ok_sync then
    log.warn("GraphvizPreview: failed to register cursor-sync autocmd: " .. tostring(sync_err))
  end
end

function M.preview()
  local server = require("interactive-graphviz.server")
  local session = require("interactive-graphviz.session")
  local config = require("interactive-graphviz.config")
  local log = require("interactive-graphviz.log")

  local bufnr = vim.api.nvim_get_current_buf()

  if not is_dot_buffer(bufnr) then
    log.notify("GraphvizPreview: current buffer is not a DOT/GV file", vim.log.levels.INFO)
    return
  end

  -- Idempotency guard: if a session is already active for this buffer AND the
  -- server is live, just re-send the current render — never re-open the browser
  -- or re-register the live-reload watch. `server.is_running()` (handle present +
  -- alive) is true both once `ready` has arrived AND while the server is still
  -- starting (pre-`ready`), so a rapid second `:GraphvizPreview` during startup
  -- does NOT stack a second `server.on_ready(...)` callback (which would open a
  -- second tab when `ready` arrives); server.send queues the render until ready.
  -- It is false once the server has exited, so a lingering session record after a
  -- crash falls through to the re-spawn path below rather than silently no-op'ing.
  if session.has(bufnr) and server.is_running() then
    local dot = table.concat(vim.api.nvim_buf_get_lines(bufnr, 0, -1, false), "\n")
    local cfg = config.get()
    reconcile_cursor_watch(bufnr, cfg.sync, log)
    server.send({
      type = "render",
      sessionId = bufnr,
      v = session.next_version(bufnr),
      engine = cfg.engine,
      dot = dot,
    })
    return
  end

  if not server.open_session(bufnr) then
    log.notify("GraphvizPreview: failed to start server", vim.log.levels.ERROR)
    return
  end

  -- Reset the watch before starting it, in case the buffer was previously
  -- watched (e.g. stop then re-open). Prevents stale debounce timer handles.
  local render = require("interactive-graphviz.render")
  pcall(render.stop_watch, bufnr)

  -- Register live-reload autocmd for this buffer (Story 1.5).
  -- pcall guard: a failure here should not block the initial render or browser open.
  local ok_watch, watch_err = pcall(render.start_watch, bufnr)
  if not ok_watch then
    log.warn("GraphvizPreview: failed to register live-reload autocmd: " .. tostring(watch_err))
  end

  -- Story 6.3: buffer→graph cursor emphasis, gated Lua-side at emission — the
  -- browser is a passive receiver, so no URL param rides along. Reconcile every
  -- preview call so config toggles and stale watchers cannot drift.
  local cfg = config.get()
  reconcile_cursor_watch(bufnr, cfg.sync, log)

  -- Send the initial render — server.send queues until `ready`, so this is safe
  -- to call before the server has announced its port/token.
  local dot = table.concat(vim.api.nvim_buf_get_lines(bufnr, 0, -1, false), "\n")
  -- Immediate editor-side feedback for an empty/whitespace buffer; the frontend
  -- also shows an in-preview notice (the canonical, all-render-paths surface).
  -- The preview still opens and live-reloads, so typing content renders normally.
  if trim(dot) == "" then
    log.notify("GraphvizPreview: buffer is empty — nothing to render yet", vim.log.levels.INFO)
  end
  server.send({
    type = "render",
    sessionId = bufnr,
    v = session.next_version(bufnr),
    engine = cfg.engine,
    dot = dot,
  })

  -- Open the browser only once port/token are known (async ready ordering).
  -- server.on_ready fires immediately if the server is already running, or
  -- defers until `ready` arrives — keeping the callback self-contained here.
  server.on_ready(function()
    if not vim.api.nvim_buf_is_valid(bufnr) then
      return
    end
    local url = preview_url(bufnr)
    if not url then
      log.notify("GraphvizPreview: server ready but port/token missing", vim.log.levels.ERROR)
      return
    end
    log.notify("GraphvizPreview: serving at " .. url, vim.log.levels.INFO)
    local open_cmd = config.get().open_cmd
    if open_cmd then
      local parts = tokenize_cmd(open_cmd)
      table.insert(parts, url)
      vim.system(parts)
    else
      vim.ui.open(url)
    end
  end)
end

function M.stop()
  local bufnr = vim.api.nvim_get_current_buf()
  local session = require("interactive-graphviz.session")
  local render = require("interactive-graphviz.render")
  local server = require("interactive-graphviz.server")
  local log = require("interactive-graphviz.log")

  -- Idempotent: if no session, stop is a no-op (no error).
  if not session.has(bufnr) then
    return
  end

  local ok1, err1 = pcall(render.stop_watch, bufnr)
  if not ok1 then
    log.warn("GraphvizPreviewStop: stop_watch error: " .. tostring(err1))
  end

  -- Story 6.3: tear down the cursor watcher unconditionally — cheap no-op when
  -- the gate was off, correct when config changed between preview and stop.
  local ok_sync, err_sync = pcall(function()
    require("interactive-graphviz.sync").stop_cursor_watch(bufnr)
  end)
  if not ok_sync then
    log.warn("GraphvizPreviewStop: stop_cursor_watch error: " .. tostring(err_sync))
  end

  -- close_session internally calls session.unregister(bufnr) AND sends session_close.
  -- Do NOT call session.unregister() directly — that would violate the single-owner invariant.
  local ok2, err2 = pcall(server.close_session, bufnr)
  if not ok2 then
    log.warn("GraphvizPreviewStop: close_session error: " .. tostring(err2))
  end

  -- Shut down the server only when this was the last session.
  if session.count() == 0 then
    local ok3, err3 = pcall(server.shutdown)
    if not ok3 then
      log.warn("GraphvizPreviewStop: shutdown error: " .. tostring(err3))
    end
  end
end

function M.toggle()
  local bufnr = vim.api.nvim_get_current_buf()
  local session = require("interactive-graphviz.session")
  if session.has(bufnr) then
    M.stop()
  else
    M.preview()
  end
end

-- :GraphvizUrl — print the current buffer's full preview URL.
--
-- Deliberately NOT log.notify: vim.notify is user-replaceable (noice.nvim,
-- nvim-notify, …) and those UIs truncate long lines and expire — once the
-- startup "serving at …" toast is gone, there is no way to get the URL back.
-- nvim_echo with history=true puts the COMPLETE untruncated URL into
-- `:messages`, retrievable and copyable at any time, regardless of which
-- notification UI is installed. Port/token are stable for the server's
-- lifetime, and the config params reflect the current setup() — i.e. exactly
-- the URL a fresh `:GraphvizPreview` tab would open.
--
-- Note the URL embeds the session auth token, so echoing it into `:messages`
-- widens its exposure from an ephemeral toast to durable message history.
-- Acceptable: the token is loopback-scoped, dies with the server, and the user
-- is explicitly asking for the URL — but keep this in mind if message history
-- is ever logged/shipped anywhere.
function M.url()
  local server = require("interactive-graphviz.server")
  local session = require("interactive-graphviz.session")
  local log = require("interactive-graphviz.log")

  local bufnr = vim.api.nvim_get_current_buf()
  if not session.has(bufnr) then
    log.notify(
      "GraphvizUrl: no active preview for this buffer — run :GraphvizPreview first",
      vim.log.levels.INFO
    )
    return nil
  end
  -- A session can outlive a crashed server (see the preview() idempotency
  -- note); tell that user the truth instead of "no active preview".
  if not server.is_running() then
    log.notify(
      "GraphvizUrl: the preview server is not running (it may have exited)"
        .. " — run :GraphvizPreview to restart",
      vim.log.levels.INFO
    )
    return nil
  end

  local url = preview_url(bufnr)
  if not url then
    log.notify(
      "GraphvizUrl: the server is still starting — try again in a moment",
      vim.log.levels.INFO
    )
    return nil
  end

  vim.api.nvim_echo({ { url } }, true, {})
  return url
end

function M.engine(opts)
  local config = require("interactive-graphviz.config")
  local log = require("interactive-graphviz.log")

  local engine = trim(opts and opts.args)
  local current = config.get()
  if engine == "" then
    log.notify(
      "GraphvizEngine: current engine: "
        .. tostring(current.engine)
        .. "; available: "
        .. table.concat(current.engines or {}, ", "),
      vim.log.levels.INFO
    )
    return
  end

  local ok, msg = config.set_engine(engine)
  if not ok then
    log.warn(msg)
    return
  end

  local bufnr = vim.api.nvim_get_current_buf()
  local session = require("interactive-graphviz.session")
  local server = require("interactive-graphviz.server")
  if not (session.has(bufnr) and server.is_running()) then
    return
  end

  local dot = table.concat(vim.api.nvim_buf_get_lines(bufnr, 0, -1, false), "\n")
  server.send({
    type = "render",
    sessionId = bufnr,
    v = session.next_version(bufnr),
    engine = config.get().engine,
    dot = dot,
  })
end

return M
