import { WS_CLOSE_AUTH_REJECTED, type ProtocolMessage } from "./protocol";

// Inbound-envelope callbacks. The frontend dispatches by `type`; in this story it
// only stashes/logs envelopes (no DOM render — Story 1.4).
export interface WebSocketClientHandlers {
  onRender?: (msg: ProtocolMessage) => void;
  onErrorDisplay?: (msg: ProtocolMessage) => void;
  onSessionClosed?: (msg: ProtocolMessage) => void;
  /** Story 6.3 — cursor-echo emphasis: nodeId string emphasizes, null clears. */
  onEmphasize?: (msg: ProtocolMessage) => void;
  onMessage?: (msg: ProtocolMessage) => void;
  /**
   * Fired whenever the live connection opens (true) or drops (false). The
   * preview uses this to surface a "disconnected — reconnecting…" cue so a
   * server restart or dropped socket never leaves the graph silently stale.
   */
  onConnectionChange?: (connected: boolean) => void;
  /**
   * Fired when the server closes the socket with WS_CLOSE_AUTH_REJECTED — the
   * hello token is bad or stale (tokens die with the server). Terminal: the
   * client stops reconnecting (retrying would re-send the same stale hello
   * forever); the page must be reopened from Neovim to get a fresh URL.
   */
  onAuthRejected?: () => void;
}

export interface WebSocketClientOptions {
  /**
   * Backoff schedule (ms) for auto-reconnect after an UNEXPECTED socket close.
   * The client retries on each entry in turn; once past the last entry the final
   * delay repeats indefinitely. A successful open resets the schedule to the
   * start. An empty array disables reconnect entirely.
   */
  reconnectDelaysMs?: number[];
  /** Timer seam — tests inject a controllable timer. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Cancels a handle returned by setTimer. Defaults to clearTimeout. */
  clearTimer?: (handle: unknown) => void;
}

// Reconnect backoff: quick first retries for a blip, capped at 10s for a
// server that stays down. The last delay repeats until the socket comes back.
const DEFAULT_RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10000];

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
 *
 * When the page has no host (a file opened from disk, e.g. an exported
 * graph.html so truncated that its payload script vanished and main.ts saw no
 * export marker), returns a permanently-inert client without constructing a
 * socket: `new WebSocket("ws:///")` would throw synchronously and take the
 * page down.
 */
export function createWebSocketClient(
  handlers: WebSocketClientHandlers = {},
  options: WebSocketClientOptions = {},
): WebSocketClient {
  const client: WebSocketClient = {
    connected: false,
    close: () => {},
    sendNodeClick: () => false,
  };
  if (window.location.host === "") return client;
  const { sessionId, token } = readConnectParams();

  const reconnectDelays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  // `socket` is reassigned on every (re)connect; sendNodeClick and close read
  // whichever socket is current at call time.
  let socket: WebSocket;
  let reconnectAttempt = 0;
  let reconnectTimer: unknown = null;
  let intentionallyClosed = false;

  const scheduleReconnect = (): void => {
    if (reconnectDelays.length === 0) return;
    const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)]!;
    reconnectAttempt += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  function connect(): void {
    socket = new WebSocket(wsUrl());

    socket.addEventListener("open", () => {
      client.connected = true;
      reconnectAttempt = 0; // fresh backoff budget for the next drop
      if (sessionId !== null && token !== null) {
        const hello: ProtocolMessage = {
          type: "hello",
          sessionId: Number(sessionId),
          token,
        };
        socket.send(JSON.stringify(hello));
      }
      handlers.onConnectionChange?.(true);
    });

    socket.addEventListener("close", (event: CloseEvent) => {
      client.connected = false;
      handlers.onConnectionChange?.(false);
      // Auth rejection is terminal: the server closed us for a bad/stale hello
      // token (tokens die with the server), so reconnecting would re-send the
      // same stale hello forever. Surface it and stop.
      if (event.code === WS_CLOSE_AUTH_REJECTED) {
        handlers.onAuthRejected?.();
        return;
      }
      // A server restart or dropped socket must not leave the preview silently
      // stale — retry with backoff. Suppressed only when WE closed the socket
      // (graceful teardown), so an intentional close does not thrash-reconnect.
      if (!intentionallyClosed) scheduleReconnect();
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
  }

  client.close = () => {
    intentionallyClosed = true;
    if (reconnectTimer !== null) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
    socket.close();
  };

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

  connect();
  return client;
}
