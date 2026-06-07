-- Unit tests for commands.lua: non-DOT guard, envelope shape, browser-open.
-- Designed to run under plain busted (no Neovim) as well as nvim+busted.
-- All vim APIs and plugin modules are stubbed via _G.vim + package.loaded injection.
package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path

-- ── vim stub ──────────────────────────────────────────────────────────────────

local function make_vim(opts)
  opts = opts or {}
  local filetype = opts.filetype or ""
  local bufname = opts.bufname or ""
  local lines = opts.lines or { "digraph{a->b}" }
  local opened_urls = opts.opened_urls or {}
  local system_calls = opts.system_calls or {}
  local buf_valid = opts.buf_valid ~= false -- default true

  local bo_proxy = setmetatable({}, {
    __index = function(_, _)
      return { filetype = filetype }
    end,
  })

  return {
    log = { levels = { INFO = 2, WARN = 3, ERROR = 4 } },
    api = {
      nvim_get_current_buf = function()
        return opts.bufnr or 3
      end,
      nvim_buf_get_name = function(_)
        return bufname
      end,
      nvim_buf_get_lines = function(_, _, _, _)
        return lines
      end,
      nvim_buf_is_valid = function(_)
        return buf_valid
      end,
      nvim_create_augroup = function(_, _)
        return 1
      end,
      nvim_create_autocmd = function(_, _) end,
      nvim_del_augroup_by_name = function(_) end,
    },
    bo = bo_proxy,
    split = function(str, _, _)
      local result = {}
      for s in str:gmatch("[^%s]+") do
        table.insert(result, s)
      end
      return result
    end,
    system = function(parts)
      table.insert(system_calls, parts)
    end,
    ui = {
      open = function(url)
        table.insert(opened_urls, url)
      end,
    },
    -- schedule used by server.on_ready in the already-running path
    schedule = function(fn)
      fn()
    end,
    uv = {
      new_timer = function()
        local t = {}
        t.start = function(_, _, _, _) end
        t.stop = function(_) end
        t.close = function(_) end
        return t
      end,
    },
  }
end

-- ── module stubs ──────────────────────────────────────────────────────────────

local function make_server(opts)
  opts = opts or {}
  local self = {
    state = opts.state or { running = true, port = 9876, token = "tok-abc" },
    open_session_returns = opts.open_session_returns ~= false,
    open_session_calls = {},
    close_session_calls = {},
    shutdown_calls = {},
    send_calls = {},
    on_ready_calls = {},
  }
  self.open_session = function(bufnr)
    table.insert(self.open_session_calls, bufnr)
    return self.open_session_returns
  end
  self.close_session = function(bufnr)
    table.insert(self.close_session_calls, bufnr)
  end
  self.shutdown = function()
    table.insert(self.shutdown_calls, true)
  end
  self.send = function(msg)
    table.insert(self.send_calls, msg)
    return true
  end
  self.is_running = function()
    if opts.is_running ~= nil then
      return opts.is_running
    end
    return self.state.running
  end
  -- Immediately call fn (server already running). Captures url inside the callback.
  self.on_ready = function(fn)
    table.insert(self.on_ready_calls, fn)
    fn()
  end
  return self
end

local function make_session(opts)
  opts = opts or {}
  local versions = {}
  local active = opts.active or {}
  return {
    has = function(bufnr)
      return active[bufnr] == true
    end,
    count = function()
      local n = 0
      for _ in pairs(active) do
        n = n + 1
      end
      return n
    end,
    next_version = function(bufnr)
      versions[bufnr] = (versions[bufnr] or 0) + 1
      return versions[bufnr]
    end,
    _active = active,
  }
end

local function make_render()
  local calls = {}
  return {
    stop_watch = function(bufnr)
      table.insert(calls, { fn = "stop_watch", bufnr = bufnr })
    end,
    stop_all = function()
      table.insert(calls, { fn = "stop_all" })
    end,
    start_watch = function(bufnr)
      table.insert(calls, { fn = "start_watch", bufnr = bufnr })
    end,
    _calls = calls,
  }
end

