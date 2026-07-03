-- Unit tests for render.lua: debounce timer, autocmd registration, latest-wins.
-- Runs under plain busted (no Neovim) via vim stubs, same pattern as commands_spec.lua.
package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path

-- ── vim stub ──────────────────────────────────────────────────────────────────

-- Controllable timer stub: start() captures the callback instead of scheduling it.
local function make_timer()
  local t = {
    started = false,
    stopped = false,
    closed = false,
    stop_count = 0,
    close_count = 0,
    delay = nil,
    callback = nil,
  }
  t.start = function(self, delay, _, fn)
    self.started = true
    self.delay = delay
    self.callback = fn
  end
  t.stop = function(self)
    self.stopped = true
    self.stop_count = self.stop_count + 1
  end
  t.close = function(self)
    self.closed = true
    self.close_count = self.close_count + 1
  end
  -- Test helper: invoke the timer callback synchronously.
  t.fire = function(self)
    if self.callback then
      self.callback()
    end
  end
  return t
end

local function make_vim(opts)
  opts = opts or {}
  local timers_created = opts.timers_created or {}
  local autocmds_created = opts.autocmds_created or {}
  local augroups_deleted = opts.augroups_deleted or {}
  local buf_valid = opts.buf_valid ~= false -- default true
  local buf_lines = opts.buf_lines or { "digraph{a->b}" }
  local scheduled_fns = opts.scheduled_fns or {}

  return {
    uv = {
      new_timer = function()
        local t = make_timer()
        table.insert(timers_created, t)
        return t
      end,
    },
    api = {
      nvim_create_augroup = function(name, _)
        return name
      end,
      nvim_create_autocmd = function(events, cfg)
        table.insert(
          autocmds_created,
          { events = events, buffer = cfg.buffer, group = cfg.group, callback = cfg.callback }
        )
      end,
      nvim_del_augroup_by_name = function(name)
        table.insert(augroups_deleted, name)
      end,
      nvim_buf_is_valid = function(_)
        return buf_valid
      end,
      nvim_buf_get_lines = function(_, _, _, _)
        return buf_lines
      end,
    },
    schedule = function(fn)
      table.insert(scheduled_fns, fn)
      fn() -- execute synchronously in tests
    end,
    _timers_created = timers_created,
    _autocmds_created = autocmds_created,
    _augroups_deleted = augroups_deleted,
    _scheduled_fns = scheduled_fns,
  }
end

-- ── module stubs ──────────────────────────────────────────────────────────────

local function make_session(opts)
  opts = opts or {}
  local versions = {}
  return {
    has = function(_)
      return opts.has ~= false
    end,
    next_version = function(bufnr)
      versions[bufnr] = (versions[bufnr] or 0) + 1
      return versions[bufnr]
    end,
    _versions = versions,
  }
end

local function make_config(debounce_ms, engine)
  return {
    get = function()
      return { debounce_ms = debounce_ms or 200, engine = engine or "dot" }
    end,
  }
end

local function make_server()
  local sent = {}
  return {
    send = function(msg)
      table.insert(sent, msg)
    end,
    _sent = sent,
  }
end

-- Count how many times the augroup for `bufnr` was deleted on the stub.
local function deleted_count(vim_stub, bufnr)
  local count = 0
  for _, name in ipairs(vim_stub._augroups_deleted) do
    if name == "InteractiveGraphvizRender" .. bufnr then
      count = count + 1
    end
  end
  return count
end

local function load_render(vim_stub, session_stub, config_stub, server_stub)
  _G.vim = vim_stub
  package.loaded["interactive-graphviz.session"] = session_stub
  package.loaded["interactive-graphviz.config"] = config_stub
  package.loaded["interactive-graphviz.server"] = server_stub
  package.loaded["interactive-graphviz.render"] = nil
  return require("interactive-graphviz.render")
end

-- ── tests ─────────────────────────────────────────────────────────────────────

