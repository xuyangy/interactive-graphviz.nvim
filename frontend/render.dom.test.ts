import { GlobalRegistrator } from "@happy-dom/global-registrator";
// Register the DOM BEFORE importing render.ts helpers are exercised. render.ts
// itself is DOM-free at import time (verified by render.test.ts importing it
// with no DOM), so import hoisting above this call is safe.
GlobalRegistrator.register();

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _setLastGoodDot,
  cursorPanNeeded,
  intersectRects,
  setAnimate,
  viewCenterInViewBox,
  zoomBy,
} from "./render";
import { ensureAppStyle } from "./style";
import {
  _cursorEmphasisSnapshot,
  _reapplyHighlightAfterRender,
  _resetHighlightState,
  _selectionSnapshot,
  applyCursorEmphasis,
  handleHighlightKeydown,
  installInteractionHandlers,
} from "./emphasis";
import {
  _resetSearchState,
  _searchIsOpen,
  closeSearch,
  handleSearchKeydown,
  openSearch,
} from "./search-ui";
import {
  extractModelFromApp,
  invalidateGraphDom,
  nodeEntries,
  nodeTitleFromClickTarget,
} from "./graph-dom";
import {
  _disconnectNoticeElement,
  _emptyNoticeElement,
  _overlayElement,
  clearDisconnectNotice,
  clearError,
  showDisconnectNotice,
  showEmptyNotice,
  showError,
} from "./overlays";
import { _viewToolbarElement, installViewToolbar } from "./toolbar";
import {
  assembleInteractiveHtml,
  hasExportMarker,
  isStaticExportPage,
  readExportPayload,
  saveGraphSvg,
  saveInteractiveHtml,
  serializeGraphSvg,
} from "./export";
import { _resetSync, setJumpOnClick, setNodeClickSender } from "./sync";

// Story 5.2/5.3/5.4 — the live DOM emphasis path (applyHighlightToDom,
// handleAppClick delegation, recomputeAndApplyHighlight, cluster augment,
// reapplyHighlightAfterRender pruning, the search box, the error/empty
// overlays). The pure highlight MATH is covered in interact.test.ts /
// search.test.ts; these tests close the recorded deferred-work gap by driving
// the exported handlers against a static graphviz-shaped SVG fixture (the
// markup d3-graphviz emits: <g class="node"><title>NAME</title>…>). The real
// WASM layout/render itself still has no automated harness (see MEMORY
// browser-render-untested) — this covers everything downstream of it.

// Graph: a -> b -> c, with cluster_g = {a, c} (so Alt+click cluster
// augmentation emphasizes c, which is NOT a plain neighbor of a — making the
// augment observable).
const FIXTURE_SVG = `
<svg width="100" height="100">
  <g class="graph">
    <g class="cluster"><title>cluster_g</title><polygon></polygon></g>
    <g class="node" id="g-a"><title>a</title><ellipse></ellipse><text>a</text></g>
    <g class="node" id="g-b"><title>b</title><ellipse></ellipse><text>b</text></g>
    <g class="node" id="g-c"><title>c</title><ellipse></ellipse><text>c</text></g>
    <g class="edge" id="g-ab"><title>a-&gt;b</title><path></path></g>
    <g class="edge" id="g-bc"><title>b-&gt;c</title><path></path></g>
  </g>
</svg>`;

const FIXTURE_DOT = `digraph { subgraph cluster_g { a; c; } a -> b; b -> c; }`;

function setupApp(): HTMLElement {
  document.body.innerHTML = `<div id="app">${FIXTURE_SVG}</div>`;
  const app = document.getElementById("app")!;
  installInteractionHandlers();
  return app;
}

function el(id: string): Element {
  const e = document.getElementById(id);
  if (!e) throw new Error(`fixture element #${id} missing`);
  return e;
}

function classesOf(id: string): string[] {
  return [...el(id).classList].filter((c) => c.startsWith("ig-")).sort();
}

function clickOn(target: Element, init: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
}

beforeEach(() => {
  setupApp();
});

afterEach(() => {
  _resetSearchState();
  _resetHighlightState();
  _setLastGoodDot(null);
  _resetSync();
  clearError(0);
  document.body.innerHTML = "";
  invalidateGraphDom();
});

