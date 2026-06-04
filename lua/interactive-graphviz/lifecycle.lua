local M = {}

local augroup = nil

-- Register the graceful-exit hook. Idempotent; called once a server exists.
function M.setup()
  if augroup then
    return
  end
  augroup = vim.api.nvim_create_augroup("InteractiveGraphvizLifecycle", { clear = true })
  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = augroup,
    callback = function()
      M.teardown()
    end,
  })
  vim.api.nvim_create_autocmd({ "BufDelete", "BufWipeout" }, {
    group = augroup,
    nested = true,
    callback = function(ev)
      local bufnr = ev.buf
      local session = require("interactive-graphviz.session")
      local render = require("interactive-graphviz.render")
      local server = require("interactive-graphviz.server")
      local log = require("interactive-graphviz.log")
      if not session.has(bufnr) then
        return
      end
      local ok1, err1 = pcall(render.stop_watch, bufnr)
      if not ok1 then
        log.warn("BufDelete: stop_watch: " .. tostring(err1))
      end
      local ok2, err2 = pcall(server.close_session, bufnr)
      if not ok2 then
        log.warn("BufDelete: close_session: " .. tostring(err2))
      end
      if session.count() == 0 then
        local ok3, err3 = pcall(server.shutdown)
        if not ok3 then
          log.warn("BufDelete: shutdown: " .. tostring(err3))
        end
      end
    end,
  })
end

-- Graceful teardown ONLY. The no-orphan guarantee must not depend on this running:
-- on abnormal exit (`kill -9`) VimLeavePre does not fire, and the server still
-- self-terminates via stdin EOF / heartbeat. This is the convenience path.
function M.teardown()
  -- stop_all() must run BEFORE shutdown() and session.reset():
  -- timers table may still hold live uv.timer handles after session.reset() clears
  -- the active map, so close all debounce timers first to prevent libuv complaints.
  -- Capture the module reference first so that require() errors are also caught.
  local render_ok, render_mod = pcall(require, "interactive-graphviz.render")
  if render_ok then
    local ok, err = pcall(render_mod.stop_all)
    if not ok then
      pcall(function()
        require("interactive-graphviz.log").warn("teardown: stop_all error: " .. tostring(err))
      end)
    end
  end
  require("interactive-graphviz.server").shutdown()
  require("interactive-graphviz.session").reset()
end

return M
