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
import { animationsEnabledWith, getAnimate } from "./animate";
import { createRenderQueue } from "./render-queue";
import { emitNodeClick } from "./sync";
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
  parseEdgeTitle,
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
  shouldCloseSearch,
  shouldOpenSearch,
  type SearchOpts,
} from "./search";
import { filterConfigSearch } from "./urlconfig";

// ── Animation gate (Story 5.4, AC1/AC4/AC5) ──────────────────────────────────
// render.ts is the only module that touches the live SVG + `matchMedia`, so it
// owns the DOM-side read; the pure config gate + decision logic live in
// animate.ts (unit-tested without a real matchMedia). animationsEnabled() is the
// SINGLE predicate both the render path and the highlight path consult, so they
// can never diverge: animate only when the config gate is on AND the environment
// does not request reduced motion.
const RENDER_TRANSITION_MS = 250; // graph re-render tween — short, never laggy
const HIGHLIGHT_TRANSITION_MS = 150; // emphasis fade — short + interruptible (NFR-7)

/** True when motion should be used right now (config gate ∧ ¬prefers-reduced-motion). */
function animationsEnabled(): boolean {
  let reducedMotion = false;
  try {
    // matchMedia is absent in non-DOM contexts; treat absence as "no preference".
    reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    reducedMotion = false;
  }
  return animationsEnabledWith(getAnimate(), reducedMotion);
}

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
        reject(err instanceof Error ? err : new Error(String(err)));
      })
        // Resolve on "end" — fires LAST in both the instant and transitioned
        // paths (verified above), so the render-lock releases exactly once after
        // any transition settles. Do NOT weaken this (AC3).
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
    // Offset right by the toolbar clearance (not 8px) so the overlay never
    // covers the view toolbar's buttons (installViewToolbar).
    overlay.style.cssText =
      `position:fixed;top:8px;right:${VIEW_TOOLBAR_CLEARANCE_PX}px;background:rgba(30,0,0,0.85);` +
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

// ── Disconnect notice ─────────────────────────────────────────────────────────
// Connection state (NOT content state): the live WebSocket to the server has
// dropped, so edits in Neovim no longer reach the preview and whatever graph is
// on screen is going stale. It is orthogonal to the error (red, top-right) and
// empty (grey, top-left) surfaces — a valid-but-stale graph can stay visible
// while disconnected — so it lives top-center and neither clears nor is cleared
// by them. main.ts shows it on socket close and clears it on the next
// successful open; ws.ts auto-reconnects with backoff so it self-heals — except
// on auth rejection (stale token), where main.ts passes a terminal message
// telling the user to reopen the preview instead.
export function showDisconnectNotice(message = "Disconnected — reconnecting…"): void {
  let el = document.getElementById("ig-disconnect-notice");
  if (!el) {
    el = document.createElement("div");
    el.id = "ig-disconnect-notice";
    el.style.cssText =
      "position:fixed;top:8px;left:50%;transform:translateX(-50%);" +
      "background:rgba(60,45,0,0.9);color:#ffcc66;padding:6px 10px;border-radius:4px;" +
      "font-size:13px;font-family:monospace;z-index:9999;pointer-events:none;max-width:60vw;";
    document.body.appendChild(el);
  }
  el.textContent = message;
}

