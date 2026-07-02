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
