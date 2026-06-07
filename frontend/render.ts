// render.ts is the ONLY module that imports d3-graphviz / @hpcc-js/wasm-graphviz.
// All other modules (main.ts, ws.ts) speak the wire protocol only.
//
// d3-graphviz 5.6.0 ships no TypeScript definitions; the import resolves to
// `any` — this is expected and intentional.

// eslint-disable-next-line import/no-unresolved
import { graphviz } from "d3-graphviz";
import { createRenderQueue } from "./render-queue";

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

// ── Last-good-render state ──────────────────────────────────────────────────
let lastGoodDot: string | null = null;
let lastGoodEngine: string = "dot";

/**
 * Wraps renderDot: on success, updates lastGoodDot/lastGoodEngine.
 * Does NOT render the fallback itself — fallback is triggered by onError in
 * the queue opts (render.ts caller responsibility).
 */
async function renderDotWithFallback(dot: string, engine: string): Promise<void> {
  await renderDot(dot, engine);
  // Only reached on success — update last-good state.
  lastGoodDot = dot;
  lastGoodEngine = engine;
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
