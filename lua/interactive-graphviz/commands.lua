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

  -- Idempotency guard: if a session is already active for this buffer, just
  -- re-send the current render — never re-open the browser or re-register the
  -- live-reload watch. This fires whether the server is already `running` OR
  -- still starting (pre-`ready`): a registered session means a browser-open is
  -- already pending/done, so a rapid second `:GraphvizPreview` during startup
  -- must NOT stack a second `server.on_ready(...)` callback (which would open a
  -- second tab when `ready` arrives). server.send queues the render until ready.
  if session.has(bufnr) then
    local dot = table.concat(vim.api.nvim_buf_get_lines(bufnr, 0, -1, false), "\n")
    server.send({
      type = "render",
      sessionId = bufnr,
      v = session.next_version(bufnr),
      engine = config.get().engine,
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
    engine = config.get().engine,
    dot = dot,
  })

  -- Open the browser only once port/token are known (async ready ordering).
  -- server.on_ready fires immediately if the server is already running, or
  -- defers until `ready` arrives — keeping the callback self-contained here.
  server.on_ready(function()
    if not vim.api.nvim_buf_is_valid(bufnr) then
      return
    end
    local port = server.state.port
    local token = server.state.token
    if not port or not token then
      log.notify("GraphvizPreview: server ready but port/token missing", vim.log.levels.ERROR)
      return
    end
    local url = string.format("http://127.0.0.1:%d/?sessionId=%d&token=%s", port, bufnr, token)
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
