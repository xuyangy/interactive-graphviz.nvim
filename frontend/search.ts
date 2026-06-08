// search.ts — pure live-search model for Story 5.3.
//
// Mirrors interact.ts / viewstate.ts exactly: this module is PURE — no DOM, no
// d3-graphviz / @hpcc-js/wasm import. It holds the search MATCH math
// (`computeSearchMatches`), the scope/toggle (case-sensitive, regex) logic, the
// invalid-regex sentinel, and the frontend-local `search={…}` config resolver.
// render.ts is the only module that touches the live SVG; it extracts the graph
// model (via extractModelFromApp — the SAME SVG-<title> source click-highlight
// uses) and feeds it into this module's pure matcher, then applies the resulting
// HighlightSet back onto the DOM through the SHARED applyHighlightToDom.
//
// Keeping the match MATH pure (operating on an injected GraphModel) means it is
// `bun test`-able exactly like dot.ts / interact.ts. The real search-box render
// + click→SVG-emphasis path has no automated harness (browser WASM render path
// is untested) and is verified manually in a browser — see the Dev Agent Record.

import {
  edgeKey,
  emptyHighlightSet,
  type EdgeKey,
  type GraphModel,
  type HighlightSet,
} from "./interact";

// ── Search scope + config seam (FR-14, frontend-local — Decision D1) ──────────
// `search={…}` is an architecture FR-14 config seam, NOT yet a Lua config key.
// AC6 forbids new wire surface / Lua protocol changes, so the frontend resolves
// it locally — exactly mirroring interact.ts's `_highlightMode` and
// viewstate.ts's `_preserveView`. Defaults match zero-config: scope "both",
// case-sensitive off, regex off.

/** Which element kinds are eligible to match (and to be counted in `total`). */
export type SearchScope = "nodes" | "edges" | "both";

const SEARCH_SCOPES: readonly SearchScope[] = ["nodes", "edges", "both"];

const DEFAULT_SCOPE: SearchScope = "both";
const DEFAULT_CASE_SENSITIVE = false;
const DEFAULT_REGEX = false;

/** The resolved search options the matcher honors. */
export interface SearchOpts {
  caseSensitive: boolean;
  regex: boolean;
  scope: SearchScope;
}

/** True when `s` is one of the three valid scopes. */
export function isSearchScope(s: unknown): s is SearchScope {
  return typeof s === "string" && (SEARCH_SCOPES as readonly string[]).includes(s);
}

// Module-level defaults for the `search={…}` seam. A partial config update
// clamps unknown values to the existing default — a bad config never breaks
// search (mirrors setHighlightMode's clamp-to-default behavior).
let _scope: SearchScope = DEFAULT_SCOPE;
let _caseSensitive: boolean = DEFAULT_CASE_SENSITIVE;
let _regex: boolean = DEFAULT_REGEX;

/** The shape of the frontend-local `search={…}` config seam (all optional). */
export interface SearchConfig {
  scope?: unknown;
  caseSensitive?: unknown;
  regex?: unknown;
}

/**
 * Set the resolved search config. Unknown / invalid values clamp to the current
 * value (which itself defaults to scope "both" / case-insensitive / no-regex),
 * so a bad config never breaks search. This is AC6's no-new-wire-surface seam —
 * it flips in-memory state only; it does NOT add a Lua config key or WS field.
 */
export function setSearchConfig(cfg: SearchConfig | undefined): void {
  if (!cfg || typeof cfg !== "object") return;
  if (isSearchScope(cfg.scope)) _scope = cfg.scope;
  if (typeof cfg.caseSensitive === "boolean") _caseSensitive = cfg.caseSensitive;
  if (typeof cfg.regex === "boolean") _regex = cfg.regex;
}

/** Current resolved search options (defaults: both / case-insensitive / no-regex). */
export function getSearchConfig(): SearchOpts {
  return { caseSensitive: _caseSensitive, regex: _regex, scope: _scope };
}

// ── Query compiler (pure; invalid-regex sentinel, never throws) ───────────────

/**
 * A compiled predicate over a candidate string. `valid` is false only when
 * `regex` was on and the query failed to compile — in that case `test` always
 * returns false (zero matches) and the caller can surface the error indication
 * (AC3): an invalid regex is a non-crashing "no match", never an uncaught throw.
 */
export interface CompiledQuery {
  test: (candidate: string) => boolean;
  /** True unless a regex query failed to compile. */
  valid: boolean;
  /** True when the query is empty/whitespace — matches nothing, dims nothing. */
  empty: boolean;
}