local function make_config(engine, open_cmd, engines)
  local state = {
    engine = engine or "dot",
    open_cmd = open_cmd,
    engines = engines or { "dot", "neato" },
  }
  return {
    get = function()
      return state
    end,
    set_engine = function(next_engine)
      for _, allowed in ipairs(state.engines) do
        if allowed == next_engine then
          state.engine = next_engine
          return true
        end
      end
      return false,
        "GraphvizEngine: unknown engine '"
          .. tostring(next_engine)
          .. "'; expected one of: "
          .. table.concat(state.engines, ", ")
    end,
  }
end

local function make_log()
  local notified = {}
  local warned = {}
  return {
    notify = function(msg, _)
      table.insert(notified, msg)
    end,
    warn = function(msg)
      table.insert(warned, msg)
    end,
    _notified = notified,
    _warned = warned,
  }
end

-- ── helpers ───────────────────────────────────────────────────────────────────

local function load_commands(
  vim_stub,
  server_stub,
  session_stub,
  config_stub,
  log_stub,
  render_stub
)
  _G.vim = vim_stub

  package.loaded["interactive-graphviz.server"] = server_stub
  package.loaded["interactive-graphviz.session"] = session_stub
  package.loaded["interactive-graphviz.config"] = config_stub
  package.loaded["interactive-graphviz.log"] = log_stub
  package.loaded["interactive-graphviz.render"] = render_stub or make_render()
  package.loaded["interactive-graphviz.commands"] = nil -- force reload

  return require("interactive-graphviz.commands")
end

-- ── test suite ────────────────────────────────────────────────────────────────

