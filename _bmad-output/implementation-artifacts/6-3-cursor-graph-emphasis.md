---
baseline_commit: ff87fffe33eba6113eb97b314332f4f2adcca2e2
---

# Story 6.3: Cursor → graph emphasis

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user editing DOT,
I want the node under my cursor emphasized in the Preview,
so that I always see where I am in the rendered Graph.

This is the **buffer → graph** half of Epic 6 (FR-20) — the architecturally *easy* direction: it
rides the existing forward path (Lua→server→browser) whose `emphasize` relay Story 6.1 already
built, validated, and contract-tested. The server needs **zero changes**. The work is a debounced
cursor watcher + line→node matching on the Lua side, and a passive emphasis treatment + `emphasize`
dispatch on the frontend side.

## Acceptance Criteria

_From `epics.md` Story 6.3 [Source: _bmad-output/planning-artifacts/epics.md:610]._

1. **(AC1 — cursor emphasizes)** Given an open preview and `sync.highlight_on_cursor = true`, when
   the cursor rests on a line containing a node (debounced `sync.cursor_debounce_ms`, default 150),
   then an `emphasize{sessionId,nodeId}` flows Lua→server→browser and that node receives a
   **passive, visually distinct** emphasis that never dims the rest of the Graph and never contends
   with the Epic 5 search/click highlight precedence (FR-20). The line→node match reuses Story
   6.2's matcher machinery. [Source: _bmad-output/planning-artifacts/epics.md:618]
2. **(AC2 — leaving clears)** Given the cursor leaves the node's line (or the feature is disabled),
   when the debounce fires, then `emphasize{nodeId:null}` clears the emphasis. Last-wins; no trail.
   [Source: _bmad-output/planning-artifacts/epics.md:626]
3. **(AC3 — echo suppression)** Given a Story 6.2 sync-initiated cursor jump, when the resulting
   CursorMoved fires, then a one-shot suppression flag prevents echoing an `emphasize` back (no
   feedback loop, NFR-8). [Source: _bmad-output/planning-artifacts/epics.md:630]
4. **(AC4 — config gate, minimal)** `sync.highlight_on_cursor` (boolean, default `true`) and
   `sync.cursor_debounce_ms` (positive integer, default `150`) exist as validated `setup()` keys
   with the same fresh-table validation pattern as `sync.jump_on_click`; zero-config keeps both
   defaults. Broader hardening (unknown-key warnings, README/vimdoc) stays in Story 6.4.
   [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-06-11.md:103]
5. **(AC5 — sync invariants preserved)** `emphasize` never carries `v`, never displaces/reorders
   renders, and is stateless last-wins; `server/server.ts` is untouched (the 6.1 relay + its exact
   three-key validation is the contract this story satisfies, not modifies); the Story 6.2
   click→jump path keeps working unchanged. [Source: _bmad-output/planning-artifacts/architecture.md:357]

## Tasks / Subtasks

- [x] **Task 1 — Config: add the two remaining sync keys (AC4)**
  - [x] In `lua/interactive-graphviz/config.lua`, extend `M.defaults.sync` to
    `{ jump_on_click = true, highlight_on_cursor = true, cursor_debounce_ms = 150 }` and extend the
    existing sync fresh-table validation block (lines 235–255): `highlight_on_cursor` must be a
    boolean (warn + default otherwise, mirroring `jump_on_click`); `cursor_debounce_ms` must be a
    positive integer (> 0, `math.floor` check — mirror the `debounce_ms` validation at lines
    102–110). Do NOT add unknown-key warnings (Story 6.4). [Source: lua/interactive-graphviz/config.lua:21]
  - [x] Do **NOT** add a URL param or touch `commands.lua`'s `preview_url` / `frontend/urlconfig.ts`
    for these keys. The gate is enforced **Lua-side at emission** (Lua originates `emphasize`; the
    browser passively applies whatever arrives). Adding a param would needlessly extend the
    urlparam contract test surface. [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-06-11.md:104]
  - [x] Extend `tests/config_spec.lua`: defaults present, valid overrides accepted, invalid types
    warn-and-default, partial `sync` table keeps defaults for unset fields.

