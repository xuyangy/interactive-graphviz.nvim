// render.ts is the ONLY module that imports d3-graphviz / @hpcc-js/wasm-graphviz.
// All other modules (main.ts, ws.ts) speak the wire protocol only.
//
// d3-graphviz 5.6.0 ships no TypeScript definitions; the import resolves to
// `any` — this is expected and intentional.

// eslint-disable-next-line import/no-unresolved
import { graphviz } from "d3-graphviz";
// d3-transition + d3-ease ship transitively inside the d3-graphviz bundle (the
// renderer pulls them in for its own transitions). Importing them directly here
// adds NO new top-level dependency — exactly as viewstate.ts imports d3-zoom's
// pure `zoomTransform`. Story 5.4 uses them to build the gated render transition.
import { transition } from "d3-transition";
import { easeCubicInOut } from "d3-ease";
// d3-zoom ships transitively inside the d3-graphviz bundle (its zoom behavior
// IS d3-zoom) — same zero-new-dependency rationale as d3-transition above and
// viewstate.ts's `zoomTransform` import. zoomIdentity builds the fit-to-
// selection transform (plan item #6).
import { zoomIdentity } from "d3-zoom";
import { createRenderQueue } from "./render-queue";
import {
  captureViewState,
  restoreViewState,
  type ViewState,
  type ZoomAccessor,
} from "./viewstate";
import { clearError, showError } from "./overlays";
import { invalidateGraphDom } from "./graph-dom";
import { animationsEnabled } from "./motion";
import {
  reapplyHighlightAfterRender,
  setClusterDotSource,
  setCursorPanHooks,
} from "./emphasis";

// The animation gate (animationsEnabled) lives in motion.ts, and the emphasis
// / search DOM layers in emphasis.ts / search-ui.ts (plan item #1b). The
// d3-touching halves they trigger — the render/pan transitions below — stay
// here, injected into emphasis.ts via the seam registrations at the bottom of
// this file.
const RENDER_TRANSITION_MS = 250; // graph re-render tween — short, never laggy

/**
 * Render a DOT string into #app using the bundled WASM renderer.
 * No system Graphviz is required — the WASM module is bundled into this file
 * via Bun's bundler (FR-6).
 *
 * Story 5.4 (AC1/AC3/AC5): when animation is enabled, attach a d3-graphviz
 * transition so node/edge positions tween across renders. When disabled (config
 * off or `prefers-reduced-motion`, or for the error-recovery render) take the
 * EXACT current instant path — no `.transition(...)` call — so the fallback is
 * byte-identical in end-state.
 *
 * `animate` defaults to the live gate; the onError recovery render forces it
 * off (instant) so a correction never stacks a transition on an error teardown.
 *
 * CRITICAL (AC3 — render-lock correctness): the promise resolves on the `"end"`
 * lifecycle event in BOTH paths. Verified against d3-graphviz 5.6.0
 * (node_modules/d3-graphviz/src/render.js): with NO transition, `'end'` is
 * dispatched synchronously at the tail of render (line ~397). WITH a transition,
 * `'end'` is dispatched from the post-transition zero-duration cleanup
 * transition's `start` handler (line ~370), i.e. AFTER `transitionEnd` (line
 * ~364) — so `"end"` still fires LAST and the render-lock in render-queue.ts
 * releases exactly once, after the transition completes. No need to move the
 * resolve to `transitionEnd`; latest-wins is preserved.
 *
 * Called by the render queue only; external callers use queueRender.
 */
