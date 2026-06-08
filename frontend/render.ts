// render.ts is the ONLY module that imports d3-graphviz / @hpcc-js/wasm-graphviz.
// All other modules (main.ts, ws.ts) speak the wire protocol only.
//
// d3-graphviz 5.6.0 ships no TypeScript definitions; the import resolves to
// `any` — this is expected and intentional.

// eslint-disable-next-line import/no-unresolved
import { graphviz } from "d3-graphviz";
import { createRenderQueue } from "./render-queue";
import {
  captureViewState,
  restoreViewState,
  type ViewState,
  type ZoomAccessor,
} from "./viewstate";
import {
  Selection,
  buildModelFromTitles,
  computeClusterHighlightSet,
  computeHighlightSet,
  emptyHighlightSet,
  getHighlightMode,
  parseDotModel,
  shouldClearHighlight,
  unionHighlight,
  type GraphModel,
  type HighlightSet,
} from "./interact";
import {
  computeSearchMatches,
  getSearchConfig,
  isSearchScope,
  searchResultToHighlightSet,
  setSearchConfig,
  shouldCloseSearch,
  shouldOpenSearch,
  type SearchOpts,
} from "./search";

/**
 * Render a DOT string into #app using the bundled WASM renderer.
 * No system Graphviz is required — the WASM module is bundled into this file
 * via Bun's bundler (FR-6).
 *
 * Called by the render queue only; external callers use queueRender.
 */
export function renderDot(dot: string, engine: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      // d3-graphviz error handling is the dedicated `.onerror()` method — NOT
      // `.on("error", …)`. The `.on()` event system only knows the render
      // lifecycle types (start/layout/render/transition/end); registering an
      // "error" listener there makes d3-dispatch throw "unknown type: error"
      // synchronously, failing every render before the DOT is even parsed.
      graphviz("#app")
        .engine(engine)
        .onerror((err: unknown) => {
          console.error("interactive-graphviz: render error", err);
          reject(err instanceof Error ? err : new Error(String(err)));
        })
        .on("end", () => resolve())
        .renderDot(dot);
    } catch (err) {
      console.error("interactive-graphviz: render error (sync)", err);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ── Zoom / view-state plumbing (Story 5.1) ───────────────────────────────────
// render.ts is the single home of the d3-graphviz import, so it also owns the
// bridge to viewstate.ts. The cached graphviz instance lives on the #app node
// (d3-graphviz stores it at node.__graphviz__ and reuses it on every
// graphviz("#app") call), so zoomSelection()/zoomBehavior() reflect the LIVE
// zoom state across renders.

/** Build a viewstate ZoomAccessor backed by the live d3-graphviz instance. */
function zoomAccessor(): ZoomAccessor {
  // d3-graphviz ships no types — gv is `any`. Its public zoom accessors are
  // zoomSelection() and zoomBehavior() (d3-graphviz/src/zoom.js).
  const gv = graphviz("#app");
  return {
    zoomSelection() {
      const sel = gv.zoomSelection();
      return sel ?? null;
    },
    zoomBehavior() {
      const b = gv.zoomBehavior();
      return b ?? null;
    },
  };
}

/**
 * Reset the view to fit-to-viewport (Story 5.1 AC1, the `0`/`r` affordance).
 * Uses the d3-graphviz public resetZoom() (resets to the original transform set
 * at layout time) rather than hand-rolling a transform. No-op before the first
 * render (no zoom behavior yet). Guarded against d3 throwing.
 */
export function resetZoomToFit(): void {
  try {
    const gv = graphviz("#app");
    if (gv.zoomBehavior() && gv.zoomSelection()) {
      gv.resetZoom();
    }
  } catch (err) {
    console.warn("interactive-graphviz: resetZoom failed", err);
  }
}

// ── Last-good-render state ──────────────────────────────────────────────────
let lastGoodDot: string | null = null;
let lastGoodEngine: string = "dot";

/**
 * Wraps renderDot: on success, updates lastGoodDot/lastGoodEngine.
 * Does NOT render the fallback itself — fallback is triggered by onError in
 * the queue opts (render.ts caller responsibility).
 *
 * Story 5.1 — preserve_view: capture the live zoom transform BEFORE the render
 * re-runs the graph transition, and reapply it AFTER renderDot's "end" event
 * resolves (the zoom behavior is in place by then). The reapply is defensive and
 * idempotent — it restores the prior view whether or not d3-graphviz happened to
 * preserve the transform on this particular render. captureViewState/restoreViewState
 * are no-ops when preserve_view is false or on a fresh canvas, so the default
 * fit-to-viewport behavior is preserved. This is the per-render success
 * boundary, so it runs for every applied render (not just the first).
 */
async function renderDotWithFallback(dot: string, engine: string): Promise<void> {
  const captured: ViewState | null = captureViewState(zoomAccessor());
  await renderDot(dot, engine);
  // Only reached on success — update last-good state.
  lastGoodDot = dot;
  lastGoodEngine = engine;
  // Reapply the prior zoom/pan now that the new zoom behavior exists (AC2).
  // No-op when preserve_view=false (AC3) or when nothing was captured.
  restoreViewState(zoomAccessor(), captured);
  // Story 5.2 AC4 — re-derive + re-apply the active highlight against the NEW
  // SVG. This runs on the per-render SUCCESS boundary only (never inside the
  // fallback-recovery render in onError), so it cannot introduce a second
  // concurrent d3 DOM mutation race on #app. It also re-binds the delegated
  // click listener (idempotent) since d3-graphviz rebuilds the #app subtree.
  reapplyHighlightAfterRender();
}

// ── Error overlay ───────────────────────────────────────────────────────────

function extractMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
}

