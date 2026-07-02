-- Tests for lifecycle.lua: teardown ordering, setup idempotency, BufDelete autocmd.
-- Designed to run under plain busted (no Neovim).
-- vim API is fully stubbed via _G.vim.
package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path

-- ── helpers ───────────────────────────────────────────────────────────────────

-- Builds a vim stub that captures autocmd registrations keyed by the first event name.
local function make_vim_stub()
  local captured = {}
  local created_augroups = {}
  return {
    log = { levels = { INFO = 2, WARN = 3, ERROR = 4 } },
    api = {
      nvim_create_augroup = function(name, _)
        table.insert(created_augroups, name)
        return name
      end,
      nvim_create_autocmd = function(events, opts)
        local key = type(events) == "table" and events[1] or events
        -- Store all callbacks keyed by first event (later registrations overwrite earlier).
        captured[key] = opts.callback
        -- Also track by table for multi-event registration (e.g. BufDelete + BufWipeout).
        if type(events) == "table" then
          for _, ev in ipairs(events) do
            captured[ev] = opts.callback
          end
        end
      end,
      nvim_del_augroup_by_name = function(_) end,
      nvim_buf_is_valid = function(_)
        return true
      end,
    },
    bo = setmetatable({}, {
      __index = function(_, _)
        return { filetype = "dot" }
      end,
    }),
    schedule = function(fn)
      fn()
    end,
    _captured = captured,
    _created_augroups = created_augroups,
  }
end

local function make_render_stub()
  local calls = {}
  return {
    stop_all = function()
      table.insert(calls, "stop_all")
    end,
    stop_watch = function(bufnr)
      table.insert(calls, { fn = "stop_watch", bufnr = bufnr })
    end,
    start_watch = function(_) end,
    _calls = calls,
  }
end

local function make_server_stub()
  local calls = {}
  return {
    shutdown = function()
      table.insert(calls, "shutdown")
    end,
    close_session = function(bufnr)
      table.insert(calls, { fn = "close_session", bufnr = bufnr })
    end,
    state = { running = false },
    _calls = calls,
  }
end

local function make_session_stub(active_map)
  active_map = active_map or {}
  return {
    has = function(bufnr)
      return active_map[bufnr] == true
    end,
    count = function()
      local n = 0
      for _ in pairs(active_map) do
        n = n + 1
      end
      return n
    end,
    reset = function()
      for k in pairs(active_map) do
        active_map[k] = nil
      end
    end,
    _active = active_map,
  }
end

local function make_log_stub()
  local warned = {}
  return {
    warn = function(msg)
      table.insert(warned, msg)
    end,
    notify = function(_, _) end,
    _warned = warned,
  }
end

-- Story 6.3: the cursor-sync watcher mirrors the render watch lifecycle.
local function make_sync_stub()
  local calls = {}
  return {
    stop_cursor_watch = function(bufnr)
      table.insert(calls, { fn = "stop_cursor_watch", bufnr = bufnr })
    end,
    stop_all = function()
      table.insert(calls, "stop_all")
    end,
    _calls = calls,
  }
end

-- Load lifecycle module fresh with injected stubs.
local function load_lifecycle(vim_stub, render_stub, server_stub, session_stub, log_stub, sync_stub)
  _G.vim = vim_stub

  package.loaded["interactive-graphviz.render"] = render_stub
  package.loaded["interactive-graphviz.server"] = server_stub
  package.loaded["interactive-graphviz.session"] = session_stub
  package.loaded["interactive-graphviz.log"] = log_stub
  package.loaded["interactive-graphviz.sync"] = sync_stub or make_sync_stub()
  package.loaded["interactive-graphviz.lifecycle"] = nil -- force reload

  return require("interactive-graphviz.lifecycle")
end

-- ── test suite ────────────────────────────────────────────────────────────────

