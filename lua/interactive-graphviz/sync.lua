-- sync.lua — editor↔graph sync (Epic 6).
--
-- Story 6.2 (graph → buffer): maps a clicked node id to its first occurrence
-- in the DOT buffer and moves the cursor there.
-- Story 6.3 (buffer → graph): resolves the node — or, on an edge line, the
-- edge (`a->b` key form, matching the SVG edge <title>) — under the cursor
-- and sends a debounced `emphasize` so the Preview outlines it (an edge
-- lights the edge plus both endpoint nodes); leaving it (or a miss) clears
-- via `emphasize{nodeId:null}`.
--
-- There is deliberately NO maintained source map: the buffer text is scanned on
-- demand, so a stale browser (live-reload race) degrades to an informative
-- notify (6.2) or a cleared emphasis (6.3) instead of a wrong result. The
-- matchers are pure (lines in, id/line out) so busted can cover them without a
-- real Neovim; only handle_node_click and the cursor watcher touch vim APIs.
local M = {}

-- Is `c` (one byte) a DOT identifier byte? The DOT grammar allows
-- [A-Za-z_0-9] plus any byte in \200-\377 octal (128–255 decimal) in bare IDs,
-- so every UTF-8 continuation/lead byte counts as an ID byte. Using bare [%w_]
-- here would treat `ñ` as a boundary and let `a` false-match the prefix of
-- `añejo` (review finding, Story 6.2).
local function is_id_byte(c)
  if c == "" then
    return false
  end
  return c:match("[%w_]") ~= nil or c:byte() >= 128
end

-- Can `id` appear as a BARE (unquoted) token in DOT source? Bare IDs are
-- identifier-shaped ([A-Za-z_\128-\255][A-Za-z_0-9\128-\255]*) or numerals
-- (-?(.d+ | d+(.d*)?)). Anything else (spaces, punctuation, quotes) only ever
-- occurs quoted — bare-scanning such ids can only produce false matches (e.g.
-- a node id of " " matching arbitrary indentation).
local function bare_eligible(id)
  if id:match("^[%a_\128-\255][%w_\128-\255]*$") then
    return true
  end
  return id:match("^%-?%d+%.?%d*$") ~= nil or id:match("^%-?%.%d+$") ~= nil
end

-- Consume a quoted string starting at the `"` at byte `i`. Returns the
-- UNESCAPED body and the index just past the closing quote (or past EOL when
-- unterminated). \" and \\ unescape; any other backslash sequence stays
-- literal (DOT keeps unknown escapes as-is in IDs).
local function read_quoted(line, i)
  local n = #line
  local buf = {}
  local j = i + 1
  while j <= n do
    local qc = line:sub(j, j)
    if qc == "\\" then
      local nxt = line:sub(j + 1, j + 1)
      if nxt == '"' or nxt == "\\" then
        table.insert(buf, nxt)
        j = j + 2
      else
        table.insert(buf, qc)
        j = j + 1
      end
    elseif qc == '"' then
      j = j + 1
      break
    else
      table.insert(buf, qc)
      j = j + 1
    end
  end
  return table.concat(buf), j
end

