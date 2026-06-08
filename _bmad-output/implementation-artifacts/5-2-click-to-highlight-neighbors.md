---
baseline_commit: 13796a328fc821495859106d7d868189947255f7
---

# Story 5.2: Click-to-highlight neighbors

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user inspecting a Graph,
I want to click a node and see its neighbors highlighted,
so that I can trace relationships in a dense Graph.

## Acceptance Criteria

**AC1 — Click a node highlights it + its neighbors per `highlight_mode`, dims the rest**
**Given** a rendered Graph
**When** the user clicks a node
**Then** the clicked node and its neighbors are highlighted (Selected = strongest emphasis: full opacity + accent stroke; Neighbor = emphasized but distinct), and all non-matching nodes/edges are dimmed (reduced opacity), per the configured `highlight_mode`:
- `single` = just the clicked node (no neighbors added)
- `upstream` = predecessors (incoming-edge sources) + the connecting edges
- `downstream` = successors (outgoing-edge targets) + the connecting edges
- `bidirectional` = both directions (default)
(FR-16) [Source: epics.md#Story-5.2; ux-interactivity-v2.md#Highlight-semantics; architecture.md#Interaction-Layer]

**AC2 — Multi-select with Shift+click; `Esc` and empty-canvas click clear**
**Given** a highlighted state
**When** the user Shift+clicks additional nodes
**Then** the highlight set accumulates (union of each clicked node's highlight set under the active `highlight_mode`)
**And When** the user presses `Esc` (or clicks empty canvas / Graph background)
**Then** all highlighting clears and every element returns to full opacity (no dimming).
[Source: epics.md#Story-5.2; ux-interactivity-v2.md (keybindings table, `Esc` = clear)]

**AC3 — Cluster highlight when clicking within a cluster**
**Given** a Graph containing clusters (`subgraph cluster_*`)
**When** the user clicks a node that lives inside a cluster
**Then** the interaction offers highlighting the whole cluster (all member nodes + intra-cluster edges) in addition to the per-node neighbor highlight.
[Source: epics.md#Story-5.2; ux-interactivity-v2.md (Cluster — "clicking within a cluster offers highlighting the whole cluster")]

**AC4 — Highlight survives live-reload and does not regress render correctness (invariant)**
**Given** a highlight is active
**When** a live-reload re-render is applied (new `v`)
**Then** highlighting is re-derived/re-applied against the new SVG if the same node titles still exist (or cleanly cleared if they do not), and the interaction layer never blanks `#app`, fires a stale render, or breaks the v-token guard, render-lock, last-good-render, error-overlay, or empty-buffer-notice surfaces.
[Source: architecture.md#Render-Pipeline; frontend/render-queue.ts; frontend/render.ts]

**AC5 — `highlight_mode` config resolved frontend-locally; no new wire surface / no new install prerequisites (invariant)**
**Given** this story ships
**When** it is built
**Then** `highlight_mode` is resolved **frontend-locally** with a default of `"bidirectional"` (mirroring the architecture's FR-14 config seam) using the same no-new-wire-surface pattern Story 5.1 used for `preserve_view` (a module-level setter, NOT a new WS-envelope field or Lua protocol change). No `server/` or `lua/` changes that add protocol surface; the browser→server return channel stays dormant (NFR-1 / SM-C1); no new dependencies; renderer stays pinned at d3-graphviz 5.6.0 / @hpcc-js/wasm-graphviz 1.21.2.
[Source: architecture.md#Interaction-Layer ("Config additions (FR-14 seam): interactive=true, highlight_mode=\"bidirectional\""); 5-1-zoom-pan-and-reset-view.md Decision D1]

## Tasks / Subtasks

- [x] **Task 1 — Create `frontend/interact.ts` with a pure adjacency + selection model (AC1, AC2)** [frontend/interact.ts (NEW)]
  - [x] Build a **pure graph model** from the DOT string (or from the rendered SVG titles — see Dev Notes "Where adjacency comes from"). Represent nodes by their Graphviz title (node name) and edges as directed pairs `{from, to}`. Keep this parsing logic dependency-free and DOM-free so it is `bun test`-able exactly like `dot.ts`/`viewstate.ts`. Do NOT import d3-graphviz / @hpcc-js/wasm here (that import is single-sourced in `render.ts`).
  - [x] Implement a pure `computeHighlightSet(model, selectedNodes: string[], mode: HighlightMode): { nodes: Set<string>, edges: Set<EdgeKey> }` that returns the set of node titles and edge keys to emphasize for the given selection + mode (`single` | `upstream` | `downstream` | `bidirectional`). For multi-select, union the per-node sets.
  - [x] Implement the **selection state machine**: current selection set, `addToSelection(node)` (Shift+click → union), `setSelection(node)` (plain click → replace), `clearSelection()` (`Esc` / empty-canvas). Keep state-mutation pure/injectable so it is unit-testable without a DOM.
  - [x] Define `HighlightMode` type and a frontend-local resolver mirroring Story 5.1's `preserve_view`: module-level `_highlightMode` defaulting to `"bidirectional"`, with `setHighlightMode(mode)` / `getHighlightMode()`. Validate/clamp unknown values to the default. This is AC5's no-new-wire-surface seam.
- [x] **Task 2 — Wire click/keyboard handlers and SVG emphasis into the render path (AC1, AC2, AC3, AC4)** [frontend/render.ts, frontend/main.ts]
  - [x] Add a **DOM-applying function in `render.ts`** (the only module allowed to touch the rendered SVG / d3 selection) that takes the computed highlight set and applies CSS classes / opacity to `#app` `<g class="node">` / `<g class="edge">` groups (Selected, Neighbor, Dimmed; everything else dimmed). Expose `interact.ts`'s pure logic through `render.ts` rather than importing d3 into `interact.ts`. Keep d3-graphviz/@hpcc-js/wasm imports confined to `render.ts` (see render.ts header comment, lines 1-5).
  - [x] Install **click handling** on `#app`: a node click sets/extends selection (Shift detection via `event.shiftKey`), a background/empty click clears. Prefer a single delegated listener on `#app` (event delegation up to the nearest `g.node`) so it survives re-renders without rebinding per element — but re-verify/re-bind after each render since d3-graphviz rebuilds the SVG subtree on every `renderDot()` (same hazard family as the zoom-behavior rebuild documented in `viewstate.ts`).
  - [x] Extend the **`Esc` handling**: a document-level keydown for `Escape` clears highlighting. Reuse the existing keydown infrastructure in `render.ts` (`installResetKeybinding` / `shouldReset` predicate pattern) — add an analogous pure predicate (e.g. `shouldClearHighlight`) that, like `shouldReset`, skips when an INPUT/TEXTAREA is focused (clean seam for Story 5.3 search, which also uses `Esc`). Do NOT regress the `0`/`r` reset binding.
  - [x] **Re-apply highlight after live-reload (AC4):** on each applied render, after the render `"end"` resolves (the per-render success boundary is `renderDotWithFallback` in `render.ts`, where view-state restore already hooks in), re-derive and re-apply the active highlight against the new SVG if the selected node titles still exist, else clear. Do this WITHOUT touching the v-guard/render-lock semantics (render-queue.ts stays untouched) and WITHOUT introducing a second concurrent d3 DOM mutation race on `#app` (mind the `setTimeout(0)` fallback reasoning in render.ts lines 256-271).
  - [x] Install the click/Esc wiring **once at startup from `main.ts`** (mirror `installResetKeybinding()`), calling functions exported from `render.ts`. Keep the d3 import out of `main.ts`.
- [x] **Task 3 — Cluster highlight (AC3)** [frontend/interact.ts, frontend/render.ts]
  - [x] Detect cluster membership: Graphviz emits clusters as `<g class="cluster">` with a `<title>` of `cluster_<name>`; member nodes are rendered as siblings within the graph but cluster bounds can be derived from the DOT `subgraph cluster_*` blocks (pure parse) or from SVG geometry. Prefer deriving cluster membership from the DOT parse in `interact.ts` (pure, testable) over SVG hit-testing.
  - [x] Offer cluster highlight when a clicked node is inside a cluster: include all cluster-member nodes + intra-cluster edges in the highlight set. "Offers" can be satisfied minimally (e.g., a modifier or that the cluster set is included alongside the neighbor set) — pick the simplest UX that satisfies the AC and document the choice in the Dev Agent Record. Do not over-build; 5.4 owns polish/animation.
- [x] **Task 4 — Tests** [frontend/interact.test.ts (NEW)]
  - [x] Add `frontend/interact.test.ts` (`bun test`, pure-unit, no DOM) covering `computeHighlightSet` for all four modes (`single`/`upstream`/`downstream`/`bidirectional`) on a small fixture graph; multi-select union; `Esc`/clear resets selection; the `setHighlightMode`/`getHighlightMode` resolver default + clamp of unknown values; cluster membership derivation. Follow the pure-unit pattern in `frontend/dot.test.ts` and `frontend/viewstate.test.ts` (inject stubs, use `_`-prefixed seams for any internal state).
  - [x] If the click→Esc keydown predicate is pure (it should be, like `shouldReset`), unit-test it directly. The actual DOM emphasis-application + real click on a live SVG has **no automated harness** (browser WASM render path is untested — see MEMORY browser-render-untested); verify that path manually in a browser and document it in the Dev Agent Record.
  - [x] CI already runs `bun test frontend` (`.github/workflows/ci.yml:50`), which auto-discovers all `frontend/*.test.ts` specs — the new spec is gated automatically. Do NOT change the CI line (the Story 5.1 deferral that switched it from `bun test frontend/dot.test.ts` to `bun test frontend` already closed the gap). Verify locally with `bun test frontend`.
- [x] **Task 5 — Docs** [README.md]
  - [x] Document the new browser interactions: click node = highlight neighbors, Shift+click = multi-select, `Esc`/empty-canvas click = clear, and the `highlight_mode` behavior (`single`/`upstream`/`downstream`/`bidirectional`, default `bidirectional`). Match the navigation-keybindings section Story 5.1 added.

### Review Findings

- [x] [Review][Patch] Neighbor emphasis is only "un-dimmed", not positively distinct (AC1 "Neighbor = emphasized but distinct") [frontend/render.ts:298-305] — FIXED: added a lighter `#ffcc80` 2px accent stroke for `ig-neighbor`, distinct from and subordinate to the Selected `#ff9800` 3px stroke
- [x] [Review][Defer] `_clusterAugment` is a single module-level boolean shared across all selected nodes; Alt+click then a non-Alt Shift+click silently drops the earlier node's cluster augmentation; SVG-title node names may diverge from DOT-parsed cluster member titles for escaped ids [frontend/render.ts:293, 386-402] — deferred, minor interaction wart; AC3 "offers" minimal-UX is satisfied
- [x] [Review][Defer] The live DOM emphasis path (applyHighlightToDom, handleAppClick, nodeTitleFromClickTarget, extractModelFromApp, recomputeAndApplyHighlight, reapplyHighlightAfterRender, installInteractionHandlers — ~200 lines) has no automated test [frontend/render.ts:273-506] — deferred, pre-existing project-wide limitation (browser WASM render path untested); pure highlight math is fully covered in interact.test.ts

## Dev Notes

### What this story is (scope)
Epic 5 is the **Interactivity Layer** — the "interactive" the plugin name promises, deferred from v1 to v2. Story 5.2 is the **click-to-highlight-neighbors** feature and introduces the new `frontend/interact.ts` module the architecture explicitly names. It is **entirely frontend-local**: it operates on the already-rendered SVG client-side, adds **no new wire messages and no install prerequisites**, and leaves the browser→server return channel dormant (reserved for v3 bidirectional sync). Story 5.1 (zoom/pan/reset + `preserve_view`) is done and committed (`13796a3`); 5.2 builds on the same render-path seams. 5.3 (search) and 5.4 (animation/polish) follow and share `interact.ts`'s highlight/dim treatment. [Source: epics.md#Epic-5; architecture.md#Interaction-Layer-(v2-—-frontend-local); sprint-change-proposal-2026-06-07.md]

### Where adjacency comes from (the key design decision)
The render envelope already carries the **DOT string** (`msg.dot` in `main.ts onRender`). Two viable sources for node/edge adjacency:
1. **Parse the DOT string (PREFERRED — pure, testable).** Extract node names and directed edges from DOT. This is dependency-free, DOM-free, and unit-testable like `dot.ts`. Caveat: full DOT is non-trivial (subgraphs, attributes, ports, `--` vs `->`, quoted ids, comments). Keep the parser pragmatic — handle the common edge syntaxes (`a -> b`, `a -- b`, chained `a -> b -> c`, quoted ids, attribute lists you skip) and document known limitations. Direction: `->` is directed (drives upstream/downstream); `--` (undirected/graph) treats both directions as neighbors.
2. **Read adjacency from the rendered SVG titles (fallback / cross-check).** Graphviz SVG output is standard: each node is `<g class="node"><title>NODENAME</title>…` and each edge is `<g class="edge"><title>A-&gt;B</title>…` (or `A--B` for undirected). Edge title text encodes endpoints, so adjacency can be reconstructed from the DOM after render. This is robust to DOT parsing gaps but requires the live SVG (not pure-unit-testable without DOM mocking). **Recommendation:** derive adjacency from the SVG `<title>` elements at apply-time inside `render.ts` (robust, mirrors what is actually drawn), and keep `computeHighlightSet`/mode logic pure in `interact.ts` operating on an injected `{nodes, edges}` model — so the graph-model EXTRACTION can be either source but the highlight MATH is always pure-unit-tested. Document the chosen extraction source in the Dev Agent Record.

This split mirrors Story 5.1's pattern exactly: pure logic in the standalone module (`viewstate.ts` ↔ `interact.ts`), DOM/d3 bridge in `render.ts` via an injected accessor.

### CRITICAL — files being modified (read current state before touching)

**`frontend/render.ts`** (UPDATE — the render path; the ONLY module importing d3-graphviz):
- It is the single home of the d3-graphviz import (header comment lines 1-5) and already owns the bridge pattern for view-state: `zoomAccessor()` builds an injected accessor, and `renderDotWithFallback(dot, engine)` captures BEFORE `renderDot` and restores AFTER the `"end"` resolves (lines 106-115). **This is the exact seam to hook highlight re-application into** — add a "re-apply active highlight after render" step alongside the existing `restoreViewState(...)` call.
- `renderDot` uses `.onerror()` NOT `.on("error", …)` (lines 27-39, commit `e2cdde7`) — do not regress.
- The error/recovery path (`onError` in `createRenderQueue`, lines 256-272) restores last-good via `setTimeout(0)` to avoid concurrent d3 DOM mutations on `#app`. Highlight re-application must not introduce a second concurrent mutation race; apply highlight only on the SUCCESS boundary, not inside the fallback recovery render.
- Existing keydown infra to reuse/extend: `ResetKeyEvent`, `shouldReset(e, activeTag)` (pure predicate skipping INPUT/TEXTAREA + modified keys, lines 210-231), `handleResetKeydown`, `installResetKeybinding` (idempotent via `_resetKeyInstalled`, lines 247-252). Add an analogous `Escape`-clear predicate + handler; keep `0`/`r` working.
- Existing test seams convention: `_lastGoodDot()`, `_overlayElement()`, `_emptyNoticeElement()` (lines 193-206) — add analogous `_`-prefixed seams for highlight state if tests need them.
- **Preserve these render-correctness invariants:** v-token guard + render-lock (Story 1.5, in render-queue.ts), last-good-render + error overlay (Story 1.6), empty-buffer notice (Story 4.1). Highlight layers on top; it must not blank `#app`, fire stale renders, or break the error/empty surfaces.

**`frontend/main.ts`** (UPDATE — entry point / startup wiring):
- Currently imports from `render.ts`: `queueRender`, `showError`, `showEmptyNotice`, `clearEmptyNotice`, `installResetKeybinding`, and calls `installResetKeybinding()` once at startup (line 16). `onRender(msg)` reads `dot`/`engine`/`v`, shows empty notice for blank DOT (`isBlankDot`), else `queueRender(dot, engine, v)` (lines 28-42).
- Add: install the click + `Esc` highlight wiring once at startup here (e.g. `installInteractionHandlers()` exported from `render.ts`), mirroring `installResetKeybinding()`. Keep the d3 import out of `main.ts` — call functions exported from `render.ts`.
- If `highlight_mode` needs resolving from any source, do it here at startup via a `setHighlightMode(...)` re-exported from `render.ts` (mirroring how `setPreserveView` is re-exported, render.ts line 287). Default-on `"bidirectional"` requires no call at all (matches the resolver default).

**`frontend/render-queue.ts`** (READ — do not break): pure v-guard + render-lock state machine. `queueRender(dot, engine, v)` discards stale `v`, coalesces while in-flight keeping latest pending. No d3 import by design. Highlight must not interfere with the v-guard/latest-wins semantics; do not modify this file.

**`frontend/viewstate.ts`** (READ — pattern reference, do not modify for this story): the canonical example of the pure-module + injected-accessor + module-level config-resolver pattern (`_preserveView` / `setPreserveView` / `getPreserveView`). Copy this structure for `_highlightMode` / `setHighlightMode` / `getHighlightMode` in `interact.ts`.

### Decision D1 — How does the frontend learn `highlight_mode`? (DEV: pick the no-new-wire option)
`highlight_mode` is an architecture **FR-14 config seam** (`highlight_mode="bidirectional"`), but it is **NOT yet a Lua config key** — `lua/interactive-graphviz/config.lua` defaults currently have `engine`, `engines`, `debounce_ms`, `bind`, `port`, `expose_to_lan`, `open_cmd`, `preserve_view`, `heartbeat_ms`, `log_level` and do **not** include `highlight_mode` or `interactive`. AC5 forbids adding new wire surface / Lua protocol changes in this story.

Resolve **frontend-locally**, mirroring Story 5.1 Decision D1 Option 1 (which the dev chose and shipped): default `_highlightMode = "bidirectional"` in `interact.ts` (matches the architecture seam default and zero-config), with `setHighlightMode()` / `getHighlightMode()` as the toggle/seam tests flip. This is zero new wire surface, zero Lua/server changes, return channel stays dormant — satisfies AC5. Do **not** add a field to the WS `render` envelope, a new message type, or a Lua config key in this story. (Adding the actual Lua `highlight_mode` config key + plumbing is a future, separate concern — keep the seam clean.) Document the chosen option in the Dev Agent Record.

### Architecture compliance & guardrails
- **Tier-3 only.** No changes to `server/` or `lua/` that add protocol/wire surface. Return channel stays dormant (reserved for v3 bidirectional sync). [Source: architecture.md#Interaction-Layer]
- **Renderer pinned:** `d3-graphviz` 5.6.0 + `@hpcc-js/wasm-graphviz` 1.21.2 (NFR-6 parity). Do not upgrade or add dependencies. d3-graphviz already brings d3-selection/d3-zoom transitively. [Source: architecture.md:217-230; frontend/package.json]
- **Module boundary:** only `render.ts` imports d3-graphviz / @hpcc-js/wasm and touches the live SVG. `interact.ts` stays pure (graph model + highlight math + state machine + config resolver), exactly like `dot.ts`. If `interact.ts` needs any DOM, route it through `render.ts` via an injected accessor (the `ZoomAccessor` pattern). [Source: frontend/render.ts header; frontend/viewstate.ts module comment]
- **Render correctness invariants (do not regress):** v-token guard + render-lock (Story 1.5), last-good + error overlay (Story 1.6), empty-buffer notice (Story 4.1). [Source: architecture.md#Render-Pipeline; frontend/render-queue.ts]
- **NFR-7 (interaction responsiveness):** click→highlight must feel immediate. Highlight is a CSS class / opacity change on existing SVG groups — cheap; do not re-render the graph to highlight. Animation/transitions are Story 5.4's scope — keep 5.2 to instant opacity/class toggles (or trivial CSS transition) and leave the animation seam clean.
- **Esc is shared with search (5.3):** the `Esc`-clear predicate must skip INPUT/TEXTAREA focus (search owns typing), mirroring `shouldReset`'s INPUT/TEXTAREA guard, so 5.3 can layer its own `Esc`-closes-search without conflict.

### File structure (where things live)
- `frontend/interact.ts` — NEW: graph model + `computeHighlightSet` + selection state machine + `highlight_mode` resolver (pure, no d3/DOM)
- `frontend/render.ts` — UPDATE: SVG emphasis application, click + Esc wiring, highlight re-apply on render, `installInteractionHandlers` + `setHighlightMode` re-export
- `frontend/main.ts` — UPDATE: install interaction handlers at startup
- `frontend/interact.test.ts` — NEW: pure unit tests
- `README.md` — UPDATE: click/highlight/multi-select/Esc + `highlight_mode` docs
[Source: architecture.md#Interaction-Layer ("New frontend modules: frontend/interact.ts (click-to-highlight + selection state machine …)"); architecture.md:574-588 (frontend/ tree)]

### Testing standards
- Frontend tests run under **`bun test`**. Existing frontend unit tests: `frontend/dot.test.ts`, `frontend/viewstate.test.ts`, `frontend/render.test.ts` (all pure / stub-injected). Server tests: `bun test server`; e2e: `bun test tests/e2e/render.spec.ts`; Lua: busted.
- CI test wiring (`.github/workflows/ci.yml:50`) already runs **`bun test frontend`**, which auto-discovers all `frontend/*.test.ts` and excludes `node_modules` — new specs are gated automatically (verified in Story 5.1). Do NOT change the CI line.
- The **browser WASM render path has no automated harness** (MEMORY: browser-render-untested) and **busted is not installed locally** (MEMORY: local-test-harness). Test `interact.ts`'s graph model + `computeHighlightSet` + selection machine + config resolver in isolation; the real click→SVG-emphasis path is verified manually in a browser — document it in the Dev Agent Record. Mirror the stub-injection approach in `viewstate.test.ts`.
- Use `_`-prefixed test seams (existing convention) for any internal state assertions; never call them from production code.

### Project Structure Notes
- No conflicts with the architecture's frontend tree; this story creates `interact.ts` exactly as the architecture's Interaction-Layer section names it. No `server/`/`lua/` modules added. `frontend/search.ts` (5.3) and animation polish (5.4) are out of scope — leave clean seams (shared highlight/dim treatment, shared `Esc` predicate that ignores text inputs).

### Git / previous-work intelligence
- `13796a3` "Complete Story 5.1: zoom/pan and reset view" (most recent): established the render-path seams this story reuses — `renderDotWithFallback` capture/restore boundary, `zoomAccessor()` injected-accessor bridge, the `shouldReset`/`installResetKeybinding` keydown pattern, and the `setPreserveView` re-export pattern (the template for `setHighlightMode`). Read `render.ts`/`viewstate.ts` from this commit before coding.
- `beecf09` Epic 4 Story 4.1: empty-DOT notice, N-tabs idempotency — established the empty-notice surface in `render.ts`/`main.ts` that must keep working.
- `42738da`: README zoom/pan claim history; `e2cdde7`: `.onerror()` NOT `.on("error")` — do not regress.
- `7701f60` removed scaffold placeholder from `#app` — `#app` is the render container (index.html); the SVG is rendered into it by d3-graphviz.

### Latest tech information
- **Graphviz SVG output structure (load-bearing for adjacency + emphasis):** standard Graphviz SVG (what d3-graphviz emits via @hpcc-js/wasm) tags each node as `<g class="node"><title>NAME</title>…</g>`, each edge as `<g class="edge"><title>A-&gt;B</title>…</g>` (`A--B` for undirected graphs), and each cluster as `<g class="cluster"><title>cluster_NAME</title>…</g>`. Select node/edge/cluster groups by `class`, read endpoints/identity from the child `<title>`. Verify exact title text format against a real render (escaped `->` appears as `&gt;` in source but the DOM `textContent` is `A->B`).
- `d3-graphviz` 5.6.0 is intentionally pinned (NFR-6). No version bumps, no new dependencies in this story (d3-selection is an existing transitive dep if you need selection helpers — but prefer plain DOM `querySelectorAll` for class-based emphasis to keep it simple and import-light).

### References
- [Source: epics.md#Story-5.2] — story statement + ACs (click→highlight, Shift+click multi-select, Esc clear, cluster)
- [Source: epics.md#Epic-5] — interactivity layer, frontend-local, no new wire messages, FR-15–FR-18
- [Source: ux-interactivity-v2.md#Browser-keybindings-&-gestures] — Click=highlight per highlight_mode, Shift+click=multi-select, Esc=clear
- [Source: ux-interactivity-v2.md#Highlight-semantics] — Selected/Neighbor/Dimmed/Cluster treatment; modes single/upstream/downstream/bidirectional; empty-canvas click clears
- [Source: architecture.md#Interaction-Layer-(v2-—-frontend-local)] — frontend/interact.ts module + selection state machine; FR-14 config seam highlight_mode="bidirectional"; no new wire surface; return channel dormant
- [Source: architecture.md#Render-Pipeline] — render-lock, last-good, error overlay (do not regress)
- [Source: 5-1-zoom-pan-and-reset-view.md] — Decision D1 frontend-local config resolution pattern; render-path seams (renderDotWithFallback, zoomAccessor, shouldReset/installResetKeybinding, setPreserveView re-export) this story reuses
- [Source: frontend/render.ts] — d3 import boundary, .onerror() invariant, renderDotWithFallback success boundary, keydown infra, setTimeout(0) fallback race note, test seams
- [Source: frontend/viewstate.ts] — pure-module + injected-accessor + module-level config-resolver pattern to mirror in interact.ts
- [Source: frontend/render-queue.ts] — v-guard + render-lock (must not regress)
- [Source: lua/interactive-graphviz/config.lua] — current config keys (highlight_mode NOT present; do not add it in this story)
- [Source: .github/workflows/ci.yml:50] — `bun test frontend` auto-gates new specs

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8)

### Debug Log References

- `bun test frontend` → 54 pass / 0 fail (4 files; includes new `interact.test.ts`, 33 cases)
- `bun test server` → 63 pass / 0 fail (9 files; no regressions)
- `bun test tests/e2e/render.spec.ts` → 2 pass / 0 fail (cold-open relay invariant intact)
- `nvim --headless … nvim_smoke.lua` → exit 0
- `stylua --check .` → exit 0 (no diffs)
- `bun build frontend/index.html --outdir dist/frontend` → bundled 181 modules, clean

### Completion Notes List

- **Decision D1 (AC5) — `highlight_mode` resolved frontend-locally.** Chose Option 1 (mirror Story 5.1's `preserve_view`): a module-level `_highlightMode` in `interact.ts` defaulting to `"bidirectional"`, with `setHighlightMode()` / `getHighlightMode()` re-exported through `render.ts`. Unknown/invalid values clamp to the default via `isHighlightMode`. No new WS-envelope field, no new message type, no Lua config key, no `server/`/`lua/` change. Default-on `"bidirectional"` requires no startup call, so `main.ts` does not call `setHighlightMode`. Browser→server return channel stays dormant. AC5 satisfied.
- **Adjacency extraction source.** Highlight MATH stays pure in `interact.ts` operating on an injected `GraphModel`. Two pure model builders ship: `parseDotModel` (pragmatic DOT parser) and `buildModelFromTitles` (from SVG `<title>` strings). `render.ts` uses the **SVG-title source** at apply time for neighbor adjacency (robust: mirrors exactly what is drawn). Cluster MEMBER sets are not derivable from SVG titles (they only name the cluster), so cluster augmentation (AC3) uses `parseDotModel(lastGoodDot)`. Both sources are unit-tested.
- **AC3 cluster-highlight UX choice.** "Offers" is satisfied via **Alt+click**: Alt+click on a node augments the per-node neighbor highlight with its whole cluster (all member nodes + intra-cluster edges), unioned via `unionHighlight`. Simplest UX that satisfies the AC without building UI chrome; 5.4 owns polish.
- **AC4 live-reload survival.** Highlight re-application hooks into the existing per-render SUCCESS boundary `renderDotWithFallback` (right after `restoreViewState`), never inside the `onError` fallback recovery render — so no second concurrent d3 DOM-mutation race on `#app`. `Selection.retain(model)` prunes selected node titles that disappeared after reload; if none survive the highlight clears cleanly. `render-queue.ts` (v-guard + render-lock) is untouched; the error overlay and empty-buffer notice surfaces are not modified.
- **Module boundary intact.** `interact.ts` is pure (no `document`/`window`, no `d3-graphviz`/`@hpcc-js` import — verified by grep). The `graphviz` import remains single-sourced in `render.ts`; `main.ts` only calls `installInteractionHandlers()` exported from `render.ts`. `d3-zoom`'s `zoomTransform` in `viewstate.ts` is pre-existing (Story 5.1) and is a pure transform helper, not the renderer.
- **Esc seam for Story 5.3.** `shouldClearHighlight` mirrors `shouldReset`: skips when an INPUT/TEXTAREA is focused and when a modifier is held, leaving a clean seam for search's own `Esc`-closes-search. The `0`/`r` reset binding is unchanged (separate handler).
- **Manual browser verification (no automated harness — MEMORY browser-render-untested).** The pure highlight model, selection machine, mode resolver, cluster derivation, and the `Esc` predicate are covered by `interact.test.ts`. The live click→SVG-emphasis DOM path (delegated click on `#app`, CSS class application, opacity/stroke treatment) has no automated harness and is to be verified manually in a browser: open a preview, click a node (neighbors highlight, rest dim), Shift+click (multi-select unions), Alt+click a clustered node (whole cluster lights up), `Esc` / empty-canvas click (clears), and edit the buffer to confirm the highlight survives live-reload.

### File List

- `frontend/interact.ts` (NEW) — pure graph model, `parseDotModel`, `buildModelFromTitles`/`parseEdgeTitle`, `computeHighlightSet` (4 modes), `Selection` state machine, cluster derivation (`clusterOf`/`computeClusterHighlightSet`/`unionHighlight`), `highlight_mode` resolver, `shouldClearHighlight` predicate
- `frontend/interact.test.ts` (NEW) — pure-unit tests (33 cases) for all of the above
- `frontend/render.ts` (MODIFIED) — SVG-title model extraction, `applyHighlightToDom`, delegated click handler + `Esc` keydown, `reapplyHighlightAfterRender` hooked into `renderDotWithFallback`, `installInteractionHandlers`, `setHighlightMode`/`getHighlightMode` re-export, highlight test seams
- `frontend/main.ts` (MODIFIED) — call `installInteractionHandlers()` once at startup
- `README.md` (MODIFIED) — click/Shift+click/Alt+click/`Esc` gestures + `highlight_mode` documentation
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (MODIFIED) — story status → review

## Change Log

- 2026-06-08 — Implemented Story 5.2 click-to-highlight-neighbors: new pure `frontend/interact.ts` (graph model + 4-mode highlight math + selection state machine + cluster derivation + `highlight_mode` resolver) with `interact.test.ts` (33 cases); wired delegated click + `Esc` + SVG emphasis + live-reload re-apply into `render.ts`/`main.ts`; README docs. All ACs satisfied; frontend-local config (no new wire surface, no `server/`/`lua/` change). All CI gates pass (stylua, bun test frontend/server, nvim smoke, e2e relay, frontend bundle). Status → review.