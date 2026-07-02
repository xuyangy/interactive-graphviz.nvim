---
baseline_commit: ed658a21fdd0f7b2ab2ae4b3ddd36b2cf7e77c41
---

# Story 6.2: Click node -> jump to source line

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user reading a Graph in the Preview,
I want clicking a node to put my Neovim cursor on that node's source line,
so that the Preview becomes a navigation surface for the DOT source.

## Acceptance Criteria

_From `epics.md` Story 6.2 [Source: _bmad-output/planning-artifacts/epics.md:590]._

1. **(AC1 - click emits and jumps)** Given an open preview and `sync.jump_on_click = true`, when the
   user clicks a node in the Preview, then the frontend emits
   `node_click{sessionId,nodeId}` and the Neovim cursor moves to the node's first
   definition/occurrence in the buffer - word-boundary matched, quoted-ID aware - via
   `lua/interactive-graphviz/sync.lua`. Epic 5 click-highlight behavior is unchanged: the jump is
   a side effect, not a replacement. [Source: _bmad-output/planning-artifacts/epics.md:593]
2. **(AC2 - stale node degrades gracefully)** Given the clicked node no longer exists in the edited
   buffer, when `node_click` arrives, then Lua shows an informative notify, does not move the
   cursor, and never errors. [Source: _bmad-output/planning-artifacts/epics.md:600]
3. **(AC3 - disabled gate suppresses emission)** Given `sync.jump_on_click = false`, when the user
   clicks a node, then no `node_click` is emitted. The gate is browser-side via the URL-param path.
   [Source: _bmad-output/planning-artifacts/epics.md:604]
4. **(AC4 - matcher coverage)** The node-to-line matcher is covered by busted specs including
   quoted/escaped IDs and multiple-occurrence cases. [Source: _bmad-output/planning-artifacts/epics.md:607]
5. **(AC5 - sync invariants preserved)** Sync messages never carry `v`, never displace/reorder
   renders, and the existing token-gated/subscribed socket security posture from Story 6.1 remains
   the only browser->Lua path. [Source: _bmad-output/planning-artifacts/architecture.md:350]

## Tasks / Subtasks

- [ ] **Task 1 - Add the minimal `jump_on_click` config and URL gate (AC3)**
  - [ ] In `lua/interactive-graphviz/config.lua`, add `sync = { jump_on_click = true }` to defaults
    and validate only this boolean for this story. Do not add `highlight_on_cursor`,
    `cursor_debounce_ms`, unknown-key warnings, README/vimdoc docs, or broader sync hardening here;
    those are Story 6.4. [Source: lua/interactive-graphviz/config.lua:3]
  - [ ] In `lua/interactive-graphviz/commands.lua`, append a deterministic
    `sync_jump_on_click=1|0` URL param alongside the existing config params. Preserve the current
    sessionId/token/preserve/search params and `b01` convention. [Source:
    lua/interactive-graphviz/commands.lua:141]
  - [ ] In `frontend/urlconfig.ts`, parse `sync_jump_on_click` as a strict boolean using the existing
    `parseBoolParam` rule; malformed values are absent/no-op. Feed the parsed value into the
    frontend sync gate. [Source: frontend/urlconfig.ts:46]
  - [ ] Update `frontend/urlconfig.test.ts`, `tests/config_spec.lua`, `tests/commands_spec.lua`, and
    `frontend/urlparam-contract.test.ts` so Lua emission, TS parsing, and defaults agree on the new
    seventh config param. [Source: frontend/urlparam-contract.test.ts:24]

- [ ] **Task 2 - Add frontend sync emission without disturbing click-highlight (AC1, AC3, AC5)**
  - [ ] Create `frontend/sync.ts` as a pure/browser-light sync module. It should own
    `setJumpOnClick`, `getJumpOnClick`, an injectable `setNodeClickSender`, and `emitNodeClick`.
    Default `jump_on_click` is `true`; invalid setter inputs clamp to default. `emitNodeClick`
    returns false and sends nothing when disabled, when `nodeId` is empty, or when no sender is
    registered. [Source: _bmad-output/planning-artifacts/architecture.md:371]
  - [ ] In `frontend/ws.ts`, extend `WebSocketClient` with a narrow outbound method such as
    `sendNodeClick(nodeId: string): boolean`. It must send exactly
    `{ type: "node_click", sessionId: Number(sessionId), nodeId }` only after the socket is open and
    the URL sessionId is numeric. It must never attach `v`, `token`, or extra keys to the
    `node_click` envelope. [Source: frontend/ws.ts:12]
  - [ ] In `frontend/main.ts`, after `createWebSocketClient(...)`, register
    `_wsClient.sendNodeClick` with `frontend/sync.ts`'s sender seam. Keep `main.ts` free of d3/WASM
    imports. [Source: frontend/main.ts:49]
  - [ ] In `frontend/render.ts`, call `emitNodeClick(title)` from `handleAppClick` only for a real,
    non-empty node title. Preserve the existing order and behavior of selection, multi-select,
    Alt-cluster augmentation, background clear, search precedence, CSS classes, and render-lock
    boundaries. A node click must still highlight exactly as Story 5.2/5.3/5.4 currently do.
    [Source: frontend/render.ts:518]

