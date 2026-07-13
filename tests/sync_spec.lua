-- Unit tests for sync.lua (Stories 6.2 + 6.3): the node→line matcher, the
-- handle_node_click cursor-jump behavior, the line→node reverse matcher, the
-- debounced cursor watcher, and the echo suppression. Designed to run under
-- plain busted (no Neovim): vim APIs and the plugin modules are stubbed via
-- _G.vim + package.loaded injection, exactly like config_spec.lua.
package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path

-- ── stubs ─────────────────────────────────────────────────────────────────────

local notify_calls = {}
local cursor_calls = {}
local warn_calls = {}
local timers_created = {}
local autocmds_created = {}
local augroups_deleted = {}
local sent_msgs = {}

-- vim.NIL sentinel: a unique table standing in for the real userdata.
local NIL_SENTINEL = setmetatable({}, {
  __tostring = function()
    return "vim.NIL"
  end,
})

-- Controllable timer stub: start() captures the callback (fire() runs it),
-- mirroring render_spec.lua's harness.
local function make_timer()
  local t = { started = false, stopped = false, closed = false, delay = nil, callback = nil }
  t.start = function(self, delay, _, fn)
    self.started = true
    self.delay = delay
    self.callback = fn
  end
  t.stop = function(self)
    self.stopped = true
  end
  t.close = function(self)
    self.closed = true
  end
  t.fire = function(self)
    if self.callback then
      self.callback()
    end
  end
  return t
end

-- Mutable per-test state driving the vim stub.
local state = {
  valid_bufs = {}, -- bufnr → true
  buf_lines = {}, -- bufnr → lines
  windows = {}, -- bufnr → { winid, ... }
  win_tabs = {}, -- winid → tabpage handle (default 1)
  win_bufs = {}, -- winid → bufnr (for nvim_win_get_buf)
  win_cursor = {}, -- winid → {lnum, col0} (for nvim_win_get_cursor)
  current_tab = 1,
  current_win = 0, -- default: matches no window
  set_cursor_error = false, -- force nvim_win_set_cursor to throw
  session_has = {}, -- bufnr → false to deny (default: has)
  session_error = false, -- force session.has to throw (pcall-symmetry tests)
  sync_cfg = nil, -- config.get().sync override for watcher tests
}

_G.vim = {
  log = { levels = { WARN = 3, ERROR = 4, INFO = 2, DEBUG = 0 } },
  NIL = NIL_SENTINEL,
  api = {
    nvim_buf_is_valid = function(bufnr)
      return state.valid_bufs[bufnr] == true
    end,
    nvim_buf_get_lines = function(bufnr, _, _, _)
      return state.buf_lines[bufnr] or {}
    end,
    nvim_get_current_tabpage = function()
      return state.current_tab
    end,
    nvim_win_get_tabpage = function(winid)
      return state.win_tabs[winid] or 1
    end,
    nvim_get_current_win = function()
      return state.current_win
    end,
    nvim_win_get_buf = function(winid)
      return state.win_bufs[winid] or -1
    end,
    nvim_win_get_cursor = function(winid)
      return state.win_cursor[winid] or { 1, 0 }
    end,
    nvim_win_set_cursor = function(winid, pos)
      if state.set_cursor_error then
        error("E5555: window was closed")
      end
      table.insert(cursor_calls, { winid = winid, pos = pos })
      state.win_cursor[winid] = { pos[1], pos[2] }
    end,
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
  },
  fn = {
    win_findbuf = function(bufnr)
      return state.windows[bufnr] or {}
    end,
  },
  uv = {
    new_timer = function()
      local t = make_timer()
      table.insert(timers_created, t)
      return t
    end,
  },
  schedule = function(fn)
    fn() -- synchronous in tests
  end,
}

local log_stub = {
  notify = function(msg, level)
    table.insert(notify_calls, { msg = msg, level = level })
  end,
  warn = function(msg)
    table.insert(warn_calls, msg)
  end,
  error = function(_) end,
  info = function(_) end,
  debug = function(_) end,
}
package.loaded["interactive-graphviz.log"] = log_stub

-- Story 6.3 collaborators, required lazily by the watcher path.
package.loaded["interactive-graphviz.session"] = {
  has = function(bufnr)
    if state.session_error then
      error("session exploded")
    end
    return state.session_has[bufnr] ~= false
  end,
}
package.loaded["interactive-graphviz.config"] = {
  get = function()
    return {
      sync = state.sync_cfg
        or { jump_on_click = true, highlight_on_cursor = true, cursor_debounce_ms = 150 },
    }
  end,
}
package.loaded["interactive-graphviz.server"] = {
  send = function(msg)
    table.insert(sent_msgs, msg)
    return true
  end,
}

package.loaded["interactive-graphviz.sync"] = nil
local sync = require("interactive-graphviz.sync")

local function reset()
  sync.stop_all() -- drain per-buffer state (timers, last_sent, suppress) first
  notify_calls = {}
  cursor_calls = {}
  warn_calls = {}
  timers_created = {}
  autocmds_created = {}
  augroups_deleted = {}
  sent_msgs = {}
  state.valid_bufs = {}
  state.buf_lines = {}
  state.windows = {}
  state.win_tabs = {}
  state.win_bufs = {}
  state.win_cursor = {}
  state.current_tab = 1
  state.current_win = 0
  state.set_cursor_error = false
  state.session_has = {}
  state.session_error = false
  state.sync_cfg = nil
  log_stub.notify = function(msg, level)
    table.insert(notify_calls, { msg = msg, level = level })
  end
  package.loaded["interactive-graphviz.log"] = log_stub