/**
 * Show a non-blocking error overlay at top-right.
 * Idempotent: if the overlay already exists, updates its text.
 */
export function showError(err: unknown, v: number): void {
  // When err is already a plain string (e.g. from a server-side error_display
  // message), use it as-is without the "DOT parse error" prefix. Error objects
  // and other unknowns are formatted with the "DOT parse error" prefix since
  // they always originate from the WASM renderer.
  // An error supersedes the empty-buffer notice — they are mutually exclusive
  // informational surfaces, never shown together.
  clearEmptyNotice();
  const msg = extractMessage(err);
  const text = typeof err === "string" ? `Error (v${v}): ${msg}` : `DOT parse error (v${v}): ${msg}`;
  let overlay = document.getElementById("ig-error-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "ig-error-overlay";
    overlay.style.cssText =
      "position:fixed;top:8px;right:8px;background:rgba(30,0,0,0.85);" +
      "color:#ff8080;padding:6px 10px;border-radius:4px;font-size:13px;" +
      "font-family:monospace;z-index:9999;pointer-events:none;max-width:50vw;word-break:break-all;";
    document.body.appendChild(overlay);
  }
  overlay.textContent = text;
}

/**
 * Clear the error overlay if present. _v is accepted for future correlation.
 */
export function clearError(_v: number): void {
  const overlay = document.getElementById("ig-error-overlay");
  if (overlay) {
    overlay.parentNode?.removeChild(overlay);
  }
}

// ── Empty-buffer notice ───────────────────────────────────────────────────────
// Informational (NOT an error): the DOT buffer is empty/whitespace, so there is
// nothing to render. Non-blocking, top-left, visually distinct from the red error
// overlay. It never touches #app, so a previously rendered good graph stays on
// screen; on an initial empty buffer #app is empty anyway and this tells the user
// why. Cleared as soon as a real (non-blank) render is dispatched.
export function showEmptyNotice(v: number): void {
  // The empty-buffer state is informational, not an error — clear any error
  // overlay so the two are never shown together.
  clearError(v);
  let el = document.getElementById("ig-empty-notice");
  if (!el) {
    el = document.createElement("div");
    el.id = "ig-empty-notice";
    el.style.cssText =
      "position:fixed;top:8px;left:8px;background:rgba(40,40,40,0.85);" +
      "color:#cccccc;padding:6px 10px;border-radius:4px;font-size:13px;" +
      "font-family:monospace;z-index:9999;pointer-events:none;max-width:50vw;";
    document.body.appendChild(el);
  }
  el.textContent = `Buffer is empty — nothing to render (v${v})`;
}

/** Remove the empty-buffer notice if present. */
export function clearEmptyNotice(): void {
  const el = document.getElementById("ig-empty-notice");
  if (el) {
    el.parentNode?.removeChild(el);
  }
}

