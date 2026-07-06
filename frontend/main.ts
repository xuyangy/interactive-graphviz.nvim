import type { ProtocolMessage } from "./protocol";
import { createWebSocketClient } from "./ws";
import { queueRender, installResetKeybinding } from "./render";
import { installInteractionHandlers, applyCursorEmphasis } from "./emphasis";
import { installSearchHandlers } from "./search-ui";
import { ensureAppStyle } from "./style";
import {
  showError,
  showEmptyNotice,
  clearEmptyNotice,
  showDisconnectNotice,
  clearDisconnectNotice,
} from "./overlays";
import { installViewToolbar } from "./toolbar";
import { readExportPayload, hasExportMarker } from "./export";
import { isBlankDot } from "./dot";
import { setNodeClickSender } from "./sync";
import { applyUrlConfig } from "./urlconfig";

// Static export mode: an exported single-file page (saveInteractiveHtml)
// carries `window.__igExport = {dot, engine, search}`. When a valid payload
// exists, the page boots from it — same config path, same handlers, one local
// render — and never opens a WebSocket. A marker that is present but garbage
// means a corrupt exported file: fail inert with an error overlay (see the
// boot branch below), never the live boot.
const exportPayload = readExportPayload();

// Resolve the interactivity config from the preview URL FIRST — this ordering
// is load-bearing: the search box reads getSearchConfig() at build time and the
// first render consults the animate/preserve_view gates, so applyUrlConfig must
// run before any handler installation. commands.lua appends the validated
// setup() keys (preserve_view / highlight_mode / animate / search_*) as query
// params; applyUrlConfig feeds the existing clamping setters. Absent params
// (legacy URL) make no setter calls — defaults identical to today. In static
// export mode the query string was captured at export time and rides the
// payload (an exported file's own URL carries no params). The typeof guard
// only makes THIS line safe outside a browser; the rest of main.ts still
// requires a DOM (it is only ever bundled for the preview page).
applyUrlConfig(
  exportPayload !== null
    ? exportPayload.search
    : typeof window !== "undefined"
      ? window.location.search
      : "",
);

// Theming (plan item #5) — inject the app stylesheet at boot, not just lazily
// on first highlight/search: the canvas background (body { background:
// var(--ig-canvas-bg) }), the dark-mode graph remap, and the theme variables
// the overlays/toolbar cssText references all must be live before the first
// render or overlay. Idempotent, and the later lazy calls stay as-is.
ensureAppStyle();

// Story 5.1 — install the document-level reset-to-fit keybinding (`0` / `r`)
// once at startup. Scroll=zoom and drag=pan are provided by d3-graphviz's
// built-in d3-zoom (enabled by default); we only add the reset affordance.
// The keydown handler is exported from render.ts so the d3 import stays there.
installResetKeybinding();

// Story 5.2 — install click-to-highlight + Esc-to-clear once at startup. Click a
// node to highlight its neighbors (per highlight_mode), Shift+click to multi-
// select, Alt+click to add the node's cluster, Esc / empty-canvas click to
// clear. The handlers are exported from render.ts so the d3 import stays there;
// highlight_mode defaults to "bidirectional" and any setup() override arrives
// via the applyUrlConfig call above.
installInteractionHandlers();

// Story 5.3 — install the document-level `/`-to-open live-search keybinding once
// at startup. Press `/` to open a compact search box; type to filter (matches
// highlight, non-matches dim), with case-sensitive + regex toggles, a scope
// select (nodes/edges/both), an N/total result counter, and `Esc` to close/clear.
// Search reuses click-highlight's SVG model extraction + the shared
// applyHighlightToDom emphasis regime; the handler is exported from render.ts so
// the d3 import stays there. Search defaults are frontend-local and any setup()
// override arrives via the applyUrlConfig call above (still zero wire surface).
installSearchHandlers();

// View toolbar — clickable home / zoom-in / zoom-out at the top-right for
// users who prefer buttons over gestures. Each button wraps the same code path
// as its gesture twin (`0`/`r` reset, scroll/double-click zoom); toolbar.ts
// calls into render.ts's zoom handlers so the d3 import stays there. In static
// export mode the save-as-HTML button is omitted (toolbar.ts gates it).
installViewToolbar();

