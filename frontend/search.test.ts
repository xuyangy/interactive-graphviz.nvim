import { afterEach, describe, expect, test } from "bun:test";
import { parseDotModel, type GraphModel } from "./interact";
import {
  compileQuery,
  computeSearchMatches,
  getSearchConfig,
  isSearchScope,
  searchResultToHighlightSet,
  setSearchConfig,
  shouldCloseSearch,
  shouldOpenSearch,
  type SearchOpts,
  _resetSearchConfig,
} from "./search";

// Pure-unit tests (bun test, no DOM) for Story 5.3's live-search model. Mirrors
// the stub-injection pattern in interact.test.ts / viewstate.test.ts. The real
// search-box rendering + click→SVG-emphasis path has no automated harness
// (browser WASM render path is untested) and is verified manually in a browser —
// see the Dev Agent Record.

afterEach(() => {
  _resetSearchConfig();
});

// A small directed fixture graph:
//   alpha -> beta -> gamma
//   Alpha -> delta            (capital A node to exercise case-sensitivity)
// Nodes: alpha, beta, gamma, Alpha, delta (5).
// Edges: alpha->beta, beta->gamma, Alpha->delta (3).
function fixture(): GraphModel {
  return parseDotModel("digraph G { alpha -> beta -> gamma; Alpha -> delta; }");
}

const OPTS = (over: Partial<SearchOpts> = {}): SearchOpts => ({
  caseSensitive: false,
  regex: false,
  scope: "both",
  ...over,
});

describe("search config resolver (AC6, mirrors highlight_mode / preserve_view)", () => {
  test("defaults to both / case-insensitive / no-regex (zero new wire surface)", () => {
    const c = getSearchConfig();
    expect(c.scope).toBe("both");
    expect(c.caseSensitive).toBe(false);
    expect(c.regex).toBe(false);
  });

  test("setSearchConfig accepts valid partial updates", () => {
    setSearchConfig({ scope: "nodes" });
    expect(getSearchConfig().scope).toBe("nodes");
    setSearchConfig({ caseSensitive: true, regex: true });
    const c = getSearchConfig();
    expect(c.caseSensitive).toBe(true);
    expect(c.regex).toBe(true);
    // scope persists from the earlier partial update
    expect(c.scope).toBe("nodes");
  });

  test("clamps unknown scope / non-boolean toggles to current value (default)", () => {
    setSearchConfig({ scope: "sideways" });
    expect(getSearchConfig().scope).toBe("both");
    setSearchConfig({ caseSensitive: "yes" });
    expect(getSearchConfig().caseSensitive).toBe(false);
    setSearchConfig({ regex: 1 });
    expect(getSearchConfig().regex).toBe(false);
    setSearchConfig(undefined);
    expect(getSearchConfig().scope).toBe("both");
    setSearchConfig({ scope: 42 });
    expect(getSearchConfig().scope).toBe("both");
  });

  test("isSearchScope type guard", () => {
    expect(isSearchScope("nodes")).toBe(true);
    expect(isSearchScope("edges")).toBe(true);
    expect(isSearchScope("both")).toBe(true);
    expect(isSearchScope("none")).toBe(false);
    expect(isSearchScope(7)).toBe(false);
  });
});

describe("compileQuery (AC3 — toggles + invalid-regex sentinel)", () => {
  test("empty / whitespace query matches nothing (empty flag set)", () => {
    const q = compileQuery("   ", OPTS());
    expect(q.empty).toBe(true);
    expect(q.valid).toBe(true);
    expect(q.test("anything")).toBe(false);
  });

  test("case-insensitive substring (default)", () => {
    const q = compileQuery("ALP", OPTS({ caseSensitive: false }));
    expect(q.test("alpha")).toBe(true);
    expect(q.test("Alpha")).toBe(true);
    expect(q.test("beta")).toBe(false);
  });

  test("case-sensitive substring", () => {
    const q = compileQuery("Alp", OPTS({ caseSensitive: true }));
    expect(q.test("Alpha")).toBe(true);
    expect(q.test("alpha")).toBe(false);
  });

  test("valid regex matches (case-insensitive)", () => {
    const q = compileQuery("^al.+a$", OPTS({ regex: true, caseSensitive: false }));
    expect(q.valid).toBe(true);
    expect(q.test("alpha")).toBe(true);
    expect(q.test("Alpha")).toBe(true); // i flag
    expect(q.test("beta")).toBe(false);
  });

  test("valid regex respects case-sensitive flag", () => {
    const q = compileQuery("^Al", OPTS({ regex: true, caseSensitive: true }));
    expect(q.test("Alpha")).toBe(true);
    expect(q.test("alpha")).toBe(false);
  });

  test("invalid regex returns sentinel (no throw, valid=false, no matches)", () => {
    // Unterminated group — invalid pattern.
    let thrown = false;
    let q;
    try {
      q = compileQuery("a(b", OPTS({ regex: true }));
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false);
    expect(q!.valid).toBe(false);
    expect(q!.empty).toBe(false);
    expect(q!.test("anything")).toBe(false);
  });
});

