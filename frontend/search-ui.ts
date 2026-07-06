// search-ui.ts — the live-search box (Story 5.3). Extracted from render.ts
// (plan item #1b), built on the graph-dom bridge (#8a/#8b). The match MATH +
// scope/toggle logic + invalid-regex sentinel + config resolver are pure +
// unit-tested in search.ts; here we (1) build a compact fixed-position search
// box (#ig-search-box) the same idempotent, inline-styled way as the overlays,
// (2) install the document-level `/` open keybinding, (3) run the pure matcher
// against the LIVE SVG model (the SAME extractModelFromApp click-highlight
// uses), and (4) apply matches through the SHARED applyHighlightToDom — no
// parallel ig-search-* class regime (AC5). Emphasis is a cheap class/opacity
// toggle, no graph re-render (NFR-7). No d3: render.ts remains the only
// module that imports d3-graphviz.
//
// Precedence (AC5): while the search box is OPEN with a non-empty query, search
// owns the highlight. Closing/clearing search restores the click-highlight
// selection state (re-run recomputeAndApplyHighlight). The two share the single
// applyHighlightToDom regime and never stack two fighting class sets. The
// post-render half of this precedence is registered with emphasis.ts via
// setSearchReapplyHook (bottom of this file) — that import direction
// (search-ui → emphasis) keeps the module graph acyclic.

import {
  computeSearchMatches,
  getSearchConfig,
  isSearchScope,
  searchResultToHighlightSet,
  shouldCloseSearch,
  shouldOpenSearch,
  type SearchOpts,
} from "./search";
import { extractModelFromApp } from "./graph-dom";
import { ensureAppStyle } from "./style";
import {
  applyHighlightToDom,
  recomputeAndApplyHighlight,
  setSearchReapplyHook,
} from "./emphasis";

const SEARCH_BOX_ID = "ig-search-box";
// Whether the search box is currently open (drives precedence + re-apply on
// live-reload). When open with a non-empty query, search owns the highlight.
let _searchOpen = false;

/** Read the live search options from the in-memory config + UI toggle state. */
function currentSearchOpts(): SearchOpts {
  const base = getSearchConfig();
  const box = document.getElementById(SEARCH_BOX_ID);
  if (!box) return base;
  const caseEl = box.querySelector<HTMLInputElement>("#ig-search-case");
  const regexEl = box.querySelector<HTMLInputElement>("#ig-search-regex");
  const scopeEl = box.querySelector<HTMLSelectElement>("#ig-search-scope");
  return {
    caseSensitive: caseEl ? caseEl.checked : base.caseSensitive,
    regex: regexEl ? regexEl.checked : base.regex,
    scope: scopeEl && isSearchScope(scopeEl.value) ? scopeEl.value : base.scope,
  };
}

/** Read the current query string from the search box input (empty when closed). */
function currentSearchQuery(): string {
  const input = document.getElementById("ig-search-input") as HTMLInputElement | null;
  return input?.value ?? "";
}

/**
 * Run the pure matcher against the live SVG model and apply the matches through
 * the shared applyHighlightToDom, updating the N/total counter and the invalid-
 * regex error indication. A non-empty query owns the highlight (AC5 precedence);
 * an empty query / zero matches dims nothing (AC2) and restores the click-
 * highlight selection so closing search leaves the prior selection intact.
 */
function runSearch(): void {
  const query = currentSearchQuery();
  const opts = currentSearchOpts();
  const model = extractModelFromApp();
  const result = computeSearchMatches(model, query, opts);

  updateSearchCounter(result.count, result.total, result.valid);

  if (result.empty) {
    // Empty query: search owns nothing — restore the click-highlight selection
    // (or cleared state) so the two never fight (AC5 precedence).
    recomputeAndApplyHighlight();
    return;
  }
  // Non-empty query owns the highlight while the box is open.
  applyHighlightToDom(searchResultToHighlightSet(result));
}

/** Update the `N/total` counter element and the invalid-regex indication. */
function updateSearchCounter(count: number, total: number, valid: boolean): void {
  const counter = document.getElementById("ig-search-counter");
  if (!counter) return;
  if (!valid) {
    counter.textContent = "invalid regex";
    counter.style.color = "var(--ig-error-fg)";
    return;
  }
  counter.textContent = `${count}/${total}`;
  counter.style.color = count === 0 ? "var(--ig-counter-zero-fg)" : "var(--ig-counter-fg)";
}

// The search box CSS (#ig-search-box layout, input/label/select treatment,
// counter) lives in styles.css — one build-time-inlined stylesheet injected
// via ensureAppStyle() (plan item #2).

/**
 * Build (idempotent) the compact fixed-position search box: a text input, an
 * N/total counter, and case-sensitive + regex toggles + a scope select. Mirrors
 * the inline-styled, idempotent (getElementById guard) overlay pattern of
 * showError/showEmptyNotice — but this one needs pointer-events:auto and a
 * focusable input. Returns the box element.
 */