// ── Test seams ──────────────────────────────────────────────────────────────
/** Returns lastGoodDot. Production code never calls this. */
export function _lastGoodDot(): string | null {
  return lastGoodDot;
}

/** Returns the overlay element (or null). Production code never calls this. */
export function _overlayElement(): HTMLElement | null {
  return document.getElementById("ig-error-overlay");
}

/** Returns the empty-notice element (or null). Production code never calls this. */
export function _emptyNoticeElement(): HTMLElement | null {
  return document.getElementById("ig-empty-notice");
}

// ── Reset keybinding (Story 5.1 AC1) ──────────────────────────────────────────

/** The shape of a keydown event we care about — keeps the predicate DOM-free. */
export interface ResetKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * Pure predicate: should this keydown trigger a reset-to-fit?
 *
 * True only for an un-modified `0` or `r` when NOT typing in a text field.
 * `activeTag` is the focused element's tagName (e.g. document.activeElement?.tagName);
 * search (Story 5.3) will own typing, so we leave that seam clean by skipping
 * INPUT/TEXTAREA. Pure + injectable so it is unit-testable without a real DOM.
 */
export function shouldReset(e: ResetKeyEvent, activeTag: string | undefined): boolean {
  if (e.key !== "0" && e.key !== "r") return false;
  if (activeTag === "INPUT" || activeTag === "TEXTAREA") return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return true;
}

/**
 * Handle a real keydown for the reset-to-fit affordance (`0` or `r`).
 * Returns true when the key was handled (for tests / callers).
 */
export function handleResetKeydown(e: KeyboardEvent): boolean {
  if (!shouldReset(e, document.activeElement?.tagName)) return false;
  resetZoomToFit();
  return true;
}

/**
 * Install the document-level reset keybinding once. Idempotent: a second call
 * is a no-op (guarded by a flag) so re-imports / HMR don't stack listeners.
 */
let _resetKeyInstalled = false;
export function installResetKeybinding(): void {
  if (_resetKeyInstalled) return;
  _resetKeyInstalled = true;
  document.addEventListener("keydown", handleResetKeydown);
}

// ── Click-to-highlight neighbors (Story 5.2) ─────────────────────────────────
// render.ts is the only module that touches the live SVG, so it owns the DOM
// bridge for the pure highlight model in interact.ts (mirroring the viewstate
// bridge). The highlight MATH and selection state machine are pure + unit-tested
// in interact.ts; here we (1) extract the graph model from the live SVG <title>
// elements (robust: mirrors what is actually drawn), (2) apply CSS classes for
// Selected / Neighbor / Dimmed emphasis, and (3) wire delegated click + Esc.
//
// Highlight is a cheap class/opacity toggle on existing SVG groups — no
// re-render (NFR-7). Animation/transition polish is Story 5.4's scope.

// Module-level selection state machine (pure, from interact.ts).
const _selection = new Selection();
// The graph model used for cluster membership (only the DOT parse carries
// cluster member sets; SVG titles do not). Re-derived from the latest applied
// DOT on each render. Null until the first render with a DOT.
let _clusterModel: GraphModel | null = null;
// Whether cluster-highlight augmentation is active (AC3). Toggled by Alt+click:
// Alt+click on a node in a cluster augments the neighbor highlight with the
// whole cluster (members + intra-cluster edges). Documented in Dev Agent Record.
let _clusterAugment = false;

const STYLE_ID = "ig-highlight-style";
// Injected once: the Selected / Neighbor / Dimmed emphasis treatment. Story 5.4
// owns richer polish; here we keep instant, cheap opacity/stroke changes.
const HIGHLIGHT_CSS = `
#app g.node.ig-dimmed, #app g.edge.ig-dimmed { opacity: 0.15; }
#app g.node.ig-neighbor, #app g.edge.ig-neighbor { opacity: 1; }
/* Neighbor = emphasized but distinct from Selected (AC1): a lighter accent
   stroke so neighbors read as positively highlighted, not merely un-dimmed,
   while staying visually subordinate to the Selected node's bolder stroke. */
#app g.node.ig-neighbor ellipse,
#app g.node.ig-neighbor polygon,
#app g.node.ig-neighbor path { stroke: #ffcc80; stroke-width: 2px; }
#app g.node.ig-selected { opacity: 1; }
#app g.node.ig-selected ellipse,
#app g.node.ig-selected polygon,
#app g.node.ig-selected path { stroke: #ff9800; stroke-width: 3px; }
`;

function ensureHighlightStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = HIGHLIGHT_CSS;
  document.head.appendChild(style);
}

/** Read the textContent of the first <title> child of an SVG group, trimmed. */
function groupTitle(group: Element): string {
  // The <title> is a direct child; querySelector(":scope > title") keeps us from
  // grabbing a descendant edge/node title in nested structures.
  const t = group.querySelector(":scope > title") ?? group.querySelector("title");
  return (t?.textContent ?? "").trim();
}

/**
 * Build the pure graph model from the LIVE SVG <title> elements. Graphviz emits
 * each node as <g class="node"><title>NAME</title>…>, each edge as
 * <g class="edge"><title>A-&gt;B</title>…> (A--B undirected), each cluster as
 * <g class="cluster"><title>cluster_NAME</title>…>. This is the chosen
 * extraction source (robust, mirrors what is drawn); the math stays pure.
 */
function extractModelFromApp(): GraphModel {
  const app = document.getElementById("app");
  if (!app) return buildModelFromTitles({ nodeTitles: [], edgeTitles: [] });
  const nodeTitles: string[] = [];
  const edgeTitles: string[] = [];
  const clusterTitles: string[] = [];
  app.querySelectorAll("g.node").forEach((g) => nodeTitles.push(groupTitle(g)));
  app.querySelectorAll("g.edge").forEach((g) => edgeTitles.push(groupTitle(g)));
  app.querySelectorAll("g.cluster").forEach((g) => clusterTitles.push(groupTitle(g)));
  return buildModelFromTitles({ nodeTitles, edgeTitles, clusterTitles });
}

/** Clear all highlight CSS classes from #app's node/edge groups (full opacity). */
function clearHighlightClasses(): void {
  const app = document.getElementById("app");
  if (!app) return;
  app.querySelectorAll("g.node, g.edge").forEach((g) => {
    g.classList.remove("ig-selected", "ig-neighbor", "ig-dimmed");
  });
}

/**
 * Apply a computed HighlightSet onto the live SVG: selected nodes get the
 * strongest emphasis, neighbors get the neighbor class, the connecting edges are
 * emphasized, and everything non-matching is dimmed. An empty highlight set
 * returns every element to full opacity (no dimming) — the cleared state.
 */
function applyHighlightToDom(set: HighlightSet): void {
  const app = document.getElementById("app");
  if (!app) return;
  ensureHighlightStyle();

  const anySelected = set.selected.size > 0;
  app.querySelectorAll("g.node").forEach((g) => {
    const name = groupTitle(g);
    g.classList.remove("ig-selected", "ig-neighbor", "ig-dimmed");
    if (!anySelected) return; // cleared state: no classes, full opacity
    if (set.selected.has(name)) g.classList.add("ig-selected");
    else if (set.nodes.has(name)) g.classList.add("ig-neighbor");
    else g.classList.add("ig-dimmed");
  });
  app.querySelectorAll("g.edge").forEach((g) => {
    const title = groupTitle(g);
    g.classList.remove("ig-neighbor", "ig-dimmed");
    if (!anySelected) return;
    // Edge <title> text is exactly the EdgeKey form (A->B / A--B).
    if (set.edges.has(title)) g.classList.add("ig-neighbor");
    else g.classList.add("ig-dimmed");
  });
}

/**
 * Compute the highlight set for the current selection (+ optional cluster
 * augmentation) against a freshly-extracted model, and apply it. Pure logic is
 * delegated to interact.ts; this only orchestrates extraction → math → DOM.
 */
function recomputeAndApplyHighlight(): void {
  if (_selection.isEmpty()) {
    applyHighlightToDom(emptyHighlightSet());
    return;
  }
  const model = extractModelFromApp();
  const mode = getHighlightMode();
  let set = computeHighlightSet(model, _selection.toArray(), mode);
  // AC3 — cluster augmentation: include the whole cluster for any selected node
  // that lives in a cluster (membership comes from the DOT parse model).
  if (_clusterAugment && _clusterModel) {
    for (const sel of _selection.toArray()) {
      set = unionHighlight(set, computeClusterHighlightSet(_clusterModel, sel));
    }
  }
  applyHighlightToDom(set);
}