export function renderDot(dot: string, engine: string, animate = animationsEnabled()): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // The render is about to mutate the #app subtree, and does so again until
    // it settles — drop the graph-dom snapshot on BOTH sides (entry + end /
    // error) so no cached elements outlive the subtree they came from. This
    // is the single choke point every DOM-rebuilding path flows through
    // (queued renders via renderDotWithFallback AND the error-recovery
    // render in the queue's onError).
    invalidateGraphDom();
    try {
      // d3-graphviz error handling is the dedicated `.onerror()` method — NOT
      // `.on("error", …)`. The `.on()` event system only knows the render
      // lifecycle types (start/layout/render/transition/end); registering an
      // "error" listener there makes d3-dispatch throw "unknown type: error"
      // synchronously, failing every render before the DOT is even parsed.
      let gv = graphviz("#app").engine(engine);
      if (animate) {
        // d3-graphviz's `.transition(factory)` takes a factory returning a fresh
        // d3 transition; positions/paths tween across the render. d3-transition +
        // d3-ease are already in the bundle (renderer's own transition support).
        gv = gv.transition(() =>
          transition("ig-render").duration(RENDER_TRANSITION_MS).ease(easeCubicInOut),
        );
      }
      gv.onerror((err: unknown) => {
        console.error("interactive-graphviz: render error", err);
        invalidateGraphDom();
        reject(err instanceof Error ? err : new Error(String(err)));
      })
        // Resolve on "end" — fires LAST in both the instant and transitioned
        // paths (verified above), so the render-lock releases exactly once after
        // any transition settles. Do NOT weaken this (AC3).
        .on("end", () => {
          invalidateGraphDom();
          resolve();
        })
        .renderDot(dot);
    } catch (err) {
      console.error("interactive-graphviz: render error (sync)", err);
      invalidateGraphDom();
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
  // SVG. This runs after the render has fully settled ("end" fired) — the
  // fallback-recovery render in onError does the same on ITS success — so it
  // cannot introduce a second concurrent d3 DOM mutation race on #app. It also
  // re-binds the delegated click listener (idempotent) since d3-graphviz
  // rebuilds the #app subtree.
  reapplyHighlightAfterRender();
}

// The error / empty / disconnect overlays live in overlays.ts (plan item #1a
// extraction); render.ts consumes showError/clearError at the queue boundary.

/**
 * The last successfully rendered DOT + engine, for modules that must export
 * exactly what is on screen (export.ts's saveInteractiveHtml). Read-only
 * accessor: the state itself is only ever set on renderDotWithFallback's
 * success boundary.
 */
export function lastGoodRenderState(): { dot: string | null; engine: string } {
  return { dot: lastGoodDot, engine: lastGoodEngine };
}

