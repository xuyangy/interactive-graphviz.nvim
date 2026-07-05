export type MessageType =
  | "session_open"
  | "render"
  | "set_engine"
  | "session_close"
  | "ping"
  | "shutdown"
  | "ready"
  | "pong"
  | "log"
  | "error_display"
  | "session_closed"
  | "hello"
  | "ack"
  | "node_click"
  | "emphasize";

export interface ProtocolMessage {
  type: MessageType;
  sessionId?: number;
  v?: number;
  // node_click: nodeId is set; emphasize: nodeId is set, or null to clear.
  // Sync messages never carry `v` (render-only token).
  nodeId?: string | null;
  [key: string]: unknown;
}

export const PROTOCOL_VERSION = 1;

// App-level WebSocket close code (4000-4999 range) sent when a `hello` is
// rejected for a bad/stale token or session. The token is minted per server
// start, so this is terminal for the page that sent it: the frontend must NOT
// auto-reconnect (it would re-send the same stale hello forever) — it tells
// the user to reopen the preview instead. A plain network drop closes with a
// standard code and stays retryable.
export const WS_CLOSE_AUTH_REJECTED = 4001;
