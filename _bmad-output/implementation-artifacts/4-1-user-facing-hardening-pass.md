---
baseline_commit: fa2873f046e139623a2c5ff713d61cdd505b3132
---

# Story 4.1: User-facing hardening pass

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a Neovim user,
I want the rough edges from v1 fixed,
so that the preview behaves predictably before interactivity (Epic 5) is layered on.

## Acceptance Criteria

1. **N-tabs idempotency.** Rapid `:GraphvizPreview` re-invocations open **exactly one** browser tab — including when the calls happen **before** the server has announced `ready` (the still-open gap in v1's existing guard). Re-invocation while a preview is starting or running re-sends the current render but never registers a second browser-open. (FR-1; closes the Story 1.4/1.7 N-tabs deferral.)
2. **Empty-DOT feedback.** When the DOT buffer is empty or whitespace-only, the user gets a **visible, informative message** instead of a silent blank preview. When the buffer gains valid content (initial, live-reload, or engine-change render), normal rendering resumes with no leftover message.
3. **`open_cmd` quoted arguments.** A configured `open_cmd` containing quoted multi-word arguments (e.g. `open -a "Google Chrome"`) launches **as intended** — the quoted token stays intact, not naively split on whitespace. Plain single-word commands and the `nil`/default (`vim.ui.open`) path keep working unchanged.
4. **Windows no-orphan verification.** The no-orphan guarantee — when Neovim dies, the closed stdin pipe (EOF), with the heartbeat watchdog as backstop, self-terminates the server — is **verified on Windows x64** for the shipped `server-windows-x64.exe` prebuilt, not just on POSIX. Closes Epic-3-retro Action Item #2 and the project-memory "Windows no-orphan unverified" note. The result is reported **honestly** — if a Windows host/runner is genuinely unavailable, deliver a runnable Windows verification harness/procedure and state plainly what was and wasn't executed (do not claim verification that did not run).

## Tasks / Subtasks

- [x] **Task 1 — N-tabs idempotency in the pre-`ready` window (AC: 1)**
  - [x] In `lua/interactive-graphviz/commands.lua` `M.preview()`, broaden the early-return idempotency guard so it triggers on `session.has(bufnr)` **regardless of `server.state.running`** (currently `commands.lua:36` also requires `server.state.running`, so a second call during startup falls through and stacks a second `server.on_ready(...)` browser-open callback).
  - [x] On the idempotent path: re-send the current render (as today) and **return without** calling `server.open_session`, `render.start_watch`, or registering another `server.on_ready` browser-open.
  - [x] Preserve the genuinely-new-session path unchanged: first invocation still opens the session, starts the watch, sends the initial render, and registers **one** browser-open.
  - [x] (Defensive, optional) If `session.has(bufnr)` is true but `server.is_running()` is false (server died, stale session), prefer re-establishing cleanly over silently re-sending into a dead server — at minimum do not stack browser-opens.
  - [x] Add/extend a `commands_spec` test asserting that N rapid `preview()` calls before `ready` result in exactly **one** queued/fired browser-open (the existing spec stubs fire callbacks immediately — exercise the deferred-queue ordering explicitly; see Dev Notes on the `on_ready` stub gap).

- [x] **Task 2 — Empty/whitespace-DOT feedback (AC: 2)**
  - [x] Primary fix in `frontend/main.ts` `onRender` (`main.ts:19`): the current `if (dot) queueRender(...)` silently drops empty/whitespace DOT. Replace with: if `dot` is empty/whitespace, render a **visible placeholder message** in `#app` (e.g. "Buffer is empty — nothing to render"); otherwise `queueRender(...)` as today. This single site covers all render sources (initial, live-reload, engine-change) uniformly.
  - [x] Do **not** call `queueRender` for empty DOT — preserve the render-lock + monotonic `v` semantics (don't advance the applied render with a non-render). When a later non-empty render arrives (higher `v`), it renders normally and clears the placeholder.
  - [x] (Optional immediate editor feedback) In `commands.lua M.preview()`, if the initial buffer is empty/whitespace, also `log.notify(...)` an informative INFO message so the user sees feedback in Neovim without switching to the browser. Keep the preview open and live-reloading.
  - [x] Ensure the placeholder does not collide with the last-good-render error overlay (Story 1.6) — empty is an informational state, not a parse error; it must not blank a previously good graph if one is showing. Confirm the intended behavior with `showError`/last-good logic in `frontend/render.ts` and keep them consistent.

- [x] **Task 3 — `open_cmd` quoted-argument handling (AC: 3)**
  - [x] In `commands.lua` (`commands.lua:91-95`), replace the naive `vim.split(open_cmd, "%s+", { trimempty = true })` with a **quote-aware tokenizer** that keeps `"..."` and `'...'` groups intact, then append the URL and pass to `vim.system(parts)`.
  - [x] Keep the config schema unchanged (`open_cmd` stays a string) to minimize blast radius — no `config.lua` validation change required. (If you instead choose to additionally accept a **list** form, that requires a matching `config.lua` validation update; treat as optional enhancement, not required.)
  - [x] Preserve the `nil` default path (`vim.ui.open(url)`), and verify the URL is appended as a **single** final argument (it contains no spaces, but the tokenizer must not mangle it).
  - [x] Add a `commands_spec` (or a small helper unit) test for the tokenizer: `open -a "Google Chrome"` → `{ "open", "-a", "Google Chrome", "<url>" }`; single-word and empty cases.

- [x] **Task 4 — Windows no-orphan verification (AC: 4)**
  - [x] Recommended (real closure): add a **`windows-latest` CI job** that installs Neovim + the built `server-windows-x64.exe`, starts a preview against a headless nvim, terminates the parent nvim **without** a graceful path (Windows equivalent of `kill -9`: `taskkill /F /PID` or process-tree kill), and asserts the server process is gone within the heartbeat-backstop window.
  - [x] The existing `tests/integration/orphan_spec.lua` is **POSIX-only** (`io.popen`, `kill -0`, `kill -9`, `sleep`) — do **not** reuse it as-is. Author a Windows-adapted liveness/kill check (PowerShell `Get-Process`/`Stop-Process` or `tasklist`/`taskkill`), reusing the same harness shape (`IG_PID_FILE`, `IG_HEARTBEAT_TIMEOUT_MS`) so both platforms exercise the same supervision contract.
  - [x] Verify **both** signals on Windows: (a) the stdin-EOF path — does `Bun.stdin.stream()`'s async iterator (`server/server.ts:243`) complete when the parent pipe closes on Windows, reaching `shutdown(0)` at `server.ts:259-262`? (b) the heartbeat watchdog backstop (`server.ts:169-194`) — set `IG_HEARTBEAT_TIMEOUT_MS` low and confirm it reaps even if EOF never arrives.
  - [x] If a Windows runner proves impractical, fall back to a **documented, runnable manual procedure** in the test README and state honestly in Completion Notes that automated Windows verification was not executed. If verification reveals EOF does **not** fire on Windows, the heartbeat backstop must still reap; if neither reaps, that is a real supervision bug — stop and flag it (it expands scope beyond this story).
  - [x] On success, update `_bmad/.../memory` is out of scope, but **note the outcome** in this story's Completion Notes and reference it from the project memory `windows-no-orphan-unverified` (the v2 plan already points that memory here).

- [x] **Task 5 — Verify, lint, regression-guard (all ACs)**
  - [x] `bun test` green in `server/` (esp. `supervisor.test.ts`, `stdio.test.ts` — do not regress the POSIX no-orphan tests while touching anything server-adjacent).
  - [x] Lua specs green via the local shim `tests/support/busted_compat.lua` (busted is **not** installed locally — see project memory `local-test-harness`); CI runs canonical busted.
  - [x] `stylua --check .` clean; `git diff --check` clean.
  - [x] Manual smoke: open a `.dot` buffer, spam `:GraphvizPreview` during startup → one tab; empty the buffer → visible message; set `open_cmd = 'open -a "Google Chrome"'` (macOS) → launches correctly.

## Dev Notes

### Scope discipline
- This is the **only** story in Epic 4 (consolidated by design). It is **hardening, not features** — do **not** start any Epic 5 interactivity work (highlight/search/zoom). `preserve_view` wiring belongs to **Story 5.1**, not here.
- Only the **user-facing** subset of `deferred-work.md` is in scope. Leave the theoretical/style debt (unbounded line buffer, PID-reuse in the orphan test, `validate()` in-place mutation, IIFE complexity, surrogate-pair slice, etc.) **untouched** — it remains documented debt.

### Files being modified (current state → change → preserve)

- **`lua/interactive-graphviz/commands.lua`** (AC 1, 2, 3)
  - *Current:* `M.preview()` has a partial idempotency guard at `:34-46` that early-returns **only** when `session.has(bufnr) and server.state.running`. Browser-open is registered via `server.on_ready(...)` at `:79-99`. `open_cmd` split at `:91-95`.
  - *Change:* broaden the guard to the starting window (Task 1); add empty-buffer notify (Task 2, optional); quote-aware `open_cmd` tokenizer (Task 3).
  - *Preserve:* the new-session path (open_session → start_watch → initial render → single on_ready browser-open); the `is_dot_buffer` no-op-with-message behavior (`:29-32`); the `nvim_buf_is_valid` guards (already present at `:10`, `:80` — a prior deferral already resolved, do not remove).

- **`lua/interactive-graphviz/server.lua`** (AC 1 context; AC 4 mechanism — read-only understanding)
  - *Current:* one server per instance; `state.running` flips true only on `ready` (`:73`); `on_ready` callbacks queued in `state.on_ready_cbs` and fired in `dispatch` `ready` handler (`:80-87`); `M.on_ready` fires immediately if running else queues (`:250-256`). stdin is the parent-death signal (header comment `:8-11`).
  - *Change:* none expected. The N-tabs fix lives in `commands.lua` (don't register the second callback) rather than de-duping inside `server.lua`. If you prefer de-duping here instead, keep `state` mutation confined to this module (architecture invariant) and justify it.
  - *Preserve:* the no-orphan supervision contract — do not alter stdin/heartbeat handling.

- **`frontend/main.ts`** (AC 2)
  - *Current:* `onRender` at `:15-22` does `if (dot) queueRender(dot, engine, v)` — empty DOT silently dropped. `onErrorDisplay` → `showError` at `:23-27`.
  - *Change:* add the empty/whitespace placeholder branch (Task 2).
  - *Preserve:* the `v`-token / render-lock contract (`frontend/render.ts` `queueRender`); don't blank a showing last-good graph for an informational empty state.

- **`server/server.ts`** (AC 4 — verification target, likely no code change)
  - *Current:* stdin loop `:239-263` (`Bun.stdin.stream()` async iterator → on EOF `shutdown(0)`); heartbeat watchdog `:169-194` (`IG_HEARTBEAT_TIMEOUT_MS`, default 3× the Lua ping interval via `server.lua heartbeat_timeout_ms()`); `process.exit` in `shutdown` `:186`.
  - *Change:* none unless Windows verification uncovers a bug.

- **`tests/integration/orphan_spec.lua`** (AC 4)
  - *Current:* POSIX-only headless-nvim `kill -9 → reaped` gate using `io.popen`/`kill -0`. Forces the EOF path by setting `IG_HEARTBEAT_TIMEOUT_MS=30000` so only stdin-EOF (not the backstop) can pass.
  - *Change:* author a Windows-adapted sibling (do not break the POSIX one). Mirror the harness shape.

### Why the N-tabs bug survived v1 (trace — so the dev doesn't assume it's fixed)
1. Call #1 `preview()`: `session.has`=false → `open_session` (registers session synchronously via `session.register`) → `on_ready(browser-open #1)` queued (server not yet running).
2. Call #2 before `ready`: `is_dot_buffer`=true; guard `session.has(bufnr) and server.state.running` → `true and false` → **not taken** → `open_session` again → `on_ready(browser-open #2)` queued.
3. `ready` arrives → `dispatch` fires **both** callbacks → **two tabs**. Broadening the guard to `session.has(bufnr)` closes step 2.

### Testing standards
- **Lua:** plenary/busted specs in `tests/`; run locally via `tests/support/busted_compat.lua` shim (busted not installed locally — `local-test-harness` memory). CI runs canonical busted. The `commands_spec` historically stubs `on_ready` to fire `fn()` immediately, so the **deferred-queue ordering is not exercised** (a known `deferred-work.md` gap) — Task 1's test must drive the real queue path, not the immediate-fire stub.
- **Server (TS):** `bun test` in `server/`; `supervisor.test.ts` is the POSIX no-orphan gate (stdin `.end()` EOF + heartbeat-timeout cases) — keep both green.
- **Lint:** `stylua --check .`, `git diff --check`.

### Project Structure Notes
- Tiers: Lua plugin (`lua/interactive-graphviz/`), server (`server/`, Bun TS), frontend (`frontend/`, static). Architecture invariant: **session-map mutation on the Lua side lives only in `session.lua`**; server owns the authoritative sessions map. The N-tabs fix stays within `commands.lua` control flow and must not mutate session state outside `session.lua`.
- `stdout` on the server is reserved for protocol lines only (`server/stdio.ts` header) — diagnostics go to stderr/`diag`. Do not print to stdout in any AC-4 instrumentation.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Epic 4 / Story 4.1]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-06-07.md] (v2 plan, scope classification, AI#2 closure)
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] (items tagged `→ Epic 4.1`)
- [Source: _bmad-output/planning-artifacts/architecture.md#Render Pipeline, #Security, #Configuration Surface (open_cmd)]
- [Source: _bmad-output/planning-artifacts/prds/.../prd.md#FR-1, #FR-14, #NFR-3]
- [Source: _bmad-output/implementation-artifacts/epic-3-retro-2026-06-05.md#Action Items (#2)]
- Code: `lua/interactive-graphviz/commands.lua:34-46,79-99`, `server.lua:8-11,73,80-87,250-256`, `frontend/main.ts:15-27`, `server/server.ts:169-194,239-263`, `tests/integration/orphan_spec.lua`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (via bmad-dev-story)

### Debug Log References

- Lua specs via `tests/support/busted_compat.lua` shim under `luajit`: `commands_spec.lua` 27/27.
- `bun test server` 63/0; `bun test tests/e2e/render.spec.ts` 2/0; `bun test frontend/dot.test.ts` 3/0.
- `stylua --check .` clean; `git diff --check` clean; `ci.yml` YAML valid; frontend bundle builds (179 modules).

### Completion Notes List

- **AC1 (N-tabs):** Root cause confirmed by reading the live code — v1's guard
  (`commands.lua`) only fired when `server.state.running`, so a second `:GraphvizPreview`
  during startup stacked a second `on_ready` browser-open. Broadened the guard to
  `session.has(bufnr)`, covering the pre-`ready` window. New test
  `commands_spec.lua` ("rapid preview() before `ready` registers exactly one browser-open")
  drives the real queued-callback path (not the immediate-fire stub) and asserts
  open_session×1, on_ready×1, render×3 across three rapid calls. Existing idempotency
  tests still pass (no regression).
- **AC2 (empty-DOT):** Fixed at the single funnel point `frontend/main.ts onRender` so all
  render sources (initial / live-reload / engine-change) are covered. Empty/whitespace DOT now
  shows a non-blocking `#ig-empty-notice` (distinct from the red error overlay, never touches
  `#app`, so a showing good graph is preserved); a real render clears it. Decision logic
  extracted to dependency-free `frontend/dot.ts#isBlankDot` and unit-tested in CI
  (`frontend/dot.test.ts`, plus a new `bun test frontend/dot.test.ts` CI step). The notice
  DOM rendering itself is browser-verified (consistent with the project's untested-frontend-DOM
  reality). Also added an immediate editor-side `log.notify` on an empty initial buffer.
- **AC3 (open_cmd):** Replaced the naive `vim.split("%s+")` with a quote-aware tokenizer
  (`commands.lua#tokenize_cmd`, exposed as `_tokenize_cmd`) keeping `"..."`/`'...'` groups intact.
  Config schema unchanged (still a string). 7 new tokenizer/integration tests, incl.
  `open -a "Google Chrome"` → `{open, -a, Google Chrome, <url>}`.
- **AC4 (Windows no-orphan) — HONEST STATUS:** Delivered the verification harness, **not yet
  observed green** (no Windows host available locally — this is a macOS dev machine). Two layers
  added: (1) `tests/integration/run_orphan_check.ps1` — PowerShell mirror of the POSIX
  `run_orphan_check.sh`, force-killing the parent nvim and asserting the server reaps via the
  stdin-EOF path (heartbeat timeout pinned high to force the EOF path, matching the POSIX gate);
  (2) a `windows-no-orphan` CI job on `windows-latest` that runs `bun test
  server/supervisor.test.ts server/stdio.test.ts` (stdin-EOF + heartbeat backstop on the Windows
  Bun runtime) and then the PowerShell harness (full real-nvim parent-death → pipe-close → reap
  chain against the shipped `server-windows-x64.exe`). **Verification executes when this is
  pushed and CI runs; the PowerShell script and the Windows nvim/bun setup have not been run on a
  real Windows host by the author.** If the CI job reveals the stdin-EOF path does not fire on
  Windows, the heartbeat backstop must still reap (covered by supervisor.test.ts on Windows); if
  neither reaps, that is a real supervision bug to escalate. This closes Epic-3 retro AI#2's
  *deliverable*; the green signal lands on the first CI run.
- **Test infra:** Added two missing busted asserts (`truthy`, `is_not_nil`) to
  `tests/support/busted_compat.lua` so `commands_spec.lua` runs under the local shim (it already
  used them; the shim simply lacked them).
- **Scope honored:** no Epic 5 work, no `preserve_view` wiring, theoretical/style debt untouched.

### File List

- `lua/interactive-graphviz/commands.lua` (modified — AC1 guard, AC2 notify, AC3 tokenizer)
- `frontend/main.ts` (modified — AC2 empty-DOT branch)
- `frontend/render.ts` (modified — AC2 `showEmptyNotice`/`clearEmptyNotice` + seam)
- `frontend/dot.ts` (new — AC2 `isBlankDot` helper)
- `frontend/dot.test.ts` (new — AC2 unit tests)
- `tests/commands_spec.lua` (modified — AC1 + AC3 tests)
- `tests/support/busted_compat.lua` (modified — `truthy`/`is_not_nil` asserts)
- `tests/integration/run_orphan_check.ps1` (new — AC4 Windows harness)
- `.github/workflows/ci.yml` (modified — frontend test step + `windows-no-orphan` job)

### Change Log

- 2026-06-07: Implemented Story 4.1 (user-facing hardening pass) — AC1–AC3 complete and
  test-covered; AC4 Windows no-orphan harness + CI job delivered, verification runs on CI push.