function buildSearchBox(): HTMLElement {
  ensureAppStyle();
  let box = document.getElementById(SEARCH_BOX_ID);
  if (box) return box;
  box = document.createElement("div");
  box.id = SEARCH_BOX_ID;

  const input = document.createElement("input");
  input.type = "text";
  input.id = "ig-search-input";
  input.placeholder = "search nodes / edges…";
  input.setAttribute("aria-label", "search graph");
  input.addEventListener("input", () => runSearch());
  // Esc on the input closes/clears search FIRST (AC4). Handling it here (and
  // stopping propagation) keeps the document-level click-highlight Esc-clear from
  // also firing — shouldClearHighlight already skips while an INPUT is focused.
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (shouldCloseSearch(e)) {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
    }
  });

  const counter = document.createElement("span");
  counter.id = "ig-search-counter";
  counter.textContent = "0/0";

  const opts = getSearchConfig();

  const caseLabel = document.createElement("label");
  caseLabel.title = "case-sensitive";
  const caseBox = document.createElement("input");
  caseBox.type = "checkbox";
  caseBox.id = "ig-search-case";
  caseBox.checked = opts.caseSensitive;
  caseBox.addEventListener("change", () => runSearch());
  caseLabel.append(caseBox, document.createTextNode("Aa"));

  const regexLabel = document.createElement("label");
  regexLabel.title = "regular expression";
  const regexBox = document.createElement("input");
  regexBox.type = "checkbox";
  regexBox.id = "ig-search-regex";
  regexBox.checked = opts.regex;
  regexBox.addEventListener("change", () => runSearch());
  regexLabel.append(regexBox, document.createTextNode(".*"));

  const scopeSel = document.createElement("select");
  scopeSel.id = "ig-search-scope";
  for (const s of ["both", "nodes", "edges"]) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s;
    if (s === opts.scope) o.selected = true;
    scopeSel.appendChild(o);
  }
  scopeSel.addEventListener("change", () => runSearch());

  box.append(input, counter, caseLabel, regexLabel, scopeSel);
  document.body.appendChild(box);
  return box;
}

/** Open the search box (build if needed) and focus the input (AC1). */
export function openSearch(): void {
  const box = buildSearchBox();
  box.style.display = "flex";
  _searchOpen = true;
  const input = document.getElementById("ig-search-input") as HTMLInputElement | null;
  if (input) {
    input.focus();
    input.select();
  }
  runSearch();
}

/**
 * Close the search box and clear its highlight/dim (AC4). Every element returns
 * to full opacity by restoring the click-highlight selection state (which is the
 * cleared state when nothing is click-selected). Precedence (AC5): closing search
 * hands the highlight back to click-highlight.
 */
export function closeSearch(): void {
  const box = document.getElementById(SEARCH_BOX_ID);
  if (box) box.style.display = "none";
  const input = document.getElementById("ig-search-input") as HTMLInputElement | null;
  if (input) {
    input.value = "";
    input.blur();
  }
  _searchOpen = false;
  // Restore click-highlight selection (or cleared state) — search no longer owns
  // the highlight. This shares the single applyHighlightToDom regime (AC5).
  recomputeAndApplyHighlight();
}

/** Handle a document-level keydown for `/`-to-open search (AC1). */
export function handleSearchKeydown(e: KeyboardEvent): boolean {
  if (!shouldOpenSearch(e, document.activeElement?.tagName)) return false;
  e.preventDefault(); // don't type the slash into anything / trigger find
  openSearch();
  return true;
}

/**
 * Install the document-level `/`-open keybinding once. Idempotent (guarded flag)
 * so re-imports / HMR / a duplicate startup call do not stack listeners. Mirrors
 * installResetKeybinding / installInteractionHandlers.
 */
let _searchKeyInstalled = false;
export function installSearchHandlers(): void {
  if (_searchKeyInstalled) return;
  _searchKeyInstalled = true;
  document.addEventListener("keydown", handleSearchKeydown);
}

/**
 * Re-apply search after a successful render (AC5 — live-reload interop). Called
 * from emphasis.ts's reapplyHighlightAfterRender (via the registered hook) on
 * the per-render SUCCESS boundary only. Returns true when search owned the
 * highlight (so click-highlight re-apply is skipped this render); false when
 * search is closed/empty (click-highlight re-apply proceeds as before).
 * Re-derives matches against the NEW SVG.
 */
function reapplySearchAfterRender(): boolean {
  if (!_searchOpen) return false;
  const query = currentSearchQuery();
  if (query.trim().length === 0) return false; // empty: click-highlight owns
  runSearch(); // re-derives matches against the new SVG + updates counter
  return true;
}

// Register the post-render precedence hook with emphasis.ts at module init —
// the search-ui → emphasis import direction keeps the graph acyclic, and the
// hook's no-op default means emphasis works standalone if this module is
// never loaded.
setSearchReapplyHook(reapplySearchAfterRender);

// ── Search test seams ─────────────────────────────────────────────────────────
/** True when the search box is open. Production code never calls this. */
export function _searchIsOpen(): boolean {
  return _searchOpen;
}

/** Force-close search + reset config. Tests only. */
export function _resetSearchState(): void {
  closeSearch();
  const box = document.getElementById(SEARCH_BOX_ID);
  if (box) box.parentNode?.removeChild(box);
  _searchOpen = false;
}