end

-- ── find_node_line: the pure matcher (AC4) ────────────────────────────────────

describe("sync.find_node_line — bare-ID boundaries", function()
  it("finds a bare node id on its first line", function()
    local lnum, col = sync.find_node_line({ "digraph {", "  a -> b;", "}" }, "a")
    assert.are.equal(2, lnum)
    assert.are.equal(3, col)
  end)

  it("`a` does not match `alpha` (leading position)", function()
    local lnum = sync.find_node_line({ "digraph {", "  alpha -> beta;", "  a -> b;", "}" }, "a")
    assert.are.equal(3, lnum)
  end)

  it("`a` does not match `gamma_a` or `a1` (trailing/underscore boundaries)", function()
    local lnum = sync.find_node_line({ "gamma_a -> a1;", "x -> a;" }, "a")
    assert.are.equal(2, lnum)
  end)

  it("id as an edge ENDPOINT matches (occurrence, not only definition)", function()
    local lnum, col = sync.find_node_line({ "digraph {", "  x -> target;", "}" }, "target")
    assert.are.equal(2, lnum)
    assert.are.equal(8, col)
  end)

  it("a node used with a port suffix matches the node id (node:port)", function()
    local lnum, col = sync.find_node_line({ "digraph {", "  rec:out -> b;", "}" }, "rec")
    assert.are.equal(2, lnum)
    assert.are.equal(3, col)
  end)

  it("multiple occurrences: the FIRST line wins", function()
    local lnum = sync.find_node_line({ "a -> b;", "b -> c;", "a -> c;" }, "a")
    assert.are.equal(1, lnum)
  end)

  it("id at start and end of line matches (no neighbor chars at all)", function()
    assert.are.equal(1, (sync.find_node_line({ "a" }, "a")))
    assert.are.equal(1, (sync.find_node_line({ "b -> a" }, "a")))
  end)
end)

describe("sync.find_node_line — quoted IDs", function()
  it("finds a quoted id with spaces", function()
    local lnum, col = sync.find_node_line({ "digraph {", '  "node one" -> b;', "}" }, "node one")
    assert.are.equal(2, lnum)
    assert.are.equal(3, col) -- column of the opening quote
  end)

  it('unescapes \\" inside a quoted id', function()
    local lnum = sync.find_node_line({ 'digraph { "say \\"hi\\"" -> x; }' }, 'say "hi"')
    assert.are.equal(1, lnum)
  end)

  it("unescapes \\\\ inside a quoted id", function()
    local lnum = sync.find_node_line({ '"back\\\\slash" -> x;' }, "back\\slash")
    assert.are.equal(1, lnum)
  end)

  it("a colon inside a quoted id is part of the ID, not a port", function()
    -- node "a:b" exists; clicking node `a` must NOT land on the quoted line.
    local lnum = sync.find_node_line({ '"a:b" -> c;', "a -> c;" }, "a")
    assert.are.equal(2, lnum)
    -- while clicking node `a:b` matches the quoted line exactly.
    local qlnum = sync.find_node_line({ '"a:b" -> c;', "a -> c;" }, "a:b")
    assert.are.equal(1, qlnum)
  end)

  it("a bare search never matches text inside a quoted string (labels)", function()
    local lnum = sync.find_node_line({ 'x [label="a fine label"];', "a -> x;" }, "a")
    assert.are.equal(2, lnum)
  end)

  it("a node clicked by its plain name also matches its quoted occurrence", function()
    -- DOT treats `a` and `"a"` as the same node; the SVG <title> is `a`.
    local lnum = sync.find_node_line({ 'digraph { "a" -> b; }' }, "a")
    assert.are.equal(1, lnum)
  end)
end)

describe("sync.find_node_line — DOT syntax awareness (review fixes)", function()
  it("a `//` comment never matches — the real definition wins", function()
    assert.are.equal(2, (sync.find_node_line({ "// define node a here", "a -> b;" }, "a")))
    assert.are.equal(2, (sync.find_node_line({ "b -> c; // mentions a", "a -> b;" }, "a")))
  end)

  it("a line-leading `#` (preprocessor) line never matches", function()
    assert.are.equal(2, (sync.find_node_line({ "  # a is important", "a -> b;" }, "a")))
  end)

  it("a mid-line `#` is NOT a comment per the DOT grammar", function()
    -- Only lines BEGINNING with # are preprocessor output; pin that boundary.
    assert.are.equal(1, (sync.find_node_line({ "b -> c; # a", "a -> x;" }, "a")))
  end)

  it("`/* */` block comments never match — same line and spanning lines", function()
    assert.are.equal(2, (sync.find_node_line({ "/* a */ b -> c;", "a -> b;" }, "a")))
    assert.are.equal(
      3,
      (sync.find_node_line({ "/* node a lives", "   here: a */", "a -> b;" }, "a"))
    )
  end)

  it("HTML strings `<...>` never match — inline and spanning lines", function()
    assert.are.equal(2, (sync.find_node_line({ "x [label=<a>];", "a -> b;" }, "a")))
    assert.are.equal(
      4,
      (sync.find_node_line({ "x [label=<", "  <b>a</b>", ">];", "a -> b;" }, "a"))
    )
  end)

  it("high bytes are ID bytes: `a` does not match the prefix of `añejo`", function()
    assert.are.equal(2, (sync.find_node_line({ "  añejo -> x;", "  a -> b;" }, "a")))
    -- and the unicode id itself is matchable bare
    assert.are.equal(1, (sync.find_node_line({ "  añejo -> x;" }, "añejo")))
  end)

  it("a bare-ineligible id (whitespace) only matches its quoted form", function()
    local lnum, col = sync.find_node_line({ "  indented -> x;", '" " -> z;' }, " ")
    assert.are.equal(2, lnum)
    assert.are.equal(1, col)
  end)

  it("numeral ids stay bare-matchable", function()
    assert.are.equal(1, (sync.find_node_line({ "5 -> 3;" }, "5")))
    assert.are.equal(1, (sync.find_node_line({ "x -> 3.14;" }, "3.14")))
  end)
end)

