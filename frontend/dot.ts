// Tiny dependency-free helpers for reasoning about DOT payloads.
// Kept separate from render.ts so unit tests need no DOM or d3-graphviz import.

/** True when the DOT payload is missing, empty, or only whitespace. */
export function isBlankDot(dot: string | undefined | null): boolean {
  return !dot || dot.trim().length === 0;
}