- [x] **Task 2 — Lua: line→node reverse matcher in `sync.lua` (AC1, AC2)**
  - [x] Add `M.find_node_at(lines, lnum, col)` (names indicative — keep them testable and pure like
    `find_node_line`). It must reuse the existing DOT-aware scanning machinery — `is_id_byte`,
    `bare_eligible`, the quoted-string unescaper, and the comment/HTML skipping — NOT a new naive
    tokenizer. [Source: lua/interactive-graphviz/sync.lua:16]
  - [x] **Cross-line state:** `find_on_line` carries `block_comment`/`html_depth` across lines; the
    reverse matcher must scan lines `1..lnum` from the top carrying that same state so a cursor
    line inside a `/* */` block or a multi-line HTML label `<...>` yields no node. A refactor that
    lets both directions share one scanner core is welcome; changing `find_node_line`'s observable
    behavior is not (its 16 busted cases + 2 documented deferred limitations are the spec).
    [Source: lua/interactive-graphviz/sync.lua:44]
  - [x] **Candidate extraction on the cursor line:** matchable occurrences are (a) quoted IDs —
    the unescaped body is the candidate id, and (b) maximal bare runs of ID bytes that are
    `bare_eligible` — but skip unquoted DOT **keywords** (`graph`, `digraph`, `subgraph`, `node`,
    `edge`, `strict`, case-insensitive): they are grammar, not nodes (a node literally named
    `node` is only addressable quoted). Numerals are valid bare ids. Port suffixes: for `n:port`,
    the candidate is `n` (colon ends a bare id; inside quotes it is part of the id — same rule as
    6.2). [Source: lua/interactive-graphviz/sync.lua:35]
  - [x] **Column disambiguation:** prefer the candidate whose span contains the cursor column
    (`col`, 1-based byte); if the cursor is not on any candidate (whitespace, punctuation, `->`),
    fall back to the **first** candidate on the line ("node's line" semantics per the UX spec);
    return `nil` when the line has none. [Source: _bmad-output/planning-artifacts/ux-sync-v3.md:30]
  - [x] **Known false-match parity:** attribute keys/values inside `[...]` (e.g. `color` in
    `x [color=red]`) will be extracted as candidates — same statement-context limitation already
    deferred for 6.2's forward matcher. Do not attempt context-aware parsing here; the browser
    resolves a non-node id to "no match → no emphasis", so the degradation is invisible-not-wrong.
    Note it in the Dev Agent Record; it is already recorded in `deferred-work.md`.
    [Source: _bmad-output/implementation-artifacts/deferred-work.md:17]