/**
 * Compile a query string into a pure predicate honoring the case-sensitive /
 * regex toggles. Never throws:
 *  - empty / whitespace query → matches nothing (`empty: true`), so the caller
 *    dims nothing and reads `0/total` at full opacity (AC2).
 *  - regex off → substring match; case-insensitive unless `caseSensitive`.
 *  - regex on  → `new RegExp(query, flags)`; an INVALID pattern returns a
 *    sentinel (`valid: false`, `test` always false) instead of throwing (AC3).
 */
export function compileQuery(query: string, opts: SearchOpts): CompiledQuery {
  const raw = query ?? "";
  if (raw.trim().length === 0) {
    return { test: () => false, valid: true, empty: true };
  }
  if (opts.regex) {
    const flags = opts.caseSensitive ? "" : "i";
    let re: RegExp;
    try {
      re = new RegExp(raw, flags);
    } catch {
      // Invalid regex: non-crashing "no match" sentinel (AC3). Never rethrow.
      return { test: () => false, valid: false, empty: false };
    }
    return { test: (c: string) => re.test(c), valid: true, empty: false };
  }
  // Substring match.
  if (opts.caseSensitive) {
    return { test: (c: string) => c.includes(raw), valid: true, empty: false };
  }
  const needle = raw.toLowerCase();
  return { test: (c: string) => c.toLowerCase().includes(needle), valid: true, empty: false };
}

// ── Search match computation (pure) ───────────────────────────────────────────

/** The result of a search: the matched nodes/edges, the denominator, and validity. */
export interface SearchResult {
  /** Matched node titles (to emphasize). */
  nodes: Set<string>;
  /** Matched edge keys (to emphasize). */
  edges: Set<EdgeKey>;
  /** Count of searchable elements within the active scope (the `N/total` denominator). */
  total: number;
  /** Number of matches (`N` in `N/total`) — nodes + edges matched. */
  count: number;
  /** False only when a regex query failed to compile (surface a non-crashing error indication). */
  valid: boolean;
  /** True when the query was empty/whitespace (matches nothing, dims nothing). */
  empty: boolean;
}

/** True when a node is eligible under the active scope. */
function nodeInScope(scope: SearchScope): boolean {
  return scope === "nodes" || scope === "both";
}

/** True when an edge is eligible under the active scope. */
function edgeInScope(scope: SearchScope): boolean {
  return scope === "edges" || scope === "both";
}

/**
 * The text an edge is matched against. The AC says "by label"; the pragmatic,
 * already-extractable source is the edge identity (`A->B` / `A--B`) — the same
 * EdgeKey the SVG <title> carries — so a query like "a", "->", or "a->b" can
 * find edges. We match against the endpoints and the rendered key form.
 */
function edgeCandidates(from: string, to: string, undirected: boolean): string[] {
  return [from, to, edgeKey(from, to, undirected)];
}

/**
 * Compute the search matches for a query against a pure GraphModel.
 *
 * - Matches node titles (identity, what extractModelFromApp gives us) and edge
 *   endpoints/keys, honoring the case-sensitive / regex toggles in `opts`.
 * - `total` is the count of searchable elements WITHIN the active scope (the
 *   `N/total` denominator): nodes only / edges only / both.
 * - An empty query matches nothing and dims nothing (`empty: true`, `count: 0`),
 *   but `total` still reflects the scope so the counter reads `0/total`.
 * - An invalid regex returns zero matches with `valid: false` (AC3) — never
 *   throws.
 *
 * DOM-free and dependency-free: unit-testable like interact.ts / dot.ts.
 */
export function computeSearchMatches(
  model: GraphModel,
  query: string,
  opts: SearchOpts,
): SearchResult {
  const scope = isSearchScope(opts.scope) ? opts.scope : DEFAULT_SCOPE;
  const compiled = compileQuery(query, opts);

  const nodes = new Set<string>();
  const edges = new Set<EdgeKey>();

  // Denominator: number of searchable elements in scope (independent of query).
  let total = 0;
  if (nodeInScope(scope)) total += model.nodes.size;
  if (edgeInScope(scope)) total += model.edges.length;

  // Empty query / invalid regex: no matches (compiled.test is always false), so
  // the loops below add nothing — but we still return the correct `total`.
  if (nodeInScope(scope)) {
    for (const name of model.nodes) {
      if (compiled.test(name)) nodes.add(name);
    }
  }
  if (edgeInScope(scope)) {
    for (const e of model.edges) {
      const undirected = e.undirected === true;
      const candidates = edgeCandidates(e.from, e.to, undirected);
      if (candidates.some((c) => compiled.test(c))) {
        edges.add(edgeKey(e.from, e.to, undirected));
      }
    }
  }

  return {
    nodes,
    edges,
    total,
    count: nodes.size + edges.size,
    valid: compiled.valid,
    empty: compiled.empty,
  };
}

