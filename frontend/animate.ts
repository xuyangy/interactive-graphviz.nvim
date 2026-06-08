// animate.ts — the frontend-local animation config gate for Story 5.4.
//
// Decision D1 (verbatim from Stories 5.1/5.2/5.3): the architecture lists
// `interactive=true` as an FR-14 config seam, but it is NOT a Lua config key, a
// WS-envelope field, or a message type. The animate on/off gate is resolved
// FRONTEND-LOCALLY exactly as `preserve_view` (viewstate.ts), `highlight_mode`
// (interact.ts) and `search` (search.ts) were: a module-level resolver with a
// setter/getter that clamps bad input to the current default. Default is ON —
// zero-config keeps interactivity polished, matching the architecture's
// `interactive=true` default. No new wire surface (AC4).
//
// This module is PURE — it holds no DOM/d3 access — so the gate + the
// reduced-motion decision logic are unit-testable without a real `matchMedia`
// or a real browser (the WASM render path has no automated harness). render.ts
// owns the single DOM-side `matchMedia` read and folds it into the effective
// decision via `animationsEnabledWith(...)`. Mirrors the pure-module +
// injected-accessor pattern of viewstate.ts.

// ── animate resolution (Decision D1: frontend-default-on) ─────────────────────
// Default true: animation is a capability d3-graphviz has bundled since v1
// (d3-transition + d3-ease ship in the existing bundle); this story turns it on,
// gated. `setAnimate(false)` (or `prefers-reduced-motion`) takes the instant
// fallback. Clamp-to-default: a non-boolean never breaks rendering.
let _animate = true;

/**
 * Set whether re-renders + highlight changes animate (default true). Non-boolean
 * input clamps to the current value, so a bad config never breaks the renderer
 * (mirrors setSearchConfig / setHighlightMode clamp-to-default behavior). This is
 * AC4's no-new-wire-surface seam — in-memory state only; NOT a Lua key / WS field.
 */
export function setAnimate(on: unknown): void {
  if (typeof on === "boolean") _animate = on;
}

/** Current resolved animate config value (default true). */
export function getAnimate(): boolean {
  return _animate;
}

/**
 * Pure effective-animation decision (AC5). Animation runs only when the config
 * gate is ON **and** the environment does not request reduced motion. This is
 * the single predicate both the render path and the highlight path consult, so
 * they can never diverge. render.ts supplies the live values
 * (`getAnimate()` + `window.matchMedia("(prefers-reduced-motion: reduce)").matches`);
 * tests call this directly so the logic is verifiable without a real matchMedia.
 */
export function animationsEnabledWith(configOn: boolean, reducedMotion: boolean): boolean {
  return configOn === true && reducedMotion !== true;
}
