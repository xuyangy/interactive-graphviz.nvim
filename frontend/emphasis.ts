// emphasis.ts — the DOM emphasis layer: click-to-highlight neighbors (Story
// 5.2), the cursor-echo outline (Story 6.3), and the post-render re-apply
// orchestration. Extracted from render.ts (plan item #1b), built on the
// graph-dom bridge (#8a/#8b). The highlight MATH and selection state machine
// are pure + unit-tested in interact.ts; here we (1) orchestrate extraction →
// math → DOM, (2) apply CSS classes for Selected / Neighbor / Dimmed emphasis,
// and (3) wire delegated click + Esc.
//
// No d3: render.ts remains the only module that imports d3-graphviz. The two
// d3-touching behaviors this layer triggers — pan-to-cursor and its
// cancellation — are INJECTED by render.ts via setCursorPanHooks (the sync.ts
// setNodeClickSender idiom), as is the last-good-DOT source for the cluster
// model (setClusterDotSource) and search's post-render precedence hook
// (setSearchReapplyHook, registered by search-ui.ts). Defaults are safe
// no-ops, so nothing breaks if a seam is unregistered.
//
// Highlight is a cheap class/opacity toggle on existing SVG groups — no
// re-render (NFR-7).

import {
  Selection,
  clusterContainsHighlight,
  computeClusterHighlightSet,
  computeHighlightSet,
  emptyHighlightSet,
  getHighlightMode,
  parseDotModel,
  parseEdgeTitle,
  shouldClearHighlight,
  unionHighlight,
  type GraphModel,
  type HighlightSet,
} from "./interact";
import {
  appElement,
  clusterEntries,
  edgeEntries,
  extractModelFromApp,
  invalidateGraphDom,
  nodeEntries,
  nodeTitleFromClickTarget,
} from "./graph-dom";
import { emitNodeClick } from "./sync";
import { ensureAppStyle } from "./style";

// ── Injection seams (registered by render.ts / search-ui.ts at module init) ──

/** The d3-touching pan behaviors applyCursorEmphasis triggers (live in render.ts). */
export interface CursorPanHooks {
  /** Center the node/edge group in the visible area (pan only, scale kept). */
  panIntoView(el: Element): void;
  /** Interrupt an in-flight cursor pan without starting a new one. */
  cancelPan(): void;
}
let _panHooks: CursorPanHooks = { panIntoView: () => {}, cancelPan: () => {} };
export function setCursorPanHooks(hooks: CursorPanHooks): void {
  _panHooks = hooks;
}

// The latest successfully rendered DOT (owned by render.ts) — the only source
// carrying cluster MEMBER sets (SVG titles only name the cluster), consumed on
// the post-render boundary for cluster augmentation (AC3).
let _clusterDotSource: () => string | null = () => null;
export function setClusterDotSource(source: () => string | null): void {
  _clusterDotSource = source;
}

// Search precedence (Story 5.3 AC5): search-ui.ts registers its post-render
// re-apply; it returns true when search owns the highlight this render (open
// box + non-empty query), in which case the click-highlight re-apply is
// skipped — the two share the single applyHighlightToDom regime.
let _searchReapplyHook: () => boolean = () => false;
export function setSearchReapplyHook(hook: () => boolean): void {
  _searchReapplyHook = hook;
}

// Search-open probe (registered by search-ui.ts, same idiom): while the search
// box is open, Esc belongs to search (its document-level handler closes the
// box), so the click-highlight Esc-clear must defer — otherwise Esc with focus
// on search's scope select or the canvas cleared the selection instead of
// closing the box. Default false keeps Esc-clear working standalone.
let _searchOpenProbe: () => boolean = () => false;
export function setSearchOpenProbe(probe: () => boolean): void {
  _searchOpenProbe = probe;
}

// ── Click-to-highlight state ──────────────────────────────────────────────────

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

// The emphasis CSS (Selected/Neighbor/Dimmed treatment, cursor outline + glow,
// motion-gated transition) lives in styles.css — one build-time-inlined
// stylesheet injected via ensureAppStyle() (plan item #2). WHICH classes are
// set is decided here; HOW they look is decided there.

// The node/edge groups carrying ig-selected/ig-neighbor after the LAST
// applyHighlightToDom pass — maintained so fit-to-selection (render.ts) reads
// the highlight without re-scanning the DOM on every `f`. Sound because
// applyHighlightToDom is the ONLY writer of those classes, and it re-runs on
// the post-render boundary, so the recorded refs refresh together with the
// classes. Between a subtree rebuild and that reapply they may briefly point
// at detached groups; fitSelectionInView filters those with isConnected.
let _emphasizedElements: Element[] = [];

/** The emphasized (non-dimmed) groups from the last highlight application. */
export function emphasizedElements(): readonly Element[] {
  return _emphasizedElements;
}

