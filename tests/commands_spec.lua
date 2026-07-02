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
  local echo_calls = opts.echo_calls or {}
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
      nvim_echo = function(chunks, history, echo_opts)
        -- Pin the real API's call shape: a chunk LIST and an opts table. A call
        -- like nvim_echo(url, true) would pass a loose stub but throw in nvim.
        assert(type(chunks) == "table", "nvim_echo: chunks must be a list of {text, hl} tuples")
        assert(type(chunks[1]) == "table", "nvim_echo: each chunk must be a table")
        assert(type(echo_opts) == "table", "nvim_echo: opts table is required")
        table.insert(echo_calls, { chunks = chunks, history = history, opts = echo_opts })
      end,
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

local function make_sync()
  local calls = {}
  return {
    start_cursor_watch = function(bufnr)
      table.insert(calls, { fn = "start_cursor_watch", bufnr = bufnr })
    end,
    stop_cursor_watch = function(bufnr)
      table.insert(calls, { fn = "stop_cursor_watch", bufnr = bufnr })
    end,
    stop_all = function()
      table.insert(calls, { fn = "stop_all" })
    end,
    _calls = calls,
  }
end

local function make_config(engine, open_cmd, engines, overrides)
  overrides = overrides or {}
  local state = {
    engine = engine or "dot",
    open_cmd = open_cmd,
    engines = engines or { "dot", "neato" },
    -- Interactivity keys carried on the preview URL; production config.setup
    -- always populates these, so the stub mirrors the validated defaults.
    preserve_view = overrides.preserve_view == nil and true or overrides.preserve_view,
    highlight_mode = overrides.highlight_mode or "bidirectional",
    animate = overrides.animate == nil and true or overrides.animate,
    search = overrides.search or { scope = "both", case_sensitive = false, regex = false },
    sync = overrides.sync
      or { jump_on_click = true, highlight_on_cursor = true, cursor_debounce_ms = 150 },
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
  render_stub,
  sync_stub
)
  _G.vim = vim_stub

  package.loaded["interactive-graphviz.server"] = server_stub
  package.loaded["interactive-graphviz.session"] = session_stub
  package.loaded["interactive-graphviz.config"] = config_stub
  package.loaded["interactive-graphviz.log"] = log_stub
  package.loaded["interactive-graphviz.render"] = render_stub or make_render()
  package.loaded["interactive-graphviz.sync"] = sync_stub or make_sync()
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
    package.loaded["interactive-graphviz.sync"] = nil
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
    local expected = string.format(
      "http://127.0.0.1:%d/?sessionId=%d&token=%s"
        .. "&preserve_view=1&highlight_mode=bidirectional&animate=1"
        .. "&search_scope=both&search_case=0&search_regex=0"
        .. "&sync_jump_on_click=1",
      port,
      bufnr,
      token
    )
    assert.are.equal(expected, opened[1])
  end)

  -- ── Promote-config spec: URL carries the interactivity config params ──────

  it("preview URL carries default-valued config params on a default setup", function()
    local opened = {}
    local server = make_server({ state = { running = true, port = 9876, token = "tok-abc" } })
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = 3, opened_urls = opened }),
      server,
      make_session(),
      make_config(), -- all interactivity keys at defaults
      make_log()
    )

    cmd.preview()

    assert.are.equal(1, #opened)
    local url = opened[1]
    assert.truthy(url:find("preserve_view=1", 1, true), "URL must carry preserve_view=1")
    assert.truthy(
      url:find("highlight_mode=bidirectional", 1, true),
      "URL must carry highlight_mode=bidirectional"
    )
    assert.truthy(url:find("animate=1", 1, true), "URL must carry animate=1")
    assert.truthy(url:find("search_scope=both", 1, true), "URL must carry search_scope=both")
    assert.truthy(url:find("search_case=0", 1, true), "URL must carry search_case=0")
    assert.truthy(url:find("search_regex=0", 1, true), "URL must carry search_regex=0")
    assert.truthy(url:find("sync_jump_on_click=1", 1, true), "URL must carry sync_jump_on_click=1")
  end)

  it("preview URL reflects non-default setup() values (booleans as 1/0)", function()
    local opened = {}
    local server = make_server({ state = { running = true, port = 9876, token = "tok-abc" } })
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = 3, opened_urls = opened }),
      server,
      make_session(),
      make_config("dot", nil, nil, {
        preserve_view = false,
        highlight_mode = "upstream",
        animate = false,
        search = { scope = "nodes", case_sensitive = true, regex = true },
        sync = { jump_on_click = false },
      }),
      make_log()
    )

    cmd.preview()

    assert.are.equal(1, #opened)
    local url = opened[1]
    assert.truthy(url:find("preserve_view=0", 1, true), "URL must carry preserve_view=0")
    assert.truthy(
      url:find("highlight_mode=upstream", 1, true),
      "URL must carry highlight_mode=upstream"
    )
    assert.truthy(url:find("animate=0", 1, true), "URL must carry animate=0")
    assert.truthy(url:find("search_scope=nodes", 1, true), "URL must carry search_scope=nodes")
    assert.truthy(url:find("search_case=1", 1, true), "URL must carry search_case=1")
    assert.truthy(url:find("search_regex=1", 1, true), "URL must carry search_regex=1")
    assert.truthy(url:find("sync_jump_on_click=0", 1, true), "URL must carry sync_jump_on_click=0")
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
    package.loaded["interactive-graphviz.sync"] = nil
    _G.vim = nil
  end)

  it("rapid preview() before `ready` registers exactly one browser-open", function()
    local bufnr = 30
    local active = {}
    -- Session registers on open_session, mirroring production (server.open_session
    -- calls session.register synchronously) so session.has(bufnr) becomes true.
    local session_mod = make_session({ active = active })
    -- Server is still STARTING: `ready` not yet received (state.running == false)
    -- but the process is alive (is_running() == true, handle present). on_ready
    -- QUEUES the callback (does not fire) until `ready` — the real pre-ready
    -- behavior that the immediate-fire stub elsewhere does not exercise.
    local server =
      make_server({ state = { running = false, port = nil, token = nil }, is_running = true })
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

  it("preview() after the server has died re-spawns instead of silently no-op'ing", function()
    local bufnr = 31
    -- A session record lingers from a prior preview; the Lua-side cache is NOT
    -- cleared when the server crashes (only on stop / VimLeavePre).
    local active = { [bufnr] = true }
    local session_mod = make_session({ active = active })
    -- Server has exited: is_running() == false even though session.has is true.
    local server = make_server({ state = { running = false }, is_running = false })

    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr }),
      server,
      session_mod,
      make_config(),
      make_log()
    )

    cmd.preview()

    -- Guard must NOT fire (is_running false) — fall through to the re-spawn path
    -- rather than re-sending into a dead server. Regression guard for the broadened
    -- idempotency check (must distinguish "starting" from "dead").
    assert.are.equal(
      1,
      #server.open_session_calls,
      "a dead server must be re-spawned via open_session"
    )
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
    package.loaded["interactive-graphviz.sync"] = nil
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
    package.loaded["interactive-graphviz.sync"] = nil
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
    package.loaded["interactive-graphviz.sync"] = nil
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

