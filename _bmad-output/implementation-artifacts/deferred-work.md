# Deferred Work

> **Triage (correct-course 2026-06-07):** the user-facing items below are pulled into v2.
> `→ Epic 4.1` = consolidated hardening story; `→ Story 5.1` = wired by the zoom/pan story.
> Unmarked items remain documented debt (theoretical/style; revisit as needed).
> See `../planning-artifacts/sprint-change-proposal-2026-06-07.md`.

## Deferred from: code review of story 5-4-animated-transitions-and-polish (2026-06-08)

- `d3-transition` and `d3-ease` are imported directly at the top of `frontend/render.ts` but are not declared in `frontend/package.json` — they resolve only as transitive dependencies of `d3-graphviz` 5.6.0. The build bundles them today (183 modules, verified) so AC4's "no new dependency" holds, but the import would break silently if d3-graphviz ever drops them. This mirrors the pre-existing convention established in Story 5.1 (`viewstate.ts` imports `d3-zoom`'s `zoomTransform` the same undeclared way), so it is documented debt, not a regression from this story. Consider declaring the d3 sub-packages this codebase imports directly (`d3-zoom`, `d3-transition`, `d3-ease`) as explicit `frontend/package.json` deps pinned to d3-graphviz's versions. [frontend/render.ts:13-14, frontend/package.json] ✅ resolved in debt paydown 2026-06-10 (pinned to lockfile-resolved versions; frozen-lockfile install, 183-module bundle, and 87 frontend tests verified)

## Deferred from: code review of story 5-2-click-to-highlight-neighbors (2026-06-08)

- `_clusterAugment` (frontend/render.ts:293) is a single module-level boolean reflecting only the most recent click's `altKey`. Alt+click a clustered node (cluster augmentation on) followed by a non-Alt Shift+click of another node resets `_clusterAugment` to false, silently dropping the first node's cluster highlight even though it stays selected. Per-selection cluster-augment tracking would be more coherent. Also: `recomputeAndApplyHighlight` looks up cluster membership by the SVG-title node name against the DOT-parsed `_clusterModel`; for node ids with escaped/quoted characters the two normalizations could diverge and miss the cluster. Minor — AC3 only requires the minimal "offers" UX, which is satisfied. [frontend/render.ts:293, 386-402]
- The live DOM emphasis path in render.ts (~200 lines: `applyHighlightToDom`, `handleAppClick`, `nodeTitleFromClickTarget`, `extractModelFromApp`, `recomputeAndApplyHighlight`, `reapplyHighlightAfterRender`, `installInteractionHandlers`) has no automated test. This is the same project-wide limitation already recorded as "browser WASM render path untested" — the pure highlight math/selection/cluster derivation IS fully covered in interact.test.ts (33 cases). Verified manually in a browser per the Dev Agent Record. [frontend/render.ts:273-506]

## Deferred from: code review of story 4-1-user-facing-hardening-pass (2026-06-07)