describe("computeSearchMatches (AC1, AC2, AC3)", () => {
  test("substring match (case-insensitive default) finds nodes + N/total", () => {
    const r = computeSearchMatches(fixture(), "al", OPTS());
    // matches: nodes alpha, Alpha; edges alpha->beta (endpoint alpha), Alpha->delta
    expect(r.nodes.has("alpha")).toBe(true);
    expect(r.nodes.has("Alpha")).toBe(true);
    expect(r.nodes.has("beta")).toBe(false);
    // total = 5 nodes + 3 edges (scope both)
    expect(r.total).toBe(8);
    expect(r.empty).toBe(false);
    expect(r.valid).toBe(true);
    expect(r.count).toBe(r.nodes.size + r.edges.size);
  });

  test("case-sensitive on/off changes matches", () => {
    const off = computeSearchMatches(fixture(), "alpha", OPTS({ caseSensitive: false }));
    expect(off.nodes.has("alpha")).toBe(true);
    expect(off.nodes.has("Alpha")).toBe(true);
    const on = computeSearchMatches(fixture(), "alpha", OPTS({ caseSensitive: true }));
    expect(on.nodes.has("alpha")).toBe(true);
    expect(on.nodes.has("Alpha")).toBe(false);
  });

  test("regex on (valid pattern) matches", () => {
    const r = computeSearchMatches(fixture(), "^beta$", OPTS({ regex: true }));
    expect(r.nodes.has("beta")).toBe(true);
    expect(r.nodes.has("alpha")).toBe(false);
    expect(r.valid).toBe(true);
  });

  test("invalid regex → zero matches, valid=false, no throw", () => {
    const r = computeSearchMatches(fixture(), "a(", OPTS({ regex: true }));
    expect(r.valid).toBe(false);
    expect(r.count).toBe(0);
    expect(r.nodes.size).toBe(0);
    expect(r.edges.size).toBe(0);
    // total still reflects scope
    expect(r.total).toBe(8);
  });

  test("scope = nodes: only nodes eligible, total = node count", () => {
    const r = computeSearchMatches(fixture(), "beta", OPTS({ scope: "nodes" }));
    expect(r.nodes.has("beta")).toBe(true);
    expect(r.edges.size).toBe(0);
    expect(r.total).toBe(5);
  });

  test("scope = edges: only edges eligible, total = edge count", () => {
    const r = computeSearchMatches(fixture(), "beta", OPTS({ scope: "edges" }));
    expect(r.nodes.size).toBe(0);
    // alpha->beta and beta->gamma both contain endpoint 'beta'
    expect(r.edges.has("alpha->beta")).toBe(true);
    expect(r.edges.has("beta->gamma")).toBe(true);
    expect(r.total).toBe(3);
  });

  test("scope = both: total = nodes + edges", () => {
    const r = computeSearchMatches(fixture(), "zzz-no-match", OPTS({ scope: "both" }));
    expect(r.total).toBe(8);
    expect(r.count).toBe(0);
  });

  test("edge matched by rendered key form (A->B)", () => {
    const r = computeSearchMatches(fixture(), "alpha->beta", OPTS({ scope: "edges" }));
    expect(r.edges.has("alpha->beta")).toBe(true);
  });

  test("empty query = zero matches, dims nothing, but total reflects scope", () => {
    const r = computeSearchMatches(fixture(), "", OPTS());
    expect(r.empty).toBe(true);
    expect(r.count).toBe(0);
    expect(r.nodes.size).toBe(0);
    expect(r.edges.size).toBe(0);
    expect(r.total).toBe(8);
  });
});

describe("searchResultToHighlightSet (AC1, AC2, AC5 — shared regime)", () => {
  test("empty query → empty highlight set (cleared, full opacity)", () => {
    const r = computeSearchMatches(fixture(), "", OPTS());
    const set = searchResultToHighlightSet(r);
    expect(set.selected.size).toBe(0);
    expect(set.nodes.size).toBe(0);
    expect(set.edges.size).toBe(0);
  });

  test("zero matches → empty highlight set (dims nothing)", () => {
    const r = computeSearchMatches(fixture(), "zzz", OPTS());
    const set = searchResultToHighlightSet(r);
    expect(set.selected.size).toBe(0);
    expect(set.nodes.size).toBe(0);
  });

  test("matches present → matched nodes/edges in set, dim regime engaged", () => {
    const r = computeSearchMatches(fixture(), "beta", OPTS({ scope: "nodes" }));
    const set = searchResultToHighlightSet(r);
    expect(set.nodes.has("beta")).toBe(true);
    // selected is populated so applyHighlightToDom's dim regime engages
    expect(set.selected.size).toBeGreaterThan(0);
  });
});

describe("shouldOpenSearch (AC1 — /-open predicate)", () => {
  test("fires on un-modified / outside a text field", () => {
    expect(shouldOpenSearch({ key: "/" }, undefined)).toBe(true);
    expect(shouldOpenSearch({ key: "/" }, "DIV")).toBe(true);
  });

  test("skips INPUT / TEXTAREA (literal slash while typing)", () => {
    expect(shouldOpenSearch({ key: "/" }, "INPUT")).toBe(false);
    expect(shouldOpenSearch({ key: "/" }, "TEXTAREA")).toBe(false);
  });

  test("skips when modified or wrong key", () => {
    expect(shouldOpenSearch({ key: "/", ctrlKey: true }, undefined)).toBe(false);
    expect(shouldOpenSearch({ key: "/", metaKey: true }, undefined)).toBe(false);
    expect(shouldOpenSearch({ key: "/", altKey: true }, undefined)).toBe(false);
    expect(shouldOpenSearch({ key: "a" }, undefined)).toBe(false);
  });
});

describe("shouldCloseSearch (AC4 — Esc-close predicate)", () => {
  test("fires on un-modified Escape", () => {
    expect(shouldCloseSearch({ key: "Escape" })).toBe(true);
  });

  test("skips when modified or wrong key", () => {
    expect(shouldCloseSearch({ key: "Escape", ctrlKey: true })).toBe(false);
    expect(shouldCloseSearch({ key: "Escape", metaKey: true })).toBe(false);
    expect(shouldCloseSearch({ key: "x" })).toBe(false);
  });
});
