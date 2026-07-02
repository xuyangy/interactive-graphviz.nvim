import type { ProtocolMessage } from "./protocol";

// Inbound-envelope callbacks. The frontend dispatches by `type`; in this story it
// only stashes/logs envelopes (no DOM render — Story 1.4).
export interface WebSocketClientHandlers {
  onRender?: (msg: ProtocolMessage) => void;
  onErrorDisplay?: (msg: ProtocolMessage) => void;
  onSessionClosed?: (msg: ProtocolMessage) => void;
  /** Story 6.3 — cursor-echo emphasis: nodeId string emphasizes, null clears. */
  onEmphasize?: (msg: ProtocolMessage) => void;
  onMessage?: (msg: ProtocolMessage) => void;
}

export interface WebSocketClient {
  connected: boolean;
  close: () => void;
  /**
   * Send a `node_click{sessionId,nodeId}` frame (Story 6.2). Returns false —
   * and sends nothing — before the socket is open or when the URL sessionId is
   * missing/non-numeric. The envelope carries EXACTLY type/sessionId/nodeId:
   * never `v` (render-only token), never `token` (hello-only), no extra keys.
   */
  sendNodeClick: (nodeId: string) => boolean;
}

interface ConnectParams {
  sessionId: string | null;
  token: string | null;
}

// Read the session/token the browser was opened with (Story 1.4 mints the URL).
function readConnectParams(): ConnectParams {
  const params = new URLSearchParams(window.location.search);
  return { sessionId: params.get("sessionId"), token: params.get("token") };
}

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/`;
}

/**
 * Open a live WebSocket to the server, authenticate with `hello{sessionId,token}`
 * on open, and dispatch inbound envelopes by `type` to the provided handlers.
 * The envelope is never redefined here — types come from `frontend/protocol.ts`.
 */
export function createWebSocketClient(handlers: WebSocketClientHandlers = {}): WebSocketClient {
  const client: WebSocketClient = {
    connected: false,
    close: () => {},
    sendNodeClick: () => false,
  };
  const { sessionId, token } = readConnectParams();

  const socket = new WebSocket(wsUrl());
  client.close = () => socket.close();

  client.sendNodeClick = (nodeId: string): boolean => {
    if (!client.connected) return false;
    if (typeof nodeId !== "string" || nodeId.length === 0) return false;
    // Strict decimal digits only: Number() would also accept "1e3"/"0x10"/
    // whitespace, silently widening the tamper surface (review finding).
    if (sessionId === null || !/^\d+$/.test(sessionId)) return false;
    const numericSessionId = Number(sessionId);
    // Exact three-key envelope — the server drops node_click frames with any
    // other shape (hasExactlyKeys), so adding a key here is a silent outage.
    const msg: ProtocolMessage = {
      type: "node_click",
      sessionId: numericSessionId,
      nodeId,
    };
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // A CLOSING socket still reports connected until the close event lands;
      // a click must never throw out of the DOM handler over a lost frame.
      return false;
    }
    return true;
  };

  socket.addEventListener("open", () => {
    client.connected = true;
    if (sessionId !== null && token !== null) {
      const hello: ProtocolMessage = {
        type: "hello",
        sessionId: Number(sessionId),
        token,
      };
      socket.send(JSON.stringify(hello));
    }
  });

  socket.addEventListener("close", () => {
    client.connected = false;
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    let msg: ProtocolMessage;
    try {
      msg = JSON.parse(String(event.data)) as ProtocolMessage;
    } catch {
      // Ignore a malformed frame — never throw across the connection.
      return;
    }
    handlers.onMessage?.(msg);
    switch (msg.type) {
      case "render":
        handlers.onRender?.(msg);
        break;
      case "error_display":
        handlers.onErrorDisplay?.(msg);
        break;
      case "session_closed":
        handlers.onSessionClosed?.(msg);
        break;
      case "emphasize":
        handlers.onEmphasize?.(msg);
        break;
      default:
        // Unrecognized inbound type: ignored (channel stays warm).
        break;
    }
  });

  return client;
}
