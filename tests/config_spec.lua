-- Unit tests for config.lua: validation, defaults, expose_to_lan security invariant.
-- Designed to run under plain busted (no Neovim) as well as nvim+busted.
-- All vim APIs and plugin modules are stubbed via _G.vim + package.loaded injection.
package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path

-- ── vim stub ──────────────────────────────────────────────────────────────────

_G.vim = {
  tbl_deep_extend = function(mode, base, override)
    -- mode="force": override wins; shallow merge sufficient for flat defaults.
    local result = {}
    for k, v in pairs(base) do
      result[k] = v
    end
    for k, v in pairs(override or {}) do
      result[k] = v
    end
    return result
  end,
  deepcopy = function(t)
    -- Shallow copy is sufficient for the flat defaults table.
    if type(t) ~= "table" then
      return t
    end
    local copy = {}
    for k, v in pairs(t) do
      copy[k] = v
    end
    return copy
  end,
  log = { levels = { WARN = 3, ERROR = 4, INFO = 2, DEBUG = 0 } },
}

-- ── log stub ─────────────────────────────────────────────────────────────────

local warn_calls = {}

local log_stub = {
  warn = function(msg)
    table.insert(warn_calls, msg)
  end,
  error = function(_) end,
  info = function(_) end,
  debug = function(_) end,
  notify = function(_) end,
}

-- Pre-inject log stub so config.lua's `require("interactive-graphviz.log")` gets it.
package.loaded["interactive-graphviz.log"] = log_stub

-- Force-reload config on each test suite run (clear module cache).
package.loaded["interactive-graphviz.config"] = nil

local config = require("interactive-graphviz.config")

-- Helper: reset warn_calls and reload config between test groups.
local function reset()
  warn_calls = {}
  -- Reset log stub reference (it may have been re-injected).
  log_stub.warn = function(msg)
    table.insert(warn_calls, msg)
  end
  package.loaded["interactive-graphviz.log"] = log_stub
  -- Re-load config module to reset M.options to defaults.
  package.loaded["interactive-graphviz.config"] = nil
  config = require("interactive-graphviz.config")
end

-- ── test suite ────────────────────────────────────────────────────────────────

