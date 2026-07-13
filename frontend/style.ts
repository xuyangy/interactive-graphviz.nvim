// style.ts — injects the single build-time-inlined stylesheet (plan item #2).
// styles.css is imported AS TEXT (Bun `with { type: "text" }`) so the CSS
// lives inside the JS bundle: the preview page stays one-bundle
// self-contained, and saveInteractiveHtml's single-file export needs no
// <link>/asset handling — the stylesheet rides along inside the inlined
// bundle. This module also owns the `html.ig-motion` class that gates the
// stylesheet's motion rules (emphasis transition + cursor pulse): it is
// re-synced on EVERY ensureAppStyle() call because the effective animate
// decision can change at runtime (setAnimate / a reduced-motion toggle),
// replacing the old recompose-the-stylesheet-text approach.

import appCss from "./styles.css" with { type: "text" };
import { animationsEnabled } from "./motion";

const STYLE_ID = "ig-style";

/**
 * Inject the app stylesheet once (idempotent, getElementById-guarded like the
 * overlays) and re-sync the motion gate class. Called lazily from every
 * styling entry point (applyHighlightToDom, applyCursorEmphasis,
 * buildSearchBox) — the same on-first-use timing the per-module ensure*Style
 * functions had.
 */
export function ensureAppStyle(): void {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = appCss;
    document.head.appendChild(style);
  }
  document.documentElement.classList.toggle("ig-motion", animationsEnabled());
}