/**
 * Re-derive + re-apply the active highlight after a successful render (AC4).
 * Selected node titles that no longer exist are pruned; if none survive the
 * highlight clears cleanly. Also re-binds the delegated click listener since
 * d3-graphviz rebuilds the #app subtree on every render. Never blanks #app and
 * never touches the v-guard / render-lock (those live in render-queue.ts).
 */
function reapplyHighlightAfterRender(): void {
  // Refresh the cluster model from the latest applied DOT (set by the queue
  // wrapper before render); fall back to SVG-derived model (no cluster members).
  if (lastGoodDot !== null) {
    try {
      // The DOT parse is the only source carrying cluster MEMBER sets (SVG
      // titles only name the cluster), so cluster augmentation (AC3) uses it.
      _clusterModel = parseDotModel(lastGoodDot);
    } catch {
      _clusterModel = null;
    }
  }
  const model = extractModelFromApp();
  _selection.retain(model); // prune nodes gone after live-reload
  installInteractionHandlers(); // idempotent re-bind
  // Story 5.3 AC5 — if search is open with a non-empty query, it owns the
  // highlight: re-derive matches against the NEW SVG and skip the click-highlight
  // re-apply this render (they share the single applyHighlightToDom regime, so
  // we must not apply both). Otherwise fall through to click-highlight re-apply.
  if (reapplySearchAfterRender()) return;
  recomputeAndApplyHighlight();
}

/**
 * Pure predicate: does this click target a node group? Returns the node title or
 * null (background / empty-canvas click). Walks up from the event target to the
 * nearest g.node within #app (event delegation), so it survives re-renders.
 */
export function nodeTitleFromClickTarget(target: EventTarget | null): string | null {
  let el = target as Element | null;
  const app = document.getElementById("app");
  while (el && el !== app && el !== document.body) {
    if (el instanceof Element && el.classList?.contains("node") && el.tagName === "g") {
      return groupTitle(el);
    }
    el = el.parentElement;
  }
  return null;
}

/** Handle a click on #app: node click selects/extends; background click clears. */
export function handleAppClick(e: MouseEvent): void {
  const title = nodeTitleFromClickTarget(e.target);
  if (title === null || title.length === 0) {
    // Empty-canvas / background click clears (AC2).
    _selection.clear();
    _clusterAugment = false;
    recomputeAndApplyHighlight();
    return;
  }
  // Alt+click augments with the node's cluster (AC3). Shift+click multi-selects.
  _clusterAugment = e.altKey === true;
  if (e.shiftKey) _selection.add(title);
  else _selection.set(title);
  recomputeAndApplyHighlight();
}

/** Handle an Esc keydown: clear highlighting (search-safe predicate). */
export function handleHighlightKeydown(e: KeyboardEvent): boolean {
  if (!shouldClearHighlight(e, document.activeElement?.tagName)) return false;
  _selection.clear();
  _clusterAugment = false;
  recomputeAndApplyHighlight();
  return true;
}

/**
 * Install the click + Esc highlight wiring. Click uses a single delegated
 * listener on #app (event delegation up to the nearest g.node) so it survives
 * re-renders; the keydown is document-level. Idempotent — guarded so re-binding
 * after every render (AC4) and a duplicate startup call do not stack listeners.
 */
let _clickBound: Element | null = null;
let _highlightKeyInstalled = false;
export function installInteractionHandlers(): void {
  const app = document.getElementById("app");
  if (app && _clickBound !== app) {
    // #app is stable across renders (d3-graphviz rebuilds its CHILDREN, not the
    // container), so the delegated listener normally binds once. Re-checking the
    // identity keeps it correct if #app is ever replaced.
    app.addEventListener("click", handleAppClick as EventListener);
    _clickBound = app;
  }
  if (!_highlightKeyInstalled) {
    _highlightKeyInstalled = true;
    document.addEventListener("keydown", handleHighlightKeydown);
  }
}

// ── Highlight test seams ──────────────────────────────────────────────────────
/** Returns the current selection snapshot. Production code never calls this. */
export function _selectionSnapshot(): string[] {
  return _selection.toArray();
}

