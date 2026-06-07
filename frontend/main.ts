import type { ProtocolMessage } from "./protocol";
import { createWebSocketClient } from "./ws";
import { queueRender, showError, showEmptyNotice, clearEmptyNotice } from "./render";
import { isBlankDot } from "./dot";

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
  // session_closed is stash/log-only until Story 1.7.
});

// Expose the stash for debugging / future render wiring.
(window as unknown as { __igEnvelopes?: ProtocolMessage[] }).__igEnvelopes = lastEnvelopes;