/**
 * Apply a computed HighlightSet onto the live SVG: selected nodes get the
 * strongest emphasis, neighbors get the neighbor class, the connecting edges are
 * emphasized, and everything non-matching is dimmed. An empty highlight set
 * returns every element to full opacity (no dimming) — the cleared state.
 *
 * Exported for search-ui.ts: search applies its matches through this SAME
 * function (AC5) — one emphasis regime, never two fighting class sets.
 */
export function applyHighlightToDom(set: HighlightSet): void {
  if (appElement() === null) return;
  ensureAppStyle();

  // The dim regime engages when ANYTHING is emphasized. Click-highlight always
  // populates `selected`, but an edge-only search match (scope "edges", or a
  // query matching only edge keys) carries edges with an empty `selected` —
  // gating on selected alone left those matches counted but invisible.
  const anyHighlight = set.selected.size > 0 || set.edges.size > 0;
  const emphasized: Element[] = [];
  nodeEntries().forEach(({ el: g, title: name }) => {
    g.classList.remove("ig-selected", "ig-neighbor", "ig-dimmed");
    if (!anyHighlight) return; // cleared state: no classes, full opacity
    if (set.selected.has(name)) g.classList.add("ig-selected");
    else if (set.nodes.has(name)) g.classList.add("ig-neighbor");
    else {
      g.classList.add("ig-dimmed");
      return;
    }
    emphasized.push(g);
  });
  edgeEntries().forEach(({ el: g, title }) => {
    g.classList.remove("ig-neighbor", "ig-dimmed");
    if (!anyHighlight) return;
    // Edge <title> text is exactly the EdgeKey form (A->B / A--B).
    if (set.edges.has(title)) {
      g.classList.add("ig-neighbor");
      emphasized.push(g);
    } else g.classList.add("ig-dimmed");
  });
  _emphasizedElements = emphasized;
  // Cluster boxes (subgraph outline + title label) follow their contents: a
  // cluster dims exactly when all its member nodes dim. Membership comes from
  // the DOT-parse model — SVG cluster titles only NAME the cluster — refreshed
  // on the render boundary alongside the Alt+click augment path; with no model
  // (null before the first render / DOT source gone) the boxes dim as scenery.
  clusterEntries().forEach(({ el: g, title }) => {
    g.classList.remove("ig-dimmed");
    if (!anyHighlight) return;
    if (!clusterContainsHighlight(_clusterModel?.clusters.get(title), set)) {
      g.classList.add("ig-dimmed");
    }
  });
}

// ── Cursor-echo emphasis (Story 6.3, FR-20) ──────────────────────────────────
// One id (or null), fed by the Lua→server→browser `emphasize` message: a node
// id, or — when the cursor sits on an edge line — an edge key in the SVG edge
// <title> form (`a->b` / `a--b`), which lights the edge AND both endpoint
// nodes. Deliberately OUTSIDE the Selection/HighlightSet regime:
// applyHighlightToDom only ever toggles ig-selected/ig-neighbor/ig-dimmed, so
// the ig-cursor class is additive by construction and the two paths cannot
// contend.
let _cursorEmphasisNode: string | null = null;

/**
 * Apply (or clear, with null) the passive cursor emphasis. Last-wins: the
 * stored id is re-asserted on the post-render boundary. An id matching a live
 * edge <title> emphasizes that edge plus its endpoint nodes (endpoints via
 * parseEdgeTitle — the same convention the highlight model uses); an id with
 * no matching live node OR edge (stale buffer text, not-a-node token)
 * emphasizes nothing — miss ≡ clear, the designed graceful degradation; never
 * an error.
 *
 * An emphasized target that is off-screen is panned to the viewport center
 * (the injected panIntoView; for an edge the edge group is the pan target —
 * its bbox spans the run between the endpoints, so centering it frames both
 * ends). This runs on the post-render re-assert too — a live reload that
 * reflows the cursor's target out of view re-centers it, which deliberately
 * outranks preserve_view for that one frame: the user's cursor IS on that
 * target.
 *
 * Last-wins also governs MOTION: a frame that does not itself pan (clear,
 * miss, target already visible) interrupts any in-flight ig-pan transition,
 * so the view never keeps gliding toward a target the cursor has already
 * left. A frame that DOES pan supersedes the old transition implicitly (d3
 * named transitions replace each other per element).
 */