/** Force-clear highlight state (selection + cluster augment). Tests only. */
export function _resetHighlightState(): void {
  _selection.clear();
  _clusterAugment = false;
  _clusterModel = null;
}

// ── Live search (Story 5.3) ───────────────────────────────────────────────────
// render.ts owns the DOM bridge for the pure search model in search.ts (mirroring
// the interact.ts / viewstate.ts bridges). The match MATH + scope/toggle logic +
// invalid-regex sentinel + config resolver are pure + unit-tested in search.ts;
// here we (1) build a compact fixed-position search box (#ig-search-box) the same
// idempotent, inline-styled way as showError/showEmptyNotice, (2) install the
// document-level `/` open keybinding, (3) run the pure matcher against the LIVE
// SVG model (the SAME extractModelFromApp click-highlight uses), and (4) apply
// matches through the SHARED applyHighlightToDom — no parallel ig-search-* class
// regime (AC5). Emphasis is a cheap class/opacity toggle, no graph re-render
// (NFR-7). Animation/transition polish is Story 5.4's scope.
//
// Precedence (AC5): while the search box is OPEN with a non-empty query, search
// owns the highlight. Closing/clearing search restores the click-highlight
// selection state (re-run recomputeAndApplyHighlight). The two share the single
// applyHighlightToDom regime and never stack two fighting class sets.

const SEARCH_BOX_ID = "ig-search-box";
// Whether the search box is currently open (drives precedence + re-apply on
// live-reload). When open with a non-empty query, search owns the highlight.
let _searchOpen = false;

/** Read the live search options from the in-memory config + UI toggle state. */
function currentSearchOpts(): SearchOpts {
  const base = getSearchConfig();
  const box = document.getElementById(SEARCH_BOX_ID);
  if (!box) return base;
  const caseEl = box.querySelector<HTMLInputElement>("#ig-search-case");
  const regexEl = box.querySelector<HTMLInputElement>("#ig-search-regex");
  const scopeEl = box.querySelector<HTMLSelectElement>("#ig-search-scope");
  return {
    caseSensitive: caseEl ? caseEl.checked : base.caseSensitive,
    regex: regexEl ? regexEl.checked : base.regex,
    scope: scopeEl && isSearchScope(scopeEl.value) ? scopeEl.value : base.scope,
  };
}

/** Read the current query string from the search box input (empty when closed). */
function currentSearchQuery(): string {
  const input = document.getElementById("ig-search-input") as HTMLInputElement | null;
  return input?.value ?? "";
}

/**
 * Run the pure matcher against the live SVG model and apply the matches through
 * the shared applyHighlightToDom, updating the N/total counter and the invalid-
 * regex error indication. A non-empty query owns the highlight (AC5 precedence);
 * an empty query / zero matches dims nothing (AC2) and restores the click-
 * highlight selection so closing search leaves the prior selection intact.
 */
function runSearch(): void {
  const query = currentSearchQuery();
  const opts = currentSearchOpts();
  const model = extractModelFromApp();
  const result = computeSearchMatches(model, query, opts);

  updateSearchCounter(result.count, result.total, result.valid);

  if (result.empty) {
    // Empty query: search owns nothing — restore the click-highlight selection
    // (or cleared state) so the two never fight (AC5 precedence).
    recomputeAndApplyHighlight();
    return;
  }
  // Non-empty query owns the highlight while the box is open.
  applyHighlightToDom(searchResultToHighlightSet(result));
}

/** Update the `N/total` counter element and the invalid-regex indication. */
function updateSearchCounter(count: number, total: number, valid: boolean): void {
  const counter = document.getElementById("ig-search-counter");
  if (!counter) return;
  if (!valid) {
    counter.textContent = "invalid regex";
    counter.style.color = "#ff8080";
    return;
  }
  counter.textContent = `${count}/${total}`;
  counter.style.color = count === 0 ? "#999999" : "#cccccc";
}