- [x] **Task 3 — Lua: debounced cursor watcher + emphasize emission (AC1, AC2, AC5)**
  - [x] In `sync.lua`, add `M.start_cursor_watch(bufnr)` / `M.stop_cursor_watch(bufnr)` mirroring
    `render.lua`'s per-buffer timer + augroup pattern exactly (latest-wins timer coalescing, augroup
    `"InteractiveGraphvizSync" .. bufnr` with `clear = true`, `CursorMoved` + `CursorMovedI`
    buffer-scoped autocmds, `timer:start(delay, 0, …)` one-shot + `vim.schedule` re-entry). Debounce
    delay = `config.get().sync.cursor_debounce_ms`. Also add a `stop_all()` mirror for teardown
    symmetry. [Source: lua/interactive-graphviz/render.lua:27]
  - [x] On debounce fire: guard `nvim_buf_is_valid(bufnr)` and `session.has(bufnr)`; read the
    cursor from a window displaying `bufnr` (`vim.fn.win_findbuf` — prefer current window if it
    shows the buffer; if no window shows it, treat as "no node"). **Indexing trap:**
    `nvim_win_get_cursor` returns `{lnum, col}` with a **0-based byte col**; the 6.2 matcher and
    the new reverse matcher speak **1-based** columns (cf. `handle_node_click` passing `col - 1`
    the other way) — convert with `col + 1` or the cursor-on-first-byte case misresolves. Then run
    the reverse matcher; then
    **dedupe**: keep a per-buffer `last_sent` record and send only when the resolved id (or nil)
    differs — resting on the same line must not re-spam identical `emphasize` frames.
  - [x] **The wire frame — exact-keys trap:** the server validates `emphasize` with
    `hasExactlyKeys(message, ["type","sessionId","nodeId"])` and `nodeId` must be a string **or
    JSON `null`**. Lua's `vim.json.encode` **drops `nil`-valued keys**, so the clear frame MUST use
    `vim.NIL`: `server.send({ type = "emphasize", sessionId = bufnr, nodeId = vim.NIL })`. A `nil`
    here silently fails `hasExactlyKeys` and the clear never reaches the browser — this is the #1
    footgun in this story. camelCase wire keys, snake_case type, no `v`, no extra keys.
    [Source: server/server.ts:261] [Source: _bmad-output/planning-artifacts/architecture.md:521]
  - [x] Gate: `commands.lua` `preview()` calls `sync.start_cursor_watch(bufnr)` **only when**
    `config.get().sync.highlight_on_cursor` is true, right beside the existing
    `render.start_watch(bufnr)` registration (same pcall-guard style, same reset-before-start
    discipline via `stop_cursor_watch`); `M.stop()` calls `sync.stop_cursor_watch(bufnr)` beside
    `render.stop_watch(bufnr)`. Disabled ⇒ watcher never installed ⇒ nothing ever emphasized
    (AC2's "disabled" arm). [Source: lua/interactive-graphviz/commands.lua:141]

- [x] **Task 4 — Lua: one-shot echo suppression with 6.2 (AC3)**
  - [x] In `sync.lua`, add a module-level one-shot flag with a consume API (e.g.
    `_suppress_next`, `M.consume_suppression()`); `handle_node_click` sets it **only when the jump
    actually changed the cursor position AND the target window is the current window** (compare
    `nvim_win_get_cursor` before/after; a no-move or cross-tab/other-window jump fires no
    CursorMoved in the current window, so setting the flag there would stale it and swallow the
    user's next legitimate cursor emphasis). [Source: lua/interactive-graphviz/sync.lua:198]
  - [x] The CursorMoved/CursorMovedI callback consumes the flag **before** starting the debounce
    timer: flag set → clear it and return (no timer, no emission). Self-healing by design: if a
    stale flag ever survives, the next real move consumes it and only one emphasis tick is lost.
  - [x] Net user-visible behavior (the UX contract): click → highlight (browser) + cursor lands
    (editor), **no** emphasize round-trip, no flicker. [Source: _bmad-output/planning-artifacts/ux-sync-v3.md:38]

- [x] **Task 5 — Frontend: receive `emphasize`, render passive emphasis (AC1, AC2, AC5)**
  - [x] In `frontend/ws.ts`, add `onEmphasize?: (msg: ProtocolMessage) => void;` to
    `WebSocketClientHandlers` and a `case "emphasize"` to the inbound switch (between
    `session_closed` and `default`). No outbound changes; `sendNodeClick` is untouched.
    [Source: frontend/ws.ts:105]
  - [x] In `frontend/render.ts`, add the DOM bridge (d3/DOM stays in render.ts per convention):
    a module-level `_cursorEmphasisNode: string | null` plus an exported
    `applyCursorEmphasis(nodeId: string | null)` that (a) stores the value, (b) removes the cursor
    class from every `g.node`, and (c) when non-null, adds it to the node whose `groupTitle(g)`
    equals `nodeId`. A nodeId with no matching SVG node (stale buffer text, attr-key false-match,
    not-a-node token) leaves nothing emphasized — miss ≡ clear, which is exactly the graceful
    degradation the design wants. [Source: frontend/render.ts:453]
  - [x] **Class + CSS treatment:** a NEW class (e.g. `ig-cursor`) in a distinct hue from the
    orange click regime (recommend the `#4fc3f7`-family blue) as an **outline/stroke treatment
    only** — it must never set opacity on anything and never dim other elements. Optional subtle
    pulse via CSS keyframes **only when `animationsEnabled()`** (extend the `highlightCss()`
    gating pattern; reduced-motion/`animate=false` gets a static outline). Add the rules to the
    existing injected highlight stylesheet. [Source: frontend/render.ts:398]
  - [x] **Precedence non-contention (the load-bearing property):** `applyHighlightToDom` only
    ever toggles `ig-selected`/`ig-neighbor`/`ig-dimmed`, so an independent `ig-cursor` class is
    additive by construction — verify the click/search paths are byte-untouched. A node that is
    simultaneously search-dimmed and cursor-emphasized shows both (dim opacity + blue outline):
    correct per "purely additive beneath both". [Source: frontend/render.ts:461]
    [Source: _bmad-output/planning-artifacts/ux-sync-v3.md:33]
  - [x] **Re-render survival:** d3-graphviz rebuilds the `#app` subtree every render, wiping
    classes. Re-apply `_cursorEmphasisNode` inside `reapplyHighlightAfterRender()` — AFTER the
    early-return search branch (the cursor class is independent of the highlight regime, so it
    re-applies on both branches); a pruned/renamed node simply no longer matches ⇒ cleared.
    [Source: frontend/render.ts:507]
  - [x] In `frontend/main.ts`, wire `onEmphasize` in the `createWebSocketClient` handler object:
    validate `msg.nodeId` is a string or `null` (anything else: ignore the frame) and call
    `applyCursorEmphasis(msg.nodeId)`. Never touch `v`, never call `queueRender`.
    [Source: frontend/main.ts:56]
  - [x] Add test seams following the established `_`-prefix convention (e.g.
    `_cursorEmphasisSnapshot()`, and clear the stored id in `_resetHighlightState()` or a sibling
    reset). [Source: frontend/render.ts:601]

- [x] **Task 6 — Tests and verification (AC1–AC5)**
  - [x] `tests/sync_spec.lua` — reverse matcher: bare id under cursor; quoted id (spaces, escaped
    quotes, colon-inside-quotes) under cursor; cursor on `->`/whitespace falls back to first
    candidate; cursor column selects the 2nd node on `a -> b`; keywords (`digraph`, `node`,
    `strict`) skipped; numeral ids matched; `n:port` yields `n`; line inside `//`, `#`, `/* */`
    (incl. state carried from an earlier line) and HTML labels yields nil; empty/blank line nil;
    out-of-range lnum nil. Watcher: dedupe logic (same id twice ⇒ one send), suppression
    consume-once semantics, `vim.NIL` present on the clear frame (stub `server.send` and inspect).
  - [x] `tests/config_spec.lua` — the two new keys (defaults, valid, invalid-type warn+default,
    partial-table merge).
  - [x] `tests/commands_spec.lua` — preview() starts the cursor watch when gated on, stops any stale
    cursor watch when `highlight_on_cursor = false`, reconciles the active-session fast path, and
    stop() stops it.
  - [x] `frontend/ws.test.ts` — inbound `emphasize` dispatches to `onEmphasize`; unknown types
    still ignored.
  - [x] `frontend/render.dom.test.ts` — applyCursorEmphasis adds/clears the class; null clears;
    unknown nodeId ⇒ no class anywhere; click-highlight classes coexist untouched (a dimmed node
    can carry the cursor class); post-render reapply restores it; pruned node ⇒ cleared; CSS text
    contains no opacity rule for the cursor class.
  - [x] Server suite must pass **unmodified** — `git diff server/` empty is the AC5 proof, same as
    6.2. Grep-verify no `v` near any `emphasize` construction and `vim.NIL` (not `nil`) on the
    clear path.
  - [x] Full battery: `bun test` in `frontend/` and `server/`, busted over `tests/*_spec.lua`,
    `stylua --check .`, headless nvim smoke, bundle smoke — the same battery 6.2 ran.
    [Source: _bmad-output/implementation-artifacts/6-2-click-node-jump-to-source-line.md:271]

### Review Findings

_Code review 2026-07-02 (Blind Hunter + Edge Case Hunter + Acceptance Auditor; triaged). 0 decision-needed, 1 patch, 5 defer, 7 dismissed. Acceptance audit: all 5 ACs genuinely implemented and tested; server byte-untouched; no scope leaks; no parallel-agent half-merges found (test stubs match source signatures across all touched files)._

- [x] [Review][Patch] `sync.stop_all` iterates `timers`, missing watchers whose debounce already fired — a fired timer nils its entry (sync.lua:463-465), so the steady-state watched buffer (augroup live, no pending timer) is skipped and its augroup survives teardown while `last_sent = {}` is cleared wholesale. Iterate `last_sent` (set for every watched buffer at start, nil'd at stop) instead; the existing "stop_all stops every buffer's watch" spec masks this by arranging pending timers for all buffers — strengthen it with a fired-timer buffer. Impact today is low (sole call site is VimLeavePre teardown) but the fix is one line. [lua/interactive-graphviz/sync.lua:510]
- [x] [Review][Defer] `suppress_next` is a single module-global, not per-buffer: a click-jump with no watcher running (`jump_on_click=true`, `highlight_on_cursor=false`) leaves the flag armed until any future watcher consumes it, and with two watched buffers the wrong buffer can consume it (one echo passes / one legit tick swallowed). Within the spec-locked "self-healing, one-tick cosmetic" design (Task 4 mandates module-level, no TTL), but the in-source comment only reasons about single-buffer staleness — key by bufnr in 6.4 hardening. [lua/interactive-graphviz/sync.lua:295] — deferred, spec-sanctioned degradation → Story 6.4
- [x] [Review][Defer] A running watcher never re-reads `highlight_on_cursor`: `setup({sync={highlight_on_cursor=false}})` mid-session keeps the augroup+timers emitting until the next preview/stop (it does re-read `cursor_debounce_ms`). 6.3's AC gates preview reconciliation; an emission-time config check belongs to 6.4 config hardening. [lua/interactive-graphviz/sync.lua:402] — deferred → Story 6.4
- [x] [Review][Defer] Browser reload/reconnect and fresh preview open can lose the resting emphasis: `last_sent` dedupe suppresses re-emit while the cursor stays on the same node, the server intentionally never replays `emphasize` (not stored as lastGoodRender), and a fresh preview's watch-start reconciliation can fire before the browser subscribes — node stays un-emphasized until the cursor moves to a different node. Dedupe is Design Decision 2 (locked); a fix needs reconnect/subscriber awareness Lua-side, not a fixed delay. [lua/interactive-graphviz/sync.lua:430] — deferred, design-decision consequence
- [x] [Review][Defer] `emit_for_cursor` runs via `vim.schedule` outside the CursorMoved callback's pcall; its internals are individually guarded (buf_is_valid, pcall'd cursor read) so no realistic throw path exists today, but the warn-and-continue guard is not where the comment implies — wrap the scheduled call for symmetry in 6.4. [lua/interactive-graphviz/sync.lua:466] — deferred, hardening
- [x] [Review][Defer] Pre-existing: `render.stop_all` has the identical fired-timer gap (its debounce also nils `timers[bufnr]` on fire, render.lua:48-49, and stop_all walks `timers`, render.lua:88) — sync mirrored the flaw faithfully. Render has no `last_sent`-style registry, so its fix needs a watched-buffers set. [lua/interactive-graphviz/render.lua:88] — deferred, pre-existing

_Code review re-run 2026-07-02 (Blind Hunter + Edge Case Hunter + Acceptance Auditor; triaged). 0 decision-needed, 3 patches, 5 defer (all recorded above / in deferred-work.md), 2 dismissed. Acceptance audit: all 5 ACs satisfied, server byte-untouched, no scope leaks; the Task 5 re-apply wording self-contradiction was resolved correctly in code (re-apply placed before the search early-return, the only placement satisfying "both branches")._

- [x] [Review][Patch] Watch-start did not reconcile emphasis state with the browser. Applied Option 1: `start_cursor_watch` seeds `last_sent[bufnr]` with a fresh sentinel and schedules one `emit_for_cursor`, so re-preview/stop→preview clears stale ghosts or re-emphasizes the current node. Fresh-preview delivery can still be dropped before subscription and is deferred to the reconnect/subscriber-awareness item above. [lua/interactive-graphviz/sync.lua:489, lua/interactive-graphviz/sync.lua:516]
- [x] [Review][Patch] `start_cursor_watch` was not fully idempotent despite its comment: it recreated the augroup and re-seeded `last_sent` but never cancelled an existing `timers[bufnr]`, so a pending debounce from the previous watch survived the restart and fired one stray `emit_for_cursor`. Fixed by cancelling the pending timer at the top, mirroring `stop_cursor_watch`. [lua/interactive-graphviz/sync.lua:484]
- [x] [Review][Patch] `commands.preview()` only reconciled the cursor watch on first session creation; the active-session fast path re-sent the render and returned, so a failed/stopped watcher or a config toggle could leave cursor emphasis inactive or stale. Fixed by centralizing cursor-watch reconciliation and calling it on both the first-open and active-session paths; disabled config stops any stale watcher. [lua/interactive-graphviz/commands.lua:100, lua/interactive-graphviz/commands.lua:148]

## Dev Notes

### Scope Boundary

Ships FR-20 (buffer→graph) end-to-end and the echo-suppression invariant shared with 6.2. Explicitly
**NOT** this story: unknown-config-key warnings, README/vimdoc/UX-spec doc updates, the bookkeeping
sweep (all Story 6.4); any `server/server.ts` or `server/protocol.ts`/`protocol.lua` change (the
protocol spine is complete since 6.1 — if you think you need a protocol change, re-read 6.1 first);
any change to the `node_click` direction beyond adding the suppression-flag set inside
`handle_node_click`; edge/cluster emphasis (nodes only in v3); focus raising.

### Previous Story Intelligence

- **6.1 built the exact relay this story emits into**: `emphasize` is forward-relayed to exactly
  the session's subscribers, validated with `hasExactlyKeys(["type","sessionId","nodeId"])` and
  `nodeId` string-or-null, never stored as lastGoodRender, never carrying `v`. The "null trap" was
  called out there: `emphasize{nodeId:null}` is the ONE sanctioned wire `null` in the whole
  protocol (everything else is omit-never-null). Contract tests for both directions already exist
  in `server/relay.test.ts` — they are your safety net, not your surface.
  [Source: _bmad-output/implementation-artifacts/6-1-activate-the-return-channel-protocol-spine.md:151]
- **6.2's review findings shape the reverse matcher too**: comments (`//`, line-leading `#`,
  `/* */` incl. multi-line) and HTML `<...>` labels must not produce candidates; ID bytes include
  128–255 (Unicode); bare-eligibility gates bare scanning. That intelligence is already encoded in
  `is_id_byte`/`bare_eligible`/`find_on_line` — reuse, don't re-derive.
  [Source: _bmad-output/implementation-artifacts/6-2-click-node-jump-to-source-line.md:126]
- **6.2's window-targeting lesson**: `win_findbuf()[1]` unqualified was a review finding (cursor
  moved invisibly on another tab). The watcher reads the cursor — prefer the current window when it
  displays the buffer; don't invent focus behavior.
  [Source: _bmad-output/implementation-artifacts/6-2-click-node-jump-to-source-line.md:140]
