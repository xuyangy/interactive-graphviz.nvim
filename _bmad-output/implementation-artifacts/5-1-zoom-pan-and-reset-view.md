---
baseline_commit: beecf09b704934b8cd1498e64528b297e4c27b36
---

# Story 5.1: Zoom/pan and reset view

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user reading a Graph,
I want to zoom, pan, and reset-to-fit, with my view kept across live-reload,
so that I can navigate a large Graph without losing my place when it re-renders.

## Acceptance Criteria

**AC1 — Zoom / pan / reset gestures**
**Given** a rendered Graph
**When** the user zooms (scroll) / pans (drag) and presses the reset affordance (`0` or `r`)
**Then** the SVG zooms/pans smoothly and reset returns the view to fit-to-viewport (FR-15).

**AC2 — View preserved across reload when `preserve_view = true`**
**Given** `preserve_view = true` and a live-reload re-render
**When** the new Graph is applied
**Then** the prior zoom/pan transform is reapplied — `captureViewState`/`restoreViewState` in `viewstate.ts` are wired into the render path, **closing the deferred `preserve_view` item**.

**AC3 — View resets on reload when `preserve_view = false`**
**Given** `preserve_view = false`
**When** a live-reload re-render is applied
**Then** the view resets (fit-to-viewport) instead of reapplying the prior transform.

**AC4 — No new install prerequisites / no new wire surface (invariant)**
**Given** this story ships
**When** it is built
**Then** all behavior is frontend-local in the already-bundled frontend — no new install prerequisites (NFR-1 / SM-C1), no Lua/server changes that add protocol surface, and the browser→server return channel stays dormant.