-- Scan one line for `node_id`, DOT-syntax-aware. Matchable occurrences:
--   * a quoted ID: `"node one" -> b` — the UNESCAPED quoted body must equal
--     node_id exactly (a colon inside the quotes is part of the ID, never a
--     port separator);
--   * a bare token (only when `bare_ok`): `a -> b` — with DOT-ID boundaries so
--     `a` never matches `alpha`/`añejo`; a following `:` is fine (`node:port`).
-- NON-matchable regions are consumed wholesale so they can never false-match:
-- quoted strings other than the id (`x [label="a b"]`), `//` and line-leading
-- `#` comments, `/* */` block comments, and HTML strings `<...>` (both may span
-- lines — `state` carries block_comment/html_depth across calls).
-- Returns the 1-based byte column of the match, or nil.
local function find_on_line(line, node_id, state, bare_ok)
  local i = 1
  local n = #line
  local id_len = #node_id
  -- A line whose first non-blank char is `#` is preprocessor output per the
  -- DOT grammar — comment, unless we're inside a multi-line construct.
  if not state.block_comment and state.html_depth == 0 and line:match("^%s*#") then
    return nil
  end
  while i <= n do
    local c = line:sub(i, i)
    if state.block_comment then
      if c == "*" and line:sub(i + 1, i + 1) == "/" then
        state.block_comment = false
        i = i + 2
      else
        i = i + 1
      end
    elseif state.html_depth > 0 then
      -- HTML strings nest with balanced angle brackets.
      if c == "<" then
        state.html_depth = state.html_depth + 1
      elseif c == ">" then
        state.html_depth = state.html_depth - 1
      end
      i = i + 1
    elseif c == '"' then
      local start = i
      local body
      body, i = read_quoted(line, i)
      if body == node_id then
        return start
      end
    elseif c == "/" and line:sub(i + 1, i + 1) == "/" then
      return nil -- `//` comment: rest of the line is dead
    elseif c == "/" and line:sub(i + 1, i + 1) == "*" then
      state.block_comment = true
      i = i + 2
    elseif c == "<" then
      state.html_depth = 1
      i = i + 1
    else
      if bare_ok and line:sub(i, i + id_len - 1) == node_id then
        local prev = i > 1 and line:sub(i - 1, i - 1) or ""
        local nxt = line:sub(i + id_len, i + id_len)
        if not is_id_byte(prev) and not is_id_byte(nxt) then
          return i
        end
      end
      i = i + 1
    end
  end
  return nil
end

-- Find the FIRST line containing `node_id` (definition or occurrence — DOT
-- nodes are implicitly defined by first mention, so first occurrence IS the
-- definition site). Returns (lnum, col), both 1-based, or nil when absent —
-- the stale-browser path.
function M.find_node_line(lines, node_id)
  if type(lines) ~= "table" or type(node_id) ~= "string" or node_id == "" then
    return nil
  end
  local bare_ok = bare_eligible(node_id)
  local state = { block_comment = false, html_depth = 0 }
  for lnum, line in ipairs(lines) do
    if type(line) == "string" then
      local col = find_on_line(line, node_id, state, bare_ok)
      if col then
        return lnum, col
      end
    end
  end
  return nil
end

-- ── Story 6.3: line → node (the reverse matcher) ─────────────────────────────

-- Unquoted DOT keywords are grammar, not nodes (case-insensitive). A node
-- literally named `node` is only addressable in its quoted form.
local DOT_KEYWORDS = {
  graph = true,
  digraph = true,
  subgraph = true,
  node = true,
  edge = true,
  strict = true,
}

-- Walk one line with the same DOT skip rules as find_on_line (line-leading `#`,
-- `//`, `/* */`, HTML `<...>` — both multi-line via `state`), optionally
-- collecting candidate node ids via `collect(id, start_col, end_col)`:
--   * quoted IDs — the unescaped body ("" is skipped: not a clickable node);
--   * bare identifier/numeral tokens that are bare_eligible, are not DOT
--     keywords, and are not a `:port` / `:compass` suffix.
-- With collect=nil this purely advances `state` across a preceding line.
-- Known parity limitation (same as find_on_line, documented in deferred-work):
-- attribute keys/values inside [...] are collected too — the browser resolves
-- such non-node ids to "no match", which reads as cleared, never wrong.
local function walk_line(line, state, collect)
  local i = 1
  local n = #line
  if not state.block_comment and state.html_depth == 0 and line:match("^%s*#") then
    return
  end
  while i <= n do
    local c = line:sub(i, i)
    if state.block_comment then
      if c == "*" and line:sub(i + 1, i + 1) == "/" then
        state.block_comment = false
        i = i + 2
      else
        i = i + 1
      end
    elseif state.html_depth > 0 then
      if c == "<" then
        state.html_depth = state.html_depth + 1
      elseif c == ">" then
        state.html_depth = state.html_depth - 1
      end
      i = i + 1
    elseif c == '"' then
      local start = i
      local body
      body, i = read_quoted(line, i)
      if collect and body ~= "" and line:sub(start - 1, start - 1) ~= ":" then
        collect(body, start, i - 1)
      end
    elseif c == "/" and line:sub(i + 1, i + 1) == "/" then
      return -- `//` comment: rest of the line is dead
    elseif c == "/" and line:sub(i + 1, i + 1) == "*" then
      state.block_comment = true
      i = i + 2
    elseif c == "<" then
      state.html_depth = 1
      i = i + 1
    elseif is_id_byte(c) then
      local start = i
      local j = i
      while j <= n and is_id_byte(line:sub(j, j)) do
        j = j + 1
      end
      local token = line:sub(start, j - 1)
      -- Numeral continuation: `3.14` is ONE DOT numeral, but `.` is not an ID
      -- byte — glue digits '.' digits back together. (Leading-dot/negative
      -- numerals like `.5`/`-5` stay unglued: a rare miss that the browser
      -- resolves as cleared, never wrong.)
      if token:match("^%d+$") and line:sub(j, j) == "." and line:sub(j + 1, j + 1):match("^%d") then
        local k = j + 1
        while k <= n and line:sub(k, k):match("%d") do
          k = k + 1
        end
        token = line:sub(start, k - 1)
        j = k
      end
      local port_suffix = line:sub(start - 1, start - 1) == ":"
      if
        collect
        and not port_suffix
        and bare_eligible(token)
        and not DOT_KEYWORDS[token:lower()]
      then
        collect(token, start, j - 1)
      end
      i = j
    else
      i = i + 1
    end
  end
