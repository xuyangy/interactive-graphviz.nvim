// overlays.ts — the preview's non-blocking informational surfaces: the error
// overlay (top-right, red), the empty-buffer notice (top-left, grey), and the
// disconnect notice (top-center, amber). Extracted from render.ts as pure code
// motion (plan item #1a): none of this touches d3 — render.ts remains the only
// module that imports d3-graphviz. Every overlay is an idempotent, inline-styled
// fixed <div> with a stable DOM id, created on demand and updated in place.

// How far right-edge overlays must stay from the viewport edge to clear the
// view-toolbar column: 8px offset + 28px button width + 8px gutter. showError
// and the search-box max-width (render.ts) derive from this — keep in sync
// with the toolbar's own cssText geometry (toolbar.ts).
export const VIEW_TOOLBAR_CLEARANCE_PX = 44;

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
      `position:fixed;top:8px;right:${VIEW_TOOLBAR_CLEARANCE_PX}px;background:var(--ig-error-bg);` +
      "color:var(--ig-error-fg);padding:6px 10px;border-radius:4px;font-size:13px;" +
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
      "position:fixed;top:8px;left:8px;background:var(--ig-notice-bg);" +
      "color:var(--ig-notice-fg);padding:6px 10px;border-radius:4px;font-size:13px;" +
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
      "background:var(--ig-warn-bg);color:var(--ig-warn-fg);padding:6px 10px;border-radius:4px;" +
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
