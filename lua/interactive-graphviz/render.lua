local M = {}

-- Per-buffer debounce timers. A buffer may have at most one live timer at a time.
-- Latest-wins: creating a new timer cancels the previous one for the same buffer.
local timers = {}

-- Buffers with a live watch (augroup registered). Set in start_watch, cleared
-- in stop_watch; stop_all iterates this registry because a timers entry is
-- transient (nil'd whenever the debounce fires) while the watch is not.
local watched = {}

local function send_render(bufnr)
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  local session = require("interactive-graphviz.session")
  if not session.has(bufnr) then
    return
  end
  local config = require("interactive-graphviz.config")
  local server = require("interactive-graphviz.server")
  local dot = table.concat(vim.api.nvim_buf_get_lines(bufnr, 0, -1, false), "\n")
  server.send({
    type = "render",
    sessionId = bufnr,
    v = session.next_version(bufnr),
    engine = config.get().engine,
    dot = dot,
  })
end

local function debounce(bufnr)
  -- Cancel any existing timer for this buffer (latest-wins coalescing).
  if timers[bufnr] then
    timers[bufnr]:stop()
    timers[bufnr]:close()
    timers[bufnr] = nil
  end

  local config = require("interactive-graphviz.config")
  local delay_ms = config.get().debounce_ms or 200

  local timer = vim.uv.new_timer()
  timers[bufnr] = timer

  -- Non-repeating one-shot timeout (second arg 0 = no repeat).
  -- The callback runs on the libuv thread; vim.schedule re-enters the main loop
  -- so vim.api.* calls are safe.
  timer:start(delay_ms, 0, function()
    timer:stop()
    timer:close()
    -- Only clear the map entry if it still points to our timer (not a newer one).
    if timers[bufnr] == timer then
      timers[bufnr] = nil
    end
    vim.schedule(function()
      send_render(bufnr)
    end)
  end)
end

-- Register TextChanged/TextChangedI autocmds for a buffer to trigger live reload.
-- Idempotent: calling twice on the same buffer safely recreates the augroup.
function M.start_watch(bufnr)
  local group = vim.api.nvim_create_augroup("InteractiveGraphvizRender" .. bufnr, { clear = true })
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    buffer = bufnr,
    group = group,
    callback = function()
      local ok, err = pcall(debounce, bufnr)
      if not ok then
        require("interactive-graphviz.log").warn(
          "InteractiveGraphviz: debounce error for buffer " .. bufnr .. ": " .. tostring(err)
        )
      end
    end,
  })
  -- Register only after autocmd creation succeeds (a throw above must not
  -- leave a phantom entry) — same order as sync.start_cursor_watch.
  watched[bufnr] = true
end

-- Cancel the debounce timer and remove the autocmd group for a buffer.
-- Seam for Story 1.7's :GraphvizPreviewStop — not wired to a command yet.
function M.stop_watch(bufnr)
  if timers[bufnr] then
    timers[bufnr]:stop()
    timers[bufnr]:close()
    timers[bufnr] = nil
  end
  watched[bufnr] = nil
  pcall(vim.api.nvim_del_augroup_by_name, "InteractiveGraphvizRender" .. bufnr)
end

-- Stop all active watches. Called during VimLeavePre teardown (lifecycle.lua).
-- Iterate `watched`, not `timers`: every watched buffer has a `watched` entry
-- from start_watch, while its timers entry is nil'd whenever the debounce has
-- already fired — walking timers alone would leave the augroup (and its
-- TextChanged autocmds) alive past teardown. timers is unioned in defensively
-- for any handle not paired with a watch. Collect keys first to avoid mutating
-- tables during pairs() iteration. Mirrors sync.stop_all — keep in sync.
function M.stop_all()
  local seen = {}
  local bufs = {}
  for bufnr in pairs(watched) do
    seen[bufnr] = true
    table.insert(bufs, bufnr)
  end
  for bufnr in pairs(timers) do
    if not seen[bufnr] then
      table.insert(bufs, bufnr)
    end
  end
  for _, bufnr in ipairs(bufs) do
    M.stop_watch(bufnr)
  end
  watched = {}
end

return M