describe("commands.url", function()
  after_each(function()
    package.loaded["interactive-graphviz.commands"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.log"] = nil
    package.loaded["interactive-graphviz.render"] = nil
    package.loaded["interactive-graphviz.sync"] = nil
    _G.vim = nil
  end)

  it("echoes the FULL preview URL into message history (history=true)", function()
    local echoed = {}
    local bufnr = 3
    local server = make_server({ state = { running = true, port = 9876, token = "tok-abc" } })
    local log = make_log()
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr, echo_calls = echoed }),
      server,
      make_session({ active = { [bufnr] = true } }),
      make_config(),
      log
    )

    local url = cmd.url()

    local expected = "http://127.0.0.1:9876/?sessionId=3&token=tok-abc"
      .. "&preserve_view=1&highlight_mode=bidirectional&animate=1"
      .. "&search_scope=both&search_case=0&search_regex=0"
      .. "&sync_jump_on_click=1"
    assert.are.equal(expected, url)
    assert.are.equal(1, #echoed, "nvim_echo called exactly once")
    assert.are.equal(true, echoed[1].history, "URL must land in :messages history")
    assert.are.equal(expected, echoed[1].chunks[1][1], "the full URL is the echoed text")
    assert.are.equal(0, #log._notified, "no notify on the success path")
  end)

  it("matches the URL that preview actually opened (single source of truth)", function()
    local echoed = {}
    local opened = {}
    local bufnr = 3
    local server = make_server({ state = { running = true, port = 9876, token = "tok-abc" } })
    local session = make_session()
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr, opened_urls = opened, echo_calls = echoed }),
      server,
      session,
      make_config(),
      make_log()
    )

    cmd.preview()
    session._active[bufnr] = true -- register() is stubbed away; mark active
    local url = cmd.url()

    assert.are.equal(1, #opened)
    assert.are.equal(opened[1], url, ":GraphvizUrl must reprint exactly the opened URL")
  end)

  it("non-default config values land in the echoed URL (b01/enum parity)", function()
    local echoed = {}
    local bufnr = 7
    local server = make_server({ state = { running = true, port = 4242, token = "tok-xyz" } })
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = bufnr, echo_calls = echoed }),
      server,
      make_session({ active = { [bufnr] = true } }),
      make_config("dot", nil, nil, {
        preserve_view = false,
        highlight_mode = "upstream",
        animate = false,
        search = { scope = "nodes", case_sensitive = true, regex = true },
        sync = { jump_on_click = false },
      }),
      make_log()
    )

    local url = cmd.url()

    assert.are.equal(
      "http://127.0.0.1:4242/?sessionId=7&token=tok-xyz"
        .. "&preserve_view=0&highlight_mode=upstream&animate=0"
        .. "&search_scope=nodes&search_case=1&search_regex=1"
        .. "&sync_jump_on_click=0",
      url
    )
    assert.are.equal(url, echoed[1].chunks[1][1])
  end)

  it("no active session: informative notify, no echo, returns nil", function()
    local echoed = {}
    local log = make_log()
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = 3, echo_calls = echoed }),
      make_server({ state = { running = true, port = 9876, token = "tok-abc" } }),
      make_session(), -- nothing active
      make_config(),
      log
    )

    assert.is_nil(cmd.url())
    assert.are.equal(0, #echoed)
    assert.are.equal(1, #log._notified)
    assert.truthy(
      log._notified[1]:find("no active preview", 1, true),
      "the no-session guard fired, not another one"
    )
    assert.truthy(
      log._notified[1]:find("GraphvizPreview", 1, true),
      "notify points at :GraphvizPreview"
    )
  end)

  it("session lingers but server exited: says the server is not running", function()
    local echoed = {}
    local log = make_log()
    -- port/token deliberately still present: if the is_running guard were
    -- removed, the pre-ready branch would NOT catch this and the test would
    -- fail loudly instead of passing by accident.
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = 3, echo_calls = echoed }),
      make_server({
        state = { running = false, port = 9876, token = "tok-abc" },
        is_running = false,
      }),
      make_session({ active = { [3] = true } }),
      make_config(),
      log
    )

    assert.is_nil(cmd.url())
    assert.are.equal(0, #echoed)
    assert.are.equal(1, #log._notified)
    assert.truthy(
      log._notified[1]:find("not running", 1, true),
      "the dead-server guard fired, not the no-session one"
    )
  end)

  it("server alive but pre-ready (no port/token yet): notify, no echo", function()
    local echoed = {}
    local log = make_log()
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = 3, echo_calls = echoed }),
      make_server({ state = { running = false, port = nil, token = nil }, is_running = true }),
      make_session({ active = { [3] = true } }),
      make_config(),
      log
    )

    assert.is_nil(cmd.url())
    assert.are.equal(0, #echoed)
    assert.are.equal(1, #log._notified)
    assert.truthy(
      log._notified[1]:find("still starting", 1, true),
      "the pre-ready guard fired, not another one"
    )
  end)
end)

