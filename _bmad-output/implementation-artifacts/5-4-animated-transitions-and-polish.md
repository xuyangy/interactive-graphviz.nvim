---
baseline_commit: 559cde9
---

# Story 5.4: Animated transitions and polish

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user,
I want highlight and re-render changes to animate,
so that the Graph is pleasant and legible to interact with.

## Acceptance Criteria

**AC1 — Graph re-renders animate via d3-graphviz transitions, config-gated, with a non-animated fallback**
**Given** `interactive` features are enabled (animation is on)
**When** the Graph re-renders (live-reload applies a new `v`)
**Then** the re-render uses a d3-graphviz transition (`graphviz("#app").transition(...)`) so node/edge positions tween rather than snap; **when animation is disabled** (config-gated off, or the environment opts out) the render path falls back to the current instant, non-animated `renderDot` with identical end-state output (no transition object attached).
(FR-18, NFR-7) [Source: epics.md#Story-5.4; ux-interactivity-v2.md#Motion; architecture.md:221-222 ("d3-graphviz … brings d3-zoom + animated transitions"); frontend/render.ts renderDot]

**AC2 — Highlight changes animate; fallback is instant**
**Given** animation is enabled
**When** the highlight set changes (click-to-highlight, multi-select, cluster augment, search match, or clear)
**Then** the Selected / Neighbor / Dimmed emphasis transitions smoothly (e.g. a CSS opacity/stroke transition on the `ig-*` classes) rather than snapping; **when animation is disabled** the emphasis applies instantly exactly as it does today. The animation is purely visual — it must not change WHICH elements are emphasized, only how the change is presented.
(FR-18) [Source: ux-interactivity-v2.md#Motion ("Highlight changes … animate"); frontend/render.ts HIGHLIGHT_CSS / applyHighlightToDom]

**AC3 — Animation never blocks interaction, stales a render, or breaks the render-correctness invariants (invariant)**
**Given** animation is enabled and a transition is in flight
**When** a newer render (`v`) arrives, the user interacts (click/search/reset), or the DOT becomes a parse error
**Then** the v-token guard + render-lock (Story 1.5, `render-queue.ts`), last-good-render + visible error overlay (Story 1.6), empty-buffer notice (Story 4.1), `preserve_view` zoom/pan reapply (Story 5.1), click-highlight (Story 5.2) and search (Story 5.3) all keep working unchanged. Specifically: the transition must resolve/reject the `renderDot` promise on the correct lifecycle event so the render-lock releases (no stuck `inFlight`); a stale completed transition must never be applied over a newer one (latest-wins preserved); and a transition must never block or perceptibly lag interaction (NFR-7). Animations respect — never bypass — the existing render-lock + `v` token. [Source: ux-interactivity-v2.md#Motion ("Animations must never block interaction or stale the latest render (respects the existing render-lock + v token)"); architecture.md#Render-Pipeline; frontend/render-queue.ts; epics.md#Story-5.4 ("interactions stay responsive without perceptible lag")]

**AC4 — Animation is config-gated frontend-local with a sane default; no new wire surface / no new install prerequisites (invariant)**
**Given** this story ships
**When** it is built
**Then** the animate-on/off gate is resolved **frontend-locally** exactly as Story 5.1 (`preserve_view`), 5.2 (`highlight_mode`) and 5.3 (`search`) did — a module-level resolver with a setter/getter and clamp-to-default, **NOT** a new Lua config key, **NOT** a new WS-envelope field, **NOT** a new message type. The browser→server return channel stays dormant (NFR-1 / SM-C1). No new dependencies; the renderer stays pinned at `d3-graphviz` 5.6.0 / `@hpcc-js/wasm-graphviz` 1.21.2 (animation uses d3-graphviz's already-bundled transition support + d3's easing, which ship in the existing bundle). [Source: architecture.md#Interaction-Layer ("Config additions (FR-14 seam): interactive=true …"; "no new install prerequisites (NFR-1 / SM-C1)"); 5-3-live-search.md Decision D1 / AC6; epics.md#Epic-5]

**AC5 — A reduced-motion / disabled path exists and is honored (polish)**
**Given** the user's environment requests reduced motion (`prefers-reduced-motion`) OR animation is explicitly disabled via the frontend config gate
**When** renders/highlights occur
**Then** transitions are skipped and the instant path is used — no perceptible motion. This keeps the feature accessible and gives the "non-animated fallback" (AC1/AC2) a real trigger beyond the config flag. [Source: ux-interactivity-v2.md#Motion ("config-gated with a non-animated fallback"); FR-18]

## Tasks / Subtasks

- [x] **Task 1 — Add a frontend-local animation config resolver (AC4, AC5)** [frontend/render.ts (or a tiny pure helper); mirror viewstate.ts/interact.ts/search.ts]
  - [x] Add a module-level animation gate mirroring the established pattern: `_animate` (default **on** — zero-config keeps interactivity polished, matching architecture's `interactive=true` default), with `setAnimate(on: boolean)` / `getAnimate(): boolean` and clamp-to-default on bad input. Decide the home: if the gate is pure logic, put the resolver in a pure module (like `viewstate.ts`'s `setPreserveView`) and re-export the setter from `render.ts` so `main.ts` configures without importing it directly; if it is only ever read inside `render.ts`, keep it local. Document the choice and follow Decision D1 (frontend-local, no new wire surface) — do NOT add a Lua config key, a WS field, or a message type. **CHOSEN: pure module `frontend/animate.ts` (mirrors viewstate.ts), re-exported from render.ts.**
  - [x] Fold `prefers-reduced-motion` into the effective gate (AC5): the effective "animate" decision = `getAnimate() && !window.matchMedia("(prefers-reduced-motion: reduce)").matches`. Expose a single internal predicate (e.g. `animationsEnabled()`) used by both the render path and the highlight path so they stay consistent. Keep the `matchMedia` read DOM-side (render.ts), and make any pure decision logic unit-testable via an injected/`_`-prefixed seam like the other modules. **DONE: pure `animationsEnabledWith(configOn, reducedMotion)` in animate.ts (unit-tested); DOM-side `animationsEnabled()` in render.ts reads matchMedia and folds it in; both render + highlight paths call it.**
  - [x] Re-export the setter from `render.ts` if `main.ts` needs to call it (default-on requires none), exactly as `setPreserveView` / `setHighlightMode` / `setSearchConfig` are re-exported (render.ts lines ~814-830). **DONE: `export { setAnimate, getAnimate } from "./animate"`. main.ts unchanged (default-on needs no call).**

- [x] **Task 2 — Animate the graph re-render via d3-graphviz transitions, gated, with instant fallback (AC1, AC3, AC5)** [frontend/render.ts renderDot / renderDotWithFallback]
  - [x] In `renderDot`, when `animationsEnabled()` is true, attach a d3-graphviz transition before `.renderDot(dot)` via `.transition(() => transition("ig-render").duration(250).ease(easeCubicInOut))`. Existing `.engine(engine)`, `.onerror(...)` reject, resolve-on-`"end"` kept intact. When disabled, EXACT current instant path (no `.transition()` call). `renderDot` now takes an optional `animate` param (defaults to the live gate) so the recovery render can force-instant.
  - [x] **Resolve on the correct lifecycle event (AC3, critical).** VERIFIED against d3-graphviz 5.6.0 source (`node_modules/d3-graphviz/src/render.js`): with NO transition `'end'` dispatches synchronously at the render tail (line ~397); WITH a transition `'end'` dispatches from the post-transition zero-duration cleanup transition's `start` handler (line ~370), i.e. AFTER `transitionEnd` (line ~364). So `"end"` fires LAST in BOTH paths — the existing resolve point is correct and the render-lock releases exactly once after the transition settles. Did NOT move the resolve; did NOT modify render-queue.ts.
  - [x] Zoom/pan preservation (Story 5.1) kept: `renderDotWithFallback` captures BEFORE and restores AFTER `await renderDot`. Since `renderDot` resolves on `"end"` (after the transition) the capture→await→restore→reapply ordering is unchanged; restore runs after the new zoom behavior exists and the transition is settled. Not reordered.
  - [x] onError fallback-recovery render: now calls `renderDot(dot, engine, false)` — **INSTANT** (no transition), documented inline, so a correction never stacks a transition on the error teardown / `setTimeout(0)` deferral preserved.

- [x] **Task 3 — Animate highlight/dim emphasis, gated, with instant fallback (AC2, AC3, AC5)** [frontend/render.ts HIGHLIGHT_CSS / ensureHighlightStyle / applyHighlightToDom]
  - [x] Emphasis change animates via a CSS `transition: opacity 150ms, stroke 150ms, stroke-width 150ms` on the base `#app g.node`/`g.edge` (+ shape elements) so the existing class toggles tween. **CHOSEN: swap injected `<style>` content based on `animationsEnabled()` at `ensureHighlightStyle()` time** — `highlightCss()` prepends the transition rule when enabled, omits it entirely when disabled (config off OR reduced-motion → instant, byte-identical to today). `ensureHighlightStyle` now re-evaluates the gate each call and updates the style text in place (runtime gate changes stay in sync).
  - [x] `applyHighlightToDom` UNCHANGED in which classes it sets — animation is presentation-only (AC2). The single shared emphasis regime (click-highlight + search) still flows through this one applier; no animated/instant code split.
  - [x] Rapid changes stay responsive (NFR-7): CSS transitions are interruptible + GPU-cheap; duration kept short (150ms); no debounce of the class toggle.

- [x] **Task 4 — Tests (AC1, AC2, AC4, AC5)** [frontend/animate.test.ts]
  - [x] Pure unit tests added in `frontend/animate.test.ts`: `setAnimate`/`getAnimate` default (on) + clamp of bad (non-boolean) input from both true and false states; `animationsEnabledWith()` decision logic (config-on AND not reduced-motion → true; config-off → false either way; reduced-motion → false even when config on). 6 tests, all pass. Mirrors viewstate.test.ts stub/seam pattern; testable without a real `matchMedia`.
  - [x] Live transition path (real d3-graphviz transition + CSS tween on the SVG) has **no automated harness** (MEMORY: browser-render-untested) and no real browser is available in this environment. RESOLVED the critical lifecycle-event UNKNOWN by reading the pinned d3-graphviz 5.6.0 source directly (definitive static finding — see Task 2 + Dev Agent Record: `"end"` fires last in both paths). The 4 visual checks (tween-on/snap-off, fade highlight, latest-wins under load, no zoom jump) require a manual real-browser pass and are flagged in the Dev Agent Record as the remaining manual verification — code is structured so all render-correctness invariants (v-guard/render-lock, last-good, error overlay, empty-notice, preserve_view, highlight, search) are untouched.
  - [x] CI line `bun test frontend` (`.github/workflows/ci.yml:50`) unchanged; new spec auto-discovered. Verified locally with `bun test frontend` → 87 pass.

- [x] **Task 5 — Docs (AC1, AC4, AC5)** [README.md]
  - [x] Added an "### Animation" subsection after "Searching": re-renders and highlight changes animate by default for legibility, never block interaction (latest render wins, short/interruptible), honor `prefers-reduced-motion`, resolved in the browser preview (no Neovim config key, no extra install prerequisites), instant fallback is the same end result. No Lua config key documented (Decision D1 frontend-local).

## Review Findings

_Code review 2026-06-08 (bmad-code-review, baseline 559cde9). 0 decision-needed, 0 patch, 1 deferred, 2 dismissed. All ACs (1-5) satisfied; full gate re-run clean: frontend 87 pass, server 63 pass, e2e 2 pass, stylua clean, frontend bundle builds (183 modules)._

- [x] [Review][Defer] `d3-transition` / `d3-ease` imported as direct top-level imports but undeclared in `frontend/package.json` (transitive-only deps of d3-graphviz) [frontend/render.ts:13-14] — deferred, pre-existing pattern. Story 5.1's `viewstate.ts` established the identical convention importing `d3-zoom`'s `zoomTransform` without declaring it; not introduced by this change. Build resolves them from `frontend/node_modules` and bundles them; "no new dependency" (AC4) holds at build time. Fragility only if d3-graphviz drops the transitive dep.

## Dev Notes

### What this story is (scope)
Story 5.4 is the **final Epic 5 story** — animation + polish. It makes the already-shipped interactions (zoom/pan 5.1, click-to-highlight 5.2, live search 5.3) and the live re-render *move* instead of snapping, so a dense Graph reads pleasantly. It is the FR-18 / NFR-7 capstone. Like every Epic 5 story it is **entirely frontend-local**: it operates on the already-rendered SVG and the existing render path client-side, adds **no new wire messages, no Lua changes, and no install prerequisites**, and leaves the browser→server return channel dormant (reserved for v3). The renderer (`d3-graphviz` 5.6.0) already bundles d3-transition/d3-ease — animation is a capability that has been in the bundle since v1; this story finally turns it on, gated. [Source: epics.md#Story-5.4; ux-interactivity-v2.md#Motion; architecture.md:221-222; sprint-change-proposal-2026-06-07.md]

### Reuse, don't reinvent (the key design decision)
Stories 5.1-5.3 already built every seam this story needs — **do not duplicate them**:
- **Config gate pattern:** `viewstate.ts` `_preserveView`/`setPreserveView`/`getPreserveView` (lines 72-82), `interact.ts` `_highlightMode`/`setHighlightMode`/`getHighlightMode`, `search.ts` `setSearchConfig`/`getSearchConfig`. The animation gate (`_animate`/`setAnimate`/`getAnimate`) is the SAME module-level-resolver shape, re-exported from `render.ts` if `main.ts` needs it. Frontend-local, default-on, clamp-to-default — Decision D1 from those stories applies verbatim. NO new wire surface (AC4).
- **The render path:** `renderDot` (render.ts 47-68) is the single home of the d3-graphviz transition wiring — the architecture explicitly notes d3-graphviz "brings d3-zoom + animated transitions" (architecture.md:221-222). The transition attaches here, gated; the instant path is the current code unchanged.
- **The render-success boundary:** `renderDotWithFallback` (129-144) is where view-state reapply (5.1) and highlight/search reapply (5.2/5.3) already hook. The transition changes WHEN the `renderDot` promise resolves — verify the lifecycle event so this boundary still fires after the transition settles. Do NOT add a new render hook.
- **The emphasis applier:** `applyHighlightToDom` (373-395) + `HIGHLIGHT_CSS` (308-321) is the single shared emphasis regime for BOTH click-highlight and search. Animate it via a CSS `transition` on the base `#app g.node`/`g.edge` rules — the class toggles already exist; do NOT add a parallel animated applier. Presentation-only (AC2).

### Decision D1 — How does the frontend learn the animate config? (DEV: pick the no-new-wire option)
The architecture lists `interactive=true` as an FR-14 config seam (architecture.md:338), but it is **NOT yet a Lua config key** — `lua/interactive-graphviz/config.lua` defaults are `engine`, `engines`, `debounce_ms`, `bind`, `port`, `expose_to_lan`, `open_cmd`, `preserve_view`, `heartbeat_ms`, `log_level` and contain neither `interactive` nor `highlight_mode` nor `search` nor an `animate` key. AC4 forbids adding new wire surface / Lua protocol changes in this story.

Resolve **frontend-locally**, exactly as Story 5.1 (`preserve_view`), 5.2 (`highlight_mode`) and 5.3 (`search`) did and shipped: a module-level `_animate` default **on**, with `setAnimate()` / `getAnimate()` as the seam tests flip, plus the `prefers-reduced-motion` media-query fold for the effective decision (AC5). Zero new wire surface, zero Lua/server changes, return channel stays dormant — satisfies AC4. Do **not** add a field to the WS `render` envelope, a new message type, or a Lua config key. (Adding the actual Lua `interactive`/`animate` config key + plumbing is a future, separate concern — keep the seam clean.) Document the chosen option in the Dev Agent Record.

### CRITICAL — files being modified (read current state before touching)

**`frontend/render.ts`** (UPDATE — the render path; the ONLY module importing d3-graphviz):
- It is the single home of the d3-graphviz import (header comment lines 1-8). Keep that boundary — any d3-transition usage stays here; the new gate's pure logic may live in a pure module but the `matchMedia`/d3 access stays in `render.ts`.
- **`renderDot` (lines 47-68)** is where the transition attaches. CRITICAL: d3-graphviz error handling is `.onerror()` NOT `.on("error", …)` (lines 50-54, regressed once — commit `e2cdde7`); do not touch that. The promise resolves on `.on("end", …)`; with a transition VERIFY which lifecycle event (`"end"` vs `"transitionEnd"`) fires last and resolve there so the render-lock releases correctly (AC3).
- **`renderDotWithFallback` (lines 129-144)** is the per-render SUCCESS boundary: it captures view BEFORE (`captureViewState`, line 130), `await renderDot` (131), updates last-good (133-134), `restoreViewState` AFTER (137), then `reapplyHighlightAfterRender()` (143). With a transition the `await` settles later — ensure capture still happens before the transition starts and restore/reapply still run after it ends. Do not reorder these.
- **`HIGHLIGHT_CSS` (308-321) + `ensureHighlightStyle` (323-329)** — add a CSS `transition` to the base `#app g.node`/`g.edge` so the existing class toggles tween; gate the duration to 0 / omit when animation is disabled. `applyHighlightToDom` (363-395) stays UNCHANGED in which classes it sets.
- **`onError` fallback-recovery render (786-806)** restores last-good via a bare `renderDot` in `setTimeout(0)` — this avoids a concurrent d3 DOM mutation while the error transition tears down. Prefer keeping recovery INSTANT (no transition) and document it; do not break the deferred `setTimeout(0)` teardown ordering.
- **Re-export pattern for the config seam:** `setPreserveView` (817), `setHighlightMode`/`getHighlightMode` (823), `setSearchConfig` (830) are re-exported from `render.ts` so `main.ts` configures without importing the pure module. Re-export `setAnimate` the same way if a startup call is needed (default-on requires none).
- **Preserve these render-correctness invariants:** v-token guard + render-lock (Story 1.5, `render-queue.ts`), last-good + error overlay (Story 1.6), empty-buffer notice (Story 4.1), preserve_view (Story 5.1), click-highlight (Story 5.2), search (Story 5.3). Animation layers on top of ALL of them and must regress NONE (AC3).

**`frontend/main.ts`** (UPDATE only if a startup setter call is needed — entry point / startup wiring):
- Currently (lines 18, 26, 36) calls `installResetKeybinding()`, `installInteractionHandlers()`, `installSearchHandlers()` once at startup, importing only from `render.ts`. If the animation gate needs a startup call, add it the same way (import from `render.ts`; keep d3 out of `main.ts`). Default-on means likely NO change is needed here.
- `onRender(msg)` (lines 48-62) handles blank DOT → `showEmptyNotice`, else `clearEmptyNotice()` + `queueRender(dot, engine, v)`. Do NOT change this — animation hooks the render path inside `render.ts`, not `main.ts`.

**`frontend/render-queue.ts`** (READ — do not break): pure v-guard + render-lock state machine. `queueRender(dot, engine, v)` discards stale `v`, coalesces while in-flight keeping latest pending; releases the lock when the `renderDotWithFallback` promise settles. The transition MUST resolve that promise at the right time (AC3) — but this file is NOT modified. The whole latest-wins/no-stale guarantee depends on the promise settling exactly once, after the transition completes.

**`frontend/viewstate.ts`** (READ — pattern reference + do not regress): the canonical pure-module + injected-accessor + module-level config-resolver pattern (`_preserveView`/`setPreserveView`/`getPreserveView`) — the structural template for `_animate`/`setAnimate`/`getAnimate`. Also: zoom/pan capture/restore must still work across a transitioned render (5.1) — do not regress it.

**`frontend/interact.ts` / `frontend/search.ts`** (READ — reuse, do not duplicate): the pure highlight + search logic. Animation does NOT change their match/highlight MATH — it only changes how `applyHighlightToDom` (in render.ts) presents the class change. Do not touch these unless a genuinely shared pure helper belongs there.

### Architecture compliance & guardrails
- **Tier-3 only.** No changes to `server/` or `lua/` that add protocol/wire surface. Return channel stays dormant (reserved for v3 bidirectional sync). [Source: architecture.md#Interaction-Layer]
- **Renderer pinned:** `d3-graphviz` 5.6.0 + `@hpcc-js/wasm-graphviz` 1.21.2 (NFR-6 parity). Do not upgrade or add dependencies. d3-graphviz already bundles d3-transition + d3-ease; animation uses what is already in the bundle. [Source: architecture.md:217-230; frontend/package.json]
- **Module boundary:** only `render.ts` imports d3-graphviz / @hpcc-js/wasm and touches the live SVG / `matchMedia`. Any new pure gate logic stays pure (like `viewstate.ts`/`interact.ts`/`search.ts`). [Source: frontend/render.ts header]
- **Render correctness invariants (do not regress):** v-token guard + render-lock (1.5), last-good + error overlay (1.6), empty-buffer notice (4.1), preserve_view (5.1), highlight (5.2), search (5.3). The transition must resolve the promise on the right lifecycle event so the render-lock releases exactly once (AC3). [Source: architecture.md#Render-Pipeline; frontend/render-queue.ts]
- **NFR-7 (interaction responsiveness):** transitions must never block or perceptibly lag interaction; keep durations short and interruptible; CSS transitions for emphasis are cheap; the d3 render transition must not stale the latest render. [Source: ux-interactivity-v2.md#Motion; epics.md#Story-5.4]
- **Config-gated with a real off path:** honor `prefers-reduced-motion` AND the frontend gate (AC5). The "non-animated fallback" must be the exact current instant behavior — not a degraded approximation.

### File structure (where things live)
- `frontend/render.ts` — UPDATE: gated d3-graphviz transition in `renderDot`; CSS `transition` on the emphasis classes; `animationsEnabled()` predicate folding the gate + `prefers-reduced-motion`; `setAnimate`/`getAnimate` resolver (or re-export from a pure module); preserve all render-correctness boundaries
- `frontend/main.ts` — UPDATE only if a startup `setAnimate(...)` call is needed (default-on likely needs none)
- `frontend/render.test.ts` (or a small new pure spec) — UPDATE/NEW: pure unit tests for the gate default+clamp and the `animationsEnabled()` decision via injected seam
- `README.md` — UPDATE: animation note in the browser-interactions section (config-gated, honors reduced-motion, instant fallback)
[Source: architecture.md#Interaction-Layer; architecture.md frontend/ tree; frontend/render.ts]

### Testing standards
- Frontend tests run under **`bun test`**. Existing frontend unit tests: `frontend/dot.test.ts`, `frontend/viewstate.test.ts`, `frontend/render.test.ts`, `frontend/interact.test.ts`, `frontend/search.test.ts` (all pure / stub-injected). Server tests: `bun test server`; e2e: `bun test tests/e2e/render.spec.ts`; Lua: busted.
- CI test wiring (`.github/workflows/ci.yml:50`) already runs **`bun test frontend`**, which auto-discovers all `frontend/*.test.ts` and excludes `node_modules` — new specs are gated automatically (verified Stories 5.1/5.2/5.3). Do NOT change the CI line.
- The **browser WASM render path has no automated harness** (MEMORY: browser-render-untested) and **busted is not installed locally** (MEMORY: local-test-harness). Unit-test the gate resolver + `animationsEnabled()` decision logic in isolation (injected/`_`-prefixed seam, like `viewstate.test.ts`/`search.test.ts`); the real transition + CSS-tween path is verified MANUALLY in a real browser — document it in the Dev Agent Record, including the d3-graphviz lifecycle-event finding (which event the `renderDot` promise resolves on under a transition).
- Use `_`-prefixed test seams (existing convention) for any internal state assertions; never call them from production code.
- Recommended local verification before marking review: `bun test frontend`, `bun test server`, `bun test tests/e2e/render.spec.ts`, `stylua --check .`, `bun build frontend/index.html --outdir dist/frontend`, and the headless nvim smoke — the full gate set Stories 5.1/5.2/5.3 ran.

### Project Structure Notes
- No conflicts with the architecture's frontend tree. This story does NOT add a new frontend module (unlike 5.2/5.3) — it wires the already-bundled d3-graphviz transition capability + a CSS transition into the existing render path, gated. It is the Epic 5 capstone: after it, Epic 5 reaches the `vscode-interactive-graphviz` parity target (highlight, search, zoom/pan/reset — all animated and polished) entirely client-side with no new install prerequisites (SM-C1 intact). Leave the seams clean.

### Git / previous-work intelligence
- `559cde9` "Complete Story 5.3: live search" (most recent, the baseline): shipped `frontend/search.ts` + wired the search box, `/`-open + `Esc`-close, shared `applyHighlightToDom` emphasis, live-reload re-apply in `reapplyHighlightAfterRender`, and the `setSearchConfig` re-export. **Animation reuses the shared emphasis applier and the render-success boundary — read `render.ts` 47-68, 129-144, 308-395, 762-830 before coding.**
- `e9a6d4d` Story 5.2: shipped `interact.ts` + `extractModelFromApp`/`applyHighlightToDom`/`recomputeAndApplyHighlight`/`reapplyHighlightAfterRender`/`handleAppClick`/`handleHighlightKeydown`/`installInteractionHandlers` in `render.ts` — the highlight regime 5.4 animates (presentation-only).
- `13796a3` Story 5.1: established `renderDotWithFallback` capture/restore boundary, `zoomAccessor()` injected-accessor bridge, the `setPreserveView` re-export pattern (the template for `setAnimate`), and the pure-module config-resolver pattern in `viewstate.ts`. The transition must not disturb the zoom/pan reapply.
- `e2cdde7`: `.onerror()` NOT `.on("error")` in `renderDot` — do not regress when adding the transition. `7701f60`: `#app` is the render container; d3-graphviz renders the SVG into it.
- `beecf09` Epic 4 Story 4.1: `showEmptyNotice`/`clearEmptyNotice` surface in `render.ts`/`main.ts` that must keep working.

### Latest tech information
- **d3-graphviz 5.6.0 transitions (load-bearing — verify against the pinned version, no upgrades):** d3-graphviz supports animated transitions via `graphviz(selector).transition(t)` where `t` is either a named transition string or a factory returning a `d3.transition()` (e.g. `() => d3.transition("main").duration(d).ease(d3.easeLinear)`). It brings `d3-transition`/`d3-ease` along (architecture.md:221-222). The transition tweens node/edge positions/paths across renders. CRITICAL UNKNOWN to resolve in a real browser: under a transition, the render lifecycle fires `transitionStart` → `transitionEnd`; confirm whether `.on("end", …)` still fires AFTER the transition completes (so the existing resolve point is correct) or whether the resolve must move to `transitionEnd` — getting this wrong leaves the render-lock stuck or releases it early (AC3 hazard). d3-graphviz ships no TypeScript definitions (the import is `any`), so this is a runtime/behavioral check, not a type check. Consider consulting d3-graphviz 5.6.0 docs (the transition API + render-lifecycle events) via context7 if behavior is ambiguous.
- **CSS for highlight animation (cheap, preferred over a d3 transition for class toggles):** the `ig-selected`/`ig-neighbor`/`ig-dimmed` classes toggle `opacity` and `stroke`/`stroke-width`; adding `transition: opacity .15s, stroke .15s, stroke-width .15s;` to the base `#app g.node`/`g.edge` rule makes the toggle tween with zero d3 involvement — interruptible and GPU-cheap (NFR-7).
- **`prefers-reduced-motion`:** `window.matchMedia("(prefers-reduced-motion: reduce)").matches` is the standard accessibility gate (AC5); fold it into `animationsEnabled()`.
- No version bumps, no new dependencies in this story.

### References
- [Source: epics.md#Story-5.4] — story statement + ACs (highlights/re-renders animate via d3-graphviz, config-gated, non-animated fallback, responsive without perceptible lag, FR-18, NFR-7)
- [Source: epics.md#Epic-5] — interactivity layer, frontend-local, no new wire messages, FR-15-FR-18, SM-C1 preserved
- [Source: ux-interactivity-v2.md#Motion] — "Highlight changes and re-renders animate via d3-graphviz transitions (FR-18), config-gated with a non-animated fallback. Animations must never block interaction or stale the latest render (respects the existing render-lock + v token)."
- [Source: architecture.md:217-230] — renderer pinned `d3-graphviz` 5.6.0 + `@hpcc-js/wasm-graphviz` 1.21.2; "d3-graphviz … brings d3-zoom + animated transitions — the foundation for v1 'preserve zoom/pan across reload' and [v2]"
- [Source: architecture.md#Interaction-Layer-(v2-—-frontend-local)] — Tier-3 only; no new wire surface; return channel dormant; config seam `interactive=true`; no new install prerequisites (NFR-1 / SM-C1)
- [Source: architecture.md#Render-Pipeline] — render-lock, latest-wins, last-good, error overlay (do not regress)
- [Source: frontend/render.ts] — `renderDot` (47-68, `.onerror()` not `.on("error")`), `renderDotWithFallback` success boundary (129-144), `HIGHLIGHT_CSS`/`ensureHighlightStyle`/`applyHighlightToDom` (308-395), `onError` recovery render (786-806), config re-export pattern (814-830)
- [Source: frontend/render-queue.ts] — v-guard + render-lock; promise must settle once after the transition (must not regress)
- [Source: frontend/viewstate.ts] — `setPreserveView`/`getPreserveView` resolver pattern (template for `setAnimate`); zoom/pan capture-restore must survive a transitioned render
- [Source: frontend/interact.ts / frontend/search.ts] — pure highlight + search logic 5.4 animates presentation-only; the shared `applyHighlightToDom` regime
- [Source: frontend/main.ts] — startup wiring (`installResetKeybinding`/`installInteractionHandlers`/`installSearchHandlers`); add a `setAnimate` call only if needed
- [Source: lua/interactive-graphviz/config.lua] — current config keys (no `interactive`/`animate`/`highlight_mode`/`search`; do not add them in this story — Decision D1 frontend-local)
- [Source: .github/workflows/ci.yml:50] — `bun test frontend` auto-gates new specs
- [Source: README.md#Navigating-the-graph-(in-the-browser)] — gestures + Highlighting + Searching sections to extend with the animation note
- [Source: 5-3-live-search.md / 5-2-click-to-highlight-neighbors.md / 5-1-zoom-pan-and-reset-view.md] — Decision D1 frontend-local config seam pattern; shared emphasis regime; render-success boundary; reuse-don't-reinvent precedent
- [Source: sprint-change-proposal-2026-06-07.md] — Epic 5 frontend-local mandate; FR-18 / NFR-7 origin; v3 deferral of the return channel

## Dev Agent Record

### Agent Model Used

claude-opus-4-8

### Debug Log References

- `bun test frontend` → 87 pass / 0 fail (was 81; +6 new in animate.test.ts)
- `bun test server` → 63 pass / 0 fail
- `bun test tests/e2e/render.spec.ts` → 2 pass / 0 fail
- `bun build frontend/index.html --outdir dist/frontend` → Bundled 183 modules (d3-transition/d3-ease resolve from the existing transitive bundle; no new top-level dep)
- `stylua --check .` → clean (exit 0)
- `nvim --headless -i NONE -u tests/minimal_init.lua -l tests/nvim_smoke.lua -c qa` → exit 0

### Completion Notes List

- **Decision D1 (how the frontend learns the animate config):** resolved FRONTEND-LOCALLY, exactly as Stories 5.1/5.2/5.3. New pure module `frontend/animate.ts` holds `_animate` (default **on**) + `setAnimate`/`getAnimate` (clamp non-boolean to current value) + the pure `animationsEnabledWith(configOn, reducedMotion)` decision. render.ts re-exports `setAnimate`/`getAnimate`. NO Lua config key, NO WS-envelope field, NO new message type; browser→server return channel stays dormant. main.ts is UNCHANGED — default-on needs no startup call (AC4).
- **CRITICAL d3-graphviz 5.6.0 lifecycle finding (AC3):** verified by reading `node_modules/d3-graphviz/src/render.js`. The `renderDot` promise resolves on `.on("end", …)`, which fires LAST in BOTH paths: with no transition `'end'` is dispatched synchronously at the render tail (line ~397); with a transition the chain is `transitionStart` (line ~361) → `transitionEnd` (line ~364) → a post-transition zero-duration cleanup transition whose `start` handler dispatches `'end'` (line ~370). So `"end"` always fires after the transition completes → the render-lock in render-queue.ts releases exactly once, after the tween settles. The resolve point was NOT moved and latest-wins is preserved. render-queue.ts was NOT modified.
- **Render animation (AC1):** gated d3-graphviz `.transition(() => transition("ig-render").duration(250).ease(easeCubicInOut))` attached only when `animationsEnabled()`. Disabled → exact current instant path (no `.transition()` call), byte-identical end-state. d3-transition + d3-ease imported directly in render.ts (already transitively bundled — same approach as viewstate.ts importing d3-zoom's `zoomTransform`); no new dependency, renderer pinned at d3-graphviz 5.6.0 / @hpcc-js/wasm-graphviz 1.21.2.
- **Highlight animation (AC2):** CSS `transition: opacity/stroke/stroke-width 150ms` on the base `#app g.node`/`g.edge` rules so the existing `ig-*` class toggles tween. `applyHighlightToDom` is UNCHANGED in which classes it sets — presentation-only; the single shared click-highlight + search emphasis regime is preserved (no animated/instant code split). `ensureHighlightStyle()` swaps the injected `<style>` content based on `animationsEnabled()` and re-evaluates the gate each call so runtime gate changes (setAnimate / reduced-motion toggle) stay in sync.
- **Reduced-motion / off path (AC5):** `animationsEnabled()` folds `window.matchMedia("(prefers-reduced-motion: reduce)").matches` into the config gate via the pure `animationsEnabledWith`. When animation is off (config OR reduced-motion) the render takes the instant path and the highlight CSS omits the transition rule — the exact current behavior, not a degraded approximation. matchMedia read is wrapped in try/catch + typeof guards so non-DOM/older contexts treat absence as "no preference".
- **onError recovery render:** now `renderDot(dot, engine, false)` — forced INSTANT so a correction never stacks a transition on the error teardown; the `setTimeout(0)` deferral that avoids concurrent d3 DOM mutation on #app is preserved.
- **Invariants preserved (AC3):** v-token guard + render-lock (1.5), last-good + error overlay (1.6), empty-buffer notice (4.1), preserve_view (5.1), click-highlight (5.2), search (5.3) all untouched — animation layers on top. Confirmed by the full passing suite (frontend 87, server 63, e2e 2) + nvim smoke.
- **Remaining MANUAL verification (no automated harness for the WASM render path — MEMORY: browser-render-untested; no real browser available in this env):** in a real browser confirm (1) a live-reload re-render visibly tweens with animation on and snaps with it off / under `prefers-reduced-motion`; (2) highlight changes fade rather than snap; (3) under rapid edits/clicks interaction stays responsive and the latest render always wins (no stale-render-wins, no stuck render-lock); (4) `preserve_view` zoom/pan is not visibly disturbed by the transition. The critical lifecycle-event unknown that drives (3) was resolved statically above; (1)/(2)/(4) are visual confirmations.

### File List

- `frontend/animate.ts` (NEW) — pure animation config gate: `_animate`/`setAnimate`/`getAnimate` + `animationsEnabledWith()`
- `frontend/animate.test.ts` (NEW) — pure unit tests for the gate default/clamp + the reduced-motion decision
- `frontend/render.ts` (MODIFIED) — import d3-transition/d3-ease + animate.ts; `animationsEnabled()` DOM predicate; gated transition in `renderDot` (+ optional `animate` param); instant onError recovery render; gated highlight-transition CSS in `ensureHighlightStyle`/`highlightCss`; re-export `setAnimate`/`getAnimate`
- `README.md` (MODIFIED) — new "### Animation" subsection (default-on, honors reduced-motion, instant fallback, no Lua key)
- `_bmad-output/implementation-artifacts/5-4-animated-transitions-and-polish.md` (MODIFIED) — story tracking
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (MODIFIED) — status → review

### Change Log

- 2026-06-08 — Story 5.4 implemented: gated d3-graphviz render transitions + CSS highlight-emphasis transitions, frontend-local animate gate (default on) folding `prefers-reduced-motion`, instant fallback. No new wire surface / Lua key / dependency. d3-graphviz 5.6.0 `"end"`-fires-last finding verified from source (render-lock correctness, AC3). Tests: frontend 87 pass, server 63, e2e 2; stylua clean; nvim smoke + frontend bundle pass.