describe("lifecycle.teardown", function()
  after_each(function()
    package.loaded["interactive-graphviz.lifecycle"] = nil
    package.loaded["interactive-graphviz.render"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.log"] = nil
    package.loaded["interactive-graphviz.sync"] = nil
    _G.vim = nil
  end)

  it(
    "teardown() stops render + sync watches before server.shutdown() and session.reset()",
    function()
      local call_order = {}
      local vim_stub = make_vim_stub()
      local render_stub = {
        stop_all = function()
          table.insert(call_order, "stop_all")
        end,
        stop_watch = function(_) end,
        start_watch = function(_) end,
      }
      local sync_stub = {
        stop_all = function()
          table.insert(call_order, "sync_stop_all")
        end,
        stop_cursor_watch = function(_) end,
      }
      local server_stub = {
        shutdown = function()
          table.insert(call_order, "shutdown")
        end,
        close_session = function(_) end,
        state = { running = false },
      }
      local session_stub = {
        has = function(_)
          return false
        end,
        count = function()
          return 0
        end,
        reset = function()
          table.insert(call_order, "reset")
        end,
      }

      local lifecycle =
        load_lifecycle(vim_stub, render_stub, server_stub, session_stub, make_log_stub(), sync_stub)
      lifecycle.setup() -- must be set up first (registers augroup)

      -- Reset augroup side-effect so teardown is fresh
      lifecycle.teardown()

      assert.are.equal(4, #call_order, "exactly 4 calls must be recorded")
      assert.are.equal("stop_all", call_order[1], "render stop_all must be first")
      assert.are.equal(
        "sync_stop_all",
        call_order[2],
        "sync stop_all before shutdown (live timers)"
      )
      assert.are.equal("shutdown", call_order[3], "shutdown must follow the watch teardown")
      assert.are.equal("reset", call_order[4], "reset must be last")
    end
  )
end)

describe("lifecycle.setup", function()
  after_each(function()
    package.loaded["interactive-graphviz.lifecycle"] = nil
    package.loaded["interactive-graphviz.render"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.log"] = nil
    package.loaded["interactive-graphviz.sync"] = nil
    _G.vim = nil
  end)

  it("setup() registers VimLeavePre and BufDelete autocmds", function()
    local vim_stub = make_vim_stub()
    local lifecycle = load_lifecycle(
      vim_stub,
      make_render_stub(),
      make_server_stub(),
      make_session_stub(),
      make_log_stub()
    )

    lifecycle.setup()

    assert.is_not_nil(vim_stub._captured["VimLeavePre"], "VimLeavePre must be registered")
    assert.is_not_nil(vim_stub._captured["BufDelete"], "BufDelete must be registered")
  end)

  it("setup() is idempotent — calling twice does not register duplicate augroups", function()
    local vim_stub = make_vim_stub()
    local lifecycle = load_lifecycle(
      vim_stub,
      make_render_stub(),
      make_server_stub(),
      make_session_stub(),
      make_log_stub()
    )

    lifecycle.setup()
    lifecycle.setup() -- second call should early-return

    -- nvim_create_augroup should only have been called once (idempotency guard)
    assert.are.equal(1, #vim_stub._created_augroups, "augroup must be created exactly once")
  end)
end)

describe("lifecycle BufDelete autocmd callback", function()
  after_each(function()
    package.loaded["interactive-graphviz.lifecycle"] = nil
    package.loaded["interactive-graphviz.render"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.log"] = nil
    package.loaded["interactive-graphviz.sync"] = nil
    _G.vim = nil
  end)

  it(
    "BufDelete callback with active session: calls stop_watch, close_session, shutdown (last session)",
    function()
      local bufnr = 3
      local active = { [bufnr] = true }
      local vim_stub = make_vim_stub()
      local render_stub = make_render_stub()
      local server_stub = make_server_stub()
      local session_stub = make_session_stub(active)
      local sync_stub = make_sync_stub()

      -- Wire close_session to unregister so count() drops to 0
      server_stub.close_session = function(b)
        table.insert(server_stub._calls, { fn = "close_session", bufnr = b })
        active[b] = nil
      end

      local lifecycle =
        load_lifecycle(vim_stub, render_stub, server_stub, session_stub, make_log_stub(), sync_stub)
      lifecycle.setup()

      -- Retrieve and invoke the BufDelete callback directly
      local cb = vim_stub._captured["BufDelete"]
      assert.is_not_nil(cb, "BufDelete callback must have been registered")
      cb({ buf = bufnr })

      -- stop_watch must have been called
      local stop_watch_called = false
      for _, c in ipairs(render_stub._calls) do
        if type(c) == "table" and c.fn == "stop_watch" and c.bufnr == bufnr then
          stop_watch_called = true
        end
      end
      assert.is_true(stop_watch_called, "render.stop_watch must be called for the deleted buffer")

      -- Story 6.3: the cursor watch must be torn down alongside the render watch
      local cursor_stop_called = false
      for _, c in ipairs(sync_stub._calls) do
        if type(c) == "table" and c.fn == "stop_cursor_watch" and c.bufnr == bufnr then
          cursor_stop_called = true
        end
      end
      assert.is_true(
        cursor_stop_called,
        "sync.stop_cursor_watch must be called for the deleted buffer"
      )

      -- close_session must have been called
      local close_called = false
      for _, c in ipairs(server_stub._calls) do
        if type(c) == "table" and c.fn == "close_session" and c.bufnr == bufnr then
          close_called = true
        end
      end
      assert.is_true(close_called, "server.close_session must be called for the deleted buffer")

      -- shutdown must have been called (last session)
      local shutdown_called = false
      for _, c in ipairs(server_stub._calls) do
        if c == "shutdown" then
          shutdown_called = true
        end
      end
      assert.is_true(shutdown_called, "server.shutdown must be called when last session is removed")
    end
  )

  it("BufDelete callback with no active session: no-op", function()
    local bufnr = 4
    local vim_stub = make_vim_stub()
    local render_stub = make_render_stub()
    local server_stub = make_server_stub()
    local session_stub = make_session_stub({}) -- no active sessions

    local lifecycle =
      load_lifecycle(vim_stub, render_stub, server_stub, session_stub, make_log_stub())
    lifecycle.setup()

    local cb = vim_stub._captured["BufDelete"]
    assert.is_not_nil(cb)
    cb({ buf = bufnr }) -- should be a no-op

    assert.are.equal(0, #render_stub._calls, "stop_watch must not be called for non-session buffer")
    assert.are.equal(0, #server_stub._calls, "close_session/shutdown must not be called")
  end)

  it("BufDelete callback with two sessions: does NOT call shutdown after removing one", function()
    local bufnr1 = 5
    local bufnr2 = 6
    local active = { [bufnr1] = true, [bufnr2] = true }
    local vim_stub = make_vim_stub()
    local render_stub = make_render_stub()
    local server_stub = make_server_stub()
    local session_stub = make_session_stub(active)

    server_stub.close_session = function(b)
      table.insert(server_stub._calls, { fn = "close_session", bufnr = b })
      active[b] = nil -- unregister only this buffer
    end

    local lifecycle =
      load_lifecycle(vim_stub, render_stub, server_stub, session_stub, make_log_stub())
    lifecycle.setup()

    local cb = vim_stub._captured["BufDelete"]
    cb({ buf = bufnr1 }) -- only bufnr1 deleted; bufnr2 still active

    -- shutdown must NOT be called — bufnr2 is still active
    local shutdown_called = false
    for _, c in ipairs(server_stub._calls) do
      if c == "shutdown" then
        shutdown_called = true
      end
    end
    assert.is_false(shutdown_called, "shutdown must NOT be called when sessions remain")
  end)
end)