export function applyCursorEmphasis(nodeId: string | null): void {
  _cursorEmphasisNode = typeof nodeId === "string" && nodeId.length > 0 ? nodeId : null;
  if (appElement() === null) return;
  ensureAppStyle();
  const key = _cursorEmphasisNode;
  // Edge pass first: it decides which endpoint nodes the node pass includes.
  let emphasizedEdge: Element | null = null;
  edgeEntries().forEach(({ el: g, title }) => {
    if (key !== null && title === key) {
      g.classList.add("ig-cursor");
      if (emphasizedEdge === null) emphasizedEdge = g; // multi-edges: all lit, first pans
    } else {
      g.classList.remove("ig-cursor");
    }
  });
  // Endpoints only when a LIVE edge matched: a key that merely parses as an
  // edge but matches nothing must not light stray same-named nodes.
  const ends = emphasizedEdge !== null && key !== null ? parseEdgeTitle(key) : null;
  let emphasizedNode: Element | null = null;
  nodeEntries().forEach(({ el: g, title }) => {
    const hit =
      key !== null && (title === key || (ends !== null && (title === ends.from || title === ends.to)));
    if (hit) {
      g.classList.add("ig-cursor");
      if (emphasizedNode === null) emphasizedNode = g;
    } else {
      g.classList.remove("ig-cursor");
    }
  });
  const panTarget = emphasizedEdge ?? emphasizedNode;
  if (panTarget !== null) _panHooks.panIntoView(panTarget);
  else _panHooks.cancelPan();
}

/**
 * Compute the highlight set for the current selection (+ optional cluster
 * augmentation) against a freshly-extracted model, and apply it. Pure logic is
 * delegated to interact.ts; this only orchestrates extraction → math → DOM.
 *
 * Exported for search-ui.ts: closing/clearing search hands the highlight back
 * to the click-selection state through this function (AC5 precedence).
 */
export function recomputeAndApplyHighlight(): void {
  if (_searchReapplyHook && _searchReapplyHook()) {
    return;
  }
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
 * Called by render.ts on the per-render success boundary.
 */
export function reapplyHighlightAfterRender(): void {
  // The subtree was just rebuilt: drop the graph-dom snapshot so every read
  // below (and every cursor frame/search keystroke until the next render)
  // works from the NEW elements. renderDot already invalidated on "end" for
  // the production path; this entry-point invalidation makes the test seam
  // (_reapplyHighlightAfterRender after an innerHTML swap) honor the same
  // render-boundary contract.
  invalidateGraphDom();
  // Refresh the cluster model from the latest applied DOT (via the render.ts
  // seam); fall back to SVG-derived model (no cluster members).
  const dot = _clusterDotSource();
  if (dot !== null) {
    try {
      // The DOT parse is the only source carrying cluster MEMBER sets (SVG
      // titles only name the cluster), so cluster augmentation (AC3) uses it.
      _clusterModel = parseDotModel(dot);
    } catch {
      _clusterModel = null;
    }
  } else {
    // No DOT source (seam unregistered / last-good cleared): keeping the
    // PREVIOUS graph's cluster members would be stale state — fall back to
    // the SVG-derived no-cluster behavior instead.
    _clusterModel = null;
  }
  const model = extractModelFromApp();
  _selection.retain(model); // prune nodes gone after live-reload
  installInteractionHandlers(); // idempotent re-bind
  // Story 6.3 — re-assert the cursor-echo emphasis on the rebuilt subtree.
  // Independent of the highlight regime, so it runs on BOTH branches below
  // (search-owned and click-owned); a pruned/renamed node no longer matches,
  // which reads as cleared.
  applyCursorEmphasis(_cursorEmphasisNode);
  // Story 5.3 AC5 — if search is open with a non-empty query, it owns the
  // highlight: re-derive matches against the NEW SVG and skip the click-highlight
  // re-apply this render (they share the single applyHighlightToDom regime, so
  // we must not apply both). Otherwise fall through to click-highlight re-apply.
  if (_searchReapplyHook()) return;
  recomputeAndApplyHighlight();
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
  // Story 6.2 — graph→buffer sync as a SIDE EFFECT of the same click: gated,
  // seam-injected, and after the highlight so 5.2/5.3/5.4 behavior is unchanged.
  emitNodeClick(title);
}

/** Handle an Esc keydown: clear highlighting (search-safe predicate). */
export function handleHighlightKeydown(e: KeyboardEvent): boolean {
  if (!shouldClearHighlight(e, document.activeElement?.tagName)) return false;
  // Open search owns Esc: its document-level handler closes the box; the
  // click selection survives until a SECOND Esc (search now closed) clears it.
  if (_searchOpenProbe()) return false;
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
  const app = appElement();
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

/** Force-clear highlight state (selection + cluster augment + cursor echo). Tests only. */
export function _resetHighlightState(): void {
  _selection.clear();
  _clusterAugment = false;
  _clusterModel = null;
  _cursorEmphasisNode = null;
  _emphasizedElements = [];
}

/** The currently stored cursor-emphasis node id, or null. Tests only. */
export function _cursorEmphasisSnapshot(): string | null {
  return _cursorEmphasisNode;
}

/**
 * Run the post-render highlight re-derivation. Tests only — the production
 * caller is render.ts's renderDotWithFallback on the per-render success
 * boundary.
 */
export function _reapplyHighlightAfterRender(): void {
  reapplyHighlightAfterRender();
}