- **Pattern language established by 6.2**: pure logic modules with injected seams, `_`-prefixed
  test-only exports, frontend gates that clamp garbage to defaults, Lua handlers that degrade with
  INFO notifies and never throw. Match it.

### Current Files To Read Before Editing (UPDATE files — current state)

- `lua/interactive-graphviz/sync.lua` — the whole 6.2 module: `is_id_byte`, `bare_eligible`,
  `find_on_line` (state-carrying scanner), `find_node_line`, `handle_node_click` (returns `true`
  only after a successful cursor move — the suppression set-point). This story roughly doubles it;
  preserve every existing behavior (16+ busted cases pin it).
- `lua/interactive-graphviz/render.lua` — the debounce/augroup pattern to mirror verbatim
  (latest-wins timer map, one-shot `timer:start(delay, 0, …)`, `vim.schedule`, `stop_watch`
  cancels timer + deletes augroup). Your watcher is this file with a different payload.
- `lua/interactive-graphviz/server.lua` — `M.send(msg)` queues until `ready` then
  `vim.json.encode`s one line; `dispatch` handles `node_click` via pcall into sync.lua. You only
  CALL `M.send`; do not touch dispatch.
- `lua/interactive-graphviz/config.lua` — the sync fresh-table validation block to extend
  (lines 235–255) and the `debounce_ms` positive-integer pattern to copy (lines 102–110).