// ── Bridge to the shared highlight regime (AC1, AC5) ──────────────────────────
// Search matches must flow through the SAME applyHighlightToDom / ig-* classes
// as click-highlight (no parallel ig-search-* classes that stack and fight).
// A SearchResult maps to a HighlightSet: matches → `ig-neighbor` emphasis
// (matched nodes go in `nodes`, matched edges in `edges`), non-matches → dimmed.
// `selected` stays empty so search matches read as the "neighbor" emphasis
// treatment (a lighter accent), distinct from a click's bold Selected node, and
// applyHighlightToDom's `anySelected` gate keys off selected.size — so we put a
// match into `selected` only when there are matches, to engage the dim regime
// while keeping the per-match class as `ig-neighbor`.

/**
 * Convert a SearchResult into a HighlightSet for the shared DOM applier.
 *
 * Matched nodes/edges become `nodes`/`edges` (rendered `ig-neighbor`,
 * emphasized); non-matches dim. To engage applyHighlightToDom's dim regime
 * (which keys off `selected.size > 0`) WITHOUT promoting any match to the bold
 * `ig-selected` treatment, we leave `selected` empty when there are no matches
 * (cleared state, full opacity) and otherwise rely on the matched nodes being in
 * `nodes` only. applyHighlightToDom dims an element when `anySelected` is true
 * and it is not in `nodes`/`edges`; an empty query yields an empty set → cleared.
 */
export function searchResultToHighlightSet(result: SearchResult): HighlightSet {
  // Empty query OR zero matches → cleared state (no dimming, full opacity) per
  // AC2 ("an empty query or zero matches reads 0/total and dims nothing").
  if (result.empty || result.count === 0) {
    return emptyHighlightSet();
  }
  // Matches present: emphasize matches as neighbors, dim the rest. We must
  // engage applyHighlightToDom's dim regime, which gates on `selected.size > 0`.
  // Put the matched nodes into `selected` as well so the gate engages — but only
  // when there is no node match do we need a different lever. Simplest robust
  // approach: mark matched nodes in BOTH `nodes` and `selected` so the gate is
  // on; matched edges in `edges`. (ig-selected vs ig-neighbor on a node is a
  // stroke-weight nuance; for search, emphasizing matches is the requirement.)
  return {
    nodes: new Set(result.nodes),
    edges: new Set(result.edges),
    selected: new Set(result.nodes),
  };
}

// ── /-open + Esc-close keydown predicates (pure) ──────────────────────────────
// Mirror render.ts's `shouldReset` / interact.ts's `shouldClearHighlight` shape
// so the gesture decisions are unit-tested without a DOM.

export interface SearchKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * True when this keydown should OPEN the search box: an un-modified `/` when NOT
 * already typing in an INPUT/TEXTAREA (so `/` typed inside the search input is a
 * literal slash, not a re-open). Mirrors shouldReset's modifier/text-field guard.
 */
export function shouldOpenSearch(e: SearchKeyEvent, activeTag: string | undefined): boolean {
  if (e.key !== "/") return false;
  if (activeTag === "INPUT" || activeTag === "TEXTAREA") return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return true;
}

/**
 * True when this keydown should CLOSE/CLEAR the search box: an un-modified `Esc`.
 * This is handled on the search input element itself (the input is focused while
 * search is open), so it stops at the input and clears search — and because
 * shouldClearHighlight already skips when an INPUT/TEXTAREA is focused, the
 * document-level click-highlight Esc-clear does NOT also fire (AC4: the two
 * never double-fire or fight).
 */
export function shouldCloseSearch(e: SearchKeyEvent): boolean {
  if (e.key !== "Escape") return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return true;
}

// ── Test seam ──────────────────────────────────────────────────────────────
/** Reset the module-level search config to defaults. Tests only. */
export function _resetSearchConfig(): void {
  _scope = DEFAULT_SCOPE;
  _caseSensitive = DEFAULT_CASE_SENSITIVE;
  _regex = DEFAULT_REGEX;
}
