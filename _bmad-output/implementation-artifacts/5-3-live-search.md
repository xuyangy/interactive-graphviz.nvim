---
baseline_commit: e9a6d4d
---

# Story 5.3: Live search

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user looking for something in a Graph,
I want to search nodes/edges by label,
so that I can find and focus elements without scanning visually.

## Acceptance Criteria

**AC1 — Open search with `/`, type a query, matches highlight + non-matches dim**
**Given** a rendered Graph
**When** the user presses `/` to open the search box and types a query
**Then** a compact search box opens (its `<input>` receives focus), matching nodes/edges are emphasized using **the same highlight/dim treatment as click-highlight** (matches = `ig-neighbor`-style emphasis, non-matches = `ig-dimmed` reduced opacity), and the highlight updates live as the query changes.
(FR-17) [Source: epics.md#Story-5.3; ux-interactivity-v2.md#Search-affordances; architecture.md#Interaction-Layer]

**AC2 — Result counter reflects the match count**
**Given** an open search box with a query
**When** matches are computed
**Then** a **result counter** shows the match count in the form `N/total` (e.g. `3/12`) — matches over total searchable elements (per the active scope). An empty query or zero matches reads `0/total` and dims nothing (all elements at full opacity).
[Source: epics.md#Story-5.3; ux-interactivity-v2.md#Search-affordances ("shows a result counter (e.g. 3/12)")]

**AC3 — Case-sensitive and regex toggles work; scope respected**
**Given** an open search box
**When** the user toggles **case-sensitive** and/or **regex** and sets the search **scope** (nodes and/or edges)
**Then** matching honors those toggles: case-sensitive off = case-insensitive substring; case-sensitive on = exact-case substring; regex on = the query is compiled as a regular expression (an invalid regex is surfaced as a non-crashing "no match"/error indication, not an uncaught throw, and never blanks `#app`); and only elements within the active scope are eligible to match/dim.
(FR-17) [Source: epics.md#Story-5.3; ux-interactivity-v2.md#Search-affordances ("Toggles: case-sensitive, regex. Scope respected (nodes and/or edges)")]

**AC4 — `Esc` closes search and clears; shared with click-highlight without conflict**
**Given** an open search box (its input focused)
**When** the user presses `Esc`
**Then** the search box closes and its highlight/dim is cleared (every element returns to full opacity). Because `Esc` is shared with click-highlight's clear (Story 5.2), the wiring must resolve unambiguously: while the search input is focused, `Esc` closes/clears search **first** and does not also fall through to (or conflict with) the click-highlight `Esc`-clear. Click-highlight's `shouldClearHighlight` already skips when an INPUT/TEXTAREA is focused — keep that guard intact so the two `Esc` behaviors do not double-fire or fight.
[Source: epics.md#Story-5.3; ux-interactivity-v2.md (keybindings table: `Esc` = "Clear all highlighting / exit search"); frontend/interact.ts shouldClearHighlight; frontend/render.ts handleHighlightKeydown]

**AC5 — Search interop with click-highlight, live-reload, and render-correctness invariants (invariant)**
**Given** search is active (a query is highlighting elements)
**When** a live-reload re-render is applied (new `v`), OR the user interacts with click-highlight
**Then** search highlighting is re-applied against the new SVG (matches re-derived from the new render; if the search box is open the query persists, else it clears cleanly), and the interaction layer never blanks `#app`, fires a stale render, or breaks the v-token guard, render-lock, last-good-render, error-overlay, or empty-buffer-notice surfaces. Search and click-highlight share the **single** `applyHighlightToDom`/dim mechanism — they must not stack two independent class regimes that fight (decide and document precedence: a non-empty search query owns the highlight while open; closing search restores the click-highlight selection or a cleared state).
[Source: architecture.md#Render-Pipeline; frontend/render-queue.ts; frontend/render.ts reapplyHighlightAfterRender]

**AC6 — Search resolved frontend-locally; no new wire surface / no new install prerequisites (invariant)**
**Given** this story ships
**When** it is built
**Then** search is implemented **entirely frontend-local** (new `frontend/search.ts` + wiring in `render.ts`/`main.ts`): no `server/` or `lua/` changes that add protocol/wire surface, no new WS-envelope field, no new Lua config key, the browser→server return channel stays dormant (NFR-1 / SM-C1). Any `search={…}` config defaults (FR-14 seam) are resolved frontend-locally exactly as Story 5.1 (`preserve_view`) and Story 5.2 (`highlight_mode`) did — a module-level setter, NOT new wire surface. No new dependencies; renderer stays pinned at d3-graphviz 5.6.0 / @hpcc-js/wasm-graphviz 1.21.2.
[Source: architecture.md#Interaction-Layer ("Config additions (FR-14 seam): ... search={…}"); epics.md#Epic-5; 5-2-click-to-highlight-neighbors.md Decision D1 / AC5]

## Tasks / Subtasks

- [x] **Task 1 — Create `frontend/search.ts` with pure search/match logic (AC1, AC2, AC3, AC6)** [frontend/search.ts (NEW)]
  - [x] Implement a **pure matcher** `computeSearchMatches(model, query, opts): { nodes: Set<string>, edges: Set<EdgeKey>, total: number }` operating on an injected `GraphModel` (reuse `GraphModel`/`EdgeKey` from `interact.ts` — do NOT redefine the graph model). `opts` carries `{ caseSensitive: boolean, regex: boolean, scope: SearchScope }`. Match node titles and edge labels/endpoints against the query per the toggles; `total` is the count of searchable elements within the active scope (denominator for the `N/total` counter). Keep this DOM-free and dependency-free so it is `bun test`-able like `dot.ts` / `interact.ts`.
  - [x] Define `SearchScope` (e.g. `"nodes" | "edges" | "both"`, default `"both"`) and a pure query compiler: case-sensitive off → case-insensitive substring; on → exact-case substring; regex on → `new RegExp(query, flags)` wrapped so an **invalid regex** returns a sentinel (no matches + a flag the caller can surface) instead of throwing (AC3). Never let an invalid regex bubble as an uncaught exception.
  - [x] Add a frontend-local **config resolver** mirroring `interact.ts`'s `_highlightMode` / `viewstate.ts`'s `_preserveView`: module-level defaults for the `search={…}` seam (e.g. default scope/case-sensitive/regex), with `setSearchConfig(...)` / getters, clamping unknown values to defaults. This is AC6's no-new-wire-surface seam — do NOT add a Lua config key or WS field.
  - [x] Reuse the **same highlight set shape** as click-highlight so the DOM applier in `render.ts` is shared: produce a `HighlightSet` (from `interact.ts`) or a compatible `{nodes, edges}` so `applyHighlightToDom` can render search matches with the identical Selected/Neighbor/Dimmed treatment (UX spec: "Matches use the same highlight/dim treatment as click-highlight"). Decide whether matches map to `ig-neighbor` (emphasized) with non-matches `ig-dimmed` — document the mapping.

- [x] **Task 2 — Build the search box UI + wire it into `render.ts` (AC1, AC2, AC3, AC4)** [frontend/render.ts, frontend/main.ts]
  - [x] Add a **DOM-building function in `render.ts`** (the module that owns DOM emphasis) that creates a compact, fixed-position search box: a text `<input>`, a **result counter** element (`N/total`), and **case-sensitive** + **regex** toggles (and optionally a scope control). Mirror the inline-styled, fixed-position pattern of `showError`/`showEmptyNotice` (e.g. an `#ig-search-box` overlay element, created once, idempotent). Opening focuses the input.
  - [x] Install a **document-level `/` keydown** to open the search box, mirroring `installResetKeybinding`/`shouldReset`: add a pure predicate (e.g. `shouldOpenSearch`) that fires on un-modified `/` and **skips when an INPUT/TEXTAREA is focused** (so `/` typed inside the search input is a literal slash, not a re-open). Keep `0`/`r` reset and click-highlight bindings working.
  - [x] On every input/toggle change, run the pure matcher against the **live SVG model** (reuse `extractModelFromApp()` in `render.ts` — the same SVG-`<title>` extraction click-highlight uses; do NOT add a second extraction path), update the counter, and apply matches through the **shared** `applyHighlightToDom`. Keep emphasis a cheap class/opacity toggle — no graph re-render (NFR-7). Animation/transition polish is Story 5.4.
  - [x] Install the search wiring **once at startup from `main.ts`** (mirror `installResetKeybinding()` / `installInteractionHandlers()`), calling a function exported from `render.ts` (e.g. `installSearchHandlers()`). Keep the d3 import out of `main.ts` and out of `search.ts`.

- [x] **Task 3 — `Esc` precedence + click-highlight interop (AC4, AC5)** [frontend/render.ts, frontend/interact.ts]
  - [x] Make `Esc` **close + clear search first** when the search box is open/focused, without conflicting with click-highlight's `Esc`-clear. Two clean approaches: (a) handle `Esc` on the search input element itself (stops at the input, clears search, blurs) so the document-level `handleHighlightKeydown` correctly sees an INPUT focused and is already skipped by `shouldClearHighlight`; or (b) a single ordered keydown handler. Pick the simplest that keeps `shouldClearHighlight`'s INPUT/TEXTAREA guard intact and does not double-fire. Document the choice in the Dev Agent Record.
  - [x] Define **precedence** between search-dim and click-highlight selection so they share the one `applyHighlightToDom` regime and never stack two fighting class sets (AC5): a non-empty search query owns the highlight while the search box is open; closing/clearing search restores the click-highlight selection state (re-run `recomputeAndApplyHighlight`) or the cleared state. Implement this without modifying `render-queue.ts` (v-guard/render-lock) and without a second concurrent `#app` mutation.
  - [x] **Re-apply search after live-reload (AC5):** hook into the existing per-render SUCCESS boundary used by click-highlight (`reapplyHighlightAfterRender` in `render.ts`, called from `renderDotWithFallback` after `restoreViewState`). If the search box is open, re-run the matcher against the new SVG and re-apply (matches re-derived; counter updated); else leave click-highlight's existing re-apply untouched. Do NOT add a separate render hook and do NOT touch the v-guard/render-lock or the `onError` fallback recovery render.

- [x] **Task 4 — Tests (AC1, AC2, AC3)** [frontend/search.test.ts (NEW)]
  - [x] Add `frontend/search.test.ts` (`bun test`, pure-unit, no DOM) covering `computeSearchMatches` on a small fixture `GraphModel`: substring match (case-insensitive default), case-sensitive on/off, regex on (valid pattern) + invalid-regex sentinel (no throw), scope = nodes / edges / both, the `N/total` counts, empty-query = zero matches/no dim, and the `setSearchConfig`/getter default + clamp of unknown values. Follow the pure-unit pattern in `frontend/interact.test.ts` / `frontend/dot.test.ts` (inject the model, use `_`-prefixed seams for internal state).
  - [x] If the `/`-open and `Esc`-close predicates are pure (they should be, like `shouldReset` / `shouldClearHighlight`), unit-test them directly (fires on un-modified `/`, skips INPUT/TEXTAREA, etc.). The live DOM path (real search box rendering, focus, click→class application on a live SVG) has **no automated harness** — browser WASM render path is untested (MEMORY: browser-render-untested) — verify it manually in a browser and document in the Dev Agent Record.
  - [x] CI already runs `bun test frontend` (`.github/workflows/ci.yml:50`), which auto-discovers all `frontend/*.test.ts` specs — the new spec is gated automatically. Do NOT change the CI line. Verify locally with `bun test frontend`.

- [x] **Task 5 — Docs (AC1–AC4)** [README.md]
  - [x] Document search in the browser-interactions section (after "Highlighting neighbors", README around lines 76–110): `/` opens search, type to filter (matches highlight, non-matches dim), the `N/total` result counter, case-sensitive + regex toggles, scope, and `Esc` closes/clears. Add `/` to the navigation gestures table (line ~80) alongside the existing `Esc` row. Match the style Story 5.1/5.2 used.

## Dev Notes

### What this story is (scope)
Epic 5 is the **Interactivity Layer** — the "interactive" the plugin name promises, deferred from v1 to v2. Story 5.3 is **live search**: it introduces the new `frontend/search.ts` module the architecture explicitly names ("`frontend/search.ts` (label search, case-sensitive/regex toggles, result counter, dim non-matches)"). It is **entirely frontend-local** — operates on the already-rendered SVG client-side, adds **no new wire messages and no install prerequisites**, leaves the browser→server return channel dormant (reserved for v3). It builds directly on Story 5.2's seams: it **reuses** the shared SVG-title model extraction (`extractModelFromApp`), the shared DOM emphasis applier (`applyHighlightToDom` with `ig-selected`/`ig-neighbor`/`ig-dimmed`), and the shared `Esc` predicate/guard (`shouldClearHighlight` skips INPUT/TEXTAREA — the seam 5.2 deliberately left for 5.3). Story 5.4 (animation/polish) follows. [Source: epics.md#Epic-5; architecture.md#Interaction-Layer-(v2-—-frontend-local); sprint-change-proposal-2026-06-07.md; 5-2-click-to-highlight-neighbors.md]

### Reuse, don't reinvent (the key design decision)
Story 5.2 already shipped the exact machinery search needs. **Do not duplicate it:**
- **Graph model + extraction:** `interact.ts` exports `GraphModel`, `Edge`, `EdgeKey`, `edgeKey`, `buildModelFromTitles`, `parseDotModel`. `render.ts` exports nothing public for extraction but has the private `extractModelFromApp()` (reads live SVG `<title>`s). Search should run against the SAME model. If `search.ts` needs the model it should receive it injected (pure) and `render.ts` supplies it via `extractModelFromApp()` — do NOT add d3/DOM imports to `search.ts`, and do NOT add a second SVG-extraction routine.
- **DOM emphasis:** `render.ts`'s private `applyHighlightToDom(set: HighlightSet)` already applies `ig-selected`/`ig-neighbor`/`ig-dimmed` and the injected `HIGHLIGHT_CSS`. Search matches should flow through this SAME applier (matches → `ig-neighbor`-style emphasis, non-matches → `ig-dimmed`) so the "same highlight/dim treatment as click-highlight" UX requirement is met by construction. Reuse `HighlightSet` / `emptyHighlightSet` from `interact.ts`.
- **Keydown infra:** `render.ts` has `installResetKeybinding`/`shouldReset` (Story 5.1) and `installInteractionHandlers`/`handleHighlightKeydown`/`shouldClearHighlight` (Story 5.2). Add `installSearchHandlers`/`shouldOpenSearch` in the same shape. The `0`/`r`, click, and `Esc`-clear bindings must all keep working.

This split mirrors Stories 5.1/5.2 exactly: **pure logic** in the standalone module (`search.ts`), **DOM/d3 bridge** in `render.ts`. The `graphviz` import stays single-sourced in `render.ts`.

### CRITICAL — files being modified (read current state before touching)

**`frontend/render.ts`** (UPDATE — the render path; the ONLY module importing d3-graphviz):
- It is the single home of the d3-graphviz import (header comment lines 1-5). Keep that boundary: `search.ts` must NOT import d3-graphviz/@hpcc-js/wasm or touch `document`/`window`.
- **The seam to hook search re-apply into is `reapplyHighlightAfterRender()` (lines 417-433), called from `renderDotWithFallback` (line 133) on the per-render SUCCESS boundary** (right after `restoreViewState`, never inside the `onError` fallback recovery render). Story 5.2's AC4 re-apply lives here; add search re-apply here too — do NOT add a second render hook.
- **Reuse `extractModelFromApp()` (lines 336-346)** for the live SVG model — do not write a second extractor. It returns a `GraphModel` from SVG `<title>`s (nodes/edges; cluster member sets are empty from titles — search does not need cluster membership).
- **Reuse `applyHighlightToDom(set)` (lines 363-385)** as the single DOM emphasis regime. It removes/sets `ig-selected`/`ig-neighbor`/`ig-dimmed` on `g.node`/`g.edge`. An empty highlight set returns all elements to full opacity (the cleared state). Search must not introduce a competing class set — share this one (AC5 precedence).
- **Reuse the keydown pattern:** `ResetKeyEvent`/`shouldReset` (lines 230-250), `installResetKeybinding` (idempotent via `_resetKeyInstalled`, 266-271), and Story 5.2's `handleHighlightKeydown`/`installInteractionHandlers` (lines 470-499). `shouldClearHighlight` (in `interact.ts`, lines 551-556) already SKIPS when INPUT/TEXTAREA is focused — this is the exact seam left for search's own `Esc`. Keep it intact.
- **Overlay pattern to mirror for the search box:** `showError` (147-168) and `showEmptyNotice` (186-201) build fixed-position, inline-styled, idempotent (`getElementById` guard) overlay elements appended to `document.body`, with `z-index:9999`. Build `#ig-search-box` the same way (but it needs `pointer-events:auto` and focusable input — the error/empty overlays use `pointer-events:none`).
- **Preserve these render-correctness invariants:** v-token guard + render-lock (Story 1.5, in `render-queue.ts`), last-good-render + error overlay (Story 1.6), empty-buffer notice (Story 4.1). Search layers on top; it must not blank `#app`, fire stale renders, or break the error/empty surfaces. Re-apply only on the SUCCESS boundary.
- **Re-export pattern for the config seam:** `setPreserveView` (line 547) and `setHighlightMode`/`getHighlightMode` (line 553) are re-exported from `render.ts` so `main.ts` configures without importing the pure module. Re-export `search.ts`'s `setSearchConfig` the same way if a startup call is needed (default-on requires none).

**`frontend/main.ts`** (UPDATE — entry point / startup wiring):
- Currently (lines 17, 25) calls `installResetKeybinding()` and `installInteractionHandlers()` once at startup, importing only from `render.ts`. Add `installSearchHandlers()` the same way (import from `render.ts`; keep d3 out of `main.ts`).
- `onRender(msg)` (lines 37-51) handles blank DOT → `showEmptyNotice`, else `clearEmptyNotice()` + `queueRender(dot, engine, v)`. Do NOT change this — search re-apply hooks the render success boundary in `render.ts`, not `main.ts`.

**`frontend/interact.ts`** (READ — reuse, modify minimally if at all): exports the pure `GraphModel`/`Edge`/`EdgeKey`/`HighlightSet`/`emptyHighlightSet`/`edgeKey`/`buildModelFromTitles`/`parseDotModel` that `search.ts` should import and operate on, and `shouldClearHighlight` (the `Esc` predicate that already guards INPUT/TEXTAREA). Prefer importing these into `search.ts` over redefining. Only modify `interact.ts` if a genuinely shared helper belongs there; otherwise leave it as Story 5.2 shipped it.

**`frontend/render-queue.ts`** (READ — do not break): pure v-guard + render-lock state machine. `queueRender(dot, engine, v)` discards stale `v`, coalesces while in-flight keeping latest pending. No d3 import by design. Search must not interfere with the v-guard/latest-wins semantics; do not modify this file.

**`frontend/viewstate.ts`** (READ — pattern reference, do not modify): the canonical pure-module + injected-accessor + module-level config-resolver pattern (`_preserveView` / `setPreserveView` / `getPreserveView`). The structural template (mirrored by `interact.ts`'s `_highlightMode`) for `search.ts`'s `setSearchConfig`.

### Decision D1 — How does the frontend learn search config? (DEV: pick the no-new-wire option)
The architecture lists `search={…}` as an FR-14 config seam, but it is **NOT yet a Lua config key** — `lua/interactive-graphviz/config.lua` defaults are `engine`, `engines`, `debounce_ms`, `bind`, `port`, `expose_to_lan`, `open_cmd`, `preserve_view`, `heartbeat_ms`, `log_level` and contain neither `search` nor `interactive` nor `highlight_mode`. AC6 forbids adding new wire surface / Lua protocol changes in this story.

Resolve **frontend-locally**, exactly as Story 5.1 (`preserve_view`, Decision D1 Option 1) and Story 5.2 (`highlight_mode`) did and shipped: module-level defaults in `search.ts` (e.g. default scope `"both"`, case-sensitive off, regex off) with `setSearchConfig()` / getters as the toggle/seam tests flip. Zero new wire surface, zero Lua/server changes, return channel stays dormant — satisfies AC6. Do **not** add a field to the WS `render` envelope, a new message type, or a Lua config key. (Adding the actual Lua `search` config key + plumbing is a future, separate concern — keep the seam clean.) Document the chosen option in the Dev Agent Record. The interactive toggles in the search box UI flip in-memory state at runtime; they need no config plumbing.

### Architecture compliance & guardrails
- **Tier-3 only.** No changes to `server/` or `lua/` that add protocol/wire surface. Return channel stays dormant (reserved for v3 bidirectional sync). [Source: architecture.md#Interaction-Layer]
- **Renderer pinned:** `d3-graphviz` 5.6.0 + `@hpcc-js/wasm-graphviz` 1.21.2 (NFR-6 parity). Do not upgrade or add dependencies. [Source: architecture.md:217-230; frontend/package.json]
- **Module boundary:** only `render.ts` imports d3-graphviz / @hpcc-js/wasm and touches the live SVG. `search.ts` stays pure (matcher + scope/toggle logic + config resolver), exactly like `dot.ts` / `interact.ts`. Route any DOM need through `render.ts`. [Source: frontend/render.ts header; frontend/interact.ts module comment]
- **Render correctness invariants (do not regress):** v-token guard + render-lock (Story 1.5), last-good + error overlay (Story 1.6), empty-buffer notice (Story 4.1). [Source: architecture.md#Render-Pipeline; frontend/render-queue.ts]
- **NFR-7 (interaction responsiveness):** search→highlight must feel immediate. Matching + a CSS class/opacity change on existing SVG groups is cheap; do NOT re-render the graph to apply search. Debounce keystrokes only if needed for very large graphs; keep it simple. Animation/transitions are Story 5.4's scope.
- **`Esc` is shared three ways now:** reset (`0`/`r` is not Esc), click-highlight clear (`handleHighlightKeydown` → `shouldClearHighlight`, skips INPUT/TEXTAREA), and search close. The search box input is an INPUT, so `shouldClearHighlight` already won't fire while it's focused — handle search's own `Esc` on the input (close/clear/blur) so the two never fight (AC4).
- **Single emphasis regime:** search and click-highlight must share `applyHighlightToDom` / the `ig-*` classes — do not invent parallel `ig-search-*` classes that stack and fight (AC5). Define precedence (search-open query owns the highlight; closing restores selection/cleared).

### File structure (where things live)
- `frontend/search.ts` — NEW: pure label-search matcher (`computeSearchMatches`) + case-sensitive/regex/scope logic + invalid-regex sentinel + frontend-local `search` config resolver (pure, no d3/DOM)
- `frontend/render.ts` — UPDATE: search-box DOM (`#ig-search-box`, input + counter + toggles), `/`-open + `Esc`-close wiring, run matcher against `extractModelFromApp()` and apply via `applyHighlightToDom`, re-apply on render in `reapplyHighlightAfterRender`, `installSearchHandlers` + `setSearchConfig` re-export, precedence with click-highlight
- `frontend/main.ts` — UPDATE: call `installSearchHandlers()` once at startup
- `frontend/search.test.ts` — NEW: pure unit tests
- `README.md` — UPDATE: `/` search docs (matcher, counter, toggles, scope, `Esc`) + `/` in the gestures table
[Source: architecture.md#Interaction-Layer ("New frontend modules: ... frontend/search.ts (label search, case-sensitive/regex toggles, result counter, dim non-matches)"); architecture.md frontend/ tree]

### Testing standards
- Frontend tests run under **`bun test`**. Existing frontend unit tests: `frontend/dot.test.ts`, `frontend/viewstate.test.ts`, `frontend/render.test.ts`, `frontend/interact.test.ts` (all pure / stub-injected). Server tests: `bun test server`; e2e: `bun test tests/e2e/render.spec.ts`; Lua: busted.
- CI test wiring (`.github/workflows/ci.yml:50`) already runs **`bun test frontend`**, which auto-discovers all `frontend/*.test.ts` and excludes `node_modules` — new specs are gated automatically (verified in Stories 5.1/5.2). Do NOT change the CI line.
- The **browser WASM render path has no automated harness** (MEMORY: browser-render-untested) and **busted is not installed locally** (MEMORY: local-test-harness). Unit-test `search.ts`'s matcher + scope/toggle logic + invalid-regex sentinel + config resolver + the pure `/`/`Esc` predicates in isolation; the real search-box-rendering + click→SVG-emphasis path is verified manually in a browser — document it in the Dev Agent Record. Mirror the stub-injection approach in `interact.test.ts` / `viewstate.test.ts`.
- Use `_`-prefixed test seams (existing convention) for any internal state assertions; never call them from production code.
- Recommended local verification before marking review: `bun test frontend`, `bun test server`, `bun test tests/e2e/render.spec.ts`, `stylua --check .`, `bun build frontend/index.html --outdir dist/frontend`, and the headless nvim smoke — the full gate set Stories 5.1/5.2 ran.

### Project Structure Notes
- No conflicts with the architecture's frontend tree; this story creates `search.ts` exactly as the architecture's Interaction-Layer section names it. No `server/`/`lua/` modules added. Story 5.4 (animation polish) is out of scope — leave clean seams (shared `applyHighlightToDom`, shared `Esc`/predicate infra, instant non-animated emphasis that 5.4 can wrap in transitions).

### Git / previous-work intelligence
- `e9a6d4d` "Complete Story 5.2: click-to-highlight neighbors" (most recent, the baseline): shipped `frontend/interact.ts` (pure `GraphModel`, `computeHighlightSet`, `Selection`, cluster derivation, `shouldClearHighlight`) + `interact.test.ts`, and wired `extractModelFromApp`/`applyHighlightToDom`/`handleAppClick`/`handleHighlightKeydown`/`installInteractionHandlers`/`reapplyHighlightAfterRender` into `render.ts` + `main.ts`. **Search reuses all of these — read `render.ts` lines 273-553 and `interact.ts` before coding.** Story 5.2 explicitly left `shouldClearHighlight`'s INPUT/TEXTAREA skip as the clean `Esc` seam for search.
- `13796a3` Story 5.1: established `renderDotWithFallback` capture/restore boundary, `zoomAccessor()` injected-accessor bridge, the `shouldReset`/`installResetKeybinding` keydown pattern (the template for `shouldOpenSearch`/`installSearchHandlers`), and the `setPreserveView` re-export pattern (the template for `setSearchConfig`).
- `beecf09` Epic 4 Story 4.1: empty-DOT notice / N-tabs idempotency — established the `showEmptyNotice`/`clearEmptyNotice` surface in `render.ts`/`main.ts` that must keep working.
- `e2cdde7`: `.onerror()` NOT `.on("error")` in `renderDot` — do not regress. `7701f60`: `#app` is the render container; the SVG is rendered into it by d3-graphviz.

### Latest tech information
- **Graphviz SVG output structure (load-bearing for search matching + emphasis):** standard Graphviz SVG (what d3-graphviz emits via @hpcc-js/wasm) tags each node as `<g class="node"><title>NAME</title>…</g>`, each edge as `<g class="edge"><title>A-&gt;B</title>…</g>` (`A--B` undirected), each cluster as `<g class="cluster"><title>cluster_NAME</title>…</g>`. The visible LABEL of a node/edge is in a child `<text>` element and may differ from the `<title>` (the node name/identity). Decide whether search matches on the `<title>` (identity, what `extractModelFromApp` already gives you) and/or the visible `<text>` label — the AC says "by label". The pragmatic, already-extractable source is the `<title>`; if visible-label matching is wanted, read child `<text>` content in `render.ts` (DOM side) and pass strings to the pure matcher. Document the choice. Verify exact text format against a real render (DOM `textContent` of an edge `<title>` is `A->B`).
- `d3-graphviz` 5.6.0 is intentionally pinned (NFR-6). No version bumps, no new dependencies in this story. Prefer plain DOM (`querySelectorAll`, class toggles) for emphasis — `applyHighlightToDom` already does this; reuse it.

### References
- [Source: epics.md#Story-5.3] — story statement + ACs (`/` opens search, matches highlight + non-matches dim, result counter, case-sensitive/regex toggles, scope respected, FR-17)
- [Source: epics.md#Epic-5] — interactivity layer, frontend-local, no new wire messages, FR-15–FR-18
- [Source: ux-interactivity-v2.md#Search-affordances] — compact search box opened with `/`, result counter `3/12`, case-sensitive + regex toggles, scope respected, same highlight/dim treatment as click-highlight, `Esc` closes and clears
- [Source: ux-interactivity-v2.md#Browser-keybindings-&-gestures] — `/` = open search box; `Esc` = clear highlighting / exit search
- [Source: architecture.md#Interaction-Layer-(v2-—-frontend-local)] — `frontend/search.ts` module (label search, case-sensitive/regex toggles, result counter, dim non-matches); FR-14 config seam `search={…}`; no new wire surface; return channel dormant
- [Source: architecture.md#Render-Pipeline] — render-lock, last-good, error overlay (do not regress)
- [Source: 5-2-click-to-highlight-neighbors.md] — `interact.ts` exports to reuse (`GraphModel`, `HighlightSet`, `shouldClearHighlight`), `extractModelFromApp`/`applyHighlightToDom`/`reapplyHighlightAfterRender` seams in `render.ts`, Decision D1 frontend-local config pattern, the `Esc`-INPUT/TEXTAREA seam left for search
- [Source: 5-1-zoom-pan-and-reset-view.md] — `shouldReset`/`installResetKeybinding` keydown pattern (template for `shouldOpenSearch`/`installSearchHandlers`), `setPreserveView` re-export pattern (template for `setSearchConfig`)
- [Source: frontend/render.ts] — d3 import boundary, `extractModelFromApp` (336-346), `applyHighlightToDom` (363-385), `reapplyHighlightAfterRender` (417-433), `renderDotWithFallback` success boundary (119-134), keydown infra, overlay patterns (`showError`/`showEmptyNotice`), test seams
- [Source: frontend/interact.ts] — pure `GraphModel`/`HighlightSet`/`edgeKey`/`buildModelFromTitles`/`parseDotModel` to reuse; `shouldClearHighlight` Esc predicate
- [Source: frontend/render-queue.ts] — v-guard + render-lock (must not regress)
- [Source: frontend/main.ts] — startup wiring (`installResetKeybinding`/`installInteractionHandlers`); add `installSearchHandlers`
- [Source: lua/interactive-graphviz/config.lua] — current config keys (no `search`/`highlight_mode`/`interactive`; do not add them in this story)
- [Source: .github/workflows/ci.yml:50] — `bun test frontend` auto-gates new specs
- [Source: README.md#Navigating-the-graph-(in-the-browser)] — gestures table + "Highlighting neighbors" section to extend with search docs

## Dev Agent Record

### Agent Model Used

claude-opus-4-8

### Debug Log References

Full gate set run locally (the Stories 5.1/5.2 gate set), all green:
- `bun test frontend` → 81 pass / 0 fail across 5 files (incl. new `search.test.ts`)
- `bun test server` → 63 pass / 0 fail (the logged "error: parse fail" is an expected rejection asserted inside a passing test)
- `bun test tests/e2e/render.spec.ts` → 2 pass / 0 fail
- `stylua --check .` → clean (exit 0; no Lua touched)
- `bun build frontend/index.html --outdir dist/frontend` → bundled 182 modules, success
- headless nvim smoke (`tests/nvim_smoke.lua` under `tests/minimal_init.lua`) → exit 0

### Completion Notes List

Story implemented entirely frontend-local (AC6): new pure `frontend/search.ts`
+ wiring in `frontend/render.ts` / `frontend/main.ts`; no `server/` or `lua/`
changes, no new WS-envelope field, no new Lua config key, return channel stays
dormant. Renderer stays pinned (d3-graphviz 5.6.0 / @hpcc-js/wasm-graphviz
1.21.2); no new dependencies.

Key decisions:
- **Reuse over reinvent** — `search.ts` imports `GraphModel`/`EdgeKey`/
  `HighlightSet`/`edgeKey`/`emptyHighlightSet` from `interact.ts`; the live SVG
  model comes from the existing `extractModelFromApp()` and emphasis flows
  through the existing `applyHighlightToDom()` (no second extractor, no parallel
  `ig-search-*` class regime). Matches render as the `ig-neighbor` emphasis
  (lighter accent) with non-matches `ig-dimmed`.
- **Decision D1 — frontend-local config seam (AC6):** `search={…}` resolved via a
  module-level resolver (`setSearchConfig`/`getSearchConfig`, clamp-to-default on
  bad input), mirroring Story 5.1 `preserve_view` and Story 5.2 `highlight_mode`.
  `setSearchConfig` is re-exported from `render.ts`; default (both /
  case-insensitive / no-regex) requires no startup call. No Lua/WS plumbing.
- **Esc precedence (AC4) — Option (a):** `Esc` is handled on the search `<input>`
  itself (`shouldCloseSearch` → `preventDefault`/`stopPropagation` → `closeSearch`).
  Because the input is focused while search is open, `interact.ts`'s
  `shouldClearHighlight` already skips (INPUT/TEXTAREA guard, the seam Story 5.2
  left), so the document-level click-highlight `Esc`-clear never double-fires.
- **Single emphasis regime + precedence (AC5):** a non-empty search query owns the
  highlight while the box is open; `searchResultToHighlightSet` puts matched nodes
  in both `nodes` and `selected` to engage `applyHighlightToDom`'s dim gate
  (which keys off `selected.size > 0`) without inventing new classes. An empty
  query / zero matches returns `emptyHighlightSet()` (cleared, full opacity —
  AC2). Closing/clearing search re-runs `recomputeAndApplyHighlight()` to restore
  the click-highlight selection (or cleared) state.
- **Live-reload re-apply (AC5):** hooked into the existing per-render SUCCESS
  boundary `reapplyHighlightAfterRender()` via `reapplySearchAfterRender()` — when
  search is open with a non-empty query it re-derives matches against the new SVG
  and returns true (skipping click-highlight re-apply this render); otherwise
  returns false and click-highlight re-apply proceeds unchanged. No second render
  hook; `render-queue.ts` (v-guard/render-lock) and the `onError` fallback render
  are untouched.
- **Edge matching:** the pure matcher tests each edge against its endpoints and
  its rendered key form (`A->B` / `A--B`), so queries like `a`, `->`, or `a->b`
  find edges. Node matching uses the node `<title>` identity (what
  `extractModelFromApp` already provides). Documented in `search.ts` comments.

Testing: pure-unit coverage in `frontend/search.test.ts` (matcher, scope/toggle
logic, valid + invalid-regex sentinel, `N/total` counts, empty-query, config
resolver default+clamp, and the pure `/`-open / `Esc`-close predicates), mirroring
the `interact.test.ts` / `viewstate.test.ts` stub-injection pattern. The live
search-box DOM path (real box rendering, focus, input→class application on a live
SVG) has **no automated harness** (browser WASM render path is untested — MEMORY:
browser-render-untested); it should be verified manually in a real browser.

### File List

- frontend/search.ts (NEW) — pure live-search matcher, scope/toggle logic, invalid-regex sentinel, `search={…}` config resolver, `SearchResult`→`HighlightSet` bridge, `/`-open + `Esc`-close pure predicates
- frontend/search.test.ts (NEW) — pure-unit tests for the matcher, config resolver, and key predicates
- frontend/render.ts (MODIFIED) — search-box DOM (`#ig-search-box`: input + `N/total` counter + case/regex toggles + scope select), `/`-open + `Esc`-close wiring, `runSearch` against `extractModelFromApp()` via shared `applyHighlightToDom`, live-reload re-apply in `reapplyHighlightAfterRender`, `installSearchHandlers` + `setSearchConfig` re-export, precedence with click-highlight
- frontend/main.ts (MODIFIED) — call `installSearchHandlers()` once at startup
- README.md (MODIFIED) — `/` search docs (matcher, `N/total` counter, case/regex toggles, scope, `Esc`) + `/` and updated `Esc` rows in the gestures table

## Change Log

| Date | Change |
| --- | --- |
| 2026-06-08 | Implemented Story 5.3 live search: new pure `frontend/search.ts` + DOM wiring in `render.ts`/`main.ts`, pure-unit tests, README docs. Frontend-local (no new wire surface). Full gate set green. Status → review. |