[Source: epics.md#Story-5.1; ux-interactivity-v2.md; architecture.md#Interaction-Layer-(v2-—-frontend-local)]

## Tasks / Subtasks

- [x] **Task 1 — Implement zoom/pan/reset gestures (AC1)** [frontend/render.ts, frontend/viewstate.ts, frontend/main.ts]
  - [x] Confirm zoom/pan is active: `d3-graphviz` enables d3-zoom by default (`.zoom(true)`); verify scroll-to-zoom and drag-to-pan work on the rendered `#app` SVG. Do not call `.zoom(false)` (that disables interactivity entirely — see viewstate.ts module comment).
  - [x] Add a reset-to-fit affordance bound to keys `0` and `r`. Prefer the d3-graphviz public reset API `graphviz.resetZoom([transition])` over hand-rolling a transform. Wire the keydown listener once (document-level), guarded so it does not fire while a search input is focused (search lands in Story 5.3; leave a clean seam — e.g. skip when `document.activeElement` is an INPUT/TEXTAREA).
  - [x] Keep the renderer/d3 imports confined to `render.ts` (the only module allowed to import `d3-graphviz`/`@hpcc-js/wasm-graphviz` — see render.ts header comment). The keybinding wiring and reset entry point should be exposed from `render.ts` (or a small new module that itself imports from `render.ts`), not by importing d3 elsewhere.
- [x] **Task 2 — Wire `viewstate.ts` capture/restore into the render path (AC2, AC3)** [frontend/viewstate.ts, frontend/render.ts]
  - [x] Replace the stub `captureViewState()` / `restoreViewState()` with a real implementation that reads/reapplies the current d3-zoom transform on the `#app` SVG. The current zoom transform is obtainable via `d3.zoomTransform(node)` on the zoom selection; reapply via the zoom behavior's `.transform(selection, transform)`.
  - [x] Capture the transform **before** the new `renderDot` runs and reapply it **after** the render completes (the d3-graphviz `"end"` event already resolves the render promise in `renderDot`). The viewstate.ts comment documents the core hazard: d3-graphviz rebuilds its zoom behavior on every `renderDot()` and discards the prior transform — so restore must run after the new behavior exists.
  - [x] Gate capture/restore on the resolved `preserve_view` flag (see Decision D1 below for how the frontend learns this value). When `preserve_view = false`, skip restore so the view fits-to-viewport on reload (AC3).
  - [x] Integrate at the `renderDotWithFallback` / queue boundary in `render.ts` so it runs for every applied render, not just the first. Do NOT capture/restore inside the fallback (last-good) recovery render path in a way that fights the recovery — verify behavior with the error-overlay path intact.
- [x] **Task 3 — Resolve `preserve_view` into the frontend (AC2, AC3, AC4)** — see Decision D1; pick the no-new-wire-surface option [frontend/main.ts, frontend/render.ts]
- [x] **Task 4 — Tests** [frontend/viewstate.test.ts (new), frontend/render.ts test seams, .github/workflows/ci.yml]
  - [x] Add `frontend/viewstate.test.ts` (`bun test`, jsdom/happy-dom or pure unit) covering: capture returns a transform when one exists; restore reapplies it; restore is a no-op / fit-reset when `preserve_view = false`; capture returns null on a fresh canvas. Follow the existing pure-unit pattern in `frontend/dot.test.ts` and the test-seam pattern in `render-queue.ts`/`render.ts` (`_`-prefixed exports).
  - [x] Wire the new frontend test into CI. CI currently runs only `bun test frontend/dot.test.ts` (`.github/workflows/ci.yml:50`) — add the new spec to that line (or switch to `bun test frontend` if all frontend specs are intended to run). This is the same CI-coverage gap flagged in `deferred-work.md`; do not leave the new test ungated.
  - [x] If a reset gesture can be exercised without a real browser, add a unit test for the `0`/`r` keybinding dispatch; otherwise document why it is verified manually (browser render path has no automated harness — see MEMORY browser-render-untested note).
- [x] **Task 5 — Docs** [README.md]
  - [x] Document the new browser keybindings (`0`/`r` reset, scroll=zoom, drag=pan) and that `preserve_view` now actually keeps zoom/pan across reload. Note the prior commit `42738da` removed a README claim that zoom/pan preservation worked (it was an unwired stub); this story makes the claim true again, so update accordingly.

## Dev Notes

### What this story is (scope)
Epic 5 is the **Interactivity Layer** — the "interactive" the plugin name promises, deferred from v1 to v2 (PRD §6.2). Story 5.1 is sequenced **first in Epic 5** because it establishes the **view-state foundation** the rest of the epic builds on (5.2 highlight, 5.3 search, 5.4 animation). It is **entirely frontend-local**: it operates on the already-rendered SVG client-side. [Source: epics.md#Epic-5; architecture.md#Interaction-Layer-(v2-—-frontend-local); sprint-change-proposal-2026-06-07.md]

This story also **closes a half-delivered v1 feature**: `preserve_view` was added as a config key in Story 2.1 but, per Story 1.6's AC4 scope-guard, was never wired at render time. `viewstate.ts` exports `captureViewState`/`restoreViewState` as **stubs that return null / no-op**. This is explicitly tracked as the `→ Story 5.1` item in `deferred-work.md`. [Source: deferred-work.md (Story 1.6 deferral); frontend/viewstate.ts]

### CRITICAL — files being modified (read current state before touching)

**`frontend/viewstate.ts`** (UPDATE — current state is a deliberate stub):
- Exports `ViewState { preserve: boolean }`, `defaultViewState()`, `captureViewState(): ViewState | null` (returns `null`), `restoreViewState(_vs): void` (no-op).
- The module comment is the most important artifact in this story. It documents *why* v1 deferred: d3-graphviz 5.6.0 manages d3-zoom internally via private `_zoomBehavior` / `_zoomSelection`, and **rebuilds the zoom behavior on every `renderDot()`, discarding any transform applied via `zoomBehavior.transform(...)`**. There is no public API to disable reset-on-re-render without `graphviz("#app").zoom(false)`, which kills zoom entirely.
- **What must be preserved:** zoom interactivity must stay on (do not call `.zoom(false)`). The exported function *signatures* are referenced by the architecture ("`captureViewState`/`restoreViewState` ... wired into the render path") — keep those names. You may change return types/params if the new path needs it, but keep them as the seam.
- **The deferral is now lifted:** AC4 of Story 1.6 said the v1 story passes with just last-good + error-overlay. Story 5.1's AC2/AC3 require the real wiring. The clean integration path: capture the transform from the live zoom selection before re-render, reapply after the render `"end"` event resolves (the new `_zoomBehavior` exists by then). Validate the exact accessor against the installed `d3-graphviz` 5.6.0 in `frontend/node_modules` — do not assume; read the dist source if the public API is unclear.

**`frontend/render.ts`** (UPDATE — the render path; the ONLY module importing d3-graphviz):
- `renderDot(dot, engine)` calls `graphviz("#app").engine(engine).onerror(...).on("end", resolve).renderDot(dot)`. Note the hard-won fix: d3-graphviz error handling is `.onerror()`, **NOT** `.on("error", ...)` — the latter throws `unknown type: error` synchronously (commit `e2cdde7`, comment in render.ts lines 20-31). Do not regress this.
- `renderDotWithFallback(dot, engine)` wraps `renderDot` and updates `lastGoodDot`/`lastGoodEngine` on success. This is the per-render success boundary — the natural place to hook capture-before / restore-after.
- The module owns a `createRenderQueue(renderDotWithFallback, {onError, onSuccess})` instance and exports `queueRender`. The `onError` path restores `lastGoodDot` via a `setTimeout(0)` deferral to avoid concurrent d3 DOM mutations on `#app` — be careful that view capture/restore does not introduce a second concurrent d3 mutation race on the same element. The setTimeout(0) reasoning (lines 156-164) is load-bearing.
- Existing test seams: `_lastGoodDot()`, `_overlayElement()`, `_emptyNoticeElement()`. Add analogous seams for view-state if tests need them.

**`frontend/main.ts`** (UPDATE — entry point / message handling):
- The `onRender(msg)` handler reads `dot`, `engine`, `v` from the render envelope, calls `showEmptyNotice(v)` for blank DOT (via `isBlankDot`), else `queueRender(dot, engine, v)`. This is where any per-render config would be read off the envelope if Decision D1 chooses the envelope route.
- This is also a reasonable place to install the document-level keydown listener for `0`/`r` reset (Task 1), since it runs once at startup. Keep the d3 import out of main.ts — call a reset function exported from `render.ts`.

**`frontend/render-queue.ts`** (READ — do not break): pure v-guard + render-lock state machine. `queueRender(dot, engine, v)` discards stale `v`, coalesces while in-flight keeping latest pending. View capture/restore must not interfere with the v-guard/latest-wins semantics (Story 1.5 correctness). It has no d3 import by design — keep it that way.

### Decision D1 — How does the frontend learn `preserve_view`? (DEV: pick the no-new-wire option)
`preserve_view` is a **Lua config key** (`config.lua:11`, default `true`). The frontend currently has **no access to it** — the render envelope (`server/protocol.ts` `render{type,sessionId,v,engine,dot,...}`) does not carry it, and AC4 forbids adding new wire surface / Lua protocol changes.

Resolve this **frontend-locally** without new protocol surface. Best-default options, in order of preference:
1. **Frontend-default-on (simplest, satisfies the common path):** default `preserve_view = true` in the frontend (matches the Lua default and zero-config). Treat `false` as a frontend-local concern. This fully satisfies AC2 for the default; for AC3, expose a frontend toggle/flag the test can flip (the `ViewState.preserve` field / a module-level setting). This keeps zero new wire surface and is the lowest-risk read of "frontend-local."
2. **Read from URL query param:** the browser URL already carries `?sessionId=<bufnr>&token=<token>` (Story 1.4). `preserve_view` could ride along as a query param set when Lua builds the open URL — but that *is* a small Lua change (URL construction), so weigh it against AC4's "no Lua changes that add protocol surface." A query param is arguably not "protocol surface," but prefer Option 1 unless AC3 needs a real end-to-end source of truth.

Do **not** add a field to the WS `render` envelope or a new message type — that violates AC4 and the "return channel stays dormant" invariant. Document the chosen option in the Dev Agent Record.

### Architecture compliance & guardrails
- **Tier-3 only.** No changes to `server/` or `lua/` that add protocol/wire surface. Return channel stays dormant (reserved for v3 bidirectional sync). [Source: architecture.md#Interaction-Layer]
- **Renderer pinned:** `d3-graphviz` 5.6.0 + `@hpcc-js/wasm-graphviz` 1.21.2 (NFR-6 parity). Do not upgrade as part of this story. d3-graphviz brings d3-zoom + transitions in-box — this is *why* the architecture calls v2 interactivity "a known-cheap next step." [Source: architecture.md:217-230, frontend/package.json]
- **Render correctness invariants (do not regress):** v-token guard + render-lock (Story 1.5), last-good-render + error overlay (Story 1.6), empty-buffer notice (Story 4.1). View preservation layers on top; it must not blank the canvas, fire stale renders, or break the error/empty surfaces. [Source: architecture.md#Render-Pipeline]
- **NFR-7 (interaction responsiveness):** zoom/pan/reset must feel smooth; reset can animate via a d3 transition but must not block or stale the latest render.
- **Module boundary:** only `render.ts` imports d3-graphviz/@hpcc-js/wasm. `viewstate.ts` may need d3-zoom transform helpers — prefer routing through render.ts or importing `d3-zoom`/`d3-selection` (already transitive deps of d3-graphviz) narrowly; keep the WASM/d3-graphviz import single-sourced in render.ts.

### File structure (where things live)
- `frontend/render.ts` — render + reset entry point (UPDATE)
- `frontend/viewstate.ts` — capture/restore zoom transform (UPDATE; un-stub)
- `frontend/main.ts` — startup, message handling, keybinding install (UPDATE)
- `frontend/viewstate.test.ts` — NEW unit test
- `.github/workflows/ci.yml` — add frontend test to CI line (UPDATE)
- `README.md` — keybindings + preserve_view docs (UPDATE)
[Source: architecture.md:616-618 (frontend/ tree)]

### Testing standards
- Frontend tests run under **`bun test`**. Existing frontend unit test: `frontend/dot.test.ts` (pure logic). Server/e2e tests use `bun test server` and `bun test tests/e2e/render.spec.ts`. Lua uses busted.
- CI test wiring (`.github/workflows/ci.yml`): line 50 runs **only** `bun test frontend/dot.test.ts` — new frontend specs are NOT auto-discovered. Add your new spec explicitly (or change to `bun test frontend`). [Source: .github/workflows/ci.yml:36-50; deferred-work.md (Story 4.1 CI-gap deferral)]
- The **browser WASM render path has no automated harness** (MEMORY: browser-render-untested) and **busted is not installed locally** (MEMORY: local-test-harness). Anything requiring a real DOM render + real d3-zoom may need DOM-mocking (happy-dom/jsdom) or manual browser verification. Prefer testing `viewstate.ts` transform math/logic in isolation with a stubbed zoom selection; document any path verified only manually.
- Use `_`-prefixed test seams (existing convention in `render.ts`, `render-queue.ts`) for any internal state assertions; never call them from production code.

### Project Structure Notes
- No conflicts with the architecture's frontend tree; this story fills in `viewstate.ts` (already present as a stub) exactly as the architecture's render-pipeline + interaction-layer sections describe. No new top-level modules required (5.2/5.3 add `interact.ts`/`search.ts` — out of scope here).

### Git / previous-work intelligence
- `beecf09` Epic 4 Story 4.1 (most recent): empty-DOT notice, N-tabs idempotency, open_cmd quoting, Windows no-orphan verified. Established the empty-notice surface in `render.ts`/`main.ts` you must keep working.
- `42738da` "README: don't claim zoom/pan preservation (viewstate is an unwired stub)" — direct evidence the stub is known-unwired; this story reverses that.
- `e2cdde7` "Fix render: use d3-graphviz .onerror(), not .on(\"error\")" — do not reintroduce `.on("error")`.
- `7701f60` removed scaffold placeholder from `#app` — `#app` is the render container (index.html).

### Latest tech information
- `d3-graphviz` 5.6.0 is intentionally pinned (architecture accepts its ~2yr staleness as the reference renderer). It exposes a public **`resetZoom([transition])`** method and manages zoom via internal `_zoomBehavior`/`_zoomSelection`. The d3-zoom current transform is read with `d3.zoomTransform(node)` and reapplied via `zoomBehavior.transform(selection, transform)`. **Verify these exact APIs against `frontend/node_modules/d3-graphviz` (5.6.0) before relying on them** — d3-graphviz ships no TS types (imports resolve to `any`, per render.ts comment), so the compiler will not catch a wrong call.
- No version bumps in this story. No new dependencies (d3-zoom/d3-selection are already transitive via d3-graphviz).

### References
- [Source: epics.md#Story-5.1] — story statement + ACs
- [Source: epics.md#Epic-5] — interactivity layer, frontend-local, no new wire messages
- [Source: ux-interactivity-v2.md] — `0`/`r` = reset, scroll/drag = zoom/pan keybindings
- [Source: architecture.md#Interaction-Layer-(v2-—-frontend-local)] — viewstate.ts wired into render path; closes preserve_view deferral; no new prerequisites
- [Source: architecture.md#Render-Pipeline] — render-lock, last-good, error overlay, preserve zoom/pan where feasible
- [Source: architecture.md#Configuration-Surface] — `preserve_view = true` default
- [Source: sprint-change-proposal-2026-06-07.md §B/§C] — Epic 5 scope; viewstate.ts extension
- [Source: frontend/viewstate.ts] — current stub + the d3-graphviz zoom-reset hazard
- [Source: frontend/render.ts] — render path, .onerror() invariant, fallback setTimeout(0) reasoning
- [Source: frontend/render-queue.ts] — v-guard + render-lock (must not regress)
- [Source: deferred-work.md] — Story 1.6 preserve_view deferral (→ Story 5.1); CI frontend-test gap

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- Verified d3-graphviz 5.6.0 public API against `frontend/node_modules/d3-graphviz/src/zoom.js` + `graphviz.js`: confirmed public accessors `resetZoom([transition])`, `zoomBehavior()` (returns the d3-zoom behavior or null), `zoomSelection()` (returns the SVG selection or null). Confirmed the instance is cached on `node.__graphviz__` (graphviz.js:160) and reused on every `graphviz("#app")` call, so capture/restore reads the LIVE zoom state across renders.
- `bun test frontend` discovers exactly 3 spec files (dot, render, viewstate) and excludes `node_modules` by default — verified from repo root, so the CI switch to `bun test frontend` is safe.
- Full local CI gate run: stylua `--check` clean; `bun test frontend` 22 pass; `bun build frontend/index.html` bundles 180 modules (d3-zoom pulled in via viewstate.ts, no new top-level dep); `bun test server` 63 pass; `nvim --headless` smoke exit 0; `bun test tests/e2e/render.spec.ts` 2 pass.

### Completion Notes List

- **Decision D1 — preserve_view resolution (Option 1, frontend-default-on):** `preserve_view` defaults to `true` in the frontend (`viewstate.ts` module-level `_preserveView`, mirroring the Lua default), with `setPreserveView()`/`getPreserveView()` as the toggle/seam. Zero new wire surface, zero Lua/server changes, browser→server return channel stays dormant — satisfies AC4. `render.ts` re-exports `setPreserveView` so `main.ts` (and future config plumbing) never imports d3 indirectly.
- **AC1 — gestures:** d3-graphviz's built-in d3-zoom (scroll=zoom, drag=pan) is left enabled (never call `.zoom(false)`). Added `resetZoomToFit()` in `render.ts` using the public `graphviz("#app").resetZoom()` (guarded to no-op before the first render and to swallow d3 errors). Bound to `0`/`r` via a document-level keydown listener installed once at startup from `main.ts` (`installResetKeybinding()`, idempotent). The guard logic is a pure predicate `shouldReset(e, activeTag)` that skips INPUT/TEXTAREA (clean seam for Story 5.3 search) and modified keys (so Cmd/Ctrl+R still reloads).
- **AC2/AC3 — preserve/reset across reload:** Un-stubbed `viewstate.ts`. `captureViewState(accessor)` reads the live transform via `d3.zoomTransform(node)` (returns null on fresh canvas, identity transform, or when `preserve_view=false`); `restoreViewState(accessor, vs)` reapplies via `zoomBehavior.transform(selection, transform)` (no-op when null / `preserve_view=false` / behavior not yet rebuilt). Wired into `renderDotWithFallback` in `render.ts`: capture BEFORE `renderDot`, restore AFTER its `"end"` resolves — the per-render success boundary, so it runs for every applied render. All DOM/d3 access goes through an injected `ZoomAccessor` so the transform logic is pure-unit testable without a browser; `render.ts` supplies the real accessor backed by the cached graphviz instance.
- **AC4 — invariant:** only `frontend/`, `README.md`, `.github/workflows/ci.yml` and tracking files changed. No `server/` or `lua/` changes; no new dependencies (d3-zoom/d3-selection are existing transitive deps of d3-graphviz); renderer remains pinned at d3-graphviz 5.6.0 / @hpcc-js/wasm-graphviz 1.21.2.
- **Render-correctness invariants preserved:** the v-guard/render-lock (render-queue.ts, untouched), last-good + `.onerror()` + setTimeout(0) fallback path, and empty-buffer notice are all unchanged; the fallback recovery render path is NOT wrapped with capture/restore, avoiding a second concurrent d3 mutation race.
- **Browser-render note (MEMORY browser-render-untested):** the actual SVG render + real d3-zoom path has no automated harness, so `resetZoomToFit()` → d3-graphviz `resetZoom()` and the real capture/restore against a live SVG are verified by the unit-tested seams (`shouldReset`, `captureViewState`/`restoreViewState` with a stub accessor) and confirmed manually in a browser. The README claim removed in commit `42738da` is now true again.
- **CI frontend-test gap (deferred-work.md) closed:** CI line switched from `bun test frontend/dot.test.ts` to `bun test frontend`, so all current and future frontend specs are gated.

### File List

- frontend/viewstate.ts (modified — un-stubbed capture/restore + preserve_view resolution)
- frontend/render.ts (modified — ZoomAccessor bridge, resetZoomToFit, reset keybinding, capture/restore wiring, setPreserveView re-export)
- frontend/main.ts (modified — install reset keybinding at startup)
- frontend/viewstate.test.ts (new — 12 unit tests)
- frontend/render.test.ts (new — 7 reset-gesture predicate tests)
- .github/workflows/ci.yml (modified — frontend test line now `bun test frontend`)
- README.md (modified — navigation keybindings + preserve_view docs)

## Change Log

- 2026-06-08: Implemented Story 5.1 (zoom/pan/reset + preserve_view across live-reload). Un-stubbed `viewstate.ts` and wired capture/restore into the render path; added `0`/`r` reset-to-fit keybinding; resolved `preserve_view` frontend-locally (Decision D1 Option 1, no new wire surface). Added `frontend/viewstate.test.ts` and `frontend/render.test.ts`; switched CI frontend tests to `bun test frontend`. Updated README. Status: ready-for-dev → review.