- `lua/interactive-graphviz/commands.lua` — `preview()`'s watch-registration block
  (lines 140–150: reset-before-start, pcall-guarded) and `stop()`'s teardown (lines 204–207).
- `frontend/render.ts` — `groupTitle`, `applyHighlightToDom` (the three-class regime you must NOT
  join), `reapplyHighlightAfterRender` (your re-apply hook; note the search early-return),
  `highlightCss()`/`ensureHighlightStyle()` (the animation-gated CSS injection to extend),
  `_resetHighlightState` (test-seam home).
- `frontend/ws.ts` — the inbound switch; `onMessage` fires for every frame, typed handlers per
  case. `emphasize` currently falls to `default` (ignored) — that's the branch you're claiming.
- `frontend/main.ts` — the single `createWebSocketClient` call site; handler wiring happens here,
  after `applyUrlConfig` (ordering note at the top of the file is load-bearing for config, not for
  this handler).

### Architecture Guardrails

- **`v` is render-only.** `emphasize` never carries, mints, or inspects `v`; it is transient
  last-wins state and can never displace or reorder renders (NFR-8).
  [Source: _bmad-output/planning-artifacts/architecture.md:357]
- **Wire shape:** one JSON object per line/frame; `type` snake_case, field keys camelCase (even in
  Lua wire tables); no `{data:…}` wrapper. The clear value is JSON `null` via `vim.NIL` — the one
  sanctioned wire null. [Source: _bmad-output/planning-artifacts/architecture.md:521]