const SEARCH_STYLE_ID = "ig-search-style";
const SEARCH_CSS = `
#${SEARCH_BOX_ID} { position:fixed; top:8px; left:50%; transform:translateX(-50%);
  background:rgba(30,30,30,0.92); color:#eee; padding:6px 8px; border-radius:6px;
  font-size:13px; font-family:monospace; z-index:9999; pointer-events:auto;
  display:flex; align-items:center; gap:8px; box-shadow:0 2px 8px rgba(0,0,0,0.4); }
#${SEARCH_BOX_ID} input[type=text] { background:#1b1b1b; color:#eee; border:1px solid #444;
  border-radius:4px; padding:3px 6px; font-family:monospace; font-size:13px; width:220px; outline:none; }
#${SEARCH_BOX_ID} label { display:flex; align-items:center; gap:3px; cursor:pointer; user-select:none; }
#${SEARCH_BOX_ID} select { background:#1b1b1b; color:#eee; border:1px solid #444; border-radius:4px; font-size:12px; }
#ig-search-counter { min-width:48px; text-align:right; color:#cccccc; }
`;

function ensureSearchStyle(): void {
  if (document.getElementById(SEARCH_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = SEARCH_STYLE_ID;
  style.textContent = SEARCH_CSS;
  document.head.appendChild(style);
}

/**
 * Build (idempotent) the compact fixed-position search box: a text input, an
 * N/total counter, and case-sensitive + regex toggles + a scope select. Mirrors
 * the inline-styled, idempotent (getElementById guard) overlay pattern of
 * showError/showEmptyNotice — but this one needs pointer-events:auto and a
 * focusable input. Returns the box element.
 */
function buildSearchBox(): HTMLElement {
  ensureSearchStyle();
  let box = document.getElementById(SEARCH_BOX_ID);
  if (box) return box;
  box = document.createElement("div");
  box.id = SEARCH_BOX_ID;

  const input = document.createElement("input");
  input.type = "text";
  input.id = "ig-search-input";
  input.placeholder = "search nodes / edges…";
  input.setAttribute("aria-label", "search graph");
  input.addEventListener("input", () => runSearch());
  // Esc on the input closes/clears search FIRST (AC4). Handling it here (and
  // stopping propagation) keeps the document-level click-highlight Esc-clear from
  // also firing — shouldClearHighlight already skips while an INPUT is focused.
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (shouldCloseSearch(e)) {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
    }
  });

  const counter = document.createElement("span");
  counter.id = "ig-search-counter";
  counter.textContent = "0/0";

  const opts = getSearchConfig();

  const caseLabel = document.createElement("label");
  caseLabel.title = "case-sensitive";
  const caseBox = document.createElement("input");
  caseBox.type = "checkbox";
  caseBox.id = "ig-search-case";
  caseBox.checked = opts.caseSensitive;
  caseBox.addEventListener("change", () => runSearch());
  caseLabel.append(caseBox, document.createTextNode("Aa"));

  const regexLabel = document.createElement("label");
  regexLabel.title = "regular expression";
  const regexBox = document.createElement("input");
  regexBox.type = "checkbox";
  regexBox.id = "ig-search-regex";
  regexBox.checked = opts.regex;
  regexBox.addEventListener("change", () => runSearch());
  regexLabel.append(regexBox, document.createTextNode(".*"));

  const scopeSel = document.createElement("select");
  scopeSel.id = "ig-search-scope";
  for (const s of ["both", "nodes", "edges"]) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s;
    if (s === opts.scope) o.selected = true;
    scopeSel.appendChild(o);
  }
  scopeSel.addEventListener("change", () => runSearch());

  box.append(input, counter, caseLabel, regexLabel, scopeSel);
  document.body.appendChild(box);
  return box;
}

/** Open the search box (build if needed) and focus the input (AC1). */
export function openSearch(): void {
  const box = buildSearchBox();
  box.style.display = "flex";
  _searchOpen = true;
  const input = document.getElementById("ig-search-input") as HTMLInputElement | null;
  if (input) {
    input.focus();
    input.select();
  }
  runSearch();
}

/**
 * Close the search box and clear its highlight/dim (AC4). Every element returns
 * to full opacity by restoring the click-highlight selection state (which is the
 * cleared state when nothing is click-selected). Precedence (AC5): closing search
 * hands the highlight back to click-highlight.
 */
