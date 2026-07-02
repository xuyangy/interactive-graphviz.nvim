import { GlobalRegistrator } from "@happy-dom/global-registrator";
// Register the DOM BEFORE importing render.ts helpers are exercised. render.ts
// itself is DOM-free at import time (verified by render.test.ts importing it
// with no DOM), so import hoisting above this call is safe.
GlobalRegistrator.register();

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _cursorEmphasisSnapshot,
  _emptyNoticeElement,
  _overlayElement,
  _reapplyHighlightAfterRender,
  _resetHighlightState,
  _resetSearchState,
  _searchIsOpen,
  _selectionSnapshot,
  _setLastGoodDot,
  applyCursorEmphasis,
  clearError,
  closeSearch,
  handleHighlightKeydown,
  handleSearchKeydown,
  installInteractionHandlers,
  nodeTitleFromClickTarget,
  openSearch,
  showEmptyNotice,
  showError,
} from "./render";
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
    // The emphasis stylesheet is injected exactly once.
    expect(document.getElementById("ig-highlight-style")).not.toBeNull();
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
    const css = document.getElementById("ig-highlight-style")!.textContent ?? "";
    expect(css).toContain(".ig-cursor");
    expect(css).toContain("stroke: #4fc3f7");
    // No rule may set element opacity for the cursor class (stroke-opacity in
    // the pulse keyframes is fine — it breathes the outline, not the node).
    expect(css).not.toMatch(/ig-cursor[^{}]*\{[^}]*[^-]opacity\s*:/);
    // The precedence law is encoded in the selector: cursor yields to click/search.
    expect(css).toContain(".ig-cursor:not(.ig-selected):not(.ig-neighbor)");
  });
});