- **Server is a relay; don't touch it.** The emphasize fan-out, validation, and cross-session
  scoping shipped in 6.1. `git diff server/` must stay empty.
  [Source: _bmad-output/planning-artifacts/architecture.md:350]
- **Line→node mapping lives Lua-side, on demand.** No maintained source map, no new deps, frontend
  stays dumb (it resolves a nodeId against SVG titles it already has).
  [Source: _bmad-output/planning-artifacts/architecture.md:367]
- **Emphasis precedence (UX law):** open search query owns the highlight; click selection next;
  cursor echo is purely additive beneath both — outline/pulse, never dims, never joins the
  selected/neighbor/dimmed class regime. [Source: _bmad-output/planning-artifacts/ux-sync-v3.md:30]
- **Session-map ownership unchanged;** the watcher checks `session.has(bufnr)` read-only.
  [Source: _bmad-output/planning-artifacts/architecture.md:550]
- **No new install prerequisites** (NFR-1 / SM-C1): everything ships in the existing binary +
  bundled frontend. [Source: _bmad-output/planning-artifacts/epics.md:184]

### Design Decisions Locked For This Story

1. **No URL param for this direction.** `highlight_on_cursor`/`cursor_debounce_ms` gate emission in
   Lua; the browser is a passive receiver. The urlparam contract test's canonical set stays at 7.
2. **Dedupe at the watcher** (send only on resolved-id change) — resting on a line must not stream
   identical frames every `CursorMoved` tick.
3. **Miss ≡ clear on the frontend.** An `emphasize` nodeId with no matching `g.node` title leaves
   nothing emphasized. This single rule gracefully absorbs stale renders, attr-key false-matches,
   and non-node tokens — no notify, no error (the editor side must never nag during typing).
4. **Suppression is set-if-actually-moved, consume-once, self-healing** (Task 4). Do not build a
   timestamp/TTL mechanism; the guards make staleness a one-tick cosmetic at worst.
5. **`CursorMoved` + `CursorMovedI`** (buffer-scoped) with the uv-timer debounce — NOT `CursorHold`
   (`updatetime` is user-global and typically 4000ms; the AC demands a configurable 150ms).