describe("commands.engine", function()
  after_each(function()
    package.loaded["interactive-graphviz.commands"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.log"] = nil
    package.loaded["interactive-graphviz.render"] = nil
    package.loaded["interactive-graphviz.sync"] = nil
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

describe("commands cursor-sync gate (Story 6.3)", function()
  after_each(function()
    package.loaded["interactive-graphviz.commands"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.log"] = nil
    package.loaded["interactive-graphviz.render"] = nil
    package.loaded["interactive-graphviz.sync"] = nil
    _G.vim = nil
  end)

  local SYNC_ON = { jump_on_click = true, highlight_on_cursor = true, cursor_debounce_ms = 150 }
  local SYNC_OFF = { jump_on_click = true, highlight_on_cursor = false, cursor_debounce_ms = 150 }

  it("preview() with highlight_on_cursor=true starts the cursor watch (reset-first)", function()
    local sync = make_sync()
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = 3 }),
      make_server(),
      make_session(),
      make_config(nil, nil, nil, { sync = SYNC_ON }),
      make_log(),
      make_render(),
      sync
    )

    cmd.preview()

    assert.are.equal(2, #sync._calls)
    assert.are.equal("stop_cursor_watch", sync._calls[1].fn, "reset before start")
    assert.are.equal("start_cursor_watch", sync._calls[2].fn)
    assert.are.equal(3, sync._calls[2].bufnr)
  end)

  it(
    "preview() with highlight_on_cursor=false stops any stale cursor watch and never starts it",
    function()
      local sync = make_sync()
      local cmd = load_commands(
        make_vim({ filetype = "dot", bufnr = 3 }),
        make_server(),
        make_session(),
        make_config(nil, nil, nil, { sync = SYNC_OFF }),
        make_log(),
        make_render(),
        sync
      )

      cmd.preview()

      assert.are.equal(1, #sync._calls, "gate off: stale watcher is torn down only")
      assert.are.equal("stop_cursor_watch", sync._calls[1].fn)
      assert.are.equal(3, sync._calls[1].bufnr)
    end
  )

  it(
    "active preview with highlight_on_cursor=true reconciles the cursor watch reset-first",
    function()
      local sync = make_sync()
      local server = make_server()
      local cmd = load_commands(
        make_vim({ filetype = "dot", bufnr = 3 }),
        server,
        make_session({ active = { [3] = true } }),
        make_config(nil, nil, nil, { sync = SYNC_ON }),
        make_log(),
        make_render(),
        sync
      )

      cmd.preview()

      assert.are.equal(0, #server.open_session_calls, "active session stays on the fast path")
      assert.are.equal(1, #server.send_calls, "render refresh still happens")
      assert.are.equal(2, #sync._calls)
      assert.are.equal("stop_cursor_watch", sync._calls[1].fn, "reset before start")
      assert.are.equal("start_cursor_watch", sync._calls[2].fn)
      assert.are.equal(3, sync._calls[2].bufnr)
    end
  )

  it(
    "active preview with highlight_on_cursor=false stops a previously running cursor watch",
    function()
      local sync = make_sync()
      local server = make_server()
      local cmd = load_commands(
        make_vim({ filetype = "dot", bufnr = 3 }),
        server,
        make_session({ active = { [3] = true } }),
        make_config(nil, nil, nil, { sync = SYNC_OFF }),
        make_log(),
        make_render(),
        sync
      )

      cmd.preview()

      assert.are.equal(0, #server.open_session_calls, "active session stays on the fast path")
      assert.are.equal(1, #server.send_calls, "render refresh still happens")
      assert.are.equal(1, #sync._calls)
      assert.are.equal("stop_cursor_watch", sync._calls[1].fn)
      assert.are.equal(3, sync._calls[1].bufnr)
    end
  )

  it("a failing start_cursor_watch warns but never blocks the render/open path", function()
    local server = make_server()
    local log = make_log()
    local sync = make_sync()
    sync.start_cursor_watch = function(_)
      error("boom")
    end
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = 3 }),
      server,
      make_session(),
      make_config(nil, nil, nil, { sync = SYNC_ON }),
      log,
      make_render(),
      sync
    )

    cmd.preview()

    assert.are.equal(1, #server.send_calls, "render still sent")
    assert.are.equal(1, #log._warned, "failure surfaced as a warning")
    assert.truthy(log._warned[1]:find("cursor-sync", 1, true))
  end)

  it("stop() tears the cursor watch down unconditionally (even with the gate off)", function()
    local sync = make_sync()
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = 3 }),
      make_server(),
      make_session({ active = { [3] = true } }),
      make_config(nil, nil, nil, { sync = SYNC_OFF }),
      make_log(),
      make_render(),
      sync
    )

    cmd.stop()

    assert.are.equal(1, #sync._calls)
    assert.are.equal("stop_cursor_watch", sync._calls[1].fn)
    assert.are.equal(3, sync._calls[1].bufnr)
  end)

  it("stop() with no active session does not touch the cursor watch (idempotent no-op)", function()
    local sync = make_sync()
    local cmd = load_commands(
      make_vim({ filetype = "dot", bufnr = 3 }),
      make_server(),
      make_session(), -- no active sessions
      make_config(nil, nil, nil, { sync = SYNC_ON }),
      make_log(),
      make_render(),
      sync
    )

    cmd.stop()

    assert.are.equal(0, #sync._calls)
  end)
end)