- [ ] **Task 3 - Implement Lua-side node matching and cursor jump (AC1, AC2, AC4)**
  - [ ] Create `lua/interactive-graphviz/sync.lua`. Keep it Lua-side and dependency-free; do not
    build a maintained source map. Export testable helpers for matching, e.g.
    `find_node_line(lines, node_id)` and `handle_node_click(session_id, node_id)`. [Source:
    _bmad-output/planning-artifacts/architecture.md:367]
  - [ ] Matcher requirements: scan the current buffer text at click time; return the first
    definition/occurrence line; match bare IDs with DOT-aware boundaries so `a` does not match
    `alpha`; handle quoted IDs (`"node one"`), escaped quotes/backslashes, IDs used as edge
    endpoints, and multiple occurrences by choosing the first matching line. Ports on an occurrence
    such as `node:port` may match the node id, but a colon inside a quoted ID is part of the ID.
    [Source: _bmad-output/planning-artifacts/prds/prd-interactive-graphviz.nvim-2026-06-02/prd.md:218]
  - [ ] Cursor movement requirements: `sessionId` is the buffer number. Validate the buffer still
    exists before reading/moving. Prefer moving the cursor in a window already displaying that
    buffer (for example via `vim.fn.win_findbuf`); if no displayed window/buffer is available, show
    an informative notify and do not throw. Do not raise the OS window or try to focus Neovim.
    [Source: _bmad-output/planning-artifacts/ux-sync-v3.md:17]
  - [ ] If no matching node line is found, notify clearly, leave the cursor unchanged, and return a
    falsey result for tests. This is the stale-browser/live-reload race path. [Source:
    _bmad-output/planning-artifacts/architecture.md:364]

- [ ] **Task 4 - Replace the 6.1 Lua no-op dispatch with the real handler (AC1, AC2, AC5)**
  - [ ] In `lua/interactive-graphviz/server.lua`, replace the Story 6.1 `node_click` log-and-ignore
    branch with validation plus a protected call to `sync.handle_node_click(msg.sessionId,
    msg.nodeId)`. Invalid `sessionId`/`nodeId` should be logged/ignored, not thrown. Unknown message
    types must still fall through silently as they do now. [Source: lua/interactive-graphviz/server.lua:54]
  - [ ] Do not change `server/server.ts` relay behavior unless tests reveal a contract regression.
    Story 6.1 already validates subscribed/token-bound sockets, session match, exact keys, and no
    `v` on `node_click`. [Source: server/server.ts:165]
  - [ ] Do not add any Lua->browser `emphasize` sender, CursorMoved/CursorHold watcher, or echo
    suppression in this story. Those are Story 6.3. [Source:
    _bmad-output/planning-artifacts/architecture.md:362]

- [ ] **Task 5 - Tests and verification (AC1-AC5)**
  - [ ] Add `tests/sync_spec.lua` for the matcher and cursor-jump behavior: bare ID boundaries,
    quoted IDs with spaces, escaped quoted IDs, endpoints in edge statements, port suffixes,
    multiple occurrences choosing first, stale-node not found, invalid buffer/window graceful path,
    and no thrown errors.
  - [ ] Add frontend tests for `frontend/sync.ts` gate/sender behavior and update
    `frontend/render.dom.test.ts` to assert a node click still selects/highlights and also calls the
    registered sender when enabled; disabled gate suppresses the call; background click does not
    emit. [Source: frontend/render.dom.test.ts:1]
  - [ ] Add/update `frontend/ws` tests if practical with a stubbed `WebSocket`, or cover the outbound
    envelope shape through the sync sender seam. The assertion must prove no `v`, `token`, or extra
    keys appear on `node_click`.
  - [ ] Run `bun test frontend`, `bun test server`, Lua busted over `tests/*_spec.lua`, and
    `stylua --check .`. If a local harness is missing, record the exact command and failure.
  - [ ] Grep-verify no `node_click` sender includes `v` and that `emphasize` behavior from 6.1 is
    untouched.

## Dev Notes

### Scope Boundary

This story ships the first user-visible half of Epic 6: **graph -> buffer**. It should activate the
already-tested `node_click` spine from Story 6.1, add the minimum config/URL gate necessary for
`sync.jump_on_click`, and move the Neovim cursor. It should not implement cursor-to-graph emphasis,
passive emphasis styling, `sync.highlight_on_cursor`, `sync.cursor_debounce_ms`, one-shot echo
suppression, README/vimdoc sync docs, or unknown-key hardening. Those remain Story 6.3/6.4.

The browser focus caveat is intentional: clicking a node moves the cursor in the Neovim buffer, but
the OS/browser focus stays wherever the window manager leaves it. Do not try to raise/focus Neovim.
[Source: _bmad-output/planning-artifacts/ux-sync-v3.md:21]

### Previous Story Intelligence