// ── Test seams ──────────────────────────────────────────────────────────────
/** Returns lastGoodDot. Production code never calls this. */
export function _lastGoodDot(): string | null {
  return lastGoodDot;
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
 * Pure predicate: should this keydown trigger fit-to-selection (plan item #6)?
 * True only for an un-modified `f` when NOT typing in a text field — the same
 * guard shape as shouldReset, so `f` typed into the search input stays a
 * literal character.
 */
export function shouldFitSelection(e: ResetKeyEvent, activeTag: string | undefined): boolean {
  if (e.key !== "f") return false;
  if (activeTag === "INPUT" || activeTag === "TEXTAREA") return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return true;
}

/**
 * Handle a real keydown for the fit-to-selection affordance (`f`).
 * Returns true when the key was handled (for tests / callers).
 */
export function handleFitKeydown(e: KeyboardEvent): boolean {
  if (!shouldFitSelection(e, document.activeElement?.tagName)) return false;
  fitSelectionInView();
  return true;
}

/**
 * Install the document-level view keybindings (`0`/`r` reset, `f` fit-to-
 * selection) once. Idempotent: a second call is a no-op (guarded by a flag)
 * so re-imports / HMR don't stack listeners.
 */
let _resetKeyInstalled = false;
export function installResetKeybinding(): void {
  if (_resetKeyInstalled) return;
  _resetKeyInstalled = true;
  document.addEventListener("keydown", handleResetKeydown);
  document.addEventListener("keydown", handleFitKeydown);
}

// The view toolbar (home / zoom-in / zoom-out / exports) lives in toolbar.ts
// (plan item #1a extraction); its buttons call back into resetZoomToFit and
// zoomBy here — the d3-touching halves stay in this module.

/**
 * Scale the view about its current center by `factor` (>1 zooms in, <1 out)
 * via the d3-graphviz instance's public zoomBehavior().scaleBy — the same
 * mechanism d3-zoom's scroll/double-click gestures use. No-op before the
 * first render (no zoom behavior yet). Guarded against d3 throwing, mirroring
 * resetZoomToFit.
 */
export function zoomBy(factor: number): void {
  try {
    const gv = graphviz("#app");
    const behavior = gv.zoomBehavior();
    const selection = gv.zoomSelection();
    if (behavior && selection) {
      behavior.scaleBy(selection, factor);
    }
  } catch (err) {
    console.warn("interactive-graphviz: zoomBy failed", err);
  }
}

// ── Pan-to-cursor (cursor-echo follow, extends Story 6.3) ────────────────────
// When the Neovim cursor emphasizes a node that is off-screen in a large
// graph, pan the view so the node lands at the viewport center. Pan-only —
// the zoom level is untouched — and only when the node is not already fully
// visible, so the view never chases the cursor while the user works inside
// the visible region. Manual pans are respected: nothing moves until the NEXT
// emphasize frame lands on an off-screen node.

const PAN_TRANSITION_MS = 250; // matches RENDER_TRANSITION_MS — one motion voice

/** The subset of DOMRect the pan predicate needs (unit-testable as plain objects). */
export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Pure predicate: pan when the node's screen rect is NOT fully inside the
 * visible-area rect. A degenerate view (zero/negative area — an empty
 * svg∩window intersection, or a non-layout test DOM where every rect is 0×0)
 * never pans. A node larger than the view always qualifies; translateTo then
 * centers it, the best possible framing.
 */
export function cursorPanNeeded(node: RectLike, view: RectLike): boolean {
  if (view.right - view.left <= 0 || view.bottom - view.top <= 0) return false;
  return (
    node.left < view.left || node.top < view.top || node.right > view.right || node.bottom > view.bottom
  );
}

/** Pure: rect intersection. May come back empty (right<left) — cursorPanNeeded treats that as "never pan". */
export function intersectRects(a: RectLike, b: RectLike): RectLike {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

/**
 * Pure: map the CENTER of `view` (CSS px, viewport-relative) into the svg's
 * viewBox coordinate space. Needed because d3-zoom's extent for an svg WITH a
 * viewBox attribute is the viewBox itself (d3-zoom defaultExtent), so
 * translateTo's target point `p` must be expressed in viewBox units — while
 * the visible area is measured in screen px. Null on any degenerate geometry
 * (caller falls back to translateTo's default target).
 */
export function viewCenterInViewBox(
  view: RectLike,
  svgRect: RectLike,
  vb: { x: number; y: number; width: number; height: number },
): [number, number] | null {
  const w = svgRect.right - svgRect.left;
  const h = svgRect.bottom - svgRect.top;
  if (w <= 0 || h <= 0 || vb.width <= 0 || vb.height <= 0) return null;
  const fx = ((view.left + view.right) / 2 - svgRect.left) / w;
  const fy = ((view.top + view.bottom) / 2 - svgRect.top) / h;
  return [vb.x + fx * vb.width, vb.y + fy * vb.height];
}

/**
 * Center the given node group in the VISIBLE area via the live d3-zoom
 * behavior's public translateTo — pan only, current scale kept.
 *
 * "Visible area" is the intersection of the svg's client rect with the
 * browser window: nothing sizes the rendered svg to the window (no fit/width
 * option, no CSS), so a large graph's svg element overflows the window and
 * the svg rect alone is NOT what the user can see (verified in a real
 * browser — an svg-rect-based pan parked the node off-window).
 *
 * Coordinate spaces: the node's getBBox() is in the graph group's user space
 * — the input space of the zoom transform d3-graphviz manages — and for a
 * graphviz svg (always carries a viewBox) that space, d3-zoom's extent, and
 * the viewBox are all the same units, so the screen-px visible center is
 * mapped through viewCenterInViewBox. Animated through the shared gate
 * (config ∧ ¬prefers-reduced-motion). No-op before the first render; guarded
 * like zoomBy so a d3 quirk can never break the emphasize path.
 */
function panCursorNodeIntoView(node: Element): void {
  try {
    const gv = graphviz("#app");
    const behavior = gv.zoomBehavior();
    const selection = gv.zoomSelection();
    if (!behavior || !selection) return;
    const svg = selection.node() as SVGSVGElement | null;
    if (!svg) return;
    const svgRect = svg.getBoundingClientRect();
    const winRect: RectLike = {
      left: 0,
      top: 0,
      right: document.documentElement.clientWidth,
      bottom: document.documentElement.clientHeight,
    };
    const view = intersectRects(svgRect, winRect);
    if (!cursorPanNeeded(node.getBoundingClientRect(), view)) {
      // The node is already visible: nothing to start, but a PREVIOUS frame's
      // pan may still be in flight toward a stale target — stop it here.
      selection.interrupt("ig-pan");
      return;
    }
    const bbox = (node as SVGGraphicsElement).getBBox();
    const vb = svg.viewBox?.baseVal;
    const p = vb ? viewCenterInViewBox(view, svgRect, vb) : null;
    const target = animationsEnabled()
      ? selection.transition("ig-pan").duration(PAN_TRANSITION_MS).ease(easeCubicInOut)
      : selection;
    if (p) {
      behavior.translateTo(target, bbox.x + bbox.width / 2, bbox.y + bbox.height / 2, p);
    } else {
      // No/degenerate viewBox: fall back to the extent centroid (svg center).
      behavior.translateTo(target, bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
    }
  } catch (err) {
    console.warn("interactive-graphviz: pan-to-cursor failed", err);
  }
}

/**
 * Interrupt an in-flight ig-pan transition without starting a new one. Called
 * for cursor frames that pan nothing (clear / miss), so a stale pan can never
 * outlive the cursor state that launched it. No-op before the first render.
 */
function cancelCursorPan(): void {
  try {
    const selection = graphviz("#app").zoomSelection();
    if (selection) selection.interrupt("ig-pan");
  } catch {
    // No live selection → no transition to cancel; never break the emphasize path.
  }
}

// ── Fit-to-selection (plan item #6, the `f` affordance) ──────────────────────
// Zoom AND pan the view so the currently highlighted elements — the click
// selection with its neighbors, or the live search matches (both regimes mark
// their elements with the same ig-selected/ig-neighbor classes) — fill the
// visible area. With nothing highlighted, `f` behaves like `0`/`r` (fit the
// whole graph): one key always answers "frame what I care about right now".

/** Fraction of the visible area the fitted selection may fill (the rest is margin). */
const FIT_MARGIN = 0.9;

/** The getBBox()-shaped box the fit math works in (input/user space). */
export interface BBoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pure: union of getBBox-shaped boxes; null for an empty list. */
export function unionBBoxes(boxes: BBoxLike[]): BBoxLike | null {
  if (boxes.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.width);
    y2 = Math.max(y2, b.y + b.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Pure: the d3-zoom transform (k, tx, ty) that centers `bbox` (input/user
 * space — the space node getBBox() coordinates live in, see
 * panCursorNodeIntoView) in the visible area at the largest scale that fits it
 * with FIT_MARGIN, clamped to the behavior's scaleExtent so `f` can never
 * out-zoom the scroll wheel. The transform maps input space to viewBox units
 * (x' = k·x + t), so the visible area is converted from CSS px to viewBox
 * units via the svg rect ↔ viewBox ratio, and its center comes through the
 * same viewCenterInViewBox the cursor pan uses. Null on any degenerate
 * geometry (zero-size bbox/view/svg/viewBox — e.g. a non-layout test DOM):
 * the caller does nothing rather than jumping to a garbage transform.
 */
export function fitTransformForBBox(
  bbox: BBoxLike,
  view: RectLike,
  svgRect: RectLike,
  vb: BBoxLike,
  scaleExtent: [number, number],
): { k: number; tx: number; ty: number } | null {
  if (
    !isFinite(bbox.x) ||
    !isFinite(bbox.y) ||
    !isFinite(bbox.width) ||
    !isFinite(bbox.height) ||
    bbox.width <= 0 ||
    bbox.height <= 0
  ) {
    return null;
  }
  const svgW = svgRect.right - svgRect.left;
  const svgH = svgRect.bottom - svgRect.top;
  const viewW = view.right - view.left;
  const viewH = view.bottom - view.top;
  if (svgW <= 0 || svgH <= 0 || viewW <= 0 || viewH <= 0) return null;
  const p = viewCenterInViewBox(view, svgRect, vb); // also guards vb dims
  if (p === null) return null;
  // Visible area in viewBox units (px → vb via the svg rect ↔ viewBox ratio).
  const viewWVb = (viewW / svgW) * vb.width;
  const viewHVb = (viewH / svgH) * vb.height;
  const fit = Math.min(viewWVb / bbox.width, viewHVb / bbox.height) * FIT_MARGIN;
  const k = Math.max(scaleExtent[0], Math.min(scaleExtent[1], fit));
  return {
    k,
    tx: p[0] - k * (bbox.x + bbox.width / 2),
    ty: p[1] - k * (bbox.y + bbox.height / 2),
  };
}

/**
 * Fit the view to the current highlight: union the bboxes of every
 * ig-selected/ig-neighbor group (nodes AND connecting edges — click selection
 * and search matches alike) and apply the fit transform through the live
 * d3-zoom behavior's public transform(). Nothing highlighted → reset-to-fit
 * (the `0`/`r` behavior). Animated through the shared motion gate, on the
 * SAME "ig-pan" named transition as the cursor pan — one motion voice,
 * last-wins by construction. No-op before the first render; guarded like
 * zoomBy/resetZoomToFit so a d3 quirk can never break the keybinding path.
 */
export function fitSelectionInView(): void {
  try {
    const gv = graphviz("#app");
    const behavior = gv.zoomBehavior();
    const selection = gv.zoomSelection();
    if (!behavior || !selection) return;
    const emphasized = document.querySelectorAll(
      "#app svg g.node.ig-selected, #app svg g.node.ig-neighbor, #app svg g.edge.ig-neighbor",
    );
    if (emphasized.length === 0) {
      resetZoomToFit();
      return;
    }
    const svg = selection.node() as SVGSVGElement | null;
    if (!svg) return;
    const vb = svg.viewBox?.baseVal;
    if (!vb) return;
    const svgRect = svg.getBoundingClientRect();
    const winRect: RectLike = {
      left: 0,
      top: 0,
      right: document.documentElement.clientWidth,
      bottom: document.documentElement.clientHeight,
    };
    const view = intersectRects(svgRect, winRect);
    const bbox = unionBBoxes(
      [...emphasized].map((el) => (el as SVGGraphicsElement).getBBox()),
    );
    if (bbox === null) return;
    const extent: [number, number] =
      typeof behavior.scaleExtent === "function" ? behavior.scaleExtent() : [0, Infinity];
    const t = fitTransformForBBox(bbox, view, svgRect, vb, extent);
    if (t === null) return;
    const target = animationsEnabled()
      ? selection.transition("ig-pan").duration(PAN_TRANSITION_MS).ease(easeCubicInOut)
      : selection;
    behavior.transform(target, zoomIdentity.translate(t.tx, t.ty).scale(t.k));
  } catch (err) {
    console.warn("interactive-graphviz: fit-to-selection failed", err);
  }
}

// Save-as-SVG / save-as-interactive-HTML live in export.ts, and the view
// toolbar in toolbar.ts (plan item #1a extraction) — neither touches d3.

/** Set lastGoodDot directly. Tests only — production sets it in renderDotWithFallback. */
export function _setLastGoodDot(dot: string | null): void {
  lastGoodDot = dot;
}

// The click-highlight / cursor-echo DOM layer lives in emphasis.ts and the
// search box in search-ui.ts (plan item #1b extraction) — neither touches d3.
// They reach back into render.ts only through the injection seams below.

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
        // Story 5.4 (Task 2): the recovery render is INSTANT (animate=false) —
        // it is a correction, not a user-driven re-render, so we never stack a
        // transition on top of the error teardown / concurrent d3 DOM mutation.
        renderDot(dot, engine, false)
          .then(() => {
            // The recovery render rebuilt the #app subtree like any success:
            // re-derive click selection / search highlight / cursor emphasis
            // against it, or the restored graph comes back bare while that
            // state is still active. Safe to run here — renderDot resolved on
            // "end", so the error teardown and the recovery's own mutations
            // are complete (the concurrency concern is the render itself,
            // not this DOM-only class pass).
            reapplyHighlightAfterRender();
          })
          .catch((fallbackErr: unknown) => {
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

// Re-export the animate setter/getter so main.ts can resolve the animation gate
// at startup without importing animate.ts directly (keeps the render/motion
// concern single-sourced behind render.ts), mirroring setPreserveView /
// setHighlightMode / setSearchConfig. Decision D1: frontend-local, default ON —
// zero-config requires NO call at all, so main.ts needs no change (AC4).
export { setAnimate, getAnimate } from "./animate";

// ── Seam registrations for emphasis.ts (plan item #1b) ────────────────────────
// emphasis.ts imports nothing from render.ts (render → emphasis is the only
// import direction, keeping the module graph acyclic); the d3-touching pan
// machinery and the cluster-fallback dot source are injected here at module
// init, mirroring sync.ts's setNodeClickSender idiom. The seams have safe
// no-op / null defaults, so emphasis.ts works standalone in unit tests.
setCursorPanHooks({ panIntoView: panCursorNodeIntoView, cancelPan: cancelCursorPan });
setClusterDotSource(() => lastGoodDot);