/** Remove the disconnect notice if present. */
export function clearDisconnectNotice(): void {
  const el = document.getElementById("ig-disconnect-notice");
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

/** Returns the disconnect-notice element (or null). Production code never calls this. */
export function _disconnectNoticeElement(): HTMLElement | null {
  return document.getElementById("ig-disconnect-notice");
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

// ── View toolbar (clickable home / zoom-in / zoom-out) ────────────────────────
// Visible affordances for users who prefer clicking over gestures. Each button
// wraps the SAME code path its gesture twin uses: home → resetZoomToFit() (the
// `0`/`r` handler), zoom in/out → the live d3-zoom behavior's public scaleBy —
// the mechanism behind d3-zoom's own scroll/double-click gestures. No parallel
// zoom implementation.

const VIEW_TOOLBAR_ID = "ig-view-toolbar";

// Per-click zoom step. Gentler than d3-zoom's double-click ×2 so repeated
// clicks give fine-grained control; in and out are multiplicative inverses
// (float drift ~1e-16 per in/out pair — far below anything visible).
const ZOOM_BUTTON_FACTOR = 1.4;

// How far overlays must stay from the right viewport edge to clear the
// toolbar column: 8px offset + 28px button width + 8px gutter. showError and
// the search-box max-width derive from this — keep the three in sync.
const VIEW_TOOLBAR_CLEARANCE_PX = 44;

// Button icons — adapted from plantuml-previewer.vim's viewer icons (the
// reference UX). Flattened for inlining: the originals carry per-file
// <style> classes (.cls-1/.cls-2) that would collide as globals when all
// three sit on one page, and a hardcoded near-black fill; here shapes use
// attributes directly and `currentColor` so the button color applies. The
// viewBox is cropped from the original A4 canvas to the icon's region.
const ICON_HOME =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 40 595.28 640" width="16" height="16" aria-hidden="true">' +
  '<path fill="currentColor" d="M477.38,403.76L328.27,245a44,44,0,0,0-64-.22l-151.36,159a41,41,0,0,0-10.75,27.67V605.09a41,41,0,0,0,41,41H214a24.4,24.4,0,0,0,24.4-24.4V542h113.4v79.68a24.4,24.4,0,0,0,24.4,24.4h70.9a41,41,0,0,0,41-41V431.44A41,41,0,0,0,477.38,403.76Z"/>' +
  '<path fill="currentColor" d="M509.59,397.39L323.83,196.74a40,40,0,0,0-58.63-.08L83.09,392.29a40,40,0,0,1-56.53,2h0a40,40,0,0,1-2-56.53L265.36,79.07a40,40,0,0,1,58.63.08L568.3,343a40,40,0,0,1-2.18,56.53h0A40,40,0,0,1,509.59,397.39Z"/>' +
  "</svg>";
const ICON_ZOOM_IN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 100 595.28 640" width="16" height="16" aria-hidden="true">' +
  '<circle fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="60" cx="237.42" cy="329.29" r="169.09" transform="translate(-163.31 264.32) rotate(-45)"/>' +
  '<rect fill="currentColor" x="428.28" y="406.9" width="60" height="286.5" rx="30" ry="30" transform="translate(-254.79 485.18) rotate(-45)"/>' +
  '<path fill="currentColor" d="M300.41,299.29h-33v-33a30,30,0,0,0-60,0v33h-33a30,30,0,0,0-30,30h0a30,30,0,0,0,30,30h33v33a30,30,0,1,0,60,0v-33h33a30,30,0,0,0,30-30h0A30,30,0,0,0,300.41,299.29Z"/>' +
  "</svg>";
const ICON_ZOOM_OUT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 100 595.28 640" width="16" height="16" aria-hidden="true">' +
  '<rect fill="currentColor" x="143.94" y="299.29" width="185.99" height="60" rx="30" ry="30"/>' +
  '<circle fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="60" cx="236.93" cy="329.29" r="169.09" transform="translate(-163.45 263.98) rotate(-45)"/>' +
  '<rect fill="currentColor" x="427.79" y="406.9" width="60" height="286.5" rx="30" ry="30" transform="translate(-254.93 484.84) rotate(-45)"/>' +
  "</svg>";
// Hand-drawn in the same coordinate scale/stroke weight as the icons above:
// a down-arrow (shaft + head) over a U-shaped tray.
const ICON_DOWNLOAD =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 100 595.28 640" width="16" height="16" aria-hidden="true">' +
  '<rect fill="currentColor" x="267.64" y="170" width="60" height="230" rx="30" ry="30"/>' +
  '<path fill="currentColor" d="M157.64,380h280L297.64,520Z"/>' +
  '<path fill="none" stroke="currentColor" stroke-width="60" stroke-linecap="round" d="M97.64,560v70a40,40,0,0,0,40,40h320a40,40,0,0,0,40-40v-70"/>' +
  "</svg>";
// Hand-drawn in the same coordinate scale/stroke weight as the icons above:
// a document outline holding <> code brackets (the interactive-HTML export).
const ICON_HTML_EXPORT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 100 595.28 640" width="16" height="16" aria-hidden="true">' +
  '<rect fill="none" stroke="currentColor" stroke-width="50" x="117.64" y="170" width="360" height="460" rx="40" ry="40"/>' +
  '<path fill="none" stroke="currentColor" stroke-width="50" stroke-linecap="round" stroke-linejoin="round" d="M257.64,320 187.64,400 257.64,480"/>' +
  '<path fill="none" stroke="currentColor" stroke-width="50" stroke-linecap="round" stroke-linejoin="round" d="M337.64,320 407.64,400 337.64,480"/>' +
  "</svg>";

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

/**
 * Serialize the live rendered graph as a standalone SVG document string, or
 * null when nothing has rendered yet. Works on a CLONE — the on-screen SVG is
 * never touched. The export is the clean graph as drawn (WYSIWYG, including
 * the current zoom/pan transform): the plugin's transient `ig-*` emphasis
 * classes are stripped (their stylesheet lives in <head> and would not ship
 * with the file), Graphviz's own classes stay, and the root gets xmlns /
 * xmlns:xlink injected when missing plus an XML prolog — the proven pattern
 * from vscode-interactive-graphviz's content/save.js.
 */
export function serializeGraphSvg(): string | null {
  const svg = document.querySelector("#app svg");
  if (!svg) return null;
  const clone = svg.cloneNode(true) as Element;
  // querySelectorAll excludes the clone root — include it explicitly.
  for (const el of [clone, ...clone.querySelectorAll("[class]")]) {
    const classes = el.getAttribute("class");
    if (classes == null) continue;
    const kept = classes.split(/\s+/).filter((c) => c.length > 0 && !c.startsWith("ig-"));
    if (kept.length === 0) el.removeAttribute("class");
    else el.setAttribute("class", kept.join(" "));
  }
  let source = new XMLSerializer().serializeToString(clone);
  if (!/^<svg[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(source)) {
    source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (!/^<svg[^>]*\sxmlns:xlink=/.test(source)) {
    source = source.replace(/^<svg/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + source;
}

/**
 * Download the current graph as `graph.svg` (the buffer's filename never
 * reaches the frontend — only config params ride the preview URL). Silent
 * no-op before the first render; guarded so a Blob/object-URL quirk can
 * never take the preview down.
 */
export function saveGraphSvg(): void {
  try {
    const source = serializeGraphSvg();
    if (source === null) return;
    const blob = new Blob([source], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "graph.svg";
    // Firefox needs the anchor in the document for a synthetic click.
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("interactive-graphviz: saveGraphSvg failed", err);
  }
}

// ── Save as interactive HTML (single-file export) ─────────────────────────────
// The preview build is fully self-contained — one JS bundle, every stylesheet
// JS-injected — so a standalone interactive export is just: the trivial page
// skeleton + an embedded {dot, engine, search} payload + the bundle inlined.
// On load, main.ts sees the payload ("static export mode"), re-renders the
// graph through the bundled WASM engine, and never opens a WebSocket — zoom,
// highlight, search and the SVG export keep working offline because they ARE
// the same code. Neovim-coupled features (jump-on-click, cursor echo) are
// inert by construction: no sender is ever registered and no emphasize frames
// arrive.

/** The payload an exported page boots from (`window.__igExport`). */
export interface ExportPayload {
  /** The DOT source to render — the preview's lastGoodDot at export time. */
  dot: string;
  /** Layout engine; defaults to "dot" when absent/invalid in the payload. */
  engine: string;
  /**
   * The preview URL's query string at export time — filtered down to the
   * interactivity config params only (filterConfigSearch), so the exported
   * page re-applies the SAME setup() config through the existing
   * applyUrlConfig path while the live session's sessionId/token never
   * enter the file.
   */
  search: string;
}

/**
 * Read and validate `window.__igExport`. Returns null unless `dot` is a
 * string (the one load-bearing field); engine/search fall back to safe
 * defaults so a hand-edited payload degrades instead of throwing. On null,
 * main.ts consults hasExportMarker() to tell a corrupt export (fail inert)
 * apart from a normal live preview (WebSocket boot).
 */
export function readExportPayload(): ExportPayload | null {
  if (typeof window === "undefined") return null;
  const raw = (window as unknown as { __igExport?: unknown }).__igExport;
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.dot !== "string") return null;
  return {
    dot: o.dot,
    engine: typeof o.engine === "string" && o.engine.length > 0 ? o.engine : "dot",
    search: typeof o.search === "string" ? o.search : "",
  };
}

/** True when this page IS an exported file (booted from an embedded payload). */
export function isStaticExportPage(): boolean {
  return readExportPayload() !== null;
}

/**
 * True when a `window.__igExport` marker is present at all — even one too
 * malformed for readExportPayload() to accept. main.ts uses this to keep a
 * corrupt exported file from falling through to the live WebSocket boot:
 * under file:// `location.host` is empty, so the WebSocket constructor would
 * throw synchronously and take the page down instead of failing inert.
 */
export function hasExportMarker(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as { __igExport?: unknown }).__igExport !== undefined;
}

/**
 * Assemble the standalone interactive HTML document. Pure string assembly —
 * no DOM, no fetch — so it is unit-testable; saveInteractiveHtml is the
 * DOM/fetch wrapper (mirroring the serializeGraphSvg/saveGraphSvg split).
 *
 * Escaping is the correctness-critical part (the HTML parser scans raw script
 * content for terminators):
 *  - the JSON payload embeds with EVERY `<` escaped as `<` — a JS string
 *    escape, so the parsed value is byte-identical while `</script>`/`<!--`
 *    can never appear in the raw text;
 *  - the bundle is arbitrary JS code, so only the terminator sequence is
 *    rewritten: `</script` → `<\/script` (case preserved via capture). That
 *    sequence can only occur inside JS strings/regex/comments, where `\/`
 *    means `/` — the standard inline-bundle escape.
 *
 * The skeleton mirrors frontend/index.html (charset/viewport + `<main
 * id="app">`); the payload rides a classic script that runs before the
 * inlined `type="module"` bundle (modules are deferred, classics are not, so
 * the ordering holds regardless).
 */
export function assembleInteractiveHtml(bundleSource: string, payload: ExportPayload): string {
  const payloadJs = JSON.stringify(payload).replace(/</g, "\\u003c");
  const inlineBundle = bundleSource.replace(/<\/(script)/gi, "<\\/$1");
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "  <head>\n" +
    '    <meta charset="utf-8">\n' +
    '    <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "    <title>graph — interactive-graphviz export</title>\n" +
    "  </head>\n" +
    "  <body>\n" +
    '    <main id="app"></main>\n' +
    `    <script>window.__igExport = ${payloadJs};</script>\n` +
    `    <script type="module">${inlineBundle}</script>\n` +
    "  </body>\n" +
    "</html>\n"
  );
}

/**
 * Download the current graph as a self-contained interactive `graph.html`.
 * Embeds the last GOOD dot (exactly what the stash holds — an error overlay
 * on screen does not change what exports) plus the page's own bundle, fetched
 * via its <script src>. Silent no-op before the first successful render or
 * when no external bundle script exists (i.e. inside an exported page, where
 * the button is hidden anyway); guarded so a fetch/Blob quirk can never take
 * the preview down.
 */
export async function saveInteractiveHtml(): Promise<void> {
  try {
    if (lastGoodDot === null) return;
    const payload: ExportPayload = {
      dot: lastGoodDot,
      engine: lastGoodEngine,
      // Whitelist-filtered: config params only. The raw location.search also
      // carries sessionId + the per-session auth token, which must never be
      // written into a shareable file.
      search: filterConfigSearch(window.location.search),
    };
    const bundleScript = document.querySelector<HTMLScriptElement>("script[src]");
    if (!bundleScript) return;
    const resp = await fetch(bundleScript.src);
    if (!resp.ok) {
      console.warn("interactive-graphviz: bundle fetch failed", resp.status);
      return;
    }
    const html = assembleInteractiveHtml(await resp.text(), payload);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "graph.html";
    // Firefox needs the anchor in the document for a synthetic click.
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("interactive-graphviz: saveInteractiveHtml failed", err);
  }
}

/**
 * Install the fixed view toolbar at the top-right: home (reset to fit),
 * zoom in, zoom out. Idempotent via DOM id guard (not a module flag) so it
 * can be reinstalled after the body is rebuilt. Attached to <body>, outside
 * #app, so d3-graphviz re-renders never touch it.
 */
export function installViewToolbar(): void {
  if (document.getElementById(VIEW_TOOLBAR_ID)) return;

  const bar = document.createElement("div");
  bar.id = VIEW_TOOLBAR_ID;
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "View controls");
  // z-index 9998: below the error overlay / empty notice (9999); those are
  // pointer-events:none so the buttons stay clickable even if overlapped.
  bar.style.cssText =
    "position:fixed;top:8px;right:8px;display:flex;flex-direction:column;" +
    "gap:4px;z-index:9998;";

  const addButton = (iconSvg: string, tooltip: string, onClick: () => void) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = iconSvg;
    btn.title = tooltip;
    // The icon SVGs are aria-hidden, so give AT a real name (title alone is
    // announced inconsistently across screen readers).
    btn.setAttribute("aria-label", tooltip);
    btn.style.cssText =
      "width:28px;height:28px;background:rgba(40,40,40,0.85);color:#cccccc;" +
      "border:none;border-radius:4px;display:flex;align-items:center;" +
      "justify-content:center;padding:0;cursor:pointer;";
    // Keep focus where it is (e.g. in the open search input) — a mouse click
    // must not move focus onto the button, which would both blur the search
    // box (breaking its Esc-to-close) and let a later Space/Enter re-fire
    // the zoom. Keyboard Tab-focus + Enter still activates normally.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", onClick);
    bar.appendChild(btn);
  };

  addButton(ICON_HOME, "Reset view to fit (0 or r)", () => resetZoomToFit());
  addButton(ICON_ZOOM_IN, "Zoom in (scroll up / double-click)", () => zoomBy(ZOOM_BUTTON_FACTOR));
  addButton(ICON_ZOOM_OUT, "Zoom out (scroll down / Shift+double-click)", () =>
    zoomBy(1 / ZOOM_BUTTON_FACTOR),
  );
  addButton(ICON_DOWNLOAD, "Save as SVG (as currently rendered)", () => saveGraphSvg());
  // Hidden inside an exported page: the bundle is inline there, not
  // re-fetchable, so a nested export is impossible by construction.
  if (!isStaticExportPage()) {
    addButton(ICON_HTML_EXPORT, "Save as interactive HTML (self-contained)", () => {
      void saveInteractiveHtml();
    });
  }

  document.body.appendChild(bar);
}

/** Returns the toolbar element (or null). Production code never calls this. */
export function _viewToolbarElement(): HTMLElement | null {
  return document.getElementById(VIEW_TOOLBAR_ID);
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
// The Selected / Neighbor / Dimmed emphasis treatment. Story 5.4 (AC2/AC5)
// animates the emphasis change by adding a CSS `transition` on the base
// `#app g.node` / `#app g.edge` opacity + stroke properties, so toggling the
// `ig-*` classes (in applyHighlightToDom — UNCHANGED) tweens rather than snaps.
// This is the simplest, GPU-cheap, interruptible approach (no d3 transition for
// class toggles — NFR-7). It is presentation-only: WHICH classes are set never
// changes, only how the change is shown. The transition line is gated: when
// animation is disabled (config off OR reduced-motion) it is omitted so emphasis
// is instant, byte-identical to today's behavior.
const HIGHLIGHT_TRANSITION_CSS = `
#app g.node, #app g.edge,
#app g.node ellipse, #app g.node polygon, #app g.node path {
  transition: opacity ${HIGHLIGHT_TRANSITION_MS}ms, stroke ${HIGHLIGHT_TRANSITION_MS}ms, stroke-width ${HIGHLIGHT_TRANSITION_MS}ms;
}
`;
const HIGHLIGHT_BASE_CSS = `
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

// Story 6.3 — the buffer→graph cursor echo: a passive outline in a hue apart
// from the click/search orange regime. STROKE ONLY, never opacity, so it can
// never dim anything and sits additively beneath the highlight classes (a
// search-dimmed node keeps its dim; the outline just rides along). The
// :not() guards encode the precedence law directly in CSS: when click/search
// own a node's emphasis (selected/neighbor stroke), the cursor outline yields
// entirely rather than fighting over the same stroke properties.
const CURSOR_EMPHASIS_CSS = `
#app g.node.ig-cursor:not(.ig-selected):not(.ig-neighbor) ellipse,
#app g.node.ig-cursor:not(.ig-selected):not(.ig-neighbor) polygon,
#app g.node.ig-cursor:not(.ig-selected):not(.ig-neighbor) path {
  stroke: #4fc3f7; stroke-width: 3px;
}
/* Edge-line emphasis: the cursor on \`a -> b\` outlines the edge too (its
   spline + arrowhead), same hue, thinner than the node outline so the ends
   stay the anchors. Same yield rule: a click/search-owned edge keeps its
   treatment. Stroke only, like the node rule — never opacity. */
#app g.edge.ig-cursor:not(.ig-neighbor) path,
#app g.edge.ig-cursor:not(.ig-neighbor) polygon {
  stroke: #4fc3f7; stroke-width: 2px;
}
`;
// The optional pulse: stroke-opacity only (the outline breathes; the node's
// fill/element opacity are untouched). Gated on animationsEnabled() like the
// highlight transition rule — reduced-motion / animate=false gets a static
// outline.
const CURSOR_PULSE_CSS = `
@keyframes ig-cursor-pulse {
  0%, 100% { stroke-opacity: 1; }
  50% { stroke-opacity: 0.45; }
}
#app g.node.ig-cursor:not(.ig-selected):not(.ig-neighbor) ellipse,
#app g.node.ig-cursor:not(.ig-selected):not(.ig-neighbor) polygon,
#app g.node.ig-cursor:not(.ig-selected):not(.ig-neighbor) path,
#app g.edge.ig-cursor:not(.ig-neighbor) path,
#app g.edge.ig-cursor:not(.ig-neighbor) polygon {
  animation: ig-cursor-pulse 1.6s ease-in-out infinite;
}
`;

/** The full highlight stylesheet text for the current animation gate. */
function highlightCss(): string {
  // When animation is enabled, prepend the transition rule so class toggles
  // tween; when disabled, omit it entirely so emphasis is instant (AC5 fallback).
  return (
    (animationsEnabled() ? HIGHLIGHT_TRANSITION_CSS : "") +
    HIGHLIGHT_BASE_CSS +
    CURSOR_EMPHASIS_CSS +
    (animationsEnabled() ? CURSOR_PULSE_CSS : "")
  );
}

function ensureHighlightStyle(): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  const css = highlightCss();
  if (style) {
    // Re-evaluate the gate each call: the effective animate decision can change
    // at runtime (setAnimate / a reduced-motion toggle), so keep the injected
    // transition rule in sync without re-creating the element.
    if (style.textContent !== css) style.textContent = css;
    return;
  }
  style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
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
 * (panCursorNodeIntoView; for an edge the edge group is the pan target — its
 * bbox spans the run between the endpoints, so centering it frames both
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
  const app = document.getElementById("app");
  if (!app) return;
  ensureHighlightStyle();
  const key = _cursorEmphasisNode;
  // Edge pass first: it decides which endpoint nodes the node pass includes.
  let emphasizedEdge: Element | null = null;
  app.querySelectorAll("g.edge").forEach((g) => {
    if (key !== null && groupTitle(g) === key) {
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
  app.querySelectorAll("g.node").forEach((g) => {
    const title = groupTitle(g);
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
  if (panTarget !== null) panCursorNodeIntoView(panTarget);
  else cancelCursorPan();
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
  // Story 6.3 — re-assert the cursor-echo emphasis on the rebuilt subtree.
  // Independent of the highlight regime, so it runs on BOTH branches below
  // (search-owned and click-owned); a pruned/renamed node no longer matches,
  // which reads as cleared.
  applyCursorEmphasis(_cursorEmphasisNode);
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
  // Story 6.2 — graph→buffer sync as a SIDE EFFECT of the same click: gated,
  // seam-injected, and after the highlight so 5.2/5.3/5.4 behavior is unchanged.
  emitNodeClick(title);
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

/** Force-clear highlight state (selection + cluster augment + cursor echo). Tests only. */
export function _resetHighlightState(): void {
  _selection.clear();
  _clusterAugment = false;
  _clusterModel = null;
  _cursorEmphasisNode = null;
}

/** The currently stored cursor-emphasis node id, or null. Tests only. */
export function _cursorEmphasisSnapshot(): string | null {
  return _cursorEmphasisNode;
}

/** Set lastGoodDot directly. Tests only — production sets it in renderDotWithFallback. */
export function _setLastGoodDot(dot: string | null): void {
  lastGoodDot = dot;
}

/**
 * Run the post-render highlight re-derivation. Tests only — the production
 * caller is renderDotWithFallback on the per-render success boundary.
 */
export function _reapplyHighlightAfterRender(): void {
  reapplyHighlightAfterRender();
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
  display:flex; align-items:center; gap:8px; box-shadow:0 2px 8px rgba(0,0,0,0.4);
  /* Cap the centered box so its right edge stays >=48px from the viewport edge
     on narrow windows — clear of the view toolbar's right column (see
     VIEW_TOOLBAR_CLEARANCE_PX); without this the higher-z-index, pointer-events:auto
     box would capture the toolbar buttons' clicks. */
  max-width:calc(100vw - 96px); flex-wrap:wrap; }
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
        // Story 5.4 (Task 2): the recovery render is INSTANT (animate=false) —
        // it is a correction, not a user-driven re-render, so we never stack a
        // transition on top of the error teardown / concurrent d3 DOM mutation.
        renderDot(dot, engine, false).catch((fallbackErr: unknown) => {
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