### Project Structure Notes

- Grows: `lua/interactive-graphviz/sync.lua`, `frontend/render.ts`, `frontend/ws.ts`,
  `frontend/main.ts`, `lua/interactive-graphviz/config.lua`, `lua/interactive-graphviz/commands.lua`.
- Tests grow in place: `tests/sync_spec.lua`, `tests/config_spec.lua`, `tests/commands_spec.lua`,
  `frontend/ws.test.ts`, `frontend/render.dom.test.ts`.
- `frontend/sync.ts` may gain nothing this story — the emphasis DOM bridge belongs in `render.ts`
  (convention: d3/DOM stays there; sync.ts is the pure outbound gate). Only extend sync.ts if you
  find genuinely pure receive-side state worth isolating; do not move DOM work into it.
- No new files expected on the frontend; Lua side adds no new module (sync.lua is the home).

### Git Intelligence

`ff87fff` (6.2 review patches), `aa32764` (6.2 feature), `61082f1` (6.1 spine) are the direct
substrate — read their diffs if any anchor above has drifted. Commit-message style:
`feat(sync): …` for the feature, review patches as `fix(sync): …`.

### Testing Standards

- Frontend: `bun test` in `frontend/` (happy-dom for DOM tests). Server: `bun test` in `server/`
  (must pass with zero source changes). Lua: busted over `tests/*_spec.lua` (local harness:
  `~/.luarocks`, Lua 5.4 — CI runs 5.1; keep specs 5.1-compatible). Format: `stylua --check .`.
- Watcher specs: stub `vim.uv.new_timer`/autocmds the way `tests/render_spec.lua` and
  `tests/commands_spec.lua` already stub them — copy those harness patterns, don't invent new ones.

### Project Context Reference