end

-- Collect every candidate id on line `lnum` with its 1-based byte span,
-- walking lines 1..lnum-1 solely to carry multi-line comment/HTML state (so a
-- cursor inside a /* */ block or HTML label collects nothing). Returns an
-- array of { id, s, e } in line order, or nil on degraded input. Shared by
-- find_node_at and find_emphasis_at so the two resolvers can never disagree
-- about what counts as a candidate.
local function candidates_at(lines, lnum)
  if type(lines) ~= "table" or type(lnum) ~= "number" then
    return nil
  end
  if lnum < 1 or lnum > #lines or type(lines[lnum]) ~= "string" then
    return nil
  end
  local state = { block_comment = false, html_depth = 0 }
  for i = 1, lnum - 1 do
    if type(lines[i]) == "string" then
      walk_line(lines[i], state, nil)
    end
  end
  local cands = {}
  walk_line(lines[lnum], state, function(id, start_col, end_col)
    table.insert(cands, { id = id, s = start_col, e = end_col })
  end)
  return cands
end

-- Resolve the node id "at" (lnum, col) — the buffer→graph direction (FR-20).
-- Prefers the candidate whose span contains `col` (1-based byte; convert
-- nvim_win_get_cursor's 0-based col before calling); falls back to the FIRST
-- candidate on the line (ux-sync-v3 "the node's line"); nil when the line
-- holds none.
function M.find_node_at(lines, lnum, col)
  local cands = candidates_at(lines, lnum)
  if cands == nil then
    return nil
  end
  if type(col) ~= "number" or col < 1 then
    col = 1
  end
  for _, c in ipairs(cands) do
    if col >= c.s and col <= c.e then
      return c.id
    end
  end
  return cands[1] and cands[1].id or nil
end

-- Is the raw text between two adjacent candidate spans exactly a DOT edge
-- operator (plus whitespace)? Returns "->" / "--" or nil. Anything else in
-- the gap (`;`, `[`, `=`, a `:port` suffix, comment text) means the pair is
-- not a plain edge — the caller degrades to node resolution, which the
-- browser at worst renders as a single-node outline, never a wrong edge.
local function edge_op_between(line, left, right)
  local gap = line:sub(left.e + 1, right.s - 1)
  if gap:match("^%s*%->%s*$") then
    return "->"
  end
  if gap:match("^%s*%-%-%s*$") then
    return "--"
  end
  return nil
end

-- Does a `;` statement boundary separate candidate `k` from the nearest edge
-- on the line? Scans the raw gaps BETWEEN candidate spans (candidate content
-- itself — e.g. a quoted label holding `;` — is never inspected) from the
-- preceding edge's right endpoint up to `k`, or from `k` to the following
-- edge's left endpoint when no edge precedes. DOT also allows bare-whitespace
-- statement separators; those fail this check and degrade to the line's
-- first edge — same-shaped miss as every other strict-detection fallback.
local function stmt_break_between(line, cands, edges, k)
  local from, to = nil, nil
  for _, ed in ipairs(edges) do
    if ed.ri <= k - 1 then
      from, to = ed.ri, k
    elseif from == nil and ed.li >= k + 1 then
      from, to = k, ed.li
      break
    end
  end
  if from == nil then
    return false
  end
  for m = from, to - 1 do
    local gap = line:sub(cands[m].e + 1, cands[m + 1].s - 1)
    if gap:find(";", 1, true) then
      return true
    end
  end
  return false
end

-- Resolve what the cursor at (lnum, col) should emphasize: an EDGE key when
-- the line contains an edge statement, else a node id (find_node_at rules).
--
-- Edge lines win regardless of column ("any position on an edge line lights
-- the edge + both ends"): `a -> b;` emphasizes the edge a->b whether the
-- cursor sits on `a`, the operator, `b`, or trailing punctuation. The key is
-- `tail<op>head` — exactly the SVG edge <title> text graphviz emits (A->B
-- directed, A--B undirected), so the browser matches it against g.edge titles
-- with no new convention. Chains (`a -> b -> c`) prefer the segment whose
-- span contains the cursor, falling back to the line's first edge; on mixed
-- lines (`a -> b; c;`) a cursor inside a `;`-separated standalone node's
-- span resolves to that node, not the earlier edge. Ports (`a:p -> b`),
-- subgraph
-- endpoints (`{a b} -> c`), and operators split by comments all fail the
-- strict gap test and degrade to node resolution — miss ≡ single-node
-- emphasis or cleared, never a wrong edge.
function M.find_emphasis_at(lines, lnum, col)
  local cands = candidates_at(lines, lnum)
  if cands == nil then
    return nil
  end
  if type(col) ~= "number" or col < 1 then
    col = 1
  end
  local line = lines[lnum]
  local edges = {}
  for i = 1, #cands - 1 do
    local op = edge_op_between(line, cands[i], cands[i + 1])
    if op then
      table.insert(edges, {
        key = cands[i].id .. op .. cands[i + 1].id,
        s = cands[i].s,
        e = cands[i + 1].e,
        li = i, -- candidate indices of the endpoints, for the
        ri = i + 1, -- statement-boundary check below
      })
    end
  end
  if #edges > 0 then
    for _, ed in ipairs(edges) do
      if col >= ed.s and col <= ed.e then
        return ed.key
      end
    end
    -- Outside every edge span: the candidate under the cursor (never an edge
    -- endpoint — edge spans cover both endpoints entirely) is a STANDALONE
    -- node on a mixed line (`a -> b; c;` with the cursor on c) only when a
    -- `;` statement boundary separates it from the nearest edge. Gaps are
    -- checked between candidate spans, so a `;` inside a quoted label can't
    -- fake a boundary; attr-list candidates (`[color=red]`) have no `;` gap
    -- and keep falling back to the edge.
    for k, c in ipairs(cands) do
      if col >= c.s and col <= c.e then
        if stmt_break_between(line, cands, edges, k) then
          return c.id
        end
        break
      end
    end
    return edges[1].key
  end
  for _, c in ipairs(cands) do
    if col >= c.s and col <= c.e then
      return c.id
    end
  end
  return cands[1] and cands[1].id or nil
end

-- ── Story 6.3: one-shot echo suppression (AC3 / NFR-8) ───────────────────────

-- Per-buffer last emphasize payload (node id, or NONE for "cleared/nothing"),
-- so resting on the same line never re-streams identical frames. A fresh watch
-- seeds an "unseeded" sentinel instead (see start_cursor_watch) so its first
-- emission is never deduped away. Declared here (not in the watcher section
-- below) because a non-nil entry is ALSO the watch-liveness signal
-- handle_node_click checks before arming suppression.
local NONE = {}
local last_sent = {}

-- A 6.2 sync-initiated cursor jump would otherwise fire CursorMoved and echo an
-- `emphasize` straight back to the browser. handle_node_click arms a buffer's
-- flag ONLY when the jump actually moved the cursor in the CURRENT window AND
-- that buffer has an active cursor watch (an unwatched buffer has no callback
-- to consume the flag — arming it would leave a stale one-shot to swallow the
-- first emphasis of a LATER watch). Keyed by bufnr so one buffer's pending
-- suppression never swallows another buffer's legitimate emphasis; the watcher
-- callback consumes its own buffer's flag instead of debouncing. Self-healing
-- by design: a stale flag costs one emphasis tick.
local suppress = {}

-- Consume-once, per buffer. Returns whether a suppression was pending for
-- `bufnr` (and clears it).
function M.consume_suppression(bufnr)
  if suppress[bufnr] then
    suppress[bufnr] = nil
    return true
  end
  return false
end

-- Handle a relayed node_click: put the cursor on the node's first source line.
-- `session_id` is the buffer number (the sessionId convention since Story 1.3).
-- Every degraded path notifies and returns false without touching the cursor;
-- nothing here ever throws (the caller additionally pcall-wraps). Only a window
-- ALREADY displaying the buffer is used — never raises/focuses anything
-- (ux-sync-v3: OS focus stays wherever the window manager leaves it).
function M.handle_node_click(session_id, node_id)
  local log = require("interactive-graphviz.log")
  if type(session_id) ~= "number" or type(node_id) ~= "string" or node_id == "" then
    return false
  end
  -- Authoritative gate. The browser also gates click emission on
  -- sync.jump_on_click, but :GraphvizJumpOnClickToggle pushes the new value via
  -- an ASYNC config_update — a click already in flight (or fired in the window
  -- before that update lands) still arrives here carrying the stale-enabled
  -- state. The Lua config flips synchronously with the toggle, so re-checking it
  -- here guarantees a disabled gate can never move the cursor.
  if not require("interactive-graphviz.config").get().sync.jump_on_click then
    return false
  end
  local bufnr = session_id
  if not vim.api.nvim_buf_is_valid(bufnr) then
    log.notify(
      "GraphvizSync: buffer " .. bufnr .. " no longer exists — not jumping",
      vim.log.levels.INFO
    )
    return false
  end
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local lnum, col = M.find_node_line(lines, node_id)
  if not lnum then
    log.notify(
      "GraphvizSync: node '" .. node_id .. "' not found in the buffer — not jumping",
      vim.log.levels.INFO
    )
    return false
  end
  local wins = vim.fn.win_findbuf(bufnr)
  if type(wins) ~= "table" or #wins == 0 then
    log.notify(
      "GraphvizSync: buffer " .. bufnr .. " is not displayed in any window — not jumping",
      vim.log.levels.INFO
    )
    return false
  end
  -- Prefer a window on the CURRENT tabpage: win_findbuf can return windows on
  -- other tabs, where a silent cursor move looks like nothing happened (review
  -- finding). Cross-tab fallback still moves the cursor (correct when the user
  -- switches back) but says so.
  local target = nil
  local ok_tab, current_tab = pcall(vim.api.nvim_get_current_tabpage)
  if ok_tab then
    for _, win in ipairs(wins) do
      local ok_win, tab = pcall(vim.api.nvim_win_get_tabpage, win)
      if ok_win and tab == current_tab then
        target = win
        break
      end
    end
  end
  local other_tab = target == nil
  target = target or wins[1]
  local ok_before, before = pcall(vim.api.nvim_win_get_cursor, target)
  -- nvim_win_set_cursor wants a 0-based column. pcall: the window could vanish
  -- between win_findbuf and here (async dispatch), and a race must not error.
  local ok = pcall(vim.api.nvim_win_set_cursor, target, { lnum, col - 1 })
  if not ok then
    log.notify("GraphvizSync: could not move the cursor — not jumping", vim.log.levels.INFO)
    return false
  end
  -- Echo suppression (Story 6.3, AC3): arm the one-shot only when this jump
  -- will actually fire a CursorMoved in the current window — i.e. the target
  -- IS the current window and the position really changed — and only when the
  -- buffer has an active cursor watch to consume it (last_sent liveness).
  local ok_cur, cur_win = pcall(vim.api.nvim_get_current_win)
  if
    ok_cur
    and cur_win == target
    and ok_before
    and type(before) == "table"
    and (before[1] ~= lnum or before[2] ~= col - 1)
    and last_sent[bufnr] ~= nil
  then
    suppress[bufnr] = true
  end
  if other_tab then
    log.notify(
      "GraphvizSync: jumped to '" .. node_id .. "' in a window on another tab",
      vim.log.levels.INFO
    )
  end
  return true
end

-- ── Story 6.3: debounced cursor watcher → emphasize emission (FR-20) ─────────

-- Per-buffer debounce timers, latest-wins — the exact render.lua pattern.
-- (NONE and last_sent live in the suppression section above: last_sent doubles
-- as the watch-liveness signal handle_node_click reads.)
local timers = {}

-- Resolve the emphasis target under the cursor for `bufnr` — a node id, or an
-- edge key (`a->b` / `a--b`) when the cursor line is an edge statement — and
-- send `emphasize` on change. Runs on the debounce boundary via vim.schedule.
-- Reads the cursor from the CURRENT window when it shows the buffer (the
-- window being edited), else the first window showing it; no window →
-- resolves to "nothing".
local function emit_for_cursor(bufnr)
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  local session = require("interactive-graphviz.session")
  if not session.has(bufnr) then
    return
  end
  -- Re-read the gate at emission time (defensive .sync-or-{} read, matching
  -- debounce() below): a mid-session setup{sync={highlight_on_cursor=false}}
  -- stops emissions at the next debounce fire, no re-preview needed. Watcher
  -- teardown stays reconcile_cursor_watch's job (commands.lua) — this gate
  -- only silences the emission where the work happens.
  local sync_cfg = require("interactive-graphviz.config").get().sync or {}
  if sync_cfg.highlight_on_cursor ~= true then
    return
  end
  local target = nil
  local win = nil
  local ok_cur, cur_win = pcall(vim.api.nvim_get_current_win)
  if ok_cur and vim.api.nvim_win_get_buf(cur_win) == bufnr then
    win = cur_win
  else
    local wins = vim.fn.win_findbuf(bufnr)
    if type(wins) == "table" then
      win = wins[1]
    end
  end
  if win then
    local ok_pos, pos = pcall(vim.api.nvim_win_get_cursor, win)
    if ok_pos and type(pos) == "table" then
      local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
      -- nvim_win_get_cursor's col is 0-based bytes; the matcher is 1-based.
      target = M.find_emphasis_at(lines, pos[1], pos[2] + 1)
    end
  end
  local key = target or NONE
  if last_sent[bufnr] == key then
    return
  end
  last_sent[bufnr] = key
  -- Exact three-key envelope: the server validates emphasize with
  -- hasExactlyKeys({type,sessionId,nodeId}) and nodeId string-or-null, then
  -- relays verbatim — an edge key rides the SAME field with zero server
  -- changes (a stale browser reads an unmatched key as cleared). The clear
  -- value MUST be vim.NIL — vim.json.encode DROPS nil-valued keys, and a
  -- missing nodeId key fails validation, silently losing the clear.
  require("interactive-graphviz.server").send({
    type = "emphasize",
    sessionId = bufnr,
    nodeId = target or vim.NIL,
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
  local sync_cfg = config.get().sync or {}
  local delay_ms = sync_cfg.cursor_debounce_ms or 150

  local timer = vim.uv.new_timer()
  timers[bufnr] = timer

  timer:start(delay_ms, 0, function()
    timer:stop()
    timer:close()
    if timers[bufnr] == timer then
      timers[bufnr] = nil
    end
    vim.schedule(function()
      -- Guard symmetry with the CursorMoved callback below: a throwing emit
      -- must warn, never propagate out of the scheduled context.
      local ok, err = pcall(emit_for_cursor, bufnr)
      if not ok then
        require("interactive-graphviz.log").warn(
          "GraphvizSync: emphasis emission error for buffer " .. bufnr .. ": " .. tostring(err)
        )
      end
    end)
  end)
end

-- Register the CursorMoved/CursorMovedI watcher for a buffer. Idempotent
-- (augroup clear=true recreates; a pending debounce is cancelled below).
-- CursorHold is deliberately NOT used: its delay is the user-global
-- 'updatetime' (typically 4000ms), not the configurable
-- sync.cursor_debounce_ms this feature promises.
function M.start_cursor_watch(bufnr)
  local group = vim.api.nvim_create_augroup("InteractiveGraphvizSync" .. bufnr, { clear = true })
  -- augroup clear=true only recreates the autocmds — a debounce still pending
  -- from a previous watch of this buffer would fire one stray emit into the
  -- fresh watch. Cancel it, mirroring stop_cursor_watch.
  if timers[bufnr] then
    timers[bufnr]:stop()
    timers[bufnr]:close()
    timers[bufnr] = nil
  end
  -- Seed with a fresh sentinel (equal to no node string and not NONE) so the
  -- reconciling emit below always passes the dedupe: a browser page that
  -- survives a stop/re-preview re-applies its last emphasis onto every new
  -- render, and only an explicit emphasize/clear frame can dislodge it.
  last_sent[bufnr] = {}
  vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
    buffer = bufnr,
    group = group,
    callback = function()
      -- A 6.2 sync-initiated jump must not echo back (AC3): consume the
      -- one-shot BEFORE debouncing so no timer is even armed.
      if M.consume_suppression(bufnr) then
        -- Also cancel a debounce armed by a pre-jump cursor move: it would
        -- fire against the post-jump cursor and emit the very echo this
        -- one-shot suppresses (review finding, Story 6.4).
        if timers[bufnr] then
          timers[bufnr]:stop()
          timers[bufnr]:close()
          timers[bufnr] = nil
        end
        return
      end
      local ok, err = pcall(debounce, bufnr)
      if not ok then
        require("interactive-graphviz.log").warn(
          "GraphvizSync: cursor debounce error for buffer " .. bufnr .. ": " .. tostring(err)
        )
      end
    end,
  })
  -- Reconcile the browser with the CURRENT cursor position at watch start —
  -- emphasize the node already under the cursor, or clear a stale ghost.
  -- Best-effort: with no subscriber connected yet the server drops the frame,
  -- so a fresh preview still needs the first cursor move. Fixing that needs
  -- replay-on-reconnect, which requires Lua-side subscriber awareness the
  -- protocol does not signal — deferred, see deferred-work.md.
  vim.schedule(function()
    local ok, err = pcall(emit_for_cursor, bufnr)
    if not ok then
      require("interactive-graphviz.log").warn(
        "GraphvizSync: emphasis emission error for buffer " .. bufnr .. ": " .. tostring(err)
      )
    end
  end)
end

-- Cancel the debounce timer and remove the watcher augroup for a buffer.
function M.stop_cursor_watch(bufnr)
  if timers[bufnr] then
    timers[bufnr]:stop()
    timers[bufnr]:close()
    timers[bufnr] = nil
  end
  last_sent[bufnr] = nil
  suppress[bufnr] = nil
  pcall(vim.api.nvim_del_augroup_by_name, "InteractiveGraphvizSync" .. bufnr)
end

-- Stop all active cursor watches (teardown symmetry with render.stop_all).
-- Iterate last_sent, not timers: every watched buffer has a last_sent entry
-- from start_cursor_watch, while its timers entry is nil'd whenever the
-- debounce has already fired — walking timers alone would leave the augroup
-- (and its CursorMoved autocmds) alive past teardown. timers is unioned in
-- defensively for any handle not paired with a watch.
-- Mirrors render.stop_all (watched-buffers registry) — keep in sync.
function M.stop_all()
  local seen = {}
  local bufs = {}
  for bufnr in pairs(last_sent) do
    seen[bufnr] = true
    table.insert(bufs, bufnr)
  end
  for bufnr in pairs(timers) do
    if not seen[bufnr] then
      table.insert(bufs, bufnr)
    end
  end
  for _, bufnr in ipairs(bufs) do
    M.stop_cursor_watch(bufnr)
  end
  last_sent = {}
  suppress = {}
end

return M