describe("config.setup — zero-config defaults", function()
  before_each(reset)

  it("M.setup() with no args returns all defaults with correct types", function()
    local opts = config.setup()
    assert.are.equal("dot", opts.engine)
    assert.are.equal("table", type(opts.engines))
    assert.are.equal(200, opts.debounce_ms)
    assert.are.equal("127.0.0.1", opts.bind)
    assert.are.equal(0, opts.port)
    assert.are.equal(false, opts.expose_to_lan)
    assert.is_nil(opts.open_cmd)
    assert.are.equal(true, opts.preserve_view)
    assert.are.equal("bidirectional", opts.highlight_mode)
    assert.are.equal(true, opts.animate)
    assert.are.equal("table", type(opts.search))
    assert.are.equal("both", opts.search.scope)
    assert.are.equal(false, opts.search.case_sensitive)
    assert.are.equal(false, opts.search.regex)
    assert.are.equal(2000, opts.heartbeat_ms)
    assert.are.equal("warn", opts.log_level)
    assert.are.equal(0, #warn_calls, "no warnings on zero-config setup")
  end)

  it("M.setup({}) behaves identically to M.setup()", function()
    local opts = config.setup({})
    assert.are.equal("dot", opts.engine)
    assert.are.equal(200, opts.debounce_ms)
    assert.are.equal("127.0.0.1", opts.bind)
    assert.are.equal(0, opts.port)
    assert.are.equal(false, opts.expose_to_lan)
    assert.is_nil(opts.open_cmd)
    assert.are.equal(true, opts.preserve_view)
    assert.are.equal(2000, opts.heartbeat_ms)
    assert.are.equal("warn", opts.log_level)
    assert.are.equal(0, #warn_calls, "no warnings on empty-table setup")
  end)

  it("M.get() returns the current options after setup", function()
    config.setup({ debounce_ms = 300 })
    local opts = config.get()
    assert.are.equal(300, opts.debounce_ms)
    assert.are.equal("dot", opts.engine)
  end)
end)

describe("config.setup — valid overrides", function()
  before_each(reset)

  it("M.setup({ engine = 'neato' }) sets engine to 'neato'", function()
    local opts = config.setup({ engine = "neato" })
    assert.are.equal("neato", opts.engine)
    assert.are.equal(0, #warn_calls, "no warnings for valid engine")
  end)

  it("second call to M.setup overwrites the first (last-wins)", function()
    config.setup({ debounce_ms = 500 })
    local opts = config.setup({ debounce_ms = 750 })
    assert.are.equal(750, opts.debounce_ms)
    assert.are.equal(750, config.get().debounce_ms)
  end)
end)

describe("config.setup — invalid engine", function()
  before_each(reset)

  it("M.setup({ engine = 'invalid' }) resets engine to 'dot' and logs a warning", function()
    local opts = config.setup({ engine = "invalid" })
    assert.are.equal("dot", opts.engine)
    assert.are.equal(1, #warn_calls, "exactly one warning emitted")
    assert.truthy(warn_calls[1]:find("engine", 1, true), "warning message mentions 'engine'")
    assert.truthy(warn_calls[1]:find("invalid", 1, true), "warning message mentions the bad value")
  end)
end)

describe("config.setup — invalid debounce_ms", function()
  before_each(reset)

  it("M.setup({ debounce_ms = -1 }) resets debounce_ms to 200 and logs a warning", function()
    local opts = config.setup({ debounce_ms = -1 })
    assert.are.equal(200, opts.debounce_ms)
    assert.are.equal(1, #warn_calls, "exactly one warning emitted")
    assert.truthy(
      warn_calls[1]:find("debounce_ms", 1, true),
      "warning message mentions 'debounce_ms'"
    )
  end)

  it("M.setup({ debounce_ms = 0 }) resets debounce_ms to 200 and logs a warning", function()
    local opts = config.setup({ debounce_ms = 0 })
    assert.are.equal(200, opts.debounce_ms)
    assert.are.equal(1, #warn_calls)
  end)
end)

describe("config.setup — invalid log_level", function()
  before_each(reset)

  it("M.setup({ log_level = 'verbose' }) resets to 'warn' and logs a warning", function()
    local opts = config.setup({ log_level = "verbose" })
    assert.are.equal("warn", opts.log_level)
    assert.are.equal(1, #warn_calls, "exactly one warning emitted")
    assert.truthy(warn_calls[1]:find("log_level", 1, true), "warning message mentions 'log_level'")
    assert.truthy(warn_calls[1]:find("verbose", 1, true), "warning message mentions the bad value")
  end)

  it("all valid log_level values are accepted without warning", function()
    for _, level in ipairs({ "off", "error", "warn", "info", "debug" }) do
      reset()
      local opts = config.setup({ log_level = level })
      assert.are.equal(level, opts.log_level)
      assert.are.equal(0, #warn_calls, "no warning for valid log_level: " .. level)
    end
  end)
end)

describe("config.setup — expose_to_lan security invariant", function()
  before_each(reset)

  it("M.setup({ expose_to_lan = true }) sets bind to '0.0.0.0'", function()
    local opts = config.setup({ expose_to_lan = true })
    assert.are.equal("0.0.0.0", opts.bind)
    assert.are.equal(0, #warn_calls, "no warnings for valid expose_to_lan=true")
  end)

  it("M.setup({ expose_to_lan = false }) keeps bind at '127.0.0.1'", function()
    local opts = config.setup({ expose_to_lan = false })
    assert.are.equal("127.0.0.1", opts.bind)
    assert.are.equal(0, #warn_calls)
  end)

  it(
    "M.setup({ expose_to_lan = false, bind = '10.0.0.1' }) ignores explicit bind (security invariant)",
    function()
      local opts = config.setup({ expose_to_lan = false, bind = "10.0.0.1" })
      assert.are.equal(
        "127.0.0.1",
        opts.bind,
        "bind must always be loopback when expose_to_lan=false"
      )
      assert.are.equal(
        0,
        #warn_calls,
        "no warning — bind override is silent by design (security invariant)"
      )
    end
  )

  it("M.setup({ expose_to_lan = true, bind = '127.0.0.1' }) overrides bind to '0.0.0.0'", function()
    local opts = config.setup({ expose_to_lan = true, bind = "127.0.0.1" })
    assert.are.equal("0.0.0.0", opts.bind, "expose_to_lan=true always wins")
  end)

  it(
    "M.setup({ expose_to_lan = 1 }) resets to false and logs a warning (AC2: non-boolean)",
    function()
      local opts = config.setup({ expose_to_lan = 1 })
      assert.are.equal(false, opts.expose_to_lan)
      assert.are.equal("127.0.0.1", opts.bind, "invalid expose_to_lan resets to default (loopback)")
      assert.are.equal(1, #warn_calls, "warning emitted for non-boolean expose_to_lan")
      assert.truthy(warn_calls[1]:find("expose_to_lan", 1, true))
    end
  )
end)

describe("config.setup — port validation", function()
  before_each(reset)

  it("port = 0 (ephemeral) is valid", function()
    local opts = config.setup({ port = 0 })
    assert.are.equal(0, opts.port)
    assert.are.equal(0, #warn_calls)
  end)

  it("port = 3000 is valid", function()
    local opts = config.setup({ port = 3000 })
    assert.are.equal(3000, opts.port)
    assert.are.equal(0, #warn_calls)
  end)

  it("port = 65535 is valid (max)", function()
    local opts = config.setup({ port = 65535 })
    assert.are.equal(65535, opts.port)
    assert.are.equal(0, #warn_calls)
  end)

  it("port = -1 resets to 0 and logs a warning", function()
    local opts = config.setup({ port = -1 })
    assert.are.equal(0, opts.port)
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("port", 1, true))
  end)

  it("port = 99999 (out of range) resets to 0 and logs a warning", function()
    local opts = config.setup({ port = 99999 })
    assert.are.equal(0, opts.port)
    assert.are.equal(1, #warn_calls)
  end)
end)

describe("config.setup — engines validation", function()
  before_each(reset)

  it("custom engines list is accepted when valid", function()
    local opts = config.setup({ engines = { "dot", "neato", "fdp" }, engine = "fdp" })
    assert.are.equal(3, #opts.engines)
    assert.are.equal("fdp", opts.engine)
    assert.are.equal(0, #warn_calls)
  end)

  it("empty engines table resets to default and logs a warning", function()
    local opts = config.setup({ engines = {} })
    assert.are.equal(2, #opts.engines, "default engines restored")
    assert.are.equal("dot", opts.engines[1])
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("engines", 1, true))
  end)
end)

describe("config.set_engine", function()
  before_each(reset)

  it("accepts a valid runtime engine switch", function()
    config.setup()

    local ok, msg = config.set_engine("neato")

    assert.are.equal(true, ok)
    assert.is_nil(msg)
    assert.are.equal("neato", config.get().engine)
    assert.are.equal(0, #warn_calls, "runtime setter must not emit setup warnings")
  end)

  it("rejects an invalid runtime engine without mutating current engine", function()
    config.setup({ engine = "neato" })

    local ok, msg = config.set_engine("fdp")

    assert.are.equal(false, ok)
    assert.truthy(msg:find("unknown engine 'fdp'", 1, true))
    assert.truthy(msg:find("dot, neato", 1, true))
    assert.are.equal("neato", config.get().engine)
    assert.are.equal(0, #warn_calls, "runtime rejection must not emit setup warnings")
  end)

  it("uses the custom engines allowlist from setup", function()
    config.setup({ engines = { "dot", "neato", "fdp" } })

    local ok = config.set_engine("fdp")

    assert.are.equal(true, ok)
    assert.are.equal("fdp", config.get().engine)
  end)

  it("does not fall back to default after invalid runtime input", function()
    config.setup({ engines = { "dot", "neato", "fdp" }, engine = "fdp" })

    local ok = config.set_engine("bad")

    assert.are.equal(false, ok)
    assert.are.equal("fdp", config.get().engine)
  end)
end)

describe("config.setup — preserve_view validation", function()
  before_each(reset)

  it("preserve_view = false is valid", function()
    local opts = config.setup({ preserve_view = false })
    assert.are.equal(false, opts.preserve_view)
    assert.are.equal(0, #warn_calls)
  end)

  it("preserve_view = 'yes' resets to true and logs a warning", function()
    local opts = config.setup({ preserve_view = "yes" })
    assert.are.equal(true, opts.preserve_view)
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("preserve_view", 1, true))
  end)
end)

describe("config.setup — highlight_mode validation", function()
  before_each(reset)

  it("all valid highlight_mode values are accepted without warning", function()
    for _, mode in ipairs({ "single", "upstream", "downstream", "bidirectional" }) do
      reset()
      local opts = config.setup({ highlight_mode = mode })
      assert.are.equal(mode, opts.highlight_mode)
      assert.are.equal(0, #warn_calls, "no warning for valid highlight_mode: " .. mode)
    end
  end)

  it("highlight_mode = 'sideways' resets to 'bidirectional' and logs a warning", function()
    local opts = config.setup({ highlight_mode = "sideways" })
    assert.are.equal("bidirectional", opts.highlight_mode)
    assert.are.equal(1, #warn_calls, "exactly one warning emitted")
    assert.truthy(
      warn_calls[1]:find("highlight_mode", 1, true),
      "warning message mentions 'highlight_mode'"
    )
    assert.truthy(warn_calls[1]:find("sideways", 1, true), "warning message mentions the bad value")
    assert.truthy(
      warn_calls[1]:find("single, upstream, downstream, bidirectional", 1, true),
      "warning message names the allowed values"
    )
  end)

  it("highlight_mode = 42 (non-string) resets to 'bidirectional' and logs a warning", function()
    local opts = config.setup({ highlight_mode = 42 })
    assert.are.equal("bidirectional", opts.highlight_mode)
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("highlight_mode", 1, true))
  end)
end)

describe("config.setup — animate validation", function()
  before_each(reset)

  it("animate = false is valid", function()
    local opts = config.setup({ animate = false })
    assert.are.equal(false, opts.animate)
    assert.are.equal(0, #warn_calls)
  end)

  it("animate = 'yes' resets to true and logs a warning", function()
    local opts = config.setup({ animate = "yes" })
    assert.are.equal(true, opts.animate)
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("animate", 1, true), "warning message mentions 'animate'")
  end)
end)

describe("config.setup — search validation", function()
  before_each(reset)

  it("a full valid search table is accepted without warning", function()
    local opts = config.setup({
      search = { scope = "edges", case_sensitive = true, regex = true },
    })
    assert.are.equal("edges", opts.search.scope)
    assert.are.equal(true, opts.search.case_sensitive)
    assert.are.equal(true, opts.search.regex)
    assert.are.equal(0, #warn_calls)
  end)

  it("a partial search table keeps defaults for unset subfields", function()
    local opts = config.setup({ search = { scope = "nodes", case_sensitive = true } })
    assert.are.equal("nodes", opts.search.scope)
    assert.are.equal(true, opts.search.case_sensitive)
    assert.are.equal(false, opts.search.regex, "unset regex keeps the default")
    assert.are.equal(0, #warn_calls, "no warning for a valid partial search table")
  end)

  it("all valid search.scope values are accepted without warning", function()
    for _, scope in ipairs({ "both", "nodes", "edges" }) do
      reset()
      local opts = config.setup({ search = { scope = scope } })
      assert.are.equal(scope, opts.search.scope)
      assert.are.equal(0, #warn_calls, "no warning for valid search.scope: " .. scope)
    end
  end)

  it("search = 'nodes' (non-table) resets to defaults and logs a warning", function()
    local opts = config.setup({ search = "nodes" })
    assert.are.equal("both", opts.search.scope)
    assert.are.equal(false, opts.search.case_sensitive)
    assert.are.equal(false, opts.search.regex)
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("search", 1, true), "warning message mentions 'search'")
  end)

  it("search.scope = 'everything' resets to 'both' and logs a warning", function()
    local opts = config.setup({ search = { scope = "everything" } })
    assert.are.equal("both", opts.search.scope)
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("search.scope", 1, true))
    assert.truthy(warn_calls[1]:find("everything", 1, true), "warning mentions the bad value")
    assert.truthy(
      warn_calls[1]:find("both, nodes, edges", 1, true),
      "warning message names the allowed values"
    )
  end)

  it("search.case_sensitive = 1 (non-boolean) resets to false and logs a warning", function()
    local opts = config.setup({ search = { case_sensitive = 1 } })
    assert.are.equal(false, opts.search.case_sensitive)
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("search.case_sensitive", 1, true))
  end)

  it("search.regex = 'on' (non-boolean) resets to false and logs a warning", function()
    local opts = config.setup({ search = { regex = "on" } })
    assert.are.equal(false, opts.search.regex)
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("search.regex", 1, true))
  end)

  it("an invalid subfield only resets that subfield (others kept)", function()
    local opts = config.setup({
      search = { scope = "nodes", case_sensitive = true, regex = "bad" },
    })
    assert.are.equal("nodes", opts.search.scope)
    assert.are.equal(true, opts.search.case_sensitive)
    assert.are.equal(false, opts.search.regex)
    assert.are.equal(1, #warn_calls, "exactly one warning (for regex only)")
  end)
end)

describe("config.setup — sync validation (Story 6.2)", function()
  before_each(reset)

  it("defaults to sync.jump_on_click = true with no warning", function()
    local opts = config.setup()
    assert.are.equal(true, opts.sync.jump_on_click)
    assert.are.equal(0, #warn_calls)
  end)

  it("defaults to highlight_on_cursor = true and cursor_debounce_ms = 150 (Story 6.3)", function()
    local opts = config.setup()
    assert.are.equal(true, opts.sync.highlight_on_cursor)
    assert.are.equal(150, opts.sync.cursor_debounce_ms)
    assert.are.equal(0, #warn_calls)
  end)

  it("sync.highlight_on_cursor = false and cursor_debounce_ms = 300 are valid", function()
    local opts = config.setup({ sync = { highlight_on_cursor = false, cursor_debounce_ms = 300 } })
    assert.are.equal(false, opts.sync.highlight_on_cursor)
    assert.are.equal(300, opts.sync.cursor_debounce_ms)
    assert.are.equal(true, opts.sync.jump_on_click, "unset subfield keeps its default")
    assert.are.equal(0, #warn_calls)
  end)

  it("sync.highlight_on_cursor = 'yes' (non-boolean) resets to true and warns", function()
    local opts = config.setup({ sync = { highlight_on_cursor = "yes" } })
    assert.are.equal(true, opts.sync.highlight_on_cursor)
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("sync.highlight_on_cursor", 1, true))
  end)

  it("sync.cursor_debounce_ms invalid values (0, -1, 1.5, 'fast') reset to 150 and warn", function()
    for _, bad in ipairs({ 0, -1, 1.5, "fast" }) do
      reset()
      local opts = config.setup({ sync = { cursor_debounce_ms = bad } })
      assert.are.equal(150, opts.sync.cursor_debounce_ms, "reset for " .. tostring(bad))
      assert.are.equal(1, #warn_calls, "one warning for " .. tostring(bad))
      assert.truthy(warn_calls[1]:find("sync.cursor_debounce_ms", 1, true))
    end
  end)

  it("sync = 'on' (non-table) resets ALL sync keys to defaults", function()
    local opts = config.setup({ sync = "on" })
    assert.are.equal(true, opts.sync.highlight_on_cursor)
    assert.are.equal(150, opts.sync.cursor_debounce_ms)
  end)

  it("sync.jump_on_click = false is valid", function()
    local opts = config.setup({ sync = { jump_on_click = false } })
    assert.are.equal(false, opts.sync.jump_on_click)
    assert.are.equal(0, #warn_calls)
  end)

  it("sync.jump_on_click = 'yes' (non-boolean) resets to true and logs a warning", function()
    local opts = config.setup({ sync = { jump_on_click = "yes" } })
    assert.are.equal(true, opts.sync.jump_on_click)
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("sync.jump_on_click", 1, true))
  end)

  it("sync = 'on' (non-table) resets to defaults and logs a warning", function()
    local opts = config.setup({ sync = "on" })
    assert.are.equal(true, opts.sync.jump_on_click)
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("sync", 1, true))
  end)

  it("validation never mutates the caller-owned sync table", function()
    local user_sync = { jump_on_click = false }
    config.setup({ sync = user_sync })
    assert.are.equal(false, user_sync.jump_on_click)
    assert.are.equal(
      1,
      (function()
        local n = 0
        for _ in pairs(user_sync) do
          n = n + 1
        end
        return n
      end)(),
      "caller table gains no keys"
    )
  end)
end)

describe("config.setup — open_cmd validation", function()
  before_each(reset)

  it("open_cmd = nil is valid (default)", function()
    local opts = config.setup({ open_cmd = nil })
    assert.is_nil(opts.open_cmd)
    assert.are.equal(0, #warn_calls)
  end)

  it("open_cmd = 'xdg-open' is valid", function()
    local opts = config.setup({ open_cmd = "xdg-open" })
    assert.are.equal("xdg-open", opts.open_cmd)
    assert.are.equal(0, #warn_calls)
  end)

  it("open_cmd = '' (empty string) resets to nil and logs a warning", function()
    local opts = config.setup({ open_cmd = "" })
    assert.is_nil(opts.open_cmd)
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("open_cmd", 1, true))
  end)
end)
