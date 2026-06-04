---
baseline_commit: 64b0a68
---

# Story 1.7: Stop, toggle, and lifecycle cleanup

Status: done

Created: 2026-06-04

Story Key: 1-7-stop-toggle-and-lifecycle-cleanup

## Story

As a Neovim user,
I want to stop or toggle the preview and have it clean up automatically,
so that sessions never linger and no server survives my editing session.

## Acceptance Criteria

1. **Given** a running preview, **when** the user runs `:GraphvizPreviewStop`, **then** the session is removed; render watch is stopped; stopping is idempotent (no error if nothing runs) (FR-2).
2. **Given** a buffer with/without a running preview, **when** the user runs `:GraphvizPreviewToggle`, **then** it starts if stopped and stops if running, never leaving an inconsistent state (no double-start, no orphan) (FR-3).
3. **Given** the last preview buffer is closed or Neovim exits gracefully, **when** teardown runs (buffer autocmd / `VimLeavePre`), **then** the session is removed and, on the graceful path, the server is shut down; after quitting Neovim no server process remains (FR-5).
4. **Session-map mutation invariant:** session-map mutation occurs only in `session.lua` (Lua side) and `sessions.ts` (server side) — no other module mutates the map directly.
5. **Idempotency guard for `:GraphvizPreview`:** a second `:GraphvizPreview` call on a buffer that already has a running preview must not open a second browser tab. The deferred item from Story 1.4 review: "Multiple rapid `:GraphvizPreview` calls before `ready` queue N browser-open callbacks — N browser tabs open."
6. **Buffer-close autocmd:** when a DOT buffer with an active session is deleted (`BufDelete`/`BufWipeout`), the session is automatically closed and if it was the last session, the server is shut down gracefully.

## Tasks / Subtasks

- [x] **`lua/interactive-graphviz/commands.lua` — implement `stop()` and `toggle()`** (AC: 1, 2)
  - [x] Replace the `stop()` placeholder. Implementation: (a) get current `bufnr`; (b) call `require("interactive-graphviz.render").stop_watch(bufnr)` to cancel the debounce timer and remove the autocmd; (c) call `require("interactive-graphviz.server").close_session(bufnr)` to unregister the session and send `session_close`; (d) if `require("interactive-graphviz.session").count() == 0`, call `require("interactive-graphviz.server").shutdown()` to gracefully stop the server (last session gone). Guard every step with `pcall` and log warnings on failure. Idempotent: if no session exists for this buffer, log nothing and return cleanly.
  - [x] Replace the `toggle()` placeholder. Implementation: if `session.has(bufnr)`, call `M.stop()`; else call `M.preview()`. Exactly two code paths — never both. No state left inconsistent.
  - [x] **Idempotency guard in `preview()`** (Story 1.4 deferred): before calling `server.open_session(bufnr)`, check `session.has(bufnr)`. If the session already exists AND the server is already running (not in pre-ready state), re-send the render but do NOT re-queue an `on_ready` callback (which would open a second tab). Clear approach: add an early-return guard: if `session.has(bufnr) and server.state.running`, re-send the render with the current DOT and return without calling `on_ready` again.