describe("sync.find_node_line — degraded inputs", function()
  it("returns nil when the node is absent (stale-browser path)", function()
    assert.is_nil(sync.find_node_line({ "a -> b;" }, "ghost"))
  end)

  it("returns nil for empty/non-string id and non-table lines", function()
    assert.is_nil(sync.find_node_line({ "a" }, ""))
    assert.is_nil(sync.find_node_line({ "a" }, nil))
    assert.is_nil(sync.find_node_line({ "a" }, 42))
    assert.is_nil(sync.find_node_line(nil, "a"))
  end)

  it("never errors on an unterminated quote", function()
    assert.is_nil(sync.find_node_line({ '"unterminated -> b;' }, "a"))
    assert.are.equal(1, (sync.find_node_line({ '"unterminated -> b;' }, "unterminated -> b;")))
  end)
end)

-- ── handle_node_click: buffer/window validation + cursor move (AC1/AC2) ──────

describe("sync.handle_node_click", function()
  before_each(reset)

  local function displayed_buffer(bufnr, lines)
    state.valid_bufs[bufnr] = true
    state.buf_lines[bufnr] = lines
    state.windows[bufnr] = { 1001 }
  end

  it("moves the cursor in a window displaying the buffer and returns true", function()
    displayed_buffer(3, { "digraph {", "  a -> b;", "}" })

    assert.is_true(sync.handle_node_click(3, "b"))
    assert.are.equal(1, #cursor_calls)
    assert.are.equal(1001, cursor_calls[1].winid)
    assert.are.same({ 2, 7 }, cursor_calls[1].pos) -- 1-based line, 0-based col
    assert.are.equal(0, #notify_calls)
  end)

  it("sync.jump_on_click disabled: does not move the cursor, returns false", function()
    -- Authoritative Lua-side gate: an in-flight click that arrives after
    -- :GraphvizJumpOnClickToggle turned the gate off (config_update to the
    -- browser is async) must be dropped here, silently — the browser, not this
    -- path, is what notifies the user about the toggle.
    displayed_buffer(3, { "digraph {", "  a -> b;", "}" })
    state.sync_cfg = { jump_on_click = false, highlight_on_cursor = true, cursor_debounce_ms = 150 }

    assert.is_false(sync.handle_node_click(3, "b"))
    assert.are.equal(0, #cursor_calls)
    assert.are.equal(0, #notify_calls)
  end)

  it("stale node: notifies, does not move the cursor, returns false (AC2)", function()
    displayed_buffer(3, { "a -> b;" })

    assert.is_false(sync.handle_node_click(3, "ghost"))
    assert.are.equal(0, #cursor_calls)
    assert.are.equal(1, #notify_calls)
    assert.truthy(notify_calls[1].msg:find("ghost", 1, true))
    assert.are.equal(vim.log.levels.INFO, notify_calls[1].level)
  end)

  it("invalid buffer: notifies and returns false without touching APIs", function()
    assert.is_false(sync.handle_node_click(99, "a"))
    assert.are.equal(0, #cursor_calls)
    assert.are.equal(1, #notify_calls)
  end)

  it("buffer not displayed in any window: notifies and returns false", function()
    state.valid_bufs[3] = true
    state.buf_lines[3] = { "a -> b;" }
    state.windows[3] = {}

    assert.is_false(sync.handle_node_click(3, "a"))
    assert.are.equal(0, #cursor_calls)
    assert.are.equal(1, #notify_calls)
  end)

  it("invalid inputs return false silently (server.lua already logged)", function()
    assert.is_false(sync.handle_node_click(nil, "a"))
    assert.is_false(sync.handle_node_click("3", "a"))
    assert.is_false(sync.handle_node_click(3, nil))
    assert.is_false(sync.handle_node_click(3, ""))
    assert.are.equal(0, #notify_calls)
    assert.are.equal(0, #cursor_calls)
  end)

  it("a throwing nvim_win_set_cursor is contained: notify + false, no error", function()
    displayed_buffer(3, { "a -> b;" })
    state.set_cursor_error = true

    assert.is_false(sync.handle_node_click(3, "a"))
    assert.are.equal(1, #notify_calls)
  end)

  it("prefers a window on the CURRENT tabpage over an earlier other-tab window", function()
    state.valid_bufs[3] = true
    state.buf_lines[3] = { "a -> b;" }
    state.windows[3] = { 2001, 1001 } -- other-tab window listed first
    state.win_tabs[2001] = 2
    state.win_tabs[1001] = 1
    state.current_tab = 1

    assert.is_true(sync.handle_node_click(3, "a"))
    assert.are.equal(1001, cursor_calls[1].winid)
    assert.are.equal(0, #notify_calls)
  end)

  it("cross-tab fallback still jumps but says so (no silent no-op)", function()
    state.valid_bufs[3] = true
    state.buf_lines[3] = { "a -> b;" }
    state.windows[3] = { 2001 } -- only displayed on another tab
    state.win_tabs[2001] = 2
    state.current_tab = 1

    assert.is_true(sync.handle_node_click(3, "a"))
    assert.are.equal(2001, cursor_calls[1].winid)
    assert.are.equal(1, #notify_calls)
    assert.truthy(notify_calls[1].msg:find("another tab", 1, true))
  end)
end)

-- ── find_node_at: the line→node reverse matcher (Story 6.3, AC1) ─────────────

describe("sync.find_node_at — cursor-column resolution", function()
  local lines = { "digraph {", "  a -> b;", "}" }

  it("resolves the node under the cursor column", function()
    assert.are.equal("a", sync.find_node_at(lines, 2, 3))
    assert.are.equal("b", sync.find_node_at(lines, 2, 8))
  end)

  it("cursor on whitespace/punctuation falls back to the FIRST node on the line", function()
    assert.are.equal("a", sync.find_node_at(lines, 2, 1)) -- leading indent
    assert.are.equal("a", sync.find_node_at(lines, 2, 5)) -- on the ->
    assert.are.equal("a", sync.find_node_at(lines, 2, 9)) -- on the ;
  end)

  it("a line with no node yields nil", function()
    assert.is_nil(sync.find_node_at(lines, 3, 1)) -- }
    assert.is_nil(sync.find_node_at({ "" }, 1, 1))
    assert.is_nil(sync.find_node_at({ "   " }, 1, 2))
  end)

  it("unquoted DOT keywords are grammar, not nodes (case-insensitive)", function()
    assert.is_nil(sync.find_node_at({ "digraph {" }, 1, 3))
    assert.is_nil(sync.find_node_at({ "Strict Graph {" }, 1, 2))
    -- Documented parity limitation: a graph NAME is still a candidate (same
    -- statement-context blindness as the 6.2 matcher; resolves as a browser miss).
    assert.are.equal("G_", sync.find_node_at({ "strict digraph G_ {" }, 1, 1))
  end)

  it("quoted ids resolve, including spaces, colons, and escapes", function()
    assert.are.equal("node one", sync.find_node_at({ '  "node one" -> b;' }, 1, 5))
    assert.are.equal("a:b", sync.find_node_at({ '"a:b" -> c;' }, 1, 2))
    assert.are.equal('say "hi"', sync.find_node_at({ '"say \\"hi\\"" -> x;' }, 1, 3))
    assert.are.equal(" ", sync.find_node_at({ '" " -> z;' }, 1, 2))
  end)

  it("a quoted node clicked at its quotes resolves to the UNESCAPED id", function()
    assert.are.equal("back\\slash", sync.find_node_at({ '"back\\\\slash" -> x;' }, 1, 1))
  end)

  it("port suffixes never become candidates; the node id does", function()
    assert.are.equal("rec", sync.find_node_at({ "rec:out -> b;" }, 1, 2))
    -- cursor ON the port falls back to the first candidate (rec), not "out"
    assert.are.equal("rec", sync.find_node_at({ "rec:out -> b;" }, 1, 6))
  end)

  it("numerals resolve as one token, including the dotted form", function()
    assert.are.equal("5", sync.find_node_at({ "5 -> 3;" }, 1, 1))
    assert.are.equal("3.14", sync.find_node_at({ "x -> 3.14;" }, 1, 7))
    assert.are.equal("x", sync.find_node_at({ "x -> 3.14;" }, 1, 1))
  end)

  it("unicode ids resolve (high bytes are ID bytes)", function()
    assert.are.equal("añejo", sync.find_node_at({ "  añejo -> x;" }, 1, 4))
  end)

  it("comments never yield candidates — //, line-leading #, /* */ inline", function()
    assert.is_nil(sync.find_node_at({ "// a b c" }, 1, 4))
    assert.is_nil(sync.find_node_at({ "  # a" }, 1, 5))
    assert.are.equal("b", sync.find_node_at({ "/* a */ b -> c;" }, 1, 4)) -- a is dead, b live
    -- cursor INSIDE a trailing comment: the comment text is never a candidate,
    -- but the line still contains nodes → first-candidate fallback (b), not a.
    assert.are.equal("b", sync.find_node_at({ "b -> c; // a" }, 1, 12))
  end)

  it("multi-line block comment state carries from earlier lines", function()
    local buf = { "/* open", "a -> b; */ c;", "a2 -> b2;" }
    -- line 2 col 1 ('a') is INSIDE the block comment; only c is live there
    assert.are.equal("c", sync.find_node_at(buf, 2, 1))
    assert.are.equal("a2", sync.find_node_at(buf, 3, 1))
  end)

  it("multi-line HTML label state carries from earlier lines", function()
    local buf = { "x [label=<", "  <b>a</b>", ">];", "a -> b;" }
    assert.is_nil(sync.find_node_at(buf, 2, 5))
    assert.are.equal("a", sync.find_node_at(buf, 4, 1))
  end)

  it("degraded inputs yield nil, never an error", function()
    assert.is_nil(sync.find_node_at(nil, 1, 1))
    assert.is_nil(sync.find_node_at({ "a" }, 0, 1))
    assert.is_nil(sync.find_node_at({ "a" }, 2, 1))
    assert.is_nil(sync.find_node_at({ "a" }, "1", 1))
    assert.are.equal("a", sync.find_node_at({ "a" }, 1, nil)) -- col defaults to 1
    assert.are.equal("a", sync.find_node_at({ "a" }, 1, -5)) -- col clamps to 1
  end)
end)

-- ── find_emphasis_at: edge lines emphasize edge + both ends ──────────────────

describe("sync.find_emphasis_at — edge-aware cursor resolution", function()
  it("ANY column on an edge line yields the edge key", function()
    local lines = { "digraph {", "  a -> b;", "}" }
    assert.are.equal("a->b", sync.find_emphasis_at(lines, 2, 1)) -- indent
    assert.are.equal("a->b", sync.find_emphasis_at(lines, 2, 3)) -- on a
    assert.are.equal("a->b", sync.find_emphasis_at(lines, 2, 5)) -- on ->
    assert.are.equal("a->b", sync.find_emphasis_at(lines, 2, 8)) -- on b
    assert.are.equal("a->b", sync.find_emphasis_at(lines, 2, 9)) -- on ;
  end)

  it("undirected edges keep the -- operator (matches the SVG edge title)", function()
    assert.are.equal("a--b", sync.find_emphasis_at({ "a -- b;" }, 1, 4))
  end)

  it("no spaces around the operator still resolves", function()
    assert.are.equal("a->b", sync.find_emphasis_at({ "a->b;" }, 1, 1))
  end)

  it("quoted endpoints resolve to their UNESCAPED ids in the key", function()
    assert.are.equal("node one->b", sync.find_emphasis_at({ '"node one" -> b;' }, 1, 5))
  end)

  it("a chain prefers the segment containing the cursor; first segment otherwise", function()
    local lines = { "a -> b -> c;" }
    assert.are.equal("a->b", sync.find_emphasis_at(lines, 1, 1)) -- on a
    assert.are.equal("b->c", sync.find_emphasis_at(lines, 1, 11)) -- on c
    assert.are.equal("a->b", sync.find_emphasis_at(lines, 1, 12)) -- on ; → first
  end)

  it("two statements on one line resolve per-cursor, first edge as fallback", function()
    local lines = { "a -> b; c -> d;" }
    assert.are.equal("c->d", sync.find_emphasis_at(lines, 1, 14)) -- on d
    assert.are.equal("a->b", sync.find_emphasis_at(lines, 1, 7)) -- on the first ;
  end)

  it("a ;-separated standalone node after an edge resolves to the node, not the edge", function()
    local lines = { "a -> b; c;" }
    assert.are.equal("c", sync.find_emphasis_at(lines, 1, 9)) -- on c
    assert.are.equal("a->b", sync.find_emphasis_at(lines, 1, 3)) -- edge still wins on a
    assert.are.equal("a->b", sync.find_emphasis_at(lines, 1, 10)) -- trailing ; → first edge
    assert.are.equal("c", sync.find_emphasis_at({ "c; a -> b;" }, 1, 1)) -- node first
  end)

  it("only a real ; boundary frees a candidate from the edge fallback", function()
    -- attr candidates have no ; gap → still the edge (parity with the
    -- attribute-list test above)
    assert.are.equal("a->b", sync.find_emphasis_at({ "a -> b [color=red];" }, 1, 12))
    -- a ; INSIDE a quoted label lives in the candidate span, not a gap —
    -- it can't fake a statement boundary for the trailing candidate
    assert.are.equal("a->b", sync.find_emphasis_at({ 'a -> b [label="x;y"] z' }, 1, 22))
    -- ...but a real ; after the attr list does free the standalone node
    assert.are.equal("z", sync.find_emphasis_at({ 'a -> b [label="x;y"]; z' }, 1, 23))
  end)

  it("attribute lists after the edge do not break detection", function()
    assert.are.equal("a->b", sync.find_emphasis_at({ "a -> b [color=red];" }, 1, 12))
  end)

  it("an arrow INSIDE a quoted attribute value is not an edge", function()
    -- No edge is detected anywhere on the line (else edge-wins would return a
    -- key even on x). The quoted value itself stays a plain candidate — the
    -- documented attr-collection parity limitation, a browser miss ≡ clear.
    assert.are.equal("x", sync.find_emphasis_at({ 'x [label="a -> b"];' }, 1, 1))
    assert.are.equal("a -> b", sync.find_emphasis_at({ 'x [label="a -> b"];' }, 1, 12))
  end)

  it("ports degrade to node resolution (never a wrong edge key)", function()
    assert.are.equal("rec", sync.find_emphasis_at({ "rec:out -> b;" }, 1, 2))
  end)

  it("non-edge lines keep the node semantics; empty lines yield nil", function()
    assert.are.equal("a", sync.find_emphasis_at({ "a [shape=box];" }, 1, 1))
    assert.is_nil(sync.find_emphasis_at({ "}" }, 1, 1))
    assert.is_nil(sync.find_emphasis_at(nil, 1, 1))
  end)

  it("an edge inside a block comment is dead (multi-line state carries)", function()
    local buf = { "/* open", "a -> b; */ c;", "x -> y;" }
    assert.are.equal("c", sync.find_emphasis_at(buf, 2, 1))
    assert.are.equal("x->y", sync.find_emphasis_at(buf, 3, 1))
  end)
end)

-- ── echo suppression (Story 6.3, AC3) ────────────────────────────────────────

describe("sync echo suppression — per-buffer one-shot, armed only for watched buffers", function()
  before_each(reset)

  local function displayed_current(bufnr, lines, winid)
    winid = winid or 1001
    state.valid_bufs[bufnr] = true
    state.buf_lines[bufnr] = lines
    state.windows[bufnr] = { winid }
    state.win_bufs[winid] = bufnr
    state.current_win = winid
  end

  -- Arming requires an active cursor watch on the buffer (Story 6.4, AC5a).
  local function watched_current(bufnr, lines, winid)
    displayed_current(bufnr, lines, winid)
    sync.start_cursor_watch(bufnr)
  end

  it("a jump that moves the cursor in the current window arms it — consume-once", function()
    watched_current(3, { "a -> b;" })
    state.win_cursor[1001] = { 1, 0 }

    assert.is_true(sync.handle_node_click(3, "b"))
    assert.is_true(sync.consume_suppression(3), "armed by the jump")
    assert.is_false(sync.consume_suppression(3), "one-shot: second consume is empty")
  end)

  it(
    "a jump landing where the cursor already is does NOT arm (no CursorMoved will fire)",
    function()
      watched_current(3, { "a -> b;" })
      state.win_cursor[1001] = { 1, 5 } -- already exactly on b

      assert.is_true(sync.handle_node_click(3, "b"))
      assert.is_false(sync.consume_suppression(3))
    end
  )

  it("a jump into a NON-current window does not arm", function()
    state.valid_bufs[3] = true
    state.buf_lines[3] = { "a -> b;" }
    state.windows[3] = { 1001 }
    state.win_bufs[1001] = 3
    state.current_win = 2002 -- user is in a different window
    state.win_cursor[1001] = { 1, 0 }
    sync.start_cursor_watch(3)

    assert.is_true(sync.handle_node_click(3, "a"))
    assert.is_false(sync.consume_suppression(3))
  end)

  it("a failed jump (stale node) never arms", function()
    watched_current(3, { "a -> b;" })

    assert.is_false(sync.handle_node_click(3, "ghost"))
    assert.is_false(sync.consume_suppression(3))
  end)

  it("an UNWATCHED buffer's jump arms nothing (no callback exists to consume it)", function()
    displayed_current(3, { "a -> b;" }) -- displayed but no cursor watch
    state.win_cursor[1001] = { 1, 0 }

    assert.is_true(sync.handle_node_click(3, "b"), "the jump itself still happens")
    assert.is_false(sync.consume_suppression(3), "but no suppression was armed")
  end)

  it("suppression is per-buffer: A's armed flag never swallows B's move", function()
    watched_current(3, { "a -> b;" }, 1001)
    local cb3 = autocmds_created[#autocmds_created].callback
    state.valid_bufs[4] = true
    state.buf_lines[4] = { "c -> d;" }
    state.windows[4] = { 1002 }
    state.win_bufs[1002] = 4
    sync.start_cursor_watch(4)
    local cb4 = autocmds_created[#autocmds_created].callback
    state.win_cursor[1001] = { 1, 0 }

    -- Arm for buffer 3 via a real current-window jump.
    assert.is_true(sync.handle_node_click(3, "b"))

    -- Buffer 4's move is NOT swallowed: it debounces normally.
    local timers_before = #timers_created
    cb4()
    assert.are.equal(timers_before + 1, #timers_created, "B's move armed a debounce")

    -- Buffer 3's echo IS swallowed: no timer armed, flag consumed.
    cb3()
    assert.are.equal(timers_before + 1, #timers_created, "A's echo armed no timer")
    assert.is_false(sync.consume_suppression(3), "A's flag was consumed by the callback")
  end)

  it("stop_cursor_watch clears a still-pending suppression for the buffer", function()
    watched_current(3, { "a -> b;" })
    state.win_cursor[1001] = { 1, 0 }
    assert.is_true(sync.handle_node_click(3, "b"))

    sync.stop_cursor_watch(3)
    assert.is_false(sync.consume_suppression(3))
  end)
end)

-- ── cursor watcher: debounce + emphasize emission (Story 6.3, AC1/AC2) ───────

describe("sync.start_cursor_watch / emphasize emission", function()
  before_each(reset)

  -- Buffer 3 shown in window 1001 (the current window), cursor placeable.
  local function editing(lines, cursor)
    state.valid_bufs[3] = true
    state.buf_lines[3] = lines
    state.windows[3] = { 1001 }
    state.win_bufs[1001] = 3
    state.current_win = 1001
    state.win_cursor[1001] = cursor or { 1, 0 }
    sync.start_cursor_watch(3)
    return autocmds_created[#autocmds_created].callback
  end

  local function fire_last_timer()
    timers_created[#timers_created]:fire()
  end

  it("registers CursorMoved + CursorMovedI on the buffer with its own augroup", function()
    editing({ "a -> b;" })
    local ac = autocmds_created[#autocmds_created]
    assert.are.equal(3, ac.buffer)
    assert.are.equal("InteractiveGraphvizSync3", ac.group)
    local events = table.concat(ac.events, ",")
    assert.truthy(events:find("CursorMoved", 1, true))
    assert.truthy(events:find("CursorMovedI", 1, true))
  end)

  it("debounce delay comes from sync.cursor_debounce_ms", function()
    state.sync_cfg = { highlight_on_cursor = true, cursor_debounce_ms = 300 }
    local cb = editing({ "a -> b;" })
    cb()
    assert.are.equal(300, timers_created[#timers_created].delay)
  end)

  it("cursor on an edge line emits the edge key with the EXACT 3-key envelope, no v", function()
    local cb = editing({ "digraph {", "  a -> b;", "}" }, { 2, 2 }) -- 0-based col 2 → on a
    cb()
    fire_last_timer()

    assert.are.equal(1, #sent_msgs)
    local msg = sent_msgs[1]
    assert.are.equal("emphasize", msg.type)
    assert.are.equal(3, msg.sessionId)
    -- Edge lines win regardless of column: the edge key rides the nodeId field.
    assert.are.equal("a->b", msg.nodeId)
    local keys = {}
    for k in pairs(msg) do
      table.insert(keys, k)
    end
    table.sort(keys)
    assert.are.same({ "nodeId", "sessionId", "type" }, keys)
  end)

  it("0-based cursor col converts to the matcher's 1-based col (first byte works)", function()
    local cb = editing({ "a;" }, { 1, 0 }) -- col 0 = first byte = a (node-only line)
    cb()
    fire_last_timer()
    assert.are.equal("a", sent_msgs[1].nodeId)
  end)

  it("leaving the node line clears via nodeId = vim.NIL (not a dropped key)", function()
    local cb = editing({ "a -> b;", "}" }, { 1, 0 })
    cb()
    fire_last_timer() -- emphasize a
    state.win_cursor[1001] = { 2, 0 } -- } line: no node
    cb()
    fire_last_timer()

    assert.are.equal(2, #sent_msgs)
    assert.are.equal(NIL_SENTINEL, sent_msgs[2].nodeId)
  end)

  it("dedupe: resting on the same node never re-streams identical frames", function()
    local cb = editing({ "a -> b;" }, { 1, 0 })
    cb()
    fire_last_timer()
    cb() -- moved within the same token/line
    fire_last_timer()
    assert.are.equal(1, #sent_msgs)
  end)

  it("a fresh watch on a non-node line reconciles with ONE explicit clear", function()
    -- A browser page surviving a stop/re-preview re-applies its stale emphasis
    -- onto the new render; only an explicit clear frame dislodges the ghost.
    local cb = editing({ "}" }, { 1, 0 })
    assert.are.equal(1, #sent_msgs)
    assert.are.equal(NIL_SENTINEL, sent_msgs[1].nodeId)
    cb() -- resting afterwards never re-streams the clear
    fire_last_timer()
    assert.are.equal(1, #sent_msgs)
  end)

  it("a fresh watch with the cursor already ON a node emphasizes without a move", function()
    editing({ "a;" }, { 1, 0 })
    assert.are.equal(1, #sent_msgs)
    assert.are.equal("a", sent_msgs[1].nodeId)
  end)

  it("a fresh watch with the cursor on an EDGE line emphasizes the edge", function()
    editing({ "a -> b;" }, { 1, 6 }) -- on the ; — any column on the line
    assert.are.equal(1, #sent_msgs)
    assert.are.equal("a->b", sent_msgs[1].nodeId)
  end)

  it("re-emphasis after a clear works (last-wins through the clear)", function()
    local cb = editing({ "a -> b;", "}" }, { 1, 0 })
    cb()
    fire_last_timer() -- a->b
    state.win_cursor[1001] = { 2, 0 }
    cb()
    fire_last_timer() -- clear
    state.win_cursor[1001] = { 1, 5 }
    cb()
    fire_last_timer() -- back on the edge line
    assert.are.equal(3, #sent_msgs)
    assert.are.equal("a->b", sent_msgs[3].nodeId)
  end)

  it("latest-wins: rapid cursor moves cancel the previous timer", function()
    local cb = editing({ "a -> b;" })
    cb()
    local first = timers_created[#timers_created]
    cb()
    assert.is_true(first.stopped)
    assert.is_true(first.closed)
    assert.are.equal(2, #timers_created)
  end)

  it("re-starting a watch cancels the previous watch's pending debounce", function()
    local cb = editing({ "a -> b;" })
    cb()
    local pending = timers_created[#timers_created]
    sync.start_cursor_watch(3) -- direct re-start, no stop_cursor_watch first
    assert.is_true(pending.stopped)
    assert.is_true(pending.closed)
  end)

  it("a pending suppression is consumed INSTEAD of debouncing (no timer armed)", function()
    local cb = editing({ "a -> b;" }, { 1, 3 })
    -- Arm via a real 6.2 jump in the current window.
    assert.is_true(sync.handle_node_click(3, "b"))
    local timers_before = #timers_created
    cb() -- the CursorMoved caused by the jump
    assert.are.equal(timers_before, #timers_created, "suppressed tick arms no timer")
    cb() -- the user's NEXT move debounces normally
    assert.are.equal(timers_before + 1, #timers_created)
  end)

  it("consume also cancels a debounce armed BEFORE the jump (no echo via pending timer)", function()
    local cb = editing({ "a -> b;" }, { 1, 3 })
    cb() -- a real user move arms a debounce
    local pending = timers_created[#timers_created]
    assert.is_false(pending.stopped)
    assert.is_true(sync.handle_node_click(3, "b")) -- jump arms the suppression
    cb() -- the jump's CursorMoved: consumed AND the pending timer cancelled
    assert.is_true(pending.stopped, "pre-jump debounce cancelled on consume")
    assert.is_true(pending.closed)
  end)

  it("invalid buffer at fire time sends nothing", function()
    local cb = editing({ "a -> b;" }, { 1, 0 })
    local baseline = #sent_msgs -- watch-start reconciliation frame
    cb()
    state.valid_bufs[3] = nil
    fire_last_timer()
    assert.are.equal(baseline, #sent_msgs)
  end)

  it("closed session at fire time sends nothing", function()
    local cb = editing({ "a -> b;" }, { 1, 0 })
    local baseline = #sent_msgs -- watch-start reconciliation frame
    cb()
    state.session_has[3] = false
    fire_last_timer()
    assert.are.equal(baseline, #sent_msgs)
  end)

  it("buffer visible only in a NON-current window still resolves (win_findbuf fallback)", function()
    local cb = editing({ "a;", "b;" }, { 1, 0 }) -- watch-start emphasizes a
    state.current_win = 2002 -- user focused elsewhere; buffer still shown in 1001
    state.win_bufs[2002] = 99
    state.win_cursor[1001] = { 2, 0 } -- now on b: only the fallback can see it
    cb()
    fire_last_timer()
    assert.are.equal(2, #sent_msgs)
    assert.are.equal("b", sent_msgs[2].nodeId)
  end)

  it("no window shows the buffer: previously-emphasized node clears", function()
    local cb = editing({ "a -> b;" }, { 1, 0 })
    cb()
    fire_last_timer() -- emphasize a
    state.windows[3] = {}
    state.current_win = 0
    cb()
    fire_last_timer()
    assert.are.equal(2, #sent_msgs)
    assert.are.equal(NIL_SENTINEL, sent_msgs[2].nodeId)
  end)

  it("stop_cursor_watch cancels the pending timer and removes the augroup", function()
    local cb = editing({ "a -> b;" })
    cb()
    local timer = timers_created[#timers_created]
    sync.stop_cursor_watch(3)
    assert.is_true(timer.stopped)
    assert.is_true(timer.closed)
    local found = false
    for _, name in ipairs(augroups_deleted) do
      if name == "InteractiveGraphvizSync3" then
        found = true
      end
    end
    assert.is_true(found)
  end)

  it("stop_all stops every buffer's watch", function()
    local cb3 = editing({ "a -> b;" })
    state.valid_bufs[4] = true
    state.buf_lines[4] = { "c -> d;" }
    sync.start_cursor_watch(4)
    local cb4 = autocmds_created[#autocmds_created].callback
    cb3()
    cb4()
    sync.stop_all()
    for _, t in ipairs(timers_created) do
      assert.is_true(t.stopped)
      assert.is_true(t.closed)
    end
  end)

  it("gate re-read: highlight_on_cursor=false mid-session stops the next fire", function()
    local cb = editing({ "a;", "b;" }, { 1, 0 })
    assert.are.equal(1, #sent_msgs, "watch-start reconcile emitted")

    -- Mid-session setup() disable: no re-preview, no watcher teardown.
    state.sync_cfg = { highlight_on_cursor = false, cursor_debounce_ms = 150 }
    state.win_cursor[1001] = { 2, 0 } -- moved onto b
    cb()
    fire_last_timer()
    assert.are.equal(1, #sent_msgs, "gate off: the debounce fire sent nothing")

    -- Gate back on: the next change emits again.
    state.sync_cfg = { highlight_on_cursor = true, cursor_debounce_ms = 150 }
    cb()
    fire_last_timer()
    assert.are.equal(2, #sent_msgs)
    assert.are.equal("b", sent_msgs[2].nodeId)
  end)

  it("a throwing emit at debounce fire warns instead of propagating", function()
    local cb = editing({ "a -> b;" }, { 1, 0 })
    cb()
    state.session_error = true
    fire_last_timer() -- must not throw
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("emphasis emission error", 1, true))
    assert.truthy(warn_calls[1]:find("buffer 3", 1, true), "names the buffer")
  end)

  it("a throwing emit at watch-start reconcile warns instead of propagating", function()
    state.valid_bufs[3] = true
    state.buf_lines[3] = { "a -> b;" }
    state.session_error = true
    sync.start_cursor_watch(3) -- reconcile emit runs via the schedule stub
    assert.are.equal(1, #warn_calls)
    assert.truthy(warn_calls[1]:find("emphasis emission error", 1, true))
    assert.are.equal(0, #sent_msgs)
  end)

  it("stop_all reaches watchers with NO pending timer (fired or never armed)", function()
    -- Buffer 3: debounce already FIRED (the steady state — timers[3] is nil).
    local cb3 = editing({ "a -> b;" }, { 1, 0 })
    cb3()
    fire_last_timer()
    -- Buffer 4: watched but the cursor never moved (no timer ever created).
    state.valid_bufs[4] = true
    state.buf_lines[4] = { "c -> d;" }
    sync.start_cursor_watch(4)
    sync.stop_all()
    local deleted = {}
    for _, name in ipairs(augroups_deleted) do
      deleted[name] = true
    end
    assert.is_true(deleted["InteractiveGraphvizSync3"], "fired-timer buffer's augroup removed")
    assert.is_true(deleted["InteractiveGraphvizSync4"], "never-armed buffer's augroup removed")
  end)
end)