describe("render.start_watch", function()
  after_each(function()
    package.loaded["interactive-graphviz.render"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    _G.vim = nil
  end)

  it("registers TextChanged and TextChangedI autocmds on the target buffer", function()
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(), make_server())

    render.start_watch(7)

    local ac = vim_stub._autocmds_created
    assert.are.equal(1, #ac, "exactly one autocmd created")
    assert.is_true(
      ac[1].events[1] == "TextChanged" or ac[1].events[2] == "TextChanged",
      "TextChanged event registered"
    )
    assert.is_true(
      ac[1].events[1] == "TextChangedI" or ac[1].events[2] == "TextChangedI",
      "TextChangedI event registered"
    )
    assert.are.equal(7, ac[1].buffer, "autocmd scoped to the correct buffer")
  end)

  it("uses augroup name InteractiveGraphvizRender{bufnr}", function()
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(), make_server())

    render.start_watch(42)

    local ac = vim_stub._autocmds_created
    assert.are.equal("InteractiveGraphvizRender42", ac[1].group)
  end)

  it(
    "is idempotent: calling twice on the same buffer creates two autocmds (group cleared)",
    function()
      local vim_stub = make_vim()
      local render = load_render(vim_stub, make_session(), make_config(), make_server())

      render.start_watch(3)
      render.start_watch(3) -- second call with clear=true recreates the group

      assert.are.equal(2, #vim_stub._autocmds_created)
    end
  )
end)

describe("render.stop_watch", function()
  after_each(function()
    package.loaded["interactive-graphviz.render"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    _G.vim = nil
  end)

  it("cancels the active timer for the buffer", function()
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(), make_server())

    render.start_watch(5)
    -- Trigger the autocmd callback to create a debounce timer.
    local autocmd_cb = vim_stub._autocmds_created[1].callback
    autocmd_cb()

    assert.are.equal(1, #vim_stub._timers_created, "timer created by debounce")
    local timer = vim_stub._timers_created[1]

    render.stop_watch(5)

    assert.is_true(timer.stopped, "timer was stopped")
    assert.is_true(timer.closed, "timer was closed")
  end)

  it("removes the augroup for the buffer", function()
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(), make_server())

    render.stop_watch(99)

    assert.are.equal(1, #vim_stub._augroups_deleted)
    assert.are.equal("InteractiveGraphvizRender99", vim_stub._augroups_deleted[1])
  end)
end)

describe("render debounce callback", function()
  after_each(function()
    package.loaded["interactive-graphviz.render"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    _G.vim = nil
  end)

  it("uses debounce_ms from config", function()
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(500), make_server())

    render.start_watch(1)
    vim_stub._autocmds_created[1].callback()

    local timer = vim_stub._timers_created[1]
    assert.are.equal(500, timer.delay)
  end)

  it("sends render envelope with correct shape when timer fires", function()
    local vim_stub = make_vim({ buf_lines = { "digraph G { a -> b }" } })
    local session_stub = make_session()
    local server_stub = make_server()
    local render = load_render(vim_stub, session_stub, make_config(200, "dot"), server_stub)

    render.start_watch(3)
    vim_stub._autocmds_created[1].callback() -- trigger debounce
    vim_stub._timers_created[1]:fire() -- fire timer synchronously

    assert.are.equal(1, #server_stub._sent)
    local msg = server_stub._sent[1]
    assert.are.equal("render", msg.type)
    assert.are.equal(3, msg.sessionId)
    assert.are.equal(1, msg.v)
    assert.are.equal("dot", msg.engine)
    assert.are.equal("digraph G { a -> b }", msg.dot)
  end)

  it("latest-wins: rapid calls cancel the previous timer", function()
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(), make_server())

    render.start_watch(4)
    local cb = vim_stub._autocmds_created[1].callback

    cb() -- first TextChanged → creates timer A
    local timer_a = vim_stub._timers_created[1]
    cb() -- second TextChanged → cancels timer A, creates timer B

    assert.are.equal(2, #vim_stub._timers_created, "two timers created")
    assert.is_true(timer_a.stopped, "timer A was cancelled")
    assert.is_true(timer_a.closed, "timer A was closed")

    local timer_b = vim_stub._timers_created[2]
    assert.is_false(timer_b.stopped, "timer B still active")
  end)

  it("does not send render if buffer is invalid when timer fires", function()
    local vim_stub = make_vim({ buf_valid = false })
    local server_stub = make_server()
    local render = load_render(vim_stub, make_session(), make_config(), server_stub)

    render.start_watch(6)
    vim_stub._autocmds_created[1].callback()
    vim_stub._timers_created[1]:fire()

    assert.are.equal(0, #server_stub._sent, "no render sent for invalid buffer")
  end)

  it("does not send render if session is not active", function()
    local vim_stub = make_vim()
    local server_stub = make_server()
    local render = load_render(vim_stub, make_session({ has = false }), make_config(), server_stub)

    render.start_watch(8)
    vim_stub._autocmds_created[1].callback()
    vim_stub._timers_created[1]:fire()

    assert.are.equal(0, #server_stub._sent, "no render sent for inactive session")
  end)
end)

describe("render.stop_all", function()
  after_each(function()
    package.loaded["interactive-graphviz.render"] = nil
    package.loaded["interactive-graphviz.session"] = nil
    package.loaded["interactive-graphviz.config"] = nil
    package.loaded["interactive-graphviz.server"] = nil
    _G.vim = nil
  end)

  it("stops all active timers without skipping any due to iterator mutation", function()
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(), make_server())

    -- Create timers for three different buffers.
    render.start_watch(10)
    render.start_watch(11)
    render.start_watch(12)
    -- Trigger debounce for each to create live timers.
    vim_stub._autocmds_created[1].callback()
    vim_stub._autocmds_created[2].callback()
    vim_stub._autocmds_created[3].callback()

    assert.are.equal(3, #vim_stub._timers_created, "three timers created")

    render.stop_all()

    for i, timer in ipairs(vim_stub._timers_created) do
      assert.is_true(timer.stopped, "timer " .. i .. " was stopped")
      assert.is_true(timer.closed, "timer " .. i .. " was closed")
    end
    -- Augroup teardown must accompany timer teardown (the blind spot that let
    -- the steady-state leak ship: earlier versions asserted timers only).
    for _, bufnr in ipairs({ 10, 11, 12 }) do
      assert.are.equal(
        1,
        deleted_count(vim_stub, bufnr),
        "augroup for buffer " .. bufnr .. " was deleted exactly once"
      )
    end
  end)

  it("deletes the augroup of a watched buffer that was never edited (no timer)", function()
    -- case-0 anchor regression: open/read/quit — no TextChanged ever fires,
    -- so no timer exists and a timers-only stop_all skips the buffer entirely.
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(), make_server())

    render.start_watch(20)
    render.stop_all()

    assert.are.equal(1, deleted_count(vim_stub, 20), "augroup deleted for never-edited buffer")
  end)

  it("does not re-stop a buffer already stopped via stop_watch", function()
    -- clear-side pin: stop_watch must clear the registry entry, otherwise
    -- stop_all would delete the augroup a second time.
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(), make_server())

    render.start_watch(21)
    render.stop_watch(21)
    render.stop_all()

    assert.are.equal(1, deleted_count(vim_stub, 21), "augroup deleted exactly once (by stop_watch)")
  end)

  it("deletes the augroup of a buffer whose debounce timer already fired", function()
    -- Steady-state teardown (the bug): the fired callback nils timers[bufnr]
    -- (render.lua real code runs under the stub's :fire()), so a timers-only
    -- stop_all leaves the augroup alive.
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(), make_server())

    render.start_watch(22)
    vim_stub._autocmds_created[1].callback() -- arm debounce
    vim_stub._timers_created[1]:fire() -- fire → render.lua nils timers[22]

    render.stop_all()

    assert.are.equal(1, deleted_count(vim_stub, 22), "augroup deleted after steady-state fire")
    -- Prove the fired timer really left the timers map: the fire itself
    -- stopped+closed the handle once; stop_all must not touch it again
    -- (re-closing a closed uv handle errors in real libuv).
    local timer = vim_stub._timers_created[1]
    assert.are.equal(1, timer.stop_count, "fired timer not re-stopped by stop_all")
    assert.are.equal(1, timer.close_count, "fired timer not re-closed by stop_all")
  end)

  it("mixed population: fired buffer and pending buffer both torn down", function()
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(), make_server())

    render.start_watch(30) -- buf A: steady-state (timer fired)
    render.start_watch(31) -- buf B: pending timer
    vim_stub._autocmds_created[1].callback()
    vim_stub._timers_created[1]:fire() -- A's timer fires, timers[30] nil'd
    vim_stub._autocmds_created[2].callback() -- B's timer stays armed

    render.stop_all()

    assert.are.equal(1, deleted_count(vim_stub, 30), "augroup deleted for fired buffer A")
    assert.are.equal(1, deleted_count(vim_stub, 31), "augroup deleted for pending buffer B")
    local timer_b = vim_stub._timers_created[2]
    assert.is_true(timer_b.stopped, "B's pending timer was stopped")
    assert.is_true(timer_b.closed, "B's pending timer was closed")
  end)

  it("re-watching the same buffer leaves one registry entry: one deletion at stop_all", function()
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(), make_server())

    render.start_watch(23)
    render.start_watch(23) -- idempotent re-watch (augroup recreated, set entry unchanged)
    render.stop_all()

    assert.are.equal(1, deleted_count(vim_stub, 23), "augroup deleted once despite double watch")
  end)

  it("is a no-op on a fresh module with nothing watched", function()
    local vim_stub = make_vim()
    local render = load_render(vim_stub, make_session(), make_config(), make_server())

    assert.has_no.errors(function()
      render.stop_all()
    end)
    assert.are.equal(0, #vim_stub._augroups_deleted, "no augroups deleted")
  end)
end)