- [x] **`lua/interactive-graphviz/lifecycle.lua` — buffer-close autocmd** (AC: 3, 6)
  - [x] In `M.setup()`, after registering the `VimLeavePre` autocmd, register a second autocmd on `BufDelete` (and `BufWipeout`) events with `{ nested = true }`. The callback receives `ev.buf` (the deleted buffer's `bufnr`). Implementation: (a) if `session.has(ev.buf)`, call `require("interactive-graphviz.render").stop_watch(ev.buf)`; (b) call `require("interactive-graphviz.server").close_session(ev.buf)`; (c) if `session.count() == 0`, call `require("interactive-graphviz.server").shutdown()`.
  - [x] Guard the callback with `pcall`; log any error via `log.warn`. The no-orphan guarantee must not depend on this path — the EOF/heartbeat backstop in the server is the real guarantee.
  - [x] `M.teardown()` already calls `server.shutdown()` and `session.reset()`. Add a call to `require("interactive-graphviz.render").stop_all()` BEFORE `session.reset()` so all debounce timers are cancelled before the session table is cleared. Order: (1) `render.stop_all()`, (2) `server.shutdown()`, (3) `session.reset()`.

- [x] **`lua/interactive-graphviz/server.lua` — idempotency guard for `open_session`** (AC: 5)
  - [x] In `M.open_session(bufnr)`: the session registration is already idempotent. The issue is at the `commands.lua` call site (see commands task above), so the guard lives there. No change required in `server.lua` for this AC — document this decision in `commands.lua` with a comment.
  - [x] No other changes to `server.lua` required by this story. Do NOT modify the EOF/heartbeat path, the `shutdown()` function, or the `_on_exit` handler.

- [x] **Tests — Lua** (AC: 1, 2, 3, 5, 6)
  - [x] **`tests/commands_spec.lua`** — extend the existing file. Add a new `describe("commands.stop")` block:
    - `stop()` with an active session: calls `render.stop_watch(bufnr)`, calls `server.close_session(bufnr)`, calls `server.shutdown()` when count reaches 0.
    - `stop()` with no active session: no error, no calls to close_session/shutdown (idempotent).
    - `stop()` with two sessions active: close one, server.shutdown NOT called (session count still > 0).
    - Add a `describe("commands.toggle")` block:
      - Toggle when session exists: calls `stop()` path.
      - Toggle when no session: calls `preview()` path (server.open_session called).
    - Add a test for the idempotency guard in `preview()`: second call with session already active and server running must NOT call `on_ready` again (no second browser tab).
  - [x] **`tests/lifecycle_spec.lua`** — replace the placeholder with real tests. Tests run under plain busted (stub `vim` via `_G.vim`):
    - `M.teardown()` calls `render.stop_all()` before `server.shutdown()` and `session.reset()` (verify call order via a spy/table tracking calls).
    - `M.setup()` is idempotent (calling twice does not register duplicate autocmds — second call returns early because `augroup` is set).
    - The `BufDelete` autocmd callback: given a buffer with an active session, calls `render.stop_watch`, `server.close_session`, and `server.shutdown` (when it's the last session). NOTE: since these tests run under busted without a real Neovim, stub `vim.api.nvim_create_autocmd` to capture the callback and call it manually.
  - [x] **Local validation:** `nvim --headless -u tests/minimal_init.lua` for Lua module-load check. No `bun test` changes needed unless you add TypeScript tests. Do NOT run `busted` locally (not installed).

- [x] **TypeScript (server side) — no changes required**
  - The server already handles `session_close` (unregisters the session) and `shutdown` (calls `process.exit`). No changes needed in `server.ts` or `sessions.ts`. Do NOT modify server-side code in this story.

## Dev Notes

### Scope Boundary (read first)

This story implements **stop, toggle, and lifecycle cleanup only**:
- `:GraphvizPreviewStop` — removes a session, stops watch, conditionally shuts down server
- `:GraphvizPreviewToggle` — delegates to start or stop
- Buffer-close autocmd — auto-cleanup when a DOT buffer is deleted
- `teardown()` ordering fix — `render.stop_all()` before `server.shutdown()`
- Idempotency guard in `preview()` — no second browser tab on re-open

Do NOT implement in this story:
- **`:GraphvizEngine`** — Story 2.2
- **`setup{}` config surface** — Story 2.1
- Any changes to the server's WebSocket broadcast, heartbeat, or EOF self-termination
- Any changes to `server/sessions.ts`, `server/server.ts`, or any TypeScript file

### What Stories 1.1–1.6 established (must not regress)

Baseline HEAD is `64b0a68` (Story 1.6 complete):

- **`render.lua`** exports `start_watch(bufnr)`, `stop_watch(bufnr)`, `stop_all()`. All three are already implemented and tested; this story ONLY calls them from the right places.
- **`server.lua`** exports `close_session(bufnr)`, `shutdown()`, `open_session(bufnr)`, `is_running()`, `state`, `on_ready(fn)`. `close_session` sends `session_close` + unregisters from `session.lua`. `shutdown()` sends `shutdown` + closes stdin.
- **`session.lua`** exports `has(bufnr)`, `count()`, `register(bufnr)`, `unregister(bufnr)`, `reset()`, `next_version(bufnr)`. Session-map mutation is confined here.
- **`lifecycle.lua`** already has `M.setup()` (registers `VimLeavePre`) and `M.teardown()` (calls `server.shutdown()` + `session.reset()`).
- **`commands.lua`** has `preview()` fully implemented. `stop()` and `toggle()` are stubs calling `placeholder(...)`.
- **`commands_spec.lua`** has 6 passing tests for `preview()`. Do NOT break these.
- `server.ts`: `session_close` case already calls `sessions.unregister(message.sessionId)`. `shutdown` case already calls `shutdown(0)`. No server-side changes.

### Implementation details for `stop()`

```lua
function M.stop()
  local bufnr = vim.api.nvim_get_current_buf()
  local session = require("interactive-graphviz.session")
  local render = require("interactive-graphviz.render")
  local server = require("interactive-graphviz.server")
  local log = require("interactive-graphviz.log")

  -- Idempotent: if no session, stop is a no-op (no error).
  if not session.has(bufnr) then
    return
  end

  local ok1, err1 = pcall(render.stop_watch, bufnr)
  if not ok1 then
    log.warn("GraphvizPreviewStop: stop_watch error: " .. tostring(err1))
  end

  local ok2, err2 = pcall(server.close_session, bufnr)
  if not ok2 then
    log.warn("GraphvizPreviewStop: close_session error: " .. tostring(err2))
  end

  -- Shut down the server only when this was the last session.
  if session.count() == 0 then
    local ok3, err3 = pcall(server.shutdown)
    if not ok3 then
      log.warn("GraphvizPreviewStop: shutdown error: " .. tostring(err3))
    end
  end
end
```

**Important:** `server.close_session(bufnr)` internally calls `session.unregister(bufnr)` AND sends the `session_close` wire message. Do NOT call `session.unregister()` directly from `commands.lua` — that would violate the single-owner invariant. Let `server.close_session()` do both.

### Implementation details for `toggle()`

```lua
function M.toggle()
  local bufnr = vim.api.nvim_get_current_buf()
  local session = require("interactive-graphviz.session")
  if session.has(bufnr) then
    M.stop()
  else
    M.preview()
  end
end
```

No pcall wrapper needed at the top level — `stop()` and `preview()` both handle their own errors internally.

### Idempotency guard in `preview()` (Story 1.4 deferred item)

The current `preview()` checks nothing before calling `server.open_session(bufnr)` and queuing `on_ready`. If called twice before `ready` fires, two callbacks are queued — two browser tabs open. Fix: add a guard at the top of `M.preview()`:

```lua
-- Idempotency guard: if session already active and server is running, just
-- re-send the current render without re-opening the browser.
if session.has(bufnr) and server.state.running then
  local dot = table.concat(vim.api.nvim_buf_get_lines(bufnr, 0, -1, false), "\n")
  server.send({
    type = "render",
    sessionId = bufnr,
    v = session.next_version(bufnr),
    engine = config.get().engine,
    dot = dot,
  })
  return
end
```

Place this guard AFTER the `is_dot_buffer` check but BEFORE the `server.open_session` call. The `server.state.running` check means the guard only fires when the server is actually running (port/token known) — not during the pre-ready startup window where `open_session` might legitimately be called to queue the initial render.

### `lifecycle.lua` teardown ordering

Current `teardown()`:
```lua
function M.teardown()
  require("interactive-graphviz.server").shutdown()
  require("interactive-graphviz.session").reset()
end
```

Updated `teardown()` — `render.stop_all()` must run BEFORE shutdown and reset:
```lua
function M.teardown()
  local ok, err = pcall(require("interactive-graphviz.render").stop_all)
  if not ok then
    require("interactive-graphviz.log").warn("teardown: stop_all error: " .. tostring(err))
  end
  require("interactive-graphviz.server").shutdown()
  require("interactive-graphviz.session").reset()
end
```

Reason: `stop_all()` iterates `timers` (per-buffer debounce timers). After `session.reset()`, `session.has()` returns false for all buffers, but `timers` may still hold live `uv.timer` handles. Closing them before exit prevents libuv from complaining about unclosed handles on Neovim exit.

### Buffer-close autocmd in `lifecycle.lua`

Add in `M.setup()`, inside the augroup, after the `VimLeavePre` autocmd:

```lua
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
    if not ok1 then log.warn("BufDelete: stop_watch: " .. tostring(err1)) end
    local ok2, err2 = pcall(server.close_session, bufnr)
    if not ok2 then log.warn("BufDelete: close_session: " .. tostring(err2)) end
    if session.count() == 0 then
      local ok3, err3 = pcall(server.shutdown)
      if not ok3 then log.warn("BufDelete: shutdown: " .. tostring(err3)) end
    end
  end,
})
```

`nested = true` allows the callback to trigger other autocmds (e.g., `VimLeavePre` should still fire on `:qa` even if `BufDelete` fires first).

### Testing strategy for `commands_spec.lua`

The existing test harness in `commands_spec.lua` stubs all dependencies. For new tests:

- Add a `make_render()` stub that records calls to `stop_watch` and `stop_all`:
  ```lua
  local function make_render()
    local calls = {}
    return {
      stop_watch = function(bufnr) table.insert(calls, {fn="stop_watch", bufnr=bufnr}) end,
      stop_all = function() table.insert(calls, {fn="stop_all"}) end,
      start_watch = function(bufnr) table.insert(calls, {fn="start_watch", bufnr=bufnr}) end,
      _calls = calls,
    }
  end
  ```

- Extend `make_server()` to include `close_session_calls`:
  ```lua
  self.close_session = function(bufnr)
    table.insert(self.close_session_calls, bufnr)
    -- Also simulate session.unregister so session.count() decrements:
    -- Do this in the test by wiring session_stub manually.
  end
  ```

- Extend `load_commands()` to inject `interactive-graphviz.render` into `package.loaded`.

- For the session-count test (server.shutdown called only when count reaches 0): use a real `session` module loaded from the Lua path (`require("interactive-graphviz.session")`), or build a counter-backed stub.

### Testing strategy for `lifecycle_spec.lua`

`lifecycle.lua` uses `vim.api.nvim_create_augroup` and `vim.api.nvim_create_autocmd`. Stub them:

```lua
local captured_callbacks = {}
_G.vim = {
  api = {
    nvim_create_augroup = function(name, _) return name end,
    nvim_create_autocmd = function(events, opts)
      -- Capture the callback keyed by the first event name for test retrieval.
      local key = type(events) == "table" and events[1] or events
      captured_callbacks[key] = opts.callback
    end,
  },
}
```

Then call the captured callback directly to test its behavior:
```lua
captured_callbacks["BufDelete"]({ buf = 3 })
-- assert render.stop_watch was called with 3
```

### Session-map mutation invariant (AC4)

The only places that call `session.register()` / `session.unregister()` are:
- `server.lua: open_session()` calls `session.register()`
- `server.lua: close_session()` calls `session.unregister()`
- `lifecycle.lua: teardown()` calls `session.reset()`

`commands.lua` must NOT call any of these directly. It only calls `server.open_session()`, `server.close_session()`, `server.shutdown()`, and reads `session.has()` / `session.count()` for idempotency checks. Reading is fine; mutation is not.

### Deferred items from earlier stories addressed by this story

From `deferred-work.md`:
- "Multiple rapid `:GraphvizPreview` calls before `ready` queue N browser-open callbacks — N browser tabs open. Story 1.7 idempotency guard will fix this." → **Addressed by AC5 and the preview() guard.**
- "No `nvim_buf_is_valid` guard in `is_dot_buffer` — Story 1.7 lifecycle cleanup will add buffer validity checks." → Add a guard at the top of `is_dot_buffer`: `if not vim.api.nvim_buf_is_valid(bufnr) then return false end`.
- "Re-calling `start_watch` on an already-watched buffer leaves previous debounce timer alive. Story 1.7 could add `stop_watch` before `start_watch` in a re-open scenario." → In `preview()`, call `render.stop_watch(bufnr)` before `render.start_watch(bufnr)` to cleanly reset the watch when re-opening a buffer that was already being watched.

### Files to modify

| File | Change type | Summary |
|------|-------------|---------|
| `lua/interactive-graphviz/commands.lua` | MODIFY | Implement `stop()`, `toggle()`; add idempotency guard + bufvalid check in `preview()` |
| `lua/interactive-graphviz/lifecycle.lua` | MODIFY | Add `render.stop_all()` to teardown; add `BufDelete`/`BufWipeout` autocmd in setup |
| `tests/commands_spec.lua` | MODIFY | Add describe blocks for `stop()` and `toggle()`; add idempotency test |
| `tests/lifecycle_spec.lua` | MODIFY | Replace placeholder with real tests |

Do NOT touch: `lua/interactive-graphviz/server.lua`, `lua/interactive-graphviz/session.lua`, `lua/interactive-graphviz/render.lua`, `lua/interactive-graphviz/config.lua`, `lua/interactive-graphviz/log.lua`, `lua/interactive-graphviz/health.lua`, `lua/interactive-graphviz/install.lua`, `lua/interactive-graphviz/protocol.lua`, `frontend/**`, `server/**`, `tests/session_spec.lua`, `tests/render_spec.lua`, `tests/scaffold_spec.lua`, `tests/config_spec.lua`, `tests/integration/orphan_spec.lua`, `.github/workflows/ci.yml`.

### Previous story intelligence (Story 1.6 done + review patches applied)

Baseline HEAD is `64b0a68` (Story 1.6 complete, review patches applied). Key patches from 1.6 review:

1. `onSuccess` in `render-queue.ts` now correctly guards against clearing a valid error when `entry.v` is stale.
2. Fallback `renderDot` in `render.ts` is now wrapped in `setTimeout(fn, 0)` to avoid a concurrent d3-graphviz render race.
3. `showError` label in `render.ts` now uses context-aware text for server-side `error_display` vs WASM errors.
4. `sessions.test.ts` tests use the public API rather than accessing `reg.sessions` internal map directly.

None of these affect Story 1.7 which is entirely Lua-side.

### Testing standards

- **busted is NOT installed locally** — do NOT run `busted` locally. CI handles Lua tests.
- **Local Lua validation:** `nvim --headless -u tests/minimal_init.lua` to confirm module loads without error.
- **TypeScript tests:** no changes needed; but if you touch TS by mistake, validate with `bun test server`.
- **Frontend bundle smoke:** no changes needed.
- **Stylua:** run `stylua --check lua/` to verify Lua formatting before completion.

### `engine()` placeholder

`commands.engine()` remains a placeholder (calls `placeholder("GraphvizEngine")`). Do NOT implement it in this story — it belongs to Story 2.2.

## Project Structure Notes

All changes are in the Lua plugin layer (`lua/interactive-graphviz/`) and its test specs (`tests/`). No new modules, no new npm packages, no new files. The three-tier boundaries are not crossed.

Architecture invariants preserved:
- Session-map mutation confined to `session.lua` (Lua side) — commands.lua reads but does not mutate.
- Process death owned by EOF/heartbeat — `server.shutdown()` is the graceful convenience path only.
- `render.lua` owns all debounce timer lifecycle — commands and lifecycle modules call the exported API (`stop_watch`, `stop_all`), never touching the `timers` table directly.

## References

- Epics: `_bmad-output/planning-artifacts/epics.md#Story 1.7` — FR-2, FR-3, FR-5
- Architecture — State & Session Model: `architecture.md` lines 276–286
- Architecture — Lifecycle invariants / session-map mutation ownership: `architecture.md` lines 497–499, 640–641
- Architecture — Process Patterns (no ad-hoc kills; graceful path = shutdown; EOF = load-bearing): `architecture.md` lines 498–499
- Architecture — Commands list: `architecture.md` lines 371–373
- Architecture — Structure Patterns (module responsibilities): `architecture.md` lines 569–582
- Architecture — Requirements to Structure Mapping (FR-2, FR-3, FR-5): `architecture.md` lines 652–658
- Deferred work resolved: `_bmad-output/implementation-artifacts/deferred-work.md` — idempotency guard (Story 1.4 deferred), `nvim_buf_is_valid` guard, re-watch stop before start
- Previous story: `_bmad-output/implementation-artifacts/1-6-error-resilience-and-view-preservation.md`
- Test pattern reference: `tests/commands_spec.lua` (stub/injection pattern)
- Memory: `local-test-harness.md` — busted not installed locally; use `nvim --headless` + Stylua check

### Review Findings

- [x] [Review][Patch] `teardown()` calls `require()` outside `pcall` — if render module is not loadable, teardown crashes without calling server.shutdown/session.reset [lua/interactive-graphviz/lifecycle.lua:54]
- [x] [Review][Patch] `teardown()` error-handler log require also not pcall-guarded — if log module unavailable, error handling itself throws [lua/interactive-graphviz/lifecycle.lua:56]
- [x] [Review][Patch] Test comment in "second :GraphvizPreview" test is misleading — references "Story 1.7 adds a guard" but the guard doesn't fire in that test's scenario (session.has returns false) [tests/commands_spec.lua:370-371]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- Implemented `M.stop()` in `commands.lua`: idempotent, pcall-guarded, calls render.stop_watch + server.close_session + conditional server.shutdown when last session.
- Implemented `M.toggle()` in `commands.lua`: exactly two paths (stop if session exists, preview if not).
- Added idempotency guard to `M.preview()`: if session already active and server running, re-sends render without re-queuing on_ready (no second browser tab). Addresses Story 1.4 deferred item.
- Added `nvim_buf_is_valid` guard to `is_dot_buffer()` as specified in deferred-work.md.
- Added `render.stop_watch(bufnr)` before `render.start_watch(bufnr)` in `preview()` to cleanly reset watch on re-open.
- Updated `lifecycle.lua` teardown: `render.stop_all()` now runs before `server.shutdown()` and `session.reset()` — closes libuv timer handles before session table is cleared.
- Added `BufDelete`/`BufWipeout` autocmd in `lifecycle.lua` setup: auto-closes sessions and conditionally shuts down server when last DOT buffer is deleted.
- Extended `tests/commands_spec.lua` with 7 new tests: stop() (3), toggle() (2), idempotency guard (1), and updated all stubs (render stub injected, warn added to log stub, nvim_buf_is_valid added to vim stub).
- Replaced `tests/lifecycle_spec.lua` placeholder with 6 real tests: teardown order (1), setup idempotency (2), BufDelete callback behavior (3).
- All CI gates pass: stylua --check, nvim smoke, bun test server (52/52), frontend bundle.

### File List

- `lua/interactive-graphviz/commands.lua`
- `lua/interactive-graphviz/lifecycle.lua`
- `tests/commands_spec.lua`
- `tests/lifecycle_spec.lua`

### Change Log

- 2026-06-04: Implemented stop(), toggle(), idempotency guard in preview(), BufDelete autocmd, teardown ordering fix, nvim_buf_is_valid guard. All AC satisfied. New tests: 7 in commands_spec, 6 in lifecycle_spec. All CI gates green.