- Windows `curl` download robustness for the ~110MB prebuilt: the in-Lua `download_to_tmp` (`curl -fL --retry 3`) stalled intermittently on the cold `windows-latest` runner (0 bytes transferred over the connection). The CI no-orphan gate works around it by pre-staging the binary via `gh release download`, but **real Windows users still hit the curl path on install**. Harden it (e.g. `--connect-timeout`, `--speed-limit/--speed-time` so a stall triggers `--retry`, more retries) or verify a 110MB transfer succeeds reliably on a real Windows host. [lua/interactive-graphviz/install.lua download_to_tmp]
- `install_spec.lua`, `config_spec.lua`, `lifecycle_spec.lua`, and `health_spec.lua` are not in the CI busted line (`.github/workflows/ci.yml` runs only scaffold/session/commands/render specs + the orphan integration). New unit tests added to those files — e.g. the Story 4.1 `extract_sha256` certutil-output test — are therefore not CI-gated. Pre-existing coverage gap; wire these specs into CI (or add a `.busted` config that discovers all `tests/*_spec.lua`). [.github/workflows/ci.yml:36] ✅ resolved in debt paydown 2026-06-10 (CI busted line now globs `tests/*_spec.lua`; fixed install_spec vim-stub drift — missing `fn.has` from Story 4.1's Windows detection — all 103 tests pass)

## Deferred from: code review of story 1-2-server-spawn-and-no-orphan-supervision (2026-06-03)

- Unbounded `stdout_buf` (Lua) / `LineBuffer` (TS) growth on a newline-less huge line. Trusted local channel; add a max-line cap that drops + diagnoses an over-long unterminated buffer. [lua/interactive-graphviz/server.lua:206, server/stdio.ts]
- Orphan integration test relies on raw `kill -0 <pid>` liveness, which is vulnerable to PID reuse. Harden with a process identity check (start-time or cmdline) rather than bare PID existence. [tests/integration/orphan_spec.lua]

## Deferred from: code review of story 1-3-message-protocol-and-websocket-relay (2026-06-03)

- `frontend/render.ts` is orphaned scaffold: `frontend/main.ts` dropped its `createRenderer` import in this story, leaving the file unreferenced dead code. Remove it (or repurpose) during Story 1.4 frontend render wiring. [frontend/render.ts] ✅ resolved in Story 1.4

## Deferred from: code review of story 1-4-open-preview-and-first-render (2026-06-04)

- Empty DOT buffer sends a render envelope; frontend silently ignores it (`if (dot)` guard in `main.ts`). User gets a blank preview with no feedback. Story 1.6 error feedback will surface this. [frontend/main.ts, lua/interactive-graphviz/commands.lua] **→ Epic 4.1**
- Multiple rapid `:GraphvizPreview` calls before `ready` queue N browser-open callbacks — N browser tabs open. Story 1.7 idempotency guard will fix this. [lua/interactive-graphviz/server.lua] **→ Epic 4.1**
- Concurrent `renderDot` calls race for `#app` — second call can interrupt or corrupt first d3-graphviz transition. Story 1.5 render-lock will address this. [frontend/render.ts]
- `lastRender` replayed on reconnect may be invalid/errored DOT (no good/bad distinction). Story 1.6 introduces `lastGoodDot` to replace `lastRender`. [server/sessions.ts]
- `lastRender` lost on server restart — browser reconnect gets blank preview. Known architectural limitation; no server-side persistence is in scope.
- `open_cmd` with quoted arguments (e.g. `open -a "Google Chrome"`) is split naively by `vim.split("%s+")`, breaking multi-word commands. Configuration edge case; consider documenting or using `vim.fn.shellescape`. [lua/interactive-graphviz/commands.lua] **→ Epic 4.1**
- No `nvim_buf_is_valid` guard in `is_dot_buffer` — theoretical error if called with invalid bufnr. Story 1.7 lifecycle cleanup will add buffer validity checks. [lua/interactive-graphviz/commands.lua]
- `commands_spec.lua` never exercises the `on_ready` deferred-queue path (all stubs fire `fn()` immediately). Requires an integration test with a real Neovim + real server; deferred to Story 1.7 scope.
- Very large DOT buffer: no size limit before `server.send`. `vim.json.encode` on a multi-MB buffer may be slow and exhaust the stdin pipe buffer. Pre-existing; relates to the unbounded `stdout_buf` deferred from Story 1.2 review. [lua/interactive-graphviz/commands.lua]
- AC5 "already-connected browser receives new render on `:GraphvizPreview` re-run" not exercised end-to-end. Components are separately verified (Lua stub confirms `send` called twice; relay tests confirm delivery). Full integration gate deferred to Story 1.7.

## Deferred from: code review of story 1-5-live-reload-on-buffer-change (2026-06-04)

- `vim.uv.new_timer()` return value unchecked for nil — pre-existing pattern from server.lua heartbeat; applies to render.lua debounce as well. Add nil guard if low-memory robustness is needed. [lua/interactive-graphviz/render.lua:38]
- Re-calling `start_watch` on an already-watched buffer leaves previous debounce timer alive (mitigated by timer-identity guard, practically safe). Story 1.7 could add `stop_watch` before `start_watch` in a re-open scenario for cleanliness. [lua/interactive-graphviz/render.lua:59-68]

## Deferred from: code review of 2-1-configuration-surface-via-setup (2026-06-04)

- `validate()` mutates its argument in-place while also returning it — misleading API that could cause subtle bugs if `validate` is ever called with a non-disposable table. Pre-existing style choice; no current correctness issue. [lua/interactive-graphviz/config.lua]
- IIFE in `engines` element-type check is unnecessarily complex; extract as a named helper or inline loop for readability. Style only, not a correctness issue. [lua/interactive-graphviz/config.lua]
- `ensure_started()` `is_running()` guard uses `state.alive` (pre-`ready`), meaning a second setup call while the server is booting is silently dropped. Pre-existing behavior; desired by AC4 but uses `alive` not `running` as the gate. [lua/interactive-graphviz/server.lua]

## Deferred from: code review of story 1-6-error-resilience-and-view-preservation (2026-06-04)

- Unicode surrogate-pair split in `extractMessage` at the 200-char boundary — JavaScript `slice` operates on UTF-16 code units and can split emoji/CJK surrogate pairs. Low-probability cosmetic issue. [frontend/render.ts:56]
- Server `lastGoodRender` stores every dispatched render envelope including broken-DOT ones; the "last good render" for reconnecting browsers is only truly filtered at the frontend's `lastGoodDot`. AC5 is partially addressed — the rename improves naming but cold-open replay can still serve broken DOT. True fix requires the server to track render success/failure, which is architecturally out of scope (WASM errors are browser-side). [server/sessions.ts, server/server.ts]
- `config.get().preserve_view` not read at render time in `render.ts`; `captureViewState`/`restoreViewState` exported from `viewstate.ts` are not called from the render path. Zoom/pan preservation deferred by AC4 scope guard; wire these when a clean d3-graphviz integration path is available. [frontend/render.ts, frontend/viewstate.ts] **→ Story 5.1**

