---
title: 'render.stop_all: tear down every watched buffer via a watched-buffers registry'
type: 'bugfix'
created: '2026-07-03'
status: 'done'
baseline_commit: '57ebc2201fcd9fc5cae8c407c8b5605db6f50e8a'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `render.stop_all` walks the `timers` table, but the debounce callback nils `timers[bufnr]` when it fires (render.lua:48-49) — so any buffer whose debounce already fired (the steady-state case) is skipped by `stop_all`, leaving its `InteractiveGraphvizRender<bufnr>` augroup and TextChanged autocmds alive through graceful teardown. Deferred from Epic 1, flagged again by the Epic 6 retro as the unfixed twin of the sync.lua bug repaired in Story 6.4.

**Approach:** Mirror the proven Story 6.4 fix shape from `sync.stop_all`: maintain a watched-buffers registry populated in `start_watch` and cleared in `stop_watch`, and have `stop_all` iterate the union of the registry and `timers` (timers unioned in defensively for any handle not paired with a watch), then reset the registry.

## Boundaries & Constraints

**Always:**
- Touch ONLY these files (enumerated allowlist): `lua/interactive-graphviz/render.lua` (the fix), `tests/render_spec.lua` (tests), `_bmad-output/implementation-artifacts/deferred-work.md` (✅ annotation only), `lua/interactive-graphviz/sync.lua` (optional: one-line twin cross-reference comment only — no code).
- Preserve existing public API and semantics: `start_watch` stays idempotent, `stop_watch` on a never-watched buffer stays a safe no-op, `stop_all` still stops+closes every live timer.
- Follow the sync.lua:574-597 pattern (union iteration, collect-then-stop to avoid mutating tables during `pairs()`, registry reset at the end) and its comment style explaining WHY timers alone is insufficient. The new `stop_all` comment must also name its twin (`mirrors sync.stop_all — keep in sync`) so future edits to either see the other.
- Write the new tests first and run them red against unmodified render.lua before applying the fix (red-green discipline; case-0 below is stub-independent so the red is unfakeable).

**Ask First:**
- Any change touching `lifecycle.lua` or `commands.lua`, or any sync.lua change beyond the one-line twin comment — call sites must not need to change; if they do, stop and ask.

**Never:**
- Do not fix the unrelated deferred items (reconnect emphasis loss, DOT scanner limits).
- Do not refactor render.lua's debounce mechanics or add a re-watch pending-timer cancel — out of scope.
- Do not introduce a shared registry module between render and sync.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Watched, never edited (modal path: open/read/quit) | Buffer watched, no edit ever → no timer ever created, then `stop_all` | Augroup `InteractiveGraphvizRender<bufnr>` deleted | N/A |
| Steady-state teardown (the bug) | Buffer watched, debounce fired (timers[bufnr]=nil), then `stop_all` | Augroup `InteractiveGraphvizRender<bufnr>` deleted | N/A |
| Pending-timer teardown | Buffer watched, debounce armed, then `stop_all` | Timer stopped+closed AND augroup deleted | N/A |
| Mixed population | Buf A steady-state, buf B pending timer, `stop_all` | Both augroups deleted, B's timer closed | N/A |
| Per-buffer stop then global (lifecycle.lua BufDelete→VimLeavePre in unit form) | `stop_watch(A)` then `stop_all` | A not re-stopped (registry entry cleared); no error | `pcall` on augroup delete already tolerates absent group |
| Re-watch same buffer | `start_watch(A)` twice, then `stop_all` | Single registry entry; augroup deleted once | N/A |
| stop_all with nothing watched | Fresh module, `stop_all` | No-op, no errors | N/A |

</frozen-after-approval>

## Code Map

- `lua/interactive-graphviz/render.lua` — the fix target: `timers` table (line 5), `debounce` nils on fire (48-49), `start_watch` (59), `stop_watch` (77), `stop_all` (88)
- `lua/interactive-graphviz/sync.lua:574-597` — proven registry-union pattern from Story 6.4 to mirror (reads `last_sent` as registry, unions `timers`, resets at end)
- `lua/interactive-graphviz/lifecycle.lua:57-70` — sole `render.stop_all` call site (VimLeavePre teardown); must not change
- `tests/render_spec.lua` — existing stubs (`make_vim`, `load_render`) and `render.stop_all` describe block (line 303) to extend; timer stubs expose `:fire()` for synchronous firing

## Tasks & Acceptance