if (exportPayload !== null) {
  // Static export mode: one local render from the embedded payload; no
  // WebSocket, no click-sender (emitNodeClick stays the safe startup no-op).
  // Blank DOT gets the same informational notice the live path shows.
  if (isBlankDot(exportPayload.dot)) {
    showEmptyNotice(0);
  } else {
    queueRender(exportPayload.dot, exportPayload.engine, 1);
  }
} else if (hasExportMarker()) {
  // A present-but-malformed __igExport means this IS an exported file whose
  // payload got corrupted (hand-edited, truncated). Never fall through to the
  // live boot: opened from disk (file://) location.host is empty, so
  // createWebSocketClient would build ws:/// and the WebSocket constructor
  // throws synchronously, crashing the page. Fail visibly and inert instead.
  showError("corrupt export payload — re-export the graph from the live preview", 0);
} else {
  // Debug stash: the most recent inbound envelopes, kept for inspection via
  // window.__igEnvelopes. Capped at the last MAX_STASHED_ENVELOPES — render
  // envelopes carry the full DOT text, so an uncapped array is a slow memory
  // leak over a long editing session on a large graph.
  const MAX_STASHED_ENVELOPES = 50;
  const lastEnvelopes: ProtocolMessage[] = [];

  // Keep the handle so Story 1.7 can call wsClient.close() for graceful teardown.
  const _wsClient = createWebSocketClient({
    onMessage(msg) {
      lastEnvelopes.push(msg);
      if (lastEnvelopes.length > MAX_STASHED_ENVELOPES) lastEnvelopes.shift();
      console.debug("interactive-graphviz: received envelope", msg);
    },
    onConnectionChange(connected) {
      // A dropped socket must not leave the preview silently stale: show a cue
      // while ws.ts reconnects with backoff, and clear it once reconnected.
      if (connected) clearDisconnectNotice();
      else showDisconnectNotice();
    },
    onAuthRejected() {
      // Terminal (fires after onConnectionChange(false) put up the reconnecting
      // cue): the token is stale — the server that minted this URL is gone —
      // so ws.ts has stopped retrying. Replace the cue with the way out.
      showDisconnectNotice("Session expired — reopen the preview from Neovim");
    },
    onRender(msg) {
      const dot = msg.dot as string | undefined;
      const engine = (msg.engine as string | undefined) ?? "dot";
      const v = (msg.v as number | undefined) ?? 0;
      if (isBlankDot(dot)) {
        // Empty/whitespace DOT: show a non-blocking notice instead of silently
        // dropping the message (which left the user staring at a blank preview).
        // Do NOT queueRender — advancing the render-lock/v with a non-render would
        // be wrong; a later real render (higher v) clears this and draws normally.
        showEmptyNotice(v);
      } else {
        clearEmptyNotice();
        queueRender(dot as string, engine, v);
      }
    },
    onErrorDisplay(msg) {
      const message = msg.message as string | undefined;
      const v = (msg.v as number | undefined) ?? 0;
      showError(message ?? "unknown error", v);
    },
    onEmphasize(msg) {
      // Story 6.3 — cursor-echo emphasis: nodeId is a string to emphasize or
      // null to clear (the one sanctioned wire null). Anything else is a
      // malformed frame — ignore it rather than clearing on garbage. Never
      // touches `v`, never queues a render (emphasize is transient last-wins).
      const nodeId = msg.nodeId;
      if (typeof nodeId === "string" || nodeId === null) applyCursorEmphasis(nodeId);
    },
    // session_closed is stash/log-only until Story 1.7.
  });

  // Story 6.2 — wire the graph→buffer sync seam: render.ts's click handler calls
  // emitNodeClick(title), which forwards through this sender (gated by
  // sync_jump_on_click via the applyUrlConfig call above). Registered AFTER the
  // client exists; before this line emitNodeClick is a safe no-op.
  setNodeClickSender((nodeId) => _wsClient.sendNodeClick(nodeId));

  // Expose the stash for debugging / future render wiring.
  (window as unknown as { __igEnvelopes?: ProtocolMessage[] }).__igEnvelopes = lastEnvelopes;
}