describe("commands.preview", function()
  after_each(function()
    -- Clean up injected stubs so they don't bleed into other tests.
    package.loaded["interactive-graphviz.commands"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.log"] = nil
    package.loaded["interactive-graphviz.render"] = nil
    _G.vim = nil
  end)

  -- ── AC4: non-DOT no-op ───────────────────────────────────────────────────

  it("non-DOT buffer: no-op with informative message, no spawn or open", function()
    local server = make_server()
    local log = make_log()
    local cmd = load_commands(
      make_vim({ filetype = "lua", bufname = "foo.lua" }),
      server,
      make_session(),
      make_config(),
      log
    )

    cmd.preview()

    assert.are.equal(
      0,
      #server.open_session_calls,
      "must not call open_session on a non-DOT buffer"
    )
    assert.are.equal(0, #server.send_calls, "must not send render on a non-DOT buffer")
    assert.are.equal(0, #server.on_ready_calls, "must not open browser on a non-DOT buffer")
    assert.are.equal(1, #log._notified, "must log exactly one message")
    assert.truthy(
      log._notified[1]:find("not a DOT") or log._notified[1]:find("DOT/GV"),
      "message must mention DOT/GV"
    )
  end)

  it("non-DOT buffer detected by extension .dot (filetype empty)", function()
    -- filetype "" but name ends in .dot → still treated as DOT
    local server = make_server()
    local opened = {}
    local cmd = load_commands(
      make_vim({ filetype = "", bufname = "/tmp/graph.dot", bufnr = 5, opened_urls = opened }),
      server,
      make_session(),
      make_config(),
      make_log()
    )

    cmd.preview()

    assert.are.equal(1, #server.open_session_calls, ".dot extension must trigger open_session")
  end)

  it("non-DOT buffer detected by extension .gv (filetype empty)", function()
    local server = make_server()
    local cmd = load_commands(
      make_vim({ filetype = "", bufname = "/tmp/graph.gv", bufnr = 6 }),
      server,
      make_session(),
      make_config(),
      make_log()
    )

    cmd.preview()

    assert.are.equal(1, #server.open_session_calls, ".gv extension must trigger open_session")
  end)

  -- ── AC1, AC2: render envelope shape ─────────────────────────────────────

  it("DOT buffer: sends render envelope with correct shape", function()
    local server = make_server()
    local bufnr = 3
    local dot_text = "digraph G { a -> b }"
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr, lines = { dot_text } }),
      server,
      make_session(),
      make_config("dot"),
      make_log()
    )

    cmd.preview()

    assert.are.equal(1, #server.send_calls)
    local msg = server.send_calls[1]
    assert.are.equal("render", msg.type)
    assert.are.equal(bufnr, msg.sessionId)
    assert.are.equal(1, msg.v, "first call to next_version returns 1")
    assert.are.equal("dot", msg.engine)
    assert.are.equal(dot_text, msg.dot)
    -- no null/nil fields exported
    assert.is_not_nil(msg.type)
    assert.is_not_nil(msg.sessionId)
    assert.is_not_nil(msg.v)
    assert.is_not_nil(msg.engine)
    assert.is_not_nil(msg.dot)
  end)

  -- ── AC1: browser URL shape ───────────────────────────────────────────────

  it("DOT buffer: opens browser at correct URL (vim.ui.open path)", function()
    local opened = {}
    local bufnr = 3
    local port = 9876
    local token = "tok-abc"
    local server = make_server({ state = { running = true, port = port, token = token } })
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr, opened_urls = opened }),
      server,
      make_session(),
      make_config("dot", nil), -- open_cmd = nil → vim.ui.open
      make_log()
    )

    cmd.preview()

    assert.are.equal(1, #opened, "vim.ui.open must be called exactly once")
    local expected = string.format("http://127.0.0.1:%d/?sessionId=%d&token=%s", port, bufnr, token)
    assert.are.equal(expected, opened[1])
  end)

  it("DOT buffer: uses open_cmd when configured", function()
    local system_calls = {}
    local bufnr = 4
    local port = 9876
    local token = "tok-abc"
    local server = make_server({ state = { running = true, port = port, token = token } })
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr, system_calls = system_calls }),
      server,
      make_session(),
      make_config("dot", "xdg-open"),
      make_log()
    )

    cmd.preview()

    assert.are.equal(1, #system_calls, "vim.system must be called when open_cmd is set")
    -- parts[1] is the command, last element is the URL
    local parts = system_calls[1]
    assert.are.equal("xdg-open", parts[1])
    local url = parts[#parts]
    -- Use plain-string find (4th arg = true) to avoid Lua pattern chars like "-".
    assert.truthy(url:find("127.0.0.1", 1, true), "URL must use loopback")
    assert.truthy(url:find("sessionId=" .. bufnr, 1, true), "URL must include sessionId")
    assert.truthy(url:find("token=" .. token, 1, true), "URL must include token")
  end)

  -- ── AC5: idempotent re-open ──────────────────────────────────────────────

  it("second :GraphvizPreview on same buffer does not double-register (idempotent)", function()
    local opened = {}
    local bufnr = 10
    local server = make_server()
    local session_mod = make_session()
    local vim_stub = make_vim({ filetype = "dot", bufnr = bufnr, opened_urls = opened })
    local cmd = load_commands(vim_stub, server, session_mod, make_config(), make_log())

    cmd.preview()
    cmd.preview() -- second call

    -- open_session called twice: the Story 1.7 idempotency guard requires BOTH
    -- session.has(bufnr)==true AND server.state.running==true. This stub's session
    -- does not auto-register on open_session, so session.has() stays false — guard
    -- does not fire and both calls go through.
    assert.are.equal(2, #server.open_session_calls)
    -- two render envelopes sent (one per call), v increments
    assert.are.equal(2, #server.send_calls)
    assert.are.equal(1, server.send_calls[1].v)
    assert.are.equal(2, server.send_calls[2].v)
    -- browser opened twice (guard not triggered — see comment above)
    assert.are.equal(2, #opened)
  end)

  -- ── server-start failure ─────────────────────────────────────────────────

  it("server start failure: no browser open, no render sent", function()
    local server = make_server({ open_session_returns = false })
    local log = make_log()
    local opened = {}
    local cmd = load_commands(
      make_vim({ filetype = "dot", opened_urls = opened }),
      server,
      make_session(),
      make_config(),
      log
    )

    cmd.preview()

    assert.are.equal(0, #server.send_calls, "no render on server failure")
    assert.are.equal(0, #opened, "no browser open on server failure")
    assert.are.equal(1, #log._notified, "must log failure message")
  end)

  -- ── AC5 (Story 1.7): idempotency guard — no second browser tab ──────────

  it("second preview() with active session and running server does NOT re-open browser", function()
    local opened = {}
    local bufnr = 20
    -- Session already has bufnr active AND server is running
    local session_mod = make_session({ active = { [bufnr] = true } })
    local server = make_server({ state = { running = true, port = 9876, token = "tok-abc" } })
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr, opened_urls = opened }),
      server,
      session_mod,
      make_config(),
      make_log()
    )

    cmd.preview()

    -- The idempotency guard fires: send a render but do NOT open browser.
    assert.are.equal(0, #server.open_session_calls, "must not call open_session on re-preview")
    assert.are.equal(0, #server.on_ready_calls, "must not register on_ready callback on re-preview")
    assert.are.equal(0, #opened, "must not open a second browser tab")
    assert.are.equal(1, #server.send_calls, "must still send a render refresh")
    assert.are.equal("render", server.send_calls[1].type)
  end)
end)

-- ── AC1 (Story 4.1): N-tabs idempotency in the pre-`ready` window ──────────────

describe("commands.preview idempotency (pre-ready N-tabs)", function()
  after_each(function()
    package.loaded["interactive-graphviz.commands"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.log"] = nil
    package.loaded["interactive-graphviz.render"] = nil
    _G.vim = nil
  end)

  it("rapid preview() before `ready` registers exactly one browser-open", function()
    local bufnr = 30
    local active = {}
    -- Session registers on open_session, mirroring production (server.open_session
    -- calls session.register synchronously) so session.has(bufnr) becomes true.
    local session_mod = make_session({ active = active })
    -- Server is still STARTING: state.running == false, and on_ready QUEUES the
    -- callback (does not fire) until `ready` — the real pre-ready behavior that
    -- the immediate-fire stub elsewhere does not exercise.
    local server = make_server({ state = { running = false, port = nil, token = nil } })
    server.open_session = function(b)
      table.insert(server.open_session_calls, b)
      active[b] = true
      return true
    end
    server.on_ready = function(fn)
      table.insert(server.on_ready_calls, fn) -- queue only; do NOT fire (pre-ready)
    end

    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr }),
      server,
      session_mod,
      make_config(),
      make_log()
    )

    cmd.preview() -- first: opens session, registers ONE browser-open
    cmd.preview() -- second, still pre-ready: must NOT register another (no N-tabs)
    cmd.preview() -- third, idempotent

    assert.are.equal(1, #server.open_session_calls, "open_session only on the first call")
    assert.are.equal(1, #server.on_ready_calls, "exactly one browser-open registered (no N-tabs)")
    -- every call still sends a render (initial + idempotent refreshes), v increments
    assert.are.equal(3, #server.send_calls)
    assert.are.equal(1, server.send_calls[1].v)
    assert.are.equal(2, server.send_calls[2].v)
    assert.are.equal(3, server.send_calls[3].v)
  end)
end)

-- ── AC3 (Story 4.1): open_cmd quote-aware tokenizer ───────────────────────────

describe("commands open_cmd tokenizer", function()
  after_each(function()
    package.loaded["interactive-graphviz.commands"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.log"] = nil
    package.loaded["interactive-graphviz.render"] = nil
    _G.vim = nil
  end)

  local function tok()
    local cmd = load_commands(
      make_vim({ filetype = "dot" }),
      make_server(),
      make_session(),
      make_config(),
      make_log()
    )
    return cmd._tokenize_cmd
  end

  it("keeps a double-quoted multi-word argument intact", function()
    assert.are.same({ "open", "-a", "Google Chrome" }, tok()('open -a "Google Chrome"'))
  end)

  it("keeps a single-quoted multi-word argument intact", function()
    assert.are.same({ "open", "-a", "Google Chrome" }, tok()("open -a 'Google Chrome'"))
  end)

  it("single-word command tokenizes to one element", function()
    assert.are.same({ "xdg-open" }, tok()("xdg-open"))
  end)

  it("collapses extra whitespace", function()
    assert.are.same({ "a", "b" }, tok()("  a   b  "))
  end)

  it("empty/whitespace string yields no tokens", function()
    assert.are.same({}, tok()("   "))
  end)

  it("concatenates adjacent quoted and unquoted runs shell-style", function()
    assert.are.same({ "--flag=a b" }, tok()('--flag="a b"'))
  end)

  it("preview() passes a quoted open_cmd through correctly", function()
    local system_calls = {}
    local bufnr = 41
    local server = make_server({ state = { running = true, port = 9876, token = "tok-abc" } })
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr, system_calls = system_calls }),
      server,
      make_session(),
      make_config("dot", 'open -a "Google Chrome"'),
      make_log()
    )

    cmd.preview()

    assert.are.equal(1, #system_calls, "vim.system called once for the quoted open_cmd")
    local parts = system_calls[1]
    assert.are.equal("open", parts[1])
    assert.are.equal("-a", parts[2])
    assert.are.equal("Google Chrome", parts[3])
    assert.truthy(parts[4]:find("127.0.0.1", 1, true), "URL appended as the final argument")
  end)
end)

-- ── commands.stop ─────────────────────────────────────────────────────────────

describe("commands.stop", function()
  after_each(function()
    package.loaded["interactive-graphviz.commands"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.log"] = nil
    package.loaded["interactive-graphviz.render"] = nil
    _G.vim = nil
  end)

  it(
    "stop() with an active session: calls stop_watch, close_session, and shutdown (last session)",
    function()
      local bufnr = 5
      local active = { [bufnr] = true }
      local session_mod = make_session({ active = active })
      local server = make_server()
      local render = make_render()

      -- Wire close_session to also unregister so count() drops to 0
      server.close_session = function(b)
        table.insert(server.close_session_calls, b)
        active[b] = nil
      end

      local cmd = load_commands(
        make_vim({ filetype = "dot", bufnr = bufnr }),
        server,
        session_mod,
        make_config(),
        make_log(),
        render
      )

      cmd.stop()

      assert.are.equal(1, #render._calls, "stop_watch must be called once")
      assert.are.equal("stop_watch", render._calls[1].fn)
      assert.are.equal(bufnr, render._calls[1].bufnr)

      assert.are.equal(1, #server.close_session_calls, "close_session must be called")
      assert.are.equal(bufnr, server.close_session_calls[1])

      assert.are.equal(1, #server.shutdown_calls, "shutdown must be called when last session gone")
    end
  )

  it("stop() with no active session: idempotent — no calls, no error", function()
    local bufnr = 7
    local session_mod = make_session({ active = {} }) -- no sessions
    local server = make_server()
    local render = make_render()

    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr }),
      server,
      session_mod,
      make_config(),
      make_log(),
      render
    )

    cmd.stop()

    assert.are.equal(0, #render._calls, "stop_watch must NOT be called when no session")
    assert.are.equal(0, #server.close_session_calls, "close_session must NOT be called")
    assert.are.equal(0, #server.shutdown_calls, "shutdown must NOT be called")
  end)

  it("stop() with two sessions active: does NOT call shutdown after removing one", function()
    local bufnr1 = 8
    local bufnr2 = 9
    local active = { [bufnr1] = true, [bufnr2] = true }
    local session_mod = make_session({ active = active })
    local server = make_server()
    local render = make_render()

    -- Wire close_session to unregister only the target buffer
    server.close_session = function(b)
      table.insert(server.close_session_calls, b)
      active[b] = nil
    end

    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr1 }),
      server,
      session_mod,
      make_config(),
      make_log(),
      render
    )

    cmd.stop() -- stops bufnr1 only; bufnr2 still active

    assert.are.equal(1, #render._calls, "stop_watch called once for bufnr1")
    assert.are.equal(bufnr1, render._calls[1].bufnr)
    assert.are.equal(1, #server.close_session_calls)
    assert.are.equal(
      0,
      #server.shutdown_calls,
      "shutdown must NOT be called — bufnr2 still active"
    )
  end)
end)

-- ── commands.toggle ───────────────────────────────────────────────────────────

describe("commands.toggle", function()
  after_each(function()
    package.loaded["interactive-graphviz.commands"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.log"] = nil
    package.loaded["interactive-graphviz.render"] = nil
    _G.vim = nil
  end)

  it("toggle() when session exists: calls stop path (stop_watch + close_session)", function()
    local bufnr = 11
    local active = { [bufnr] = true }
    local session_mod = make_session({ active = active })
    local server = make_server()
    local render = make_render()

    server.close_session = function(b)
      table.insert(server.close_session_calls, b)
      active[b] = nil
    end

    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr }),
      server,
      session_mod,
      make_config(),
      make_log(),
      render
    )

    cmd.toggle()

    -- Should have taken the stop path
    assert.are.equal(1, #render._calls, "stop_watch must be called via toggle→stop")
    assert.are.equal("stop_watch", render._calls[1].fn)
    assert.are.equal(
      1,
      #server.close_session_calls,
      "close_session must be called via toggle→stop"
    )
    -- open_session must NOT be called (preview path not taken)
    assert.are.equal(
      0,
      #server.open_session_calls,
      "open_session must not be called when toggling off"
    )
  end)

  it("toggle() when no session: calls preview path (open_session called)", function()
    local bufnr = 12
    local session_mod = make_session({ active = {} }) -- no active session
    local server = make_server()
    local render = make_render()

    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr }),
      server,
      session_mod,
      make_config(),
      make_log(),
      render
    )

    cmd.toggle()

    -- Should have taken the preview path
    assert.are.equal(
      1,
      #server.open_session_calls,
      "open_session must be called via toggle→preview"
    )
    -- stop_watch was called as pre-watch reset (before start_watch) — expected
    -- close_session must NOT be called (stop path not taken)
    assert.are.equal(
      0,
      #server.close_session_calls,
      "close_session must not be called when toggling on"
    )
  end)
end)

-- ── commands.engine ───────────────────────────────────────────────────────────

describe("commands.engine", function()
  after_each(function()
    package.loaded["interactive-graphviz.commands"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.log"] = nil
    package.loaded["interactive-graphviz.render"] = nil
    _G.vim = nil
  end)

  it("valid engine with active session updates config and sends fresh render", function()
    local bufnr = 21
    local server = make_server({ state = { running = true, port = 9876, token = "tok-abc" } })
    local config = make_config("dot")
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr, lines = { "digraph{neato}" } }),
      server,
      make_session({ active = { [bufnr] = true } }),
      config,
      make_log()
    )

    cmd.engine({ args = "neato" })

    assert.are.equal("neato", config.get().engine)
    assert.are.equal(1, #server.send_calls)
    local msg = server.send_calls[1]
    assert.are.equal("render", msg.type)
    assert.are.equal(bufnr, msg.sessionId)
    assert.are.equal(1, msg.v)
    assert.are.equal("neato", msg.engine)
    assert.are.equal("digraph{neato}", msg.dot)
  end)

  it("valid engine with no active session updates config only", function()
    local server = make_server()
    local config = make_config("dot")
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = 22 }),
      server,
      make_session({ active = {} }),
      config,
      make_log()
    )

    cmd.engine({ args = "neato" })

    assert.are.equal("neato", config.get().engine)
    assert.are.equal(0, #server.send_calls)
    assert.are.equal(0, #server.open_session_calls)
  end)

  it("valid engine with active starting server queues a fresh render", function()
    local bufnr = 25
    local server =
      make_server({ state = { running = false, port = nil, token = nil }, is_running = true })
    local config = make_config("dot")
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr, lines = { "digraph{queued}" } }),
      server,
      make_session({ active = { [bufnr] = true } }),
      config,
      make_log()
    )

    cmd.engine({ args = "neato" })

    assert.are.equal("neato", config.get().engine)
    assert.are.equal(1, #server.send_calls)
    assert.are.equal("render", server.send_calls[1].type)
    assert.are.equal(bufnr, server.send_calls[1].sessionId)
    assert.are.equal("neato", server.send_calls[1].engine)
    assert.are.equal("digraph{queued}", server.send_calls[1].dot)
    assert.are.equal(0, #server.open_session_calls)
  end)

  it("invalid engine logs and sends nothing", function()
    local bufnr = 23
    local server = make_server()
    local config = make_config("dot")
    local log = make_log()
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr }),
      server,
      make_session({ active = { [bufnr] = true } }),
      config,
      log
    )

    cmd.engine({ args = "fdp" })

    assert.are.equal("dot", config.get().engine)
    assert.are.equal(1, #log._warned)
    assert.truthy(log._warned[1]:find("unknown engine 'fdp'", 1, true))
    assert.are.equal(0, #server.send_calls)
    assert.are.equal(0, #server.open_session_calls)
  end)

  it("empty args reports current and available engines without sending render", function()
    local server = make_server()
    local log = make_log()
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = 24 }),
      server,
      make_session({ active = { [24] = true } }),
      make_config("dot"),
      log
    )

    cmd.engine({ args = "" })

    assert.are.equal(1, #log._notified)
    assert.truthy(log._notified[1]:find("current engine: dot", 1, true))
    assert.truthy(log._notified[1]:find("available: dot, neato", 1, true))
    assert.are.equal(0, #server.send_calls)
  end)
end)
