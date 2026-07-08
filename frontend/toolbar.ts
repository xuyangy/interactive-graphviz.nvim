// toolbar.ts — the fixed view toolbar (home / fit / zoom-in / zoom-out /
// pan-toggle / save-SVG / save-HTML) at the top-right. Extracted from
// render.ts as pure code motion (plan item #1a): the buttons only CALL the
// d3-touching code paths (resetZoomToFit / fitGraphInView / zoomBy /
// togglePanMode, imported from render.ts) — render.ts remains the only module
// that imports d3-graphviz. Each button wraps the SAME code path its gesture
// twin uses: home → resetZoomToFit() (the `0`/`r` handler), fit →
// fitGraphInView() (the `Shift+F` handler), zoom in/out → the live d3-zoom
// behavior's public scaleBy — the mechanism behind d3-zoom's own
// scroll/double-click gestures, pan → togglePanMode() (the `p` handler). No
// parallel zoom implementation.

import { fitGraphInView, onPanModeChange, panModeEnabled, resetZoomToFit, togglePanMode, zoomBy } from "./render";
import { isStaticExportPage, saveGraphSvg, saveInteractiveHtml } from "./export";

const VIEW_TOOLBAR_ID = "ig-view-toolbar";

// Per-click zoom step. Gentler than d3-zoom's double-click ×2 so repeated
// clicks give fine-grained control; in and out are multiplicative inverses
// (float drift ~1e-16 per in/out pair — far below anything visible).
const ZOOM_BUTTON_FACTOR = 1.4;

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
// Hand-drawn in the same coordinate scale/stroke weight as the icons below:
// four corner brackets framing a center dot — fit the whole graph in the window.
const ICON_FIT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 100 595.28 640" width="16" height="16" aria-hidden="true">' +
  '<path fill="none" stroke="currentColor" stroke-width="50" stroke-linecap="round" d="M117.64,310V210a40,40 0 0 1 40,-40h100"/>' +
  '<path fill="none" stroke="currentColor" stroke-width="50" stroke-linecap="round" d="M477.64,310V210a40,40 0 0 0 -40,-40h-100"/>' +
  '<path fill="none" stroke="currentColor" stroke-width="50" stroke-linecap="round" d="M117.64,490V590a40,40 0 0 0 40,40h100"/>' +
  '<path fill="none" stroke="currentColor" stroke-width="50" stroke-linecap="round" d="M477.64,490V590a40,40 0 0 1 -40,40h-100"/>' +
  '<circle fill="currentColor" cx="297.64" cy="400" r="60"/>' +
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
// a four-way arrow cross — the pan-scroll mode toggle.
const ICON_PAN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 100 595.28 640" width="16" height="16" aria-hidden="true">' +
  '<rect fill="currentColor" x="272.64" y="230" width="50" height="340" rx="25"/>' +
  '<rect fill="currentColor" x="127.64" y="375" width="340" height="50" rx="25"/>' +
  '<path fill="currentColor" d="M297.64,150L367.64,240H227.64Z"/>' +
  '<path fill="currentColor" d="M297.64,650L367.64,560H227.64Z"/>' +
  '<path fill="currentColor" d="M97.64,400L187.64,330V470Z"/>' +
  '<path fill="currentColor" d="M497.64,400L407.64,330V470Z"/>' +
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
 * Install the fixed view toolbar at the top-right: home (reset to fit),
 * fit graph to window, zoom in, zoom out, pan-scroll toggle. Idempotent via
 * DOM id guard (not a module flag) so it
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

  const addButton = (iconSvg: string, tooltip: string, onClick: () => void): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = iconSvg;
    btn.title = tooltip;
    // The icon SVGs are aria-hidden, so give AT a real name (title alone is
    // announced inconsistently across screen readers).
    btn.setAttribute("aria-label", tooltip);
    btn.style.cssText =
      "width:28px;height:28px;background:var(--ig-button-bg);color:var(--ig-button-fg);" +
      "border:none;border-radius:4px;display:flex;align-items:center;" +
      "justify-content:center;padding:0;cursor:pointer;";
    // Keep focus where it is (e.g. in the open search input) — a mouse click
    // must not move focus onto the button, which would both blur the search
    // box (breaking its Esc-to-close) and let a later Space/Enter re-fire
    // the zoom. Keyboard Tab-focus + Enter still activates normally.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", onClick);
    bar.appendChild(btn);
    return btn;
  };

  addButton(ICON_HOME, "Reset view to fit (0 or r)", () => resetZoomToFit());
  addButton(ICON_FIT, "Fit graph to window (Shift+F)", () => fitGraphInView());
  addButton(ICON_ZOOM_IN, "Zoom in (scroll up / double-click)", () => zoomBy(ZOOM_BUTTON_FACTOR));
  addButton(ICON_ZOOM_OUT, "Zoom out (scroll down / Shift+double-click)", () =>
    zoomBy(1 / ZOOM_BUTTON_FACTOR),
  );
  // Pan-scroll mode is a TOGGLE, not an action: the pressed state must track
  // the mode wherever it is flipped from (this button or the `p` key), so it
  // paints from the onPanModeChange seam rather than assuming its own clicks
  // are the only source of truth. Orange = the shared selected-accent color.
  const panBtn = addButton(
    ICON_PAN,
    "Toggle pan-scroll mode (p): scroll pans, Shift+scroll pans sideways",
    () => void togglePanMode(),
  );
  const paintPanState = (on: boolean) => {
    panBtn.setAttribute("aria-pressed", String(on));
    panBtn.style.color = on ? "#ff9800" : "var(--ig-button-fg)";
  };
  paintPanState(panModeEnabled());
  onPanModeChange(paintPanState);
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