export function closeSearch(): void {
  const box = document.getElementById(SEARCH_BOX_ID);
  if (box) box.style.display = "none";
  const input = document.getElementById("ig-search-input") as HTMLInputElement | null;
  if (input) {
    input.value = "";
    input.blur();
  }
  _searchOpen = false;
  // Restore click-highlight selection (or cleared state) — search no longer owns
  // the highlight. This shares the single applyHighlightToDom regime (AC5).
  recomputeAndApplyHighlight();
}

/** Handle a document-level keydown for `/`-to-open search (AC1). */
export function handleSearchKeydown(e: KeyboardEvent): boolean {
  if (!shouldOpenSearch(e, document.activeElement?.tagName)) return false;
  e.preventDefault(); // don't type the slash into anything / trigger find
  openSearch();
  return true;
}

/**
 * Install the document-level `/`-open keybinding once. Idempotent (guarded flag)
 * so re-imports / HMR / a duplicate startup call do not stack listeners. Mirrors
 * installResetKeybinding / installInteractionHandlers.
 */
let _searchKeyInstalled = false;
export function installSearchHandlers(): void {
  if (_searchKeyInstalled) return;
  _searchKeyInstalled = true;
  document.addEventListener("keydown", handleSearchKeydown);
}

/**
 * Re-apply search after a successful render (AC5 — live-reload interop). Called
 * from reapplyHighlightAfterRender on the per-render SUCCESS boundary only.
 * Returns true when search owned the highlight (so click-highlight re-apply is
 * skipped this render); false when search is closed/empty (click-highlight
 * re-apply proceeds as before). Re-derives matches against the NEW SVG.
 */
function reapplySearchAfterRender(): boolean {
  if (!_searchOpen) return false;
  const query = currentSearchQuery();
  if (query.trim().length === 0) return false; // empty: click-highlight owns
  runSearch(); // re-derives matches against the new SVG + updates counter
  return true;
}

// ── Search test seams ─────────────────────────────────────────────────────────
/** True when the search box is open. Production code never calls this. */
export function _searchIsOpen(): boolean {
  return _searchOpen;
}

/** Force-close search + reset config. Tests only. */
export function _resetSearchState(): void {
  closeSearch();
  const box = document.getElementById(SEARCH_BOX_ID);
  if (box) box.parentNode?.removeChild(box);
  _searchOpen = false;
}

// ── Render queue wired to real WASM renderer + error overlay ─────────────────
const _queue = createRenderQueue(renderDotWithFallback, {
  onError(err: unknown, v: number) {
    showError(err, v);
    if (lastGoodDot !== null) {
      // Restore last good render directly (bypass the queue — recovery path).
      // Deferred via setTimeout(0) so the current d3-graphviz error transition
      // is fully torn down before the fallback render begins — avoids concurrent
      // d3 DOM mutations on #app (onError fires while inFlight is still true,
      // before the .finally() cleanup).
      const dot = lastGoodDot;
      const engine = lastGoodEngine;
      setTimeout(() => {
        renderDot(dot, engine).catch((fallbackErr: unknown) => {
          console.warn("interactive-graphviz: fallback render failed", fallbackErr);
        });
      }, 0);
    }
  },
  onSuccess(v: number) {
    clearError(v);
  },
});

/**
 * Queue a render with v-guard and render-lock (Story 1.5).
 * Use this instead of renderDot directly from main.ts.
 */
export const queueRender = _queue.queueRender.bind(_queue);

// Re-export the preserve_view setter so main.ts configures view preservation
// without importing viewstate.ts directly (keeps the render/view concern
// single-sourced behind render.ts). Decision D1 Option 1: frontend-default-on.
export { setPreserveView } from "./viewstate";

// Re-export the highlight_mode setter so main.ts can resolve the mode at startup
// without importing interact.ts directly (keeps the interaction concern
// single-sourced behind render.ts), mirroring setPreserveView. Decision D1
// Option 1: frontend-local, default "bidirectional" requires no call at all.
export { setHighlightMode, getHighlightMode } from "./interact";

// Re-export the search config setter so main.ts can resolve `search={…}` at
// startup without importing search.ts directly (keeps the interaction concern
// single-sourced behind render.ts), mirroring setHighlightMode / setPreserveView.
// Decision D1: frontend-local, default (both / case-insensitive / no-regex)
// requires no call at all — zero new wire surface (AC6).
export { setSearchConfig } from "./search";
