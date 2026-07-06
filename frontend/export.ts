// export.ts — save-as-SVG and save-as-interactive-HTML (the view toolbar's two
// download buttons) plus the static-export payload the exported page boots
// from. Extracted from render.ts as pure code motion (plan item #1a): nothing
// here touches d3 — the live SVG is read via querySelector and the last-good
// DOT comes through render.ts's lastGoodRenderState() accessor. render.ts
// remains the only module that imports d3-graphviz.

import { showError } from "./overlays";
import { lastGoodRenderState } from "./render";
import { currentConfigSearch } from "./urlconfig";

/**
 * Serialize the live rendered graph as a standalone SVG document string, or
 * null when nothing has rendered yet. Works on a CLONE — the on-screen SVG is
 * never touched. The export is the clean graph as drawn (WYSIWYG, including
 * the current zoom/pan transform): the plugin's transient `ig-*` emphasis
 * classes are stripped (their stylesheet lives in <head> and would not ship
 * with the file), Graphviz's own classes stay, and the root gets xmlns /
 * xmlns:xlink injected when missing plus an XML prolog — the proven pattern
 * from vscode-interactive-graphviz's content/save.js.
 */
export function serializeGraphSvg(): string | null {
  const svg = document.querySelector("#app svg");
  if (!svg) return null;
  const clone = svg.cloneNode(true) as Element;
  // querySelectorAll excludes the clone root — include it explicitly.
  for (const el of [clone, ...clone.querySelectorAll("[class]")]) {
    const classes = el.getAttribute("class");
    if (classes == null) continue;
    const kept = classes.split(/\s+/).filter((c) => c.length > 0 && !c.startsWith("ig-"));
    if (kept.length === 0) el.removeAttribute("class");
    else el.setAttribute("class", kept.join(" "));
  }
  let source = new XMLSerializer().serializeToString(clone);
  if (!/^<svg[^>]*\sxmlns=(['"])http:\/\/www\.w3\.org\/2000\/svg\1/.test(source)) {
    source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (!/^<svg[^>]*\sxmlns:xlink=/.test(source)) {
    source = source.replace(/^<svg/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + source;
}

/**
 * Download the current graph as `graph.svg` (the buffer's filename never
 * reaches the frontend — only config params ride the preview URL). Silent
 * no-op before the first render; guarded so a Blob/object-URL quirk can
 * never take the preview down.
 */
export function saveGraphSvg(): void {
  try {
    const source = serializeGraphSvg();
    if (source === null) return;
    const blob = new Blob([source], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "graph.svg";
    // Firefox needs the anchor in the document for a synthetic click.
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("interactive-graphviz: saveGraphSvg failed", err);
  }
}

// ── Save as interactive HTML (single-file export) ─────────────────────────────
// The preview build is fully self-contained — one JS bundle, every stylesheet
// JS-injected — so a standalone interactive export is just: the trivial page
// skeleton + an embedded {dot, engine, search} payload + the bundle inlined.
// On load, main.ts sees the payload ("static export mode"), re-renders the
// graph through the bundled WASM engine, and never opens a WebSocket — zoom,
// highlight, search and the SVG export keep working offline because they ARE
// the same code. Neovim-coupled features (jump-on-click, cursor echo) are
// inert by construction: no sender is ever registered and no emphasize frames
// arrive.

/** The payload an exported page boots from (`window.__igExport`). */
export interface ExportPayload {
  /** The DOT source to render — the preview's lastGoodDot at export time. */
  dot: string;
  /** Layout engine; defaults to "dot" when absent/invalid in the payload. */
  engine: string;
  /**
   * The interactivity config in force at export time as a whitelisted query
   * string (currentConfigSearch: the boot URL's config params overlaid with
   * every live config_update), so the exported page re-applies the SAME
   * effective config through the existing applyUrlConfig path while the live
   * session's sessionId/token never enter the file.
   */
  search: string;
}

/**
 * Read and validate `window.__igExport`. Returns null unless `dot` is a
 * string (the one load-bearing field); engine/search fall back to safe
 * defaults so a hand-edited payload degrades instead of throwing. On null,
 * main.ts consults hasExportMarker() to tell a corrupt export (fail inert)
 * apart from a normal live preview (WebSocket boot).
 */
export function readExportPayload(): ExportPayload | null {
  if (typeof window === "undefined") return null;
  const raw = (window as unknown as { __igExport?: unknown }).__igExport;
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.dot !== "string") return null;
  return {
    dot: o.dot,
    engine: typeof o.engine === "string" && o.engine.length > 0 ? o.engine : "dot",
    search: typeof o.search === "string" ? o.search : "",
  };
}

/** True when this page IS an exported file (booted from an embedded payload). */
export function isStaticExportPage(): boolean {
  return readExportPayload() !== null;
}

/**
 * True when a `window.__igExport` marker is present at all — even one too
 * malformed for readExportPayload() to accept. main.ts uses this to keep a
 * corrupt exported file from falling through to the live WebSocket boot:
 * under file:// `location.host` is empty, so the WebSocket constructor would
 * throw synchronously and take the page down instead of failing inert.
 * Own-property check, not `!== undefined`: a hand-corrupted
 * `window.__igExport = undefined` is still a present marker (corrupt export),
 * not a live preview.
 */
export function hasExportMarker(): boolean {
  if (typeof window === "undefined") return false;
  return Object.prototype.hasOwnProperty.call(window, "__igExport");
}

/**
 * Assemble the standalone interactive HTML document. Pure string assembly —
 * no DOM, no fetch — so it is unit-testable; saveInteractiveHtml is the
 * DOM/fetch wrapper (mirroring the serializeGraphSvg/saveGraphSvg split).
 *
 * Escaping is the correctness-critical part (the HTML parser scans raw script
 * content for terminators):
 *  - the JSON payload embeds with EVERY `<` escaped as `<` — a JS string
 *    escape, so the parsed value is byte-identical while `</script>`/`<!--`
 *    can never appear in the raw text;
 *  - the bundle is arbitrary JS code, so only the terminator sequence is
 *    rewritten: `</script` → `<\/script` (case preserved via capture). That
 *    sequence can only occur inside JS strings/regex/comments, where `\/`
 *    means `/` — the standard inline-bundle escape.
 *
 * The skeleton mirrors frontend/index.html (charset/viewport + `<main
 * id="app">`); the payload rides a classic script that runs before the
 * inlined `type="module"` bundle (modules are deferred, classics are not, so
 * the ordering holds regardless).
 */
export function assembleInteractiveHtml(bundleSource: string, payload: ExportPayload): string {
  const payloadJs = JSON.stringify(payload).replace(/</g, "\\u003c");
  const inlineBundle = bundleSource.replace(/<\/(script)/gi, "<\\/$1");
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "  <head>\n" +
    '    <meta charset="utf-8">\n' +
    '    <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "    <title>graph — interactive-graphviz export</title>\n" +
    "  </head>\n" +
    "  <body>\n" +
    '    <main id="app"></main>\n' +
    `    <script>window.__igExport = ${payloadJs};</script>\n` +
    `    <script type="module">${inlineBundle}</script>\n` +
    "  </body>\n" +
    "</html>\n"
  );
}

/**
 * Download the current graph as a self-contained interactive `graph.html`.
 * Embeds the last GOOD dot (exactly what the stash holds — an error overlay
 * on screen does not change what exports) plus the page's own bundle, fetched
 * via its <script src>. Silent no-op before the first successful render or
 * when no external bundle script exists (i.e. inside an exported page, where
 * the button is hidden anyway); guarded so a fetch/Blob quirk can never take
 * the preview down — but a fetch that FAILS surfaces on the error overlay,
 * because the user just clicked a button and deserves better than a silent
 * nothing.
 */
export async function saveInteractiveHtml(): Promise<void> {
  try {
    const { dot, engine } = lastGoodRenderState();
    if (dot === null) return;
    const payload: ExportPayload = {
      dot,
      engine,
      // The EFFECTIVE config, not window.location.search: urlconfig.ts
      // accumulates the whitelisted params across the boot URL and every
      // live config_update, so an export after a live push carries the
      // config actually in force. The whitelist also keeps sessionId + the
      // per-session auth token out of the shareable file, as before.
      search: currentConfigSearch(),
    };
    // Prefer the app's own module bundle over an arbitrary script[src]: a
    // browser extension or injected tool can add a classic script before the
    // app's, and inlining THAT would produce a broken standalone file. The
    // skeleton (index.html / bun's build output) carries exactly one
    // type="module" script; the bare [src] fallback keeps a nonstandard
    // embedding working.
    const bundleScript =
      document.querySelector<HTMLScriptElement>('script[type="module"][src]') ??
      document.querySelector<HTMLScriptElement>("script[src]");
    if (!bundleScript || !bundleScript.src) return;
    const resp = await fetch(bundleScript.src);
    if (!resp.ok) {
      // Surface the failure — with only a console.warn, the toolbar button
      // silently "does nothing" unless devtools are open.
      console.warn("interactive-graphviz: bundle fetch failed", resp.status);
      showError(`export failed — could not fetch the app bundle (HTTP ${resp.status})`, 0);
      return;
    }
    const html = assembleInteractiveHtml(await resp.text(), payload);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "graph.html";
    // Firefox needs the anchor in the document for a synthetic click.
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("interactive-graphviz: saveInteractiveHtml failed", err);
    showError(`export failed — ${err instanceof Error ? err.message : String(err)}`, 0);
  }
}