**Execution:**
- [x] `tests/render_spec.lua` — add the new `stop_all` tests FIRST and run them red against unmodified render.lua. Mandatory named cases: **(case-0, anchor regression)** `start_watch(bufnr)`, no edit/no timer, `stop_all`, assert augroup deleted via `vim_stub._augroups_deleted` — stub-independent, must fail on current code; **(clear-side pin)** `start_watch(A)`, `stop_watch(A)`, then `stop_all` — assert A's augroup deleted exactly once total (by `stop_watch`, not re-deleted by `stop_all`), the only case that catches a registry set in `start_watch` but never cleared in `stop_watch`; **(fired-timer)** trigger debounce, `:fire()` the timer, `stop_all`, assert augroup deleted — first verify the stub's `:fire()` nils `timers[bufnr]` the same way render.lua:48-49 does, else cut this case rather than ship a fake red; **(mixed)** buf A steady/fired + buf B pending → both augroups deleted, B's timer stopped+closed; **(no-op)** fresh module, `stop_all`, no errors. Also retrofit an augroup-deletion assertion into the EXISTING pending-timer `stop_all` test (its augroup blind spot is how this bug shipped)
- [x] `lua/interactive-graphviz/render.lua` — add module-local `watched = {}`; set `watched[bufnr] = true` in `start_watch`, nil it in `stop_watch`; rewrite `stop_all` to collect the union of `watched` and `timers` keys, call `stop_watch` for each, then reset `watched = {}`; comment must explain why iterating timers alone leaks steady-state augroups AND name the twin (`mirrors sync.stop_all — keep in sync`)
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` — annotate the render.stop_all entry `✅ resolved` matching the ledger's Story-6.4 format

**Acceptance Criteria:**
- Given a buffer that was watched but never edited (no timer ever created), when `stop_all` runs, then its augroup is deleted — and this test was observed failing on pre-fix code (red) before the fix was applied
- Given a buffer stopped via `stop_watch` before `stop_all` runs, when `stop_all` executes, then that buffer is not re-stopped (registry was cleared)
- Given the full existing suite, when `busted tests/*_spec.lua` runs, then all pre-existing tests still pass (the one permitted modification: adding augroup assertions to the existing pending-timer test)
- Given the fix has landed, when the corresponding entry in `deferred-work.md` is read, then it carries a `✅ resolved` annotation matching the ledger's established format

## Spec Change Log

## Verification

**Commands:**
- `busted -C /Users/xuyangy/trash/git/interactive-graphviz.nvim tests/render_spec.lua` — expected: 0 failures, new stop_all cases green
- `busted -C /Users/xuyangy/trash/git/interactive-graphviz.nvim tests/*_spec.lua` — expected: full suite green (lifecycle_spec exercises teardown)
- `stylua --check /Users/xuyangy/trash/git/interactive-graphviz.nvim/lua/interactive-graphviz/render.lua /Users/xuyangy/trash/git/interactive-graphviz.nvim/tests/render_spec.lua` — expected: no diffs

## Suggested Review Order

**The fix: watched-buffers registry**

- Entry point — stop_all now walks the registry∪timers union instead of timers alone
  [`render.lua:102`](../../lua/interactive-graphviz/render.lua#L102)

- The why-comment: fired debounce nils its timers entry; names the sync twin
  [`render.lua:96`](../../lua/interactive-graphviz/render.lua#L96)

- Registry declaration — boolean set, single-purpose (cleaner than sync's dual-use `last_sent`)
  [`render.lua:10`](../../lua/interactive-graphviz/render.lua#L10)

- Set-side: registered after autocmd creation succeeds, so no phantom entries
  [`render.lua:80`](../../lua/interactive-graphviz/render.lua#L80)

- Clear-side: stop_watch nils the entry — keeps BufDelete→VimLeavePre from re-stopping
  [`render.lua:91`](../../lua/interactive-graphviz/render.lua#L91)

**Drift guard**

- Reciprocal twin comment on the proven Story 6.4 original
  [`sync.lua:580`](../../lua/interactive-graphviz/sync.lua#L580)

**Tests (red-first: case-0, fired-timer, mixed observed failing pre-fix)**

- Case-0 anchor regression: watched-never-edited, the modal open/read/quit path
  [`render_spec.lua:359`](../../tests/render_spec.lua#L359)

- Clear-side pin: stopped buffer not re-stopped by stop_all
  [`render_spec.lua:371`](../../tests/render_spec.lua#L371)

- Fired-timer case with stop/close counters pinning no-double-close on the fired handle
  [`render_spec.lua:384`](../../tests/render_spec.lua#L384)

- Mixed fired+pending population; re-watch idempotence; fresh-module no-op
  [`render_spec.lua:406`](../../tests/render_spec.lua#L406)

- Retrofitted exactly-once augroup assertions into the pre-existing test (its blind spot shipped the bug)
  [`render_spec.lua:353`](../../tests/render_spec.lua#L353)

- Stub timers gained stop/close counters (additive; booleans preserved)
  [`render_spec.lua:21`](../../tests/render_spec.lua#L21)

**Ledger**

- Deferred-work entry annotated ✅ resolved in the established format
  [`deferred-work.md:48`](deferred-work.md#L48)