No `project-context.md` exists in this workspace at story-creation time; this story is grounded in
the BMad planning artifacts (epics.md, ux-sync-v3.md, architecture.md "Return Channel Activation
(v3)", sprint-change-proposal-2026-06-11.md), Stories 6.1/6.2, and the current source files read
above at baseline `ff87fff`.

## Dev Agent Record

### Agent Model Used

Claude Fable 5 (claude-fable-5) via Claude Code.

### Implementation Plan

- Task 1 (config keys + specs) was found already implemented in the working
  tree at dev start, matching the story spec exactly (fresh-table validation,
  `debounce_ms`-style warning copy); verified green (config_spec 54/54) and
  adopted rather than rewritten.
- Reverse matcher: extracted a shared `read_quoted` helper from `find_on_line`
  (behavior-identical — the 16 pinned 6.2 cases stay green), then added
  `walk_line` (same skip rules, candidate collection: quoted bodies + bare
  eligible non-keyword tokens, port suffixes excluded, `3.14`-style numerals
  reglued) and `find_node_at` (state carried from line 1, cursor-column span
  preferred, first-candidate fallback).
- Watcher: `start/stop_cursor_watch` + `stop_all` mirror render.lua's
  latest-wins timer/augroup pattern verbatim; emission dedupes on resolved id
  per buffer (NONE sentinel — a fresh watch on a non-node line sends nothing);
  the clear frame uses `vim.NIL` so the key survives `vim.json.encode` and the
  server's `hasExactlyKeys` validation.
- Suppression: armed inside `handle_node_click` only when the jump moved the
  cursor in the CURRENT window (before/after position compare); consumed by
  the watcher callback before any timer is armed. Self-healing on staleness.
- Frontend: `ws.ts` gained the `emphasize` dispatch case; `render.ts` owns the
  DOM bridge (`applyCursorEmphasis`, module-level last-wins id, re-asserted in
  `reapplyHighlightAfterRender` on BOTH the search-owned and click-owned
  branches); the `ig-cursor` treatment is stroke-only (`#4fc3f7`) with
  `:not(.ig-selected):not(.ig-neighbor)` encoding the precedence law in CSS,
  and an animation-gated stroke-opacity pulse. `main.ts` validates
  nodeId string-or-null before applying (garbage frames ignored, not treated
  as clear).

### Debug Log References

- Full battery 2026-07-02: busted `tests/*_spec.lua` 206 pass (sync_spec 65,
  config_spec 54, commands_spec 41) / `bun test` frontend 151 pass / `bun
  test` server 71 pass / root `bun test` incl. e2e 224 pass / `stylua --check
  .` clean / headless nvim smoke exit 0 / `bun build frontend/index.html`
  bundle smoke OK.
- `git diff server/` empty — AC5 held by construction (byte-identical to the
  6.2 commit).
- Grep verification: the only `emphasize` construction site carries exactly
  {type, sessionId, nodeId}, no `v`; clear path uses `vim.NIL` (line 441);
  Lua 5.1/LuaJIT syntax check via nvim `loadfile` OK on all six touched Lua
  files.
- One test-authoring fix during dev: cursor inside a trailing `//` comment on
  a line that also holds live nodes falls back to the line's first candidate
  (line-level semantics) — the spec's expectation was corrected, not the code.

### Completion Notes List

Ultimate context engine analysis completed - comprehensive developer guide created.

- All 5 ACs implemented and tested. AC5 by construction: zero server changes;
  all 6.2 matcher/jump/emission tests still green; no sync message carries `v`.
- Scope boundary respected: no unknown-key warnings, no README/vimdoc/UX-spec
  updates, no bookkeeping sweep (Story 6.4); no protocol changes; nodes only.
- Suite deltas: busted 163→206 (+43: find_node_at 12, suppression 4, watcher
  15, config 5, commands gate 5, plus stylua-split refactors), frontend
  142→151 (+9: ws emphasize dispatch 2, render.dom cursor emphasis 7).
- Known parity limitations documented in-code and covered by tests: attribute
  keys/graph names inside statements can become candidates (browser miss ≡
  clear, never wrong); leading-dot/negative numerals un-reglued (same
  degradation). Both mirror the 6.2 deferred-work items.
- Teardown symmetry (Task 3's stop_all mirror) wired into lifecycle.lua:
  BufDelete/BufWipeout and VimLeavePre teardown stop the cursor watch exactly
  as they stop the render watch; asserted in lifecycle_spec (6 cases green,
  suite re-run after the change: busted 206, stylua clean).
- Note for the record: this story was implemented by two agents sharing the
  same checkout concurrently (implementation+specs vs lifecycle+verification);
  overlaps reconciled and the combined battery re-run green afterwards.

### File List

- `lua/interactive-graphviz/config.lua` — sync defaults + validation for
  `highlight_on_cursor` / `cursor_debounce_ms` (adopted pre-existing WT change)
- `lua/interactive-graphviz/sync.lua` — read_quoted extraction; walk_line +
  find_node_at reverse matcher; consume_suppression + arming in
  handle_node_click; start/stop_cursor_watch, stop_all, debounced emit with
  vim.NIL clear
- `lua/interactive-graphviz/commands.lua` — preview() gate-wired cursor-watch
  registration; stop() unconditional teardown
- `frontend/ws.ts` — `onEmphasize` handler + `emphasize` dispatch case
- `frontend/render.ts` — ig-cursor CSS (stroke-only, precedence-encoding
  :not() selectors, gated pulse); applyCursorEmphasis; post-render re-assert;
  `_cursorEmphasisSnapshot` seam; `_resetHighlightState` clears cursor state
- `frontend/main.ts` — onEmphasize wiring with string-or-null validation
- `tests/sync_spec.lua` — harness extended (timers/autocmds/NIL sentinel/
  config/server/session stubs); +31 cases for reverse matcher, suppression,
  watcher
- `tests/config_spec.lua` — +5 Story 6.3 validation cases (adopted WT change)
- `tests/commands_spec.lua` — make_sync stub + loader/cleanup wiring; +5
  cursor-sync gate cases
- `frontend/ws.test.ts` — +2 emphasize dispatch cases
- `frontend/render.dom.test.ts` — +7 cursor-emphasis DOM cases
- `lua/interactive-graphviz/lifecycle.lua` — teardown symmetry: BufDelete
  calls sync.stop_cursor_watch beside render.stop_watch; teardown() calls
  sync.stop_all before shutdown (same live-timer rationale as render)
- `tests/lifecycle_spec.lua` — make_sync_stub + loader/cleanup wiring;
  teardown ordering asserts render→sync→shutdown→reset; BufDelete asserts the
  cursor watch is torn down for the deleted buffer
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status tracking

## Change Log

- 2026-07-02: Story 6.3 implemented — resting the cursor on a node's line
  emphasizes that node in the Preview (debounced `sync.cursor_debounce_ms`,
  gated by `sync.highlight_on_cursor`, both new validated setup() keys);
  leaving or missing clears via `emphasize{nodeId:null}` (vim.NIL); 6.2
  click-jumps are echo-suppressed one-shot. Server byte-untouched. All suites
  green (busted 206, frontend 151, server 71, e2e, stylua, nvim smoke, bundle
  smoke). Status → review.
- 2026-07-02: Code review (Blind Hunter + Edge Case Hunter + Acceptance Auditor):
  all 5 ACs confirmed; 1 patch applied — `stop_all` now iterates `last_sent`
  (all watched buffers) instead of `timers`, so watchers whose debounce already
  fired are torn down too; +1 sync_spec case (red against the old code); 5
  minors deferred to deferred-work.md (mostly → Story 6.4); 7 findings
  dismissed as parity/false-positive. Battery re-run green (busted 207,
  stylua). Status → done.
