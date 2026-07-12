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

// The cursor glow is a real SVG <filter> referenced from styles.css via
// filter:url(#ig-cursor-glow) — NOT a CSS drop-shadow() function chain, which
// WebKit does not reliably render on SVG elements (Safari showed no glow at
// all in v0.12.0). The def rides in its own zero-size carrier <svg> on <body>
// (url(#) resolves document-wide), NEVER inside the rendered graph svg:
// a foreign <defs> there breaks d3-graphviz's re-render data join ("Cannot
// read properties of undefined (reading 'key')" surfaced as a bogus DOT parse
// error), and outside the graph it also survives re-renders and stays out of
// the save-as-SVG export without scrubbing. Hidden via width/height 0, NOT
// display:none — Firefox ignores filter defs inside display:none subtrees.
// The filter is static by design: styles.css animates only stroke-width (the
// Firefox CPU fix), and the glow swells with the widening stroke for free.
const GLOW_CARRIER_ID = "ig-cursor-glow-defs";
const SVG_NS = "http://www.w3.org/2000/svg";
function ensureCursorGlowFilter(): void {
  if (document.getElementById(GLOW_CARRIER_ID)) return;
  const carrier = document.createElementNS(SVG_NS, "svg");
  carrier.setAttribute("id", GLOW_CARRIER_ID);
  carrier.setAttribute("aria-hidden", "true");
  carrier.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  const defs = document.createElementNS(SVG_NS, "defs");
  // Two filters with the same shadows but different regions, because the blur
  // re-runs over the whole region EVERY animation frame — region area is the
  // Firefox CPU knob. Node shapes get a tight region: the halo reaches
  // ~14px past the shape's geometric bbox (bloomed stroke/2 + 3·σ), and
  // even the smallest default node (~54×36) keeps that inside -45%/-65%
  // padding. Edge GROUPS need the wide region: their bbox minor dimension can
  // be as small as the arrowhead (~7px) on a straight spline, so tight
  // percentages would clip the halo flat along the run — but 600% of small
  // stays small.
  for (const [id, x, y, w, h] of [
    ["ig-cursor-glow", "-45%", "-65%", "190%", "230%"],
    ["ig-cursor-glow-edge", "-250%", "-250%", "600%", "600%"],
  ]) {
    const filter = document.createElementNS(SVG_NS, "filter");
    filter.setAttribute("id", id);
    filter.setAttribute("x", x);
    filter.setAttribute("y", y);
    filter.setAttribute("width", w);
    filter.setAttribute("height", h);
    // ONE blur pass, STACKED: a single gaussian layer reads as no glow at all
    // (blurring a thin stroke band leaves only a faint fringe — v0.12.1
    // looked like a bare stroke pulse), but each extra blur pass is per-frame
    // CPU (the Firefox lesson, measured ~2× for two passes). So blur ONCE,
    // then feMerge the SAME result several times — merge nodes are cheap
    // composites, and stacking multiplies the halo's alpha toward opaque at
    // the stroke while the outer tail stays soft: the neon look.
    // The glow is built SHADOW-ONLY (blur SourceAlpha, flood the accent,
    // composite in) rather than with feDropShadow: feDropShadow's output
    // carries SourceGraphic on top, so stacking it would stack the original
    // graphic too — a translucent DOT fill (alpha 0.2) turned ~2.5× more
    // opaque (≈0.49) while cursor-emphasized. SourceGraphic merges exactly
    // ONCE, last, keeping the crisp stroke above the halo.
    // The stacked glow is then CLIPPED to outside the shape's silhouette
    // (solidify SourceAlpha with a step transfer, composite the glow "out"
    // of it): SourceAlpha includes the FILL, so an unclipped glow lights the
    // whole interior and shows through translucent fills as a strong cyan
    // wash (measured r 255→189 under an alpha-0.2 red fill). A solidified
    // silhouette is required — "out" against the raw alpha only scales the
    // wash by (1-fill alpha). Unfilled default nodes have interior alpha 0,
    // so their familiar inward glow is untouched.
    // σ4 × 3 stacks is calibrated for the near-native ~2px stroke: the halo
    // peaks around HALF alpha right at the stroke (translucent — denser
    // stacking reads as extra line thickness, not glow; picked from a
    // rendered σ/stacks/opacity sweep) and fades out over ~10px.
    // Gaussian-of-a-band falloff is steep — don't trust reach intuition,
    // measure (glow-visual.spec.ts).
    const blur = document.createElementNS(SVG_NS, "feGaussianBlur");
    blur.setAttribute("in", "SourceAlpha");
    blur.setAttribute("stdDeviation", "4");
    blur.setAttribute("result", "blur");
    filter.appendChild(blur);
    const flood = document.createElementNS(SVG_NS, "feFlood");
    flood.setAttribute("flood-color", "#4fc3f7");
    flood.setAttribute("flood-opacity", "1");
    flood.setAttribute("result", "color");
    filter.appendChild(flood);
    const composite = document.createElementNS(SVG_NS, "feComposite");
    composite.setAttribute("in", "color");
    composite.setAttribute("in2", "blur");
    composite.setAttribute("operator", "in");
    composite.setAttribute("result", "glowRaw");
    filter.appendChild(composite);
    const solidify = document.createElementNS(SVG_NS, "feComponentTransfer");
    solidify.setAttribute("in", "SourceAlpha");
    solidify.setAttribute("result", "solid");
    const funcA = document.createElementNS(SVG_NS, "feFuncA");
    funcA.setAttribute("type", "linear");
    funcA.setAttribute("slope", "255");
    funcA.setAttribute("intercept", "0");
    solidify.appendChild(funcA);
    filter.appendChild(solidify);
    const clip = document.createElementNS(SVG_NS, "feComposite");
    clip.setAttribute("in", "glowRaw");
    clip.setAttribute("in2", "solid");
    clip.setAttribute("operator", "out");
    clip.setAttribute("result", "glow");
    filter.appendChild(clip);
    const merge = document.createElementNS(SVG_NS, "feMerge");
    for (let i = 0; i < 3; i++) {
      const mergeNode = document.createElementNS(SVG_NS, "feMergeNode");
      mergeNode.setAttribute("in", "glow");
      merge.appendChild(mergeNode);
    }
    const mergeSource = document.createElementNS(SVG_NS, "feMergeNode");
    mergeSource.setAttribute("in", "SourceGraphic");
    merge.appendChild(mergeSource);
    filter.appendChild(merge);
    defs.appendChild(filter);
  }
  carrier.appendChild(defs);
  document.body.appendChild(carrier);
}

// Pin every running cursor-bloom animation to the same document-timeline
// origin. Without this the bloom phases drift: a CSS animation starts when its
// element FIRST matches the rule, so moving the cursor from a node line onto
// one of that node's edge lines keeps the endpoint's class (no restart) while
// the edge + other endpoint start fresh — the endpoints then bloom
// alternately instead of together (v0.12.0 issue #3). startTime 0 makes every
// element's phase `now mod duration`, identical by construction; re-pinning an
// already-pinned animation is a no-op. Guarded: happy-dom has no getAnimations.
function syncCursorBloomPhase(): void {
  if (typeof document.getAnimations !== "function") return;
  for (const anim of document.getAnimations()) {
    if ((anim as CSSAnimation).animationName === "ig-cursor-bloom" && anim.startTime !== 0) {
      anim.startTime = 0;
    }
  }
}

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
  if (key !== null) ensureCursorGlowFilter();
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
  syncCursorBloomPhase();
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
