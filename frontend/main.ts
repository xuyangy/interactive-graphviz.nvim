import type { ProtocolMessage } from "./protocol";
import { createWebSocketClient } from "./ws";
import {
  queueRender,
  showError,
  showEmptyNotice,
  clearEmptyNotice,
  installResetKeybinding,
  installInteractionHandlers,
  installSearchHandlers,
  applyCursorEmphasis,
} from "./render";
import { isBlankDot } from "./dot";
import { setNodeClickSender } from "./sync";
import { applyUrlConfig } from "./urlconfig";

// Resolve the interactivity config from the preview URL FIRST — this ordering
// is load-bearing: the search box reads getSearchConfig() at build time and the
// first render consults the animate/preserve_view gates, so applyUrlConfig must
// run before any handler installation. commands.lua appends the validated
// setup() keys (preserve_view / highlight_mode / animate / search_*) as query
// params; applyUrlConfig feeds the existing clamping setters. Absent params
// (legacy URL) make no setter calls — defaults identical to today. The typeof
// guard only makes THIS line safe outside a browser; the rest of main.ts still
// requires a DOM (it is only ever bundled for the preview page).
applyUrlConfig(typeof window !== "undefined" ? window.location.search : "");

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

// Debug stash: all inbound envelopes are kept here for inspection.
// Intentional — reviewed and dismissed in Story 1.3 code review.
const lastEnvelopes: ProtocolMessage[] = [];

// Keep the handle so Story 1.7 can call wsClient.close() for graceful teardown.
const _wsClient = createWebSocketClient({
  onMessage(msg) {
    lastEnvelopes.push(msg);
    console.debug("interactive-graphviz: received envelope", msg);
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