describe("click-to-highlight DOM emphasis (Story 5.2)", () => {
  test("clicking a node emphasizes it, its neighbors, and the connecting edges; dims the rest", () => {
    clickOn(el("g-a").querySelector("ellipse")!);

    expect(_selectionSnapshot()).toEqual(["a"]);
    expect(classesOf("g-a")).toEqual(["ig-selected"]);
    expect(classesOf("g-b")).toEqual(["ig-neighbor"]);
    expect(classesOf("g-c")).toEqual(["ig-dimmed"]);
    expect(classesOf("g-ab")).toEqual(["ig-neighbor"]);
    expect(classesOf("g-bc")).toEqual(["ig-dimmed"]);
    // The app stylesheet (styles.css via ensureAppStyle) is injected exactly once.
    expect(document.getElementById("ig-style")).not.toBeNull();
  });

  test("background click clears every emphasis class (full opacity)", () => {
    clickOn(el("g-a").querySelector("ellipse")!);
    clickOn(document.getElementById("app")!.querySelector("svg")!);

    expect(_selectionSnapshot()).toEqual([]);
    for (const id of ["g-a", "g-b", "g-c", "g-ab", "g-bc"]) {
      expect(classesOf(id)).toEqual([]);
    }
  });

  test("shift+click multi-selects (union of per-node neighbor sets)", () => {
    clickOn(el("g-a").querySelector("ellipse")!);
    clickOn(el("g-c").querySelector("ellipse")!, { shiftKey: true });

    expect(_selectionSnapshot().sort()).toEqual(["a", "c"]);
    expect(classesOf("g-a")).toEqual(["ig-selected"]);
    expect(classesOf("g-c")).toEqual(["ig-selected"]);
    // b is a neighbor of both (a->b downstream of a, b->c upstream of c).
    expect(classesOf("g-b")).toEqual(["ig-neighbor"]);
    expect(classesOf("g-ab")).toEqual(["ig-neighbor"]);
    expect(classesOf("g-bc")).toEqual(["ig-neighbor"]);
  });

  test("plain click replaces the selection", () => {
    clickOn(el("g-a").querySelector("ellipse")!);
    clickOn(el("g-c").querySelector("ellipse")!);

    expect(_selectionSnapshot()).toEqual(["c"]);
    expect(classesOf("g-a")).toEqual(["ig-dimmed"]);
    expect(classesOf("g-c")).toEqual(["ig-selected"]);
  });

  test("Esc clears the highlight; modified Esc does not", () => {
    clickOn(el("g-a").querySelector("ellipse")!);

    expect(handleHighlightKeydown(new KeyboardEvent("keydown", { key: "Escape", ctrlKey: true }))).toBe(false);
    expect(classesOf("g-a")).toEqual(["ig-selected"]);

    expect(handleHighlightKeydown(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
    expect(_selectionSnapshot()).toEqual([]);
    expect(classesOf("g-a")).toEqual([]);
  });

  test("nodeTitleFromClickTarget walks up nested children and rejects background", () => {
    expect(nodeTitleFromClickTarget(el("g-a").querySelector("text"))).toBe("a");
    expect(nodeTitleFromClickTarget(el("g-b"))).toBe("b");
    expect(nodeTitleFromClickTarget(document.getElementById("app")!.querySelector("svg"))).toBeNull();
    expect(nodeTitleFromClickTarget(null)).toBeNull();
  });

  test("Alt+click augments the highlight with the node's whole cluster (AC3)", () => {
    // The cluster model comes from the DOT parse on the post-render boundary.
    _setLastGoodDot(FIXTURE_DOT);
    _reapplyHighlightAfterRender();

    clickOn(el("g-a").querySelector("ellipse")!, { altKey: true });

    expect(classesOf("g-a")).toEqual(["ig-selected"]);
    expect(classesOf("g-b")).toEqual(["ig-neighbor"]); // plain neighbor
    // c is NOT a neighbor of a — emphasized only via cluster_g membership.
    expect(classesOf("g-c")).toEqual(["ig-neighbor"]);

    // A later plain click drops the augmentation: c dims again.
    clickOn(el("g-a").querySelector("ellipse")!);
    expect(classesOf("g-c")).toEqual(["ig-dimmed"]);
  });
});

describe("node-click sync emission (Story 6.2)", () => {
  function captureSender(): string[] {
    const seen: string[] = [];
    setNodeClickSender((nodeId) => {
      seen.push(nodeId);
      return true;
    });
    return seen;
  }

  test("a node click calls the registered sender AND still highlights (AC1 side effect)", () => {
    const seen = captureSender();

    clickOn(el("g-a").querySelector("ellipse")!);

    expect(seen).toEqual(["a"]);
    // Epic 5 click-highlight is unchanged — same assertions as Story 5.2 above.
    expect(_selectionSnapshot()).toEqual(["a"]);
    expect(classesOf("g-a")).toEqual(["ig-selected"]);
    expect(classesOf("g-b")).toEqual(["ig-neighbor"]);
  });

  test("disabled gate suppresses the emission but never the highlight (AC3)", () => {
    const seen = captureSender();
    setJumpOnClick(false);

    clickOn(el("g-b").querySelector("ellipse")!);

    expect(seen).toEqual([]);
    expect(_selectionSnapshot()).toEqual(["b"]);
    expect(classesOf("g-b")).toEqual(["ig-selected"]);
  });

  test("background click clears the highlight and emits nothing", () => {
    const seen = captureSender();

    clickOn(el("g-a").querySelector("ellipse")!);
    clickOn(document.getElementById("app")!.querySelector("svg")!);

    expect(seen).toEqual(["a"]); // only the node click, never the background
    expect(_selectionSnapshot()).toEqual([]);
  });

  test("shift+click and alt+click variants also emit (same click path)", () => {
    const seen = captureSender();

    clickOn(el("g-a").querySelector("ellipse")!);
    clickOn(el("g-c").querySelector("ellipse")!, { shiftKey: true });
    clickOn(el("g-b").querySelector("ellipse")!, { altKey: true });

    expect(seen).toEqual(["a", "c", "b"]);
  });
});

describe("reapplyHighlightAfterRender (Story 5.2 AC4 — live-reload interop)", () => {
  test("re-applies the active highlight against a rebuilt SVG", () => {
    clickOn(el("g-a").querySelector("ellipse")!);

    // Simulate d3-graphviz rebuilding the #app subtree on a re-render.
    document.getElementById("app")!.innerHTML = FIXTURE_SVG;
    expect(classesOf("g-a")).toEqual([]); // fresh subtree, no classes yet

    _reapplyHighlightAfterRender();
    expect(classesOf("g-a")).toEqual(["ig-selected"]);
    expect(classesOf("g-b")).toEqual(["ig-neighbor"]);
    expect(classesOf("g-c")).toEqual(["ig-dimmed"]);
  });

  test("prunes selected nodes that no longer exist; empty survivor set clears cleanly", () => {
    clickOn(el("g-a").querySelector("ellipse")!);

    // A live-reload that drops node a drops its edges too (the SVG model also
    // derives nodes from edge endpoints, so a dangling a->b would keep "a" alive).
    el("g-a").remove();
    el("g-ab").remove();
    _reapplyHighlightAfterRender();

    expect(_selectionSnapshot()).toEqual([]);
    for (const id of ["g-b", "g-c", "g-bc"]) {
      expect(classesOf(id)).toEqual([]);
    }
  });
});

describe("graph-dom snapshot cache (plan item #8b)", () => {
  test("reads are cached per snapshot: same entries and same model object until invalidated", () => {
    const first = nodeEntries();
    expect(first.map((e) => e.title)).toEqual(["a", "b", "c"]);
    expect(nodeEntries()).toBe(first); // identical array — no re-scan
    const model = extractModelFromApp();
    expect(extractModelFromApp()).toBe(model); // model cached per snapshot

    invalidateGraphDom();
    const fresh = nodeEntries();
    expect(fresh).not.toBe(first); // rebuilt from the live DOM
    expect(fresh.map((e) => e.title)).toEqual(["a", "b", "c"]); // same content
    expect(extractModelFromApp()).not.toBe(model);
  });

  test("the render boundary (reapply) refreshes the snapshot after a subtree rebuild", () => {
    const stale = nodeEntries();
    // Simulate d3-graphviz rebuilding the subtree; production invalidates via
    // renderDot + the reapply boundary — the seam mirrors the latter.
    document.getElementById("app")!.innerHTML = FIXTURE_SVG;
    // Outside the render boundary the contract serves the cached snapshot:
    expect(nodeEntries()).toBe(stale);

    _reapplyHighlightAfterRender();
    const fresh = nodeEntries();
    expect(fresh).not.toBe(stale);
    // The fresh entries are the NEW elements, not the detached ones.
    expect(fresh[0]!.el.isConnected).toBe(true);
    expect(stale[0]!.el.isConnected).toBe(false);
  });

  test("a wholesale #app replacement is self-detected (no explicit invalidation)", () => {
    const before = nodeEntries();
    expect(before.map((e) => e.title)).toEqual(["a", "b", "c"]);
    setupApp(); // replaces body -> brand-new #app element
    const after = nodeEntries();
    expect(after).not.toBe(before);
    expect(after[0]!.el.isConnected).toBe(true);
  });
});

describe("error overlay + empty-buffer notice (Story 1.6 / Epic 4)", () => {
  test("showError creates the overlay, is idempotent, and clearError removes it", () => {
    showError(new Error("syntax error in line 3"), 7);
    const overlay = _overlayElement();
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toBe("DOT parse error (v7): syntax error in line 3");

    showError(new Error("another"), 8);
    expect(_overlayElement()).toBe(overlay); // updated in place, not duplicated
    expect(overlay!.textContent).toBe("DOT parse error (v8): another");

    clearError(8);
    expect(_overlayElement()).toBeNull();
  });

  test("a plain-string error renders without the DOT-parse prefix", () => {
    showError("server exploded", 2);
    expect(_overlayElement()!.textContent).toBe("Error (v2): server exploded");
  });

  test("long messages are truncated at 200 chars with an ellipsis", () => {
    showError(new Error("x".repeat(300)), 1);
    expect(_overlayElement()!.textContent).toBe(`DOT parse error (v1): ${"x".repeat(200)}…`);
  });

  test("error overlay and empty notice are mutually exclusive", () => {
    showEmptyNotice(3);
    expect(_emptyNoticeElement()!.textContent).toContain("nothing to render (v3)");

    showError(new Error("boom"), 4);
    expect(_emptyNoticeElement()).toBeNull();
    expect(_overlayElement()).not.toBeNull();

    showEmptyNotice(5);
    expect(_overlayElement()).toBeNull();
    expect(_emptyNoticeElement()).not.toBeNull();
  });
});

describe("disconnect notice (silent-disconnect fix)", () => {
  test("showDisconnectNotice creates the notice, is idempotent, and clearDisconnectNotice removes it", () => {
    showDisconnectNotice();
    const el = _disconnectNoticeElement();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("Disconnected");

    showDisconnectNotice();
    expect(_disconnectNoticeElement()).toBe(el); // reused in place, not duplicated

    clearDisconnectNotice();
    expect(_disconnectNoticeElement()).toBeNull();
  });

  test("clearDisconnectNotice is a safe no-op when nothing is shown", () => {
    expect(() => clearDisconnectNotice()).not.toThrow();
    expect(_disconnectNoticeElement()).toBeNull();
  });

  test("it is orthogonal to the error and empty surfaces — all three coexist", () => {
    showError(new Error("boom"), 1);
    showEmptyNotice(2); // clears the error (they are mutually exclusive)...
    showDisconnectNotice(); // ...but the disconnect notice is independent
    expect(_emptyNoticeElement()).not.toBeNull();
    expect(_disconnectNoticeElement()).not.toBeNull();
    clearDisconnectNotice();
    expect(_emptyNoticeElement()).not.toBeNull(); // clearing one leaves the other
  });
});

describe("live search DOM (Story 5.3)", () => {
  function searchInput(): HTMLInputElement {
    return document.getElementById("ig-search-input") as HTMLInputElement;
  }

  function typeQuery(q: string): void {
    const input = searchInput();
    input.value = q;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function counterText(): string {
    return document.getElementById("ig-search-counter")!.textContent ?? "";
  }

  test("openSearch builds the box, focuses the input, and matches drive the shared ig-* classes", () => {
    openSearch();
    expect(_searchIsOpen()).toBe(true);
    expect(document.activeElement).toBe(searchInput());

    typeQuery("a");
    // Scope "both": total = 3 nodes + 2 edges; "a" matches node a + edge a->b.
    expect(counterText()).toBe("2/5");
    expect(classesOf("g-a")).toEqual(["ig-selected"]);
    expect(classesOf("g-ab")).toEqual(["ig-neighbor"]);
    expect(classesOf("g-b")).toEqual(["ig-dimmed"]);
    expect(classesOf("g-c")).toEqual(["ig-dimmed"]);
    expect(classesOf("g-bc")).toEqual(["ig-dimmed"]);
  });

  test("zero matches and empty query dim nothing (AC2)", () => {
    openSearch();
    typeQuery("zzz");
    expect(counterText()).toBe("0/5");
    for (const id of ["g-a", "g-b", "g-c", "g-ab", "g-bc"]) {
      expect(classesOf(id)).toEqual([]);
    }

    typeQuery("");
    expect(counterText()).toBe("0/5");
    expect(classesOf("g-a")).toEqual([]);
  });

  test("an invalid regex surfaces the error indication and never dims (AC3)", () => {
    openSearch();
    const regexToggle = document.getElementById("ig-search-regex") as HTMLInputElement;
    regexToggle.checked = true;
    typeQuery("(");
    expect(counterText()).toBe("invalid regex");
    expect(classesOf("g-a")).toEqual([]);
  });

  test("closing search restores the click-highlight selection (AC4/AC5 precedence)", () => {
    clickOn(el("g-c").querySelector("ellipse")!);
    openSearch();
    typeQuery("a");
    expect(classesOf("g-c")).toEqual(["ig-dimmed"]); // search owns the highlight

    closeSearch();
    expect(_searchIsOpen()).toBe(false);
    expect(searchInput().value).toBe("");
    expect(classesOf("g-c")).toEqual(["ig-selected"]); // selection restored
    expect(classesOf("g-b")).toEqual(["ig-neighbor"]);
  });

  test("Esc on the search input closes search without clearing the click selection", () => {
    clickOn(el("g-b").querySelector("ellipse")!);
    openSearch();
    typeQuery("c");
    searchInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(_searchIsOpen()).toBe(false);
    expect(_selectionSnapshot()).toEqual(["b"]);
    expect(classesOf("g-b")).toEqual(["ig-selected"]);
  });

  test("`/` opens search via the document keydown handler; ignored while typing", () => {
    expect(handleSearchKeydown(new KeyboardEvent("keydown", { key: "/", cancelable: true }))).toBe(true);
    expect(_searchIsOpen()).toBe(true);
    // Input is focused now — a second `/` must not be swallowed (it's typing).
    expect(handleSearchKeydown(new KeyboardEvent("keydown", { key: "/", cancelable: true }))).toBe(false);
  });

  test("search re-derives matches against the new SVG on the post-render boundary (AC5)", () => {
    openSearch();
    typeQuery("c");
    expect(counterText()).toBe("2/5"); // node c + edge b->c

    // Re-render rebuilds the subtree WITHOUT node c (live-reload removed it).
    const app = document.getElementById("app")!;
    app.innerHTML = FIXTURE_SVG;
    el("g-c").remove();
    el("g-bc").remove();
    _reapplyHighlightAfterRender();

    expect(counterText()).toBe("0/3");
    expect(classesOf("g-a")).toEqual([]); // zero matches → dims nothing
  });
});

describe("cursor-echo emphasis (Story 6.3)", () => {
  test("emphasizes exactly the matching node; last-wins; null clears", () => {
    applyCursorEmphasis("b");
    expect(classesOf("g-b")).toEqual(["ig-cursor"]);
    expect(classesOf("g-a")).toEqual([]);
    expect(_cursorEmphasisSnapshot()).toBe("b");

    applyCursorEmphasis("a"); // last-wins, no trail
    expect(classesOf("g-a")).toEqual(["ig-cursor"]);
    expect(classesOf("g-b")).toEqual([]);

    applyCursorEmphasis(null);
    for (const id of ["g-a", "g-b", "g-c"]) {
      expect(classesOf(id)).toEqual([]);
    }
    expect(_cursorEmphasisSnapshot()).toBeNull();
  });

  test("a nodeId with no matching node emphasizes nothing (miss ≡ clear)", () => {
    applyCursorEmphasis("b");
    applyCursorEmphasis("ghost");
    for (const id of ["g-a", "g-b", "g-c"]) {
      expect(classesOf(id)).toEqual([]);
    }
  });

  test("additive beneath click-highlight: both class regimes coexist untouched", () => {
    clickOn(el("g-a").querySelector("ellipse")!); // a selected, b neighbor, c dimmed
    applyCursorEmphasis("c");

    expect(classesOf("g-c")).toEqual(["ig-cursor", "ig-dimmed"]);
    expect(classesOf("g-a")).toEqual(["ig-selected"]);
    expect(classesOf("g-b")).toEqual(["ig-neighbor"]);
    expect(_selectionSnapshot()).toEqual(["a"]);
  });

  test("a click AFTER the emphasis keeps the cursor class (applyHighlightToDom never touches it)", () => {
    applyCursorEmphasis("c");
    clickOn(el("g-a").querySelector("ellipse")!);

    expect(classesOf("g-c")).toEqual(["ig-cursor", "ig-dimmed"]);
    // clearing the click leaves the cursor emphasis in place
    clickOn(document.getElementById("app")!.querySelector("svg")!);
    expect(classesOf("g-c")).toEqual(["ig-cursor"]);
  });

  test("survives a re-render via the post-render boundary; a pruned node reads as cleared", () => {
    applyCursorEmphasis("b");

    document.getElementById("app")!.innerHTML = FIXTURE_SVG; // d3 rebuilds the subtree
    expect(classesOf("g-b")).toEqual([]); // fresh subtree, class gone

    _reapplyHighlightAfterRender();
    expect(classesOf("g-b")).toEqual(["ig-cursor"]); // re-asserted

    el("g-b").remove(); // live-reload drops the node
    _reapplyHighlightAfterRender();
    const cursored = document.querySelectorAll(".ig-cursor");
    expect(cursored.length).toBe(0); // miss ≡ clear
    expect(_cursorEmphasisSnapshot()).toBe("b"); // stored id survives (last-wins)…

    document.getElementById("app")!.innerHTML = FIXTURE_SVG; // …so a render that
    _reapplyHighlightAfterRender(); // brings the node back re-emphasizes it
    expect(classesOf("g-b")).toEqual(["ig-cursor"]);
  });

  test("re-applies on the search-owned branch too (regimes independent)", () => {
    applyCursorEmphasis("c");
    openSearch();
    const input = document.getElementById("ig-search-input") as HTMLInputElement;
    input.value = "a";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    document.getElementById("app")!.innerHTML = FIXTURE_SVG;
    _reapplyHighlightAfterRender(); // search owns the highlight branch

    expect(classesOf("g-c")).toEqual(["ig-cursor", "ig-dimmed"]); // both regimes live
  });

  test("the stylesheet styles ig-cursor via stroke only — never element opacity", () => {
    applyCursorEmphasis("a"); // forces stylesheet injection
    const css = document.getElementById("ig-style")!.textContent ?? "";
    expect(css).toContain(".ig-cursor");
    expect(css).toContain("stroke: #4fc3f7");
    // No rule may set element opacity for the cursor class (stroke-opacity in
    // the pulse keyframes is fine — it breathes the outline, not the node).
    expect(css).not.toMatch(/ig-cursor[^{}]*\{[^}]*[^-]opacity\s*:/);
    // The precedence law is encoded in the selector: cursor yields to click/search.
    expect(css).toContain(".ig-cursor:not(.ig-selected):not(.ig-neighbor)");
    // Edge-line emphasis has its own rule, with the same yield law for edges.
    expect(css).toContain("g.edge.ig-cursor:not(.ig-neighbor)");
  });

  test("an edge key emphasizes the edge AND both endpoint nodes; last-wins; null clears", () => {
    applyCursorEmphasis("b->c");
    expect(classesOf("g-bc")).toEqual(["ig-cursor"]);
    expect(classesOf("g-b")).toEqual(["ig-cursor"]);
    expect(classesOf("g-c")).toEqual(["ig-cursor"]);
    expect(classesOf("g-a")).toEqual([]);
    expect(classesOf("g-ab")).toEqual([]);
    expect(_cursorEmphasisSnapshot()).toBe("b->c");

    applyCursorEmphasis("a"); // last-wins back to a plain node, no edge trail
    expect(classesOf("g-a")).toEqual(["ig-cursor"]);
    for (const id of ["g-b", "g-c", "g-ab", "g-bc"]) {
      expect(classesOf(id)).toEqual([]);
    }

    applyCursorEmphasis("a->b");
    expect(classesOf("g-ab")).toEqual(["ig-cursor"]);
    applyCursorEmphasis(null);
    for (const id of ["g-a", "g-b", "g-c", "g-ab", "g-bc"]) {
      expect(classesOf(id)).toEqual([]);
    }
  });

  test("an edge key with no matching live edge emphasizes nothing — not even nodes", () => {
    // a->c parses as an edge and both endpoints exist as nodes, but no such
    // edge is rendered: endpoints must NOT light without their edge (miss ≡ clear).
    applyCursorEmphasis("a->c");
    for (const id of ["g-a", "g-b", "g-c", "g-ab", "g-bc"]) {
      expect(classesOf(id)).toEqual([]);
    }
  });

  test("edge emphasis is additive beneath the click-highlight regime", () => {
    clickOn(el("g-a").querySelector("ellipse")!); // a selected, b neighbor, c + b->c dimmed
    applyCursorEmphasis("b->c");
    expect(classesOf("g-bc")).toEqual(["ig-cursor", "ig-dimmed"]);
    expect(classesOf("g-b")).toEqual(["ig-cursor", "ig-neighbor"]);
    expect(classesOf("g-c")).toEqual(["ig-cursor", "ig-dimmed"]);
  });

  test("edge emphasis survives a re-render via the post-render boundary", () => {
    applyCursorEmphasis("b->c");
    document.getElementById("app")!.innerHTML = FIXTURE_SVG; // d3 rebuilds the subtree
    _reapplyHighlightAfterRender();
    expect(classesOf("g-bc")).toEqual(["ig-cursor"]);
    expect(classesOf("g-b")).toEqual(["ig-cursor"]);
    expect(classesOf("g-c")).toEqual(["ig-cursor"]);
  });
});

describe("view toolbar (home / zoom-in / zoom-out)", () => {
  // No fixture render is needed: the toolbar attaches to <body> outside #app,
  // and the button code paths are guarded no-ops before the first real render
  // (no zoom behavior exists under happy-dom — exactly the pre-render state).

  test("install creates the toolbar with exactly 5 buttons, each with an icon and a tooltip", () => {
    installViewToolbar();
    const bar = _viewToolbarElement();
    expect(bar).not.toBeNull();
    const buttons = bar!.querySelectorAll("button");
    expect(buttons.length).toBe(5);
    for (const btn of buttons) {
      expect((btn.getAttribute("title") ?? "").length).toBeGreaterThan(0);
      // Each button carries an inline SVG icon that inherits the button color
      // (currentColor) — a hardcoded fill would vanish on the dark background.
      const svg = btn.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.outerHTML).toContain("currentColor");
      expect(svg!.outerHTML).not.toContain("#231815");
    }
    // The tooltips name the gesture twins (the discoverability contract).
    const titles = [...buttons].map((b) => b.getAttribute("title") ?? "");
    expect(titles[0]).toContain("0 or r");
    expect(titles[1]).toContain("Zoom in");
    expect(titles[2]).toContain("Zoom out");
    expect(titles[3]).toContain("Save as SVG");
    expect(titles[4]).toContain("interactive HTML");
  });

  test("double install is idempotent — still one toolbar, 5 buttons", () => {
    installViewToolbar();
    installViewToolbar();
    expect(document.querySelectorAll("#ig-view-toolbar").length).toBe(1);
    expect(_viewToolbarElement()!.querySelectorAll("button").length).toBe(5);
  });

  test("clicking every button before any render is a silent no-op (no throw)", () => {
    installViewToolbar();
    for (const btn of _viewToolbarElement()!.querySelectorAll("button")) {
      expect(() => clickOn(btn)).not.toThrow();
    }
  });

  test("zoomBy without a live zoom behavior does not throw", () => {
    expect(() => zoomBy(1.4)).not.toThrow();
    expect(() => zoomBy(1 / 1.4)).not.toThrow();
  });

  test("cursorPanNeeded: fully inside is false; crossing any edge is true", () => {
    const view = { left: 0, top: 0, right: 800, bottom: 600 };
    expect(cursorPanNeeded({ left: 10, top: 10, right: 50, bottom: 40 }, view)).toBe(false);
    expect(cursorPanNeeded({ left: -5, top: 10, right: 50, bottom: 40 }, view)).toBe(true);
    expect(cursorPanNeeded({ left: 10, top: -5, right: 50, bottom: 40 }, view)).toBe(true);
    expect(cursorPanNeeded({ left: 780, top: 10, right: 810, bottom: 40 }, view)).toBe(true);
    expect(cursorPanNeeded({ left: 10, top: 590, right: 50, bottom: 610 }, view)).toBe(true);
    expect(cursorPanNeeded({ left: 900, top: 700, right: 950, bottom: 750 }, view)).toBe(true);
    // A node larger than the viewport still pans — centering is the best framing.
    expect(cursorPanNeeded({ left: -100, top: -100, right: 900, bottom: 700 }, view)).toBe(true);
  });

  test("cursorPanNeeded: degenerate zero-area viewport (non-layout DOM) never pans", () => {
    const zero = { left: 0, top: 0, right: 0, bottom: 0 };
    expect(cursorPanNeeded({ left: 0, top: 0, right: 0, bottom: 0 }, zero)).toBe(false);
    expect(cursorPanNeeded({ left: 5, top: 5, right: 10, bottom: 10 }, zero)).toBe(false);
  });

  test("intersectRects: svg smaller than window → svg; svg overflowing → window; disjoint → empty", () => {
    const win = { left: 0, top: 0, right: 1000, bottom: 800 };
    const small = { left: 100, top: 100, right: 500, bottom: 400 };
    expect(intersectRects(small, win)).toEqual(small);
    const huge = { left: 0, top: 0, right: 9000, bottom: 3000 };
    expect(intersectRects(huge, win)).toEqual(win);
    const gone = { left: 2000, top: 0, right: 3000, bottom: 100 };
    const empty = intersectRects(gone, win);
    expect(empty.right - empty.left).toBeLessThanOrEqual(0);
    expect(cursorPanNeeded({ left: 0, top: 0, right: 10, bottom: 10 }, empty)).toBe(false);
  });

  test("viewCenterInViewBox maps the visible center from screen px to viewBox units", () => {
    // svg drawn at 2× its viewBox scale, offset by (-100, 50) on screen.
    const svgRect = { left: -100, top: 50, right: 1900, bottom: 1050 };
    const vb = { x: 0, y: 0, width: 1000, height: 500 };
    // Visible slice: window center at screen (400, 550) → svg-fraction (0.25, 0.5).
    const view = { left: -100, top: 50, right: 900, bottom: 1050 };
    expect(viewCenterInViewBox(view, svgRect, vb)).toEqual([250, 250]);
    // Degenerate geometry → null (caller falls back to the extent centroid).
    expect(viewCenterInViewBox(view, { left: 0, top: 0, right: 0, bottom: 0 }, vb)).toBeNull();
    expect(viewCenterInViewBox(view, svgRect, { x: 0, y: 0, width: 0, height: 0 })).toBeNull();
  });

  test("cursor emphasis on a matched node without a live zoom behavior does not throw (pan guard)", () => {
    expect(() => applyCursorEmphasis("a")).not.toThrow();
    expect(classesOf("g-a")).toEqual(["ig-cursor"]);
    // Clear and miss frames route through cancelCursorPan (stale-pan interrupt);
    // both must stay safe with no live zoom selection.
    expect(() => applyCursorEmphasis(null)).not.toThrow();
    expect(() => applyCursorEmphasis("no-such-node")).not.toThrow();
    expect(classesOf("g-a")).toEqual([]);
  });

  test("the error overlay clears the toolbar column (right offset > toolbar width)", () => {
    installViewToolbar();
    showError(new Error("boom"), 1);
    const overlay = _overlayElement()!;
    // Toolbar column ends 36px from the right edge (8px offset + 28px button);
    // 44px (VIEW_TOOLBAR_CLEARANCE_PX) leaves an 8px gutter.
    expect(overlay.style.right).toBe("44px");
    expect(_viewToolbarElement()!.style.right).toBe("8px");
  });

  test("toolbar is an accessible toolbar: role + aria-labels alongside tooltips", () => {
    installViewToolbar();
    const bar = _viewToolbarElement()!;
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect((bar.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
    for (const btn of bar.querySelectorAll("button")) {
      // aria-label mirrors title — the SVG icons are aria-hidden.
      expect(btn.getAttribute("aria-label")).toBe(btn.getAttribute("title"));
    }
  });
});

describe("save-as-SVG export (view toolbar)", () => {
  test("serializeGraphSvg returns null when nothing has rendered", () => {
    document.body.innerHTML = `<div id="app"></div>`;
    expect(serializeGraphSvg()).toBeNull();
  });

  test("export is a clean standalone document: prolog, namespace guard, no ig-* classes", () => {
    // Active click-highlight AND cursor emphasis put ig-* classes on the live SVG.
    clickOn(el("g-a").querySelector("ellipse")!);
    applyCursorEmphasis("c");
    expect(classesOf("g-a")).toEqual(["ig-selected"]);

    const source = serializeGraphSvg()!;
    expect(source).not.toBeNull();
    expect(source.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    // FIXTURE_SVG's root deliberately has no xmlns — this exercises the guard.
    expect(source).toContain('xmlns="http://www.w3.org/2000/svg"');
    // The drawn content is present; the transient emphasis state is not.
    expect(source).toContain("<title>a</title>");
    expect(source).toContain("b-&gt;c");
    expect(source).not.toContain("ig-");
    // Graphviz's own classes survive the scrub.
    expect(source).toContain('class="node"');

    // The clone-based scrub never touches the live SVG.
    expect(classesOf("g-a")).toEqual(["ig-selected"]);
    expect(classesOf("g-c")).toContain("ig-cursor");
  });

  test("saveGraphSvg before any render is a silent no-op (no throw, no anchor)", () => {
    document.body.innerHTML = `<div id="app"></div>`;
    expect(() => saveGraphSvg()).not.toThrow();
    expect(document.querySelector("a[download]")).toBeNull();
  });
});

describe("save-as-interactive-HTML export (view toolbar)", () => {
  const PAYLOAD = { dot: "digraph { a -> b }", engine: "dot", search: "?animate=0" };

  afterEach(() => {
    delete (window as unknown as { __igExport?: unknown }).__igExport;
  });

  test("assembled document: skeleton, payload before module bundle, app container", () => {
    const out = assembleInteractiveHtml("console.log(1);", PAYLOAD);
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('<main id="app"></main>');
    const payloadAt = out.indexOf("window.__igExport = ");
    const bundleAt = out.indexOf('<script type="module">console.log(1);</script>');
    expect(payloadAt).toBeGreaterThan(-1);
    expect(bundleAt).toBeGreaterThan(payloadAt);
  });

  test("payload embeds with every `<` escaped, and round-trips through JSON.parse", () => {
    const hostile = {
      dot: 'digraph { a [label="</script><script>alert(1)</script> <!-- ü"] }',
      engine: "neato",
      search: "?highlight_mode=downstream",
    };
    const out = assembleInteractiveHtml("var x = 1;", hostile);
    const json = out.slice(
      out.indexOf("window.__igExport = ") + "window.__igExport = ".length,
      out.indexOf(";</script>"),
    );
    // The raw payload text contains no `<` at all — it can never terminate the
    // script element or open an HTML comment, whatever the DOT contains.
    expect(json).not.toContain("<");
    expect(json).toContain("\\u003c");
    expect(JSON.parse(json)).toEqual(hostile);
  });

  test("bundle escaping: `</script` in any case is rewritten, case preserved, nothing else touched", () => {
    const bundle = 'var a = "</script>"; var b = "</SCRIPT>"; var c = "<script>";';
    const out = assembleInteractiveHtml(bundle, PAYLOAD);
    expect(out).toContain('var a = "<\\/script>";');
    expect(out).toContain('var b = "<\\/SCRIPT>";');
    // An OPENING <script in a string is harmless and must pass through untouched.
    expect(out).toContain('var c = "<script>";');
    // The only raw terminators left are the assembled document's two real ones.
    expect(out.match(/<\/script/gi)!.length).toBe(2);
  });

  test("readExportPayload validates: garbage shapes are null, minimal payload gets defaults", () => {
    const w = window as unknown as { __igExport?: unknown };
    expect(readExportPayload()).toBeNull();
    for (const garbage of [null, "digraph {}", 42, { engine: "dot" }, { dot: 7 }]) {
      w.__igExport = garbage;
      expect(readExportPayload()).toBeNull();
    }
    w.__igExport = { dot: "digraph {}" };
    expect(readExportPayload()).toEqual({ dot: "digraph {}", engine: "dot", search: "" });
    expect(isStaticExportPage()).toBe(true);
  });

  test("hasExportMarker: true for a present-but-corrupt payload, false with none", () => {
    const w = window as unknown as { __igExport?: unknown };
    expect(hasExportMarker()).toBe(false); // live preview: no marker at all
    w.__igExport = "digraph {}"; // marker present but malformed
    expect(hasExportMarker()).toBe(true);
    expect(readExportPayload()).toBeNull();
    // This pair (marker present, payload null) is what main.ts maps to the
    // corrupt-export error branch instead of the live WebSocket boot.
  });

  test("an exported page's toolbar omits the save-as-HTML button (4 buttons)", () => {
    (window as unknown as { __igExport?: unknown }).__igExport = PAYLOAD;
    installViewToolbar();
    const titles = [..._viewToolbarElement()!.querySelectorAll("button")].map(
      (b) => b.getAttribute("title") ?? "",
    );
    expect(titles.length).toBe(4);
    expect(titles.some((t) => t.includes("interactive HTML"))).toBe(false);
    // The SVG export stays available inside an exported page.
    expect(titles.some((t) => t.includes("Save as SVG"))).toBe(true);
  });

  test("saveInteractiveHtml before any render is a silent no-op (no throw, no anchor)", async () => {
    document.body.innerHTML = `<div id="app"></div>`;
    await expect(saveInteractiveHtml()).resolves.toBeUndefined();
    expect(document.querySelector("a[download]")).toBeNull();
  });
});

describe("theming (plan item #5)", () => {
  test("the stylesheet defines theme variables with a dark-scheme override block", () => {
    ensureAppStyle();
    const css = document.getElementById("ig-style")!.textContent ?? "";
    expect(css).toContain(":root");
    expect(css).toContain("--ig-canvas-bg");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    // The canvas background rides the variable so the page themes with the scheme.
    expect(css).toContain("body { background: var(--ig-canvas-bg); }");
  });

  test("the dark graph remap targets ONLY Graphviz's defaults, never user DOT colors", () => {
    ensureAppStyle();
    const css = document.getElementById("ig-style")!.textContent ?? "";
    // Defaults arrive as concrete attributes — remap by attribute VALUE...
    expect(css).toContain('#app svg [stroke="black"]');
    expect(css).toContain('#app svg [fill="black"]');
    expect(css).toContain('.graph > polygon[fill="white"]');
    // ...and default text has NO fill attribute, so the :not([fill]) guard is
    // what keeps fontcolor= text (an explicit fill attribute) untouched.
    expect(css).toContain("#app svg text:not([fill])");
    // No bare text rule: CSS properties beat presentation attributes in the
    // cascade, so `#app svg text {` would clobber every fontcolor= in the DOT.
    expect(css).not.toMatch(/#app svg text\s*\{/);
  });

  test("ensureAppStyle syncs html.ig-motion from the single animate gate", () => {
    setAnimate(true);
    ensureAppStyle();
    expect(document.documentElement.classList.contains("ig-motion")).toBe(true);
    setAnimate(false);
    ensureAppStyle();
    expect(document.documentElement.classList.contains("ig-motion")).toBe(false);
    setAnimate(true); // restore the default for other tests
  });
});