Story 6.1 is the direct prerequisite. It added canonical `node_click` and `emphasize` types,
validated and relayed `node_click` only from subscribed/token-validated sockets, rejected cross-session
or malformed sync envelopes, and left Lua as log-and-ignore. 6.2 should consume that spine rather
than redefining the protocol. [Source: _bmad-output/implementation-artifacts/6-1-activate-the-return-channel-protocol-spine.md:17]

Specific 6.1 review fixes that must not regress:
- closed/stale sessions must not relay `node_click`;
- `node_click` must reject invalid payloads and any `v`;
- `emphasize` relay must stay transient and no-`v`;
- URL param contracts must stay cross-boundary tested. [Source:
  _bmad-output/implementation-artifacts/6-1-activate-the-return-channel-protocol-spine.md:112]

### Current Files To Read Before Editing

- `frontend/render.ts`: `handleAppClick` currently owns the delegated node click and updates the
  existing `Selection`/highlight classes. Add node-click emission as a side effect only; do not replace
  or reorder highlight behavior. `nodeTitleFromClickTarget` already extracts the SVG `<title>` value
  used as `nodeId`. [Source: frontend/render.ts:419] [Source: frontend/render.ts:518]
- `frontend/ws.ts`: currently authenticates with `hello{sessionId,token}` and dispatches inbound
  frames only. It needs the smallest possible outbound method for `node_click`; keep the envelope
  typed through `ProtocolMessage`. [Source: frontend/ws.ts:33]
- `frontend/urlconfig.ts`: this is the existing Lua->browser config path. Add the sync gate here; do
  not add a new wire message for config. [Source: frontend/urlconfig.ts:1]
- `lua/interactive-graphviz/server.lua`: `dispatch` currently logs-and-ignores `node_click`. Replace
  that branch only; preserve ready/pong/log and unknown-type behavior. [Source:
  lua/interactive-graphviz/server.lua:54]
- `lua/interactive-graphviz/commands.lua`: the preview URL already emits deterministic config params.
  Add `sync_jump_on_click` in the same style. [Source: lua/interactive-graphviz/commands.lua:151]
- `lua/interactive-graphviz/config.lua`: current nested config exists for `search`; use that as the
  merge/validate pattern for the minimal `sync.jump_on_click` table, but leave broader 6.4 validation
  work out. [Source: lua/interactive-graphviz/config.lua:14]

### Architecture Guardrails

- Wire shape is a single JSON object per frame/line. `type` values are snake_case and field keys are
  camelCase on every tier, including Lua wire tables. No `{data: ...}` wrapper. [Source:
  _bmad-output/planning-artifacts/architecture.md:518]
- `v` is render-only. This story must not mint, send, preserve, or inspect `v` on `node_click`.
  [Source: _bmad-output/planning-artifacts/architecture.md:358]
- The server remains a relay. Node-to-line mapping lives in Lua, on demand, with no source map and no
  new dependency. [Source: _bmad-output/planning-artifacts/architecture.md:367]
- Security posture is unchanged: localhost bind, token-gated `hello`, and subscribed-session scoping
  are already enforced by the server. Do not add LAN exposure or token-in-payload behavior. [Source:
  _bmad-output/planning-artifacts/architecture.md:379]
- Session map ownership remains in the existing session modules. Do not mutate server/Lua session
  ownership from sync code. [Source: _bmad-output/planning-artifacts/architecture.md:550]

### Project Structure Notes

- New Lua module: `lua/interactive-graphviz/sync.lua`.
- Likely new frontend module: `frontend/sync.ts`, matching the architecture's planned sync boundary.
- Likely updated tests: `tests/sync_spec.lua`, `tests/config_spec.lua`, `tests/commands_spec.lua`,
  `frontend/sync.test.ts`, `frontend/render.dom.test.ts`, `frontend/urlconfig.test.ts`,
  `frontend/urlparam-contract.test.ts`.
- Avoid server changes unless preserving Story 6.1 tests requires a small test-only adjustment.

### Git Intelligence

Recent commits show v2 interactivity and config work are already in place:
- `ed658a2` released v0.2.0 interactivity parity plus user-settable config;
- `1af7d69` promoted interactivity config to real Lua `setup()` keys and URL params;
- `f52b773` added happy-dom coverage for the live DOM emphasis path.

Use those patterns: pure logic modules with Bun tests, DOM bridge in `render.ts`, Lua setup values
validated in `config.lua`, browser startup config via URL params, and cross-boundary contract tests.

### Testing Standards

- Frontend: `bun test frontend`.
- Server: `bun test server`.
- Lua: busted specs under `tests/*_spec.lua`.
- Formatting: `stylua --check .`.
- Use `_`-prefixed test seams only for tests, following existing frontend conventions.

### Project Context Reference

No `project-context.md` file exists in this workspace at story creation time, so this story is grounded
in the BMad planning artifacts, Story 6.1, and current source files listed above.

## Dev Agent Record

### Agent Model Used

To be filled by the dev agent.

### Debug Log References

### Completion Notes List

Ultimate context engine analysis completed - comprehensive developer guide created.

### File List
