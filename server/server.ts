import { getHealth } from "./health";
import { PROTOCOL_VERSION, WS_CLOSE_AUTH_REJECTED, type ProtocolMessage } from "./protocol";
import { staticAssetRoot } from "./static";
import { SessionRegistry, type SocketData, type Subscriber } from "./sessions";
import { encodeLine, LineBuffer } from "./stdio";

export function bundledFrontendEntry(): unknown {
  return staticAssetRoot();
}

// Backstop only. The primary no-orphan signal is stdin EOF (the OS closes the
// child's stdin when the parent Neovim dies, including `kill -9`). The heartbeat
// catches the rare case where the pipe stays open but Neovim has gone silent.
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 6000;

export function heartbeatTimeoutMs(): number {
  const raw = process.env.IG_HEARTBEAT_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEARTBEAT_TIMEOUT_MS;
}

// Reads the bind address from the environment. Defaults to loopback (NFR-4).
// The Lua config enforces the security invariant: IG_BIND is only "0.0.0.0"
// when expose_to_lan=true is explicitly set.
export function resolveBindAddress(): string {
  return process.env.IG_BIND ?? "127.0.0.1";
}

// Reads the listen port from the environment. 0 = ephemeral (Bun picks a free
// port and reports it back in the ready announcement). Returns 0 on bad input.
export function resolvePort(): number {
  const raw = process.env.IG_PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

// Diagnostics go to stderr; stdout is the protocol channel.
function diag(message: string): void {
  console.error(`interactive-graphviz server: ${message}`);
}

function writeStdout(message: ProtocolMessage): void {
  process.stdout.write(encodeLine(message));
}

function hasExactlyKeys(message: ProtocolMessage, keys: string[]): boolean {
  const actual = Object.keys(message).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

// Guarded send so one dead socket can't throw across a broadcast loop.
function safeSend(ws: Subscriber, payload: string): void {
  try {
    ws.send(payload);
  } catch (err) {
    diag(`ws send failed: ${String(err)}`);
  }
}

export function main(): number {
  void bundledFrontendEntry();

  const sessions = new SessionRegistry();

  // The per-start token minted below; enforced in `hello`. Captured by closure so
  // the websocket handlers can validate without re-reading process state.
  const token = crypto.randomUUID();

  const bindAddress = resolveBindAddress();

  const server = Bun.serve<SocketData, undefined>({
    hostname: bindAddress, // NFR-4: loopback by default; 0.0.0.0 only when Lua config sets expose_to_lan=true
    port: resolvePort(), // 0 = ephemeral; the real port is read back below
    // Static frontend served through the `static.ts` HTML-bundle seam (binary-
    // friendly: same path under `bun run` and a `--compile` binary).
    routes: {
      "/": staticAssetRoot(),
      // Observability-only JSON diagnostics (AC 8). Never writes to stdout; the
      // protocol stdout channel is untouched. Does not affect `/` or WS upgrade.
      "/health": (_req, srv) =>
        Response.json(
          getHealth({ port: srv.port ?? 0, bind: bindAddress, sessions: sessions.size }),
        ),
    },
    fetch(req, srv) {
      // WebSocket upgrade is performed here (Bun's contract): return undefined on
      // a successful upgrade. The socket is created UN-subscribed; subscription
      // happens only on a valid `hello`.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = srv.upgrade<SocketData>(req, {
          data: { subscribed: false },
        });
        if (upgraded) {
          return undefined;
        }
        return new Response("upgrade failed", { status: 400 });
      }
      // Non-WS, non-route requests: nothing else is served in v1.
      return new Response(null, { status: 404 });
    },
    websocket: {
      open() {
        // Held un-subscribed until a valid `hello` arrives.
      },
      message(ws, raw) {
        handleWsMessage(ws, raw);
      },
      close(ws) {
        // Remove from the session's subscriber set (mutation lives in sessions.ts).
        if (typeof ws.data.sessionId === "number") {
          sessions.unsubscribe(ws.data.sessionId, ws);
          ws.data.subscribed = false;
        }
      },
    },
  });

  // One JSON object per WS frame (no NDJSON inside a frame). Dispatches on `type`;
  // one malformed/unknown frame is logged + ignored and never throws.
  function handleWsMessage(ws: Subscriber, raw: string | Buffer): void {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let msg: ProtocolMessage;
    try {
      msg = JSON.parse(text) as ProtocolMessage;
    } catch {
      diag(`unparseable ws frame ignored: ${text}`);
      return;
    }
    switch (msg.type) {
      case "hello": {
        const sessionId = msg.sessionId;
        const supplied = (msg as { token?: unknown }).token;
        if (typeof sessionId !== "number" || supplied !== token) {
          // Missing/wrong token (or no session) → reject: close, do NOT subscribe.
          // The app-level close code marks this terminal so the frontend stops
          // auto-reconnecting instead of re-sending the same stale hello forever.
          diag("hello rejected: invalid token or session");
          try {
            ws.close(WS_CLOSE_AUTH_REJECTED, "invalid token or session");
          } catch {
            // already closing
          }
          return;
        }
        // If this socket was already subscribed (e.g. a re-`hello` to a
        // different session), drop the prior subscription first so it can never
        // keep receiving the old session's renders — never cross sessions (AC1).
        if (typeof ws.data.sessionId === "number" && ws.data.sessionId !== sessionId) {
          sessions.unsubscribe(ws.data.sessionId, ws);
        }
        const session = sessions.subscribe(sessionId, ws);
        ws.data.sessionId = sessionId;
        ws.data.subscribed = true;
        // Replay the last cleanly-relayed render to a browser that connects after
        // the first fan-out (cold-open race). `lastGoodRender` is the last render
        // envelope that was cleanly dispatched by the server (Story 1.6).
        if (session.lastGoodRender) {
          safeSend(ws, JSON.stringify(session.lastGoodRender));
        }
        break;
      }
      case "ack":
        // Warm-channel liveness only — no v1 feature behavior beyond keeping the
        // channel alive. (Story 1.5 owns real `v` semantics.)
        break;
      case "node_click": {
        // Story 6.1: activate the return channel. Only a subscribed, token-validated
        // socket may originate inbound events — `ws.data.subscribed` flips true only
        // after a valid `hello` (token + numeric sessionId).
        if (!ws.data.subscribed || typeof ws.data.sessionId !== "number") {
          diag("node_click from un-subscribed socket ignored");
          break;
        }
        // No cross-session injection: the frame's sessionId must be the socket's
        // bound session. Then relay VERBATIM to Lua over stdout (byte-shape
        // preserved; no `v` minted). The Lua handler logs-and-ignores in 6.1.
        if (msg.sessionId !== ws.data.sessionId) {
          diag("node_click sessionId mismatch ignored");
          break;
        }
        if (!sessions.has(ws.data.sessionId)) {
          diag("node_click for closed session ignored");
          break;
        }
        if (!hasExactlyKeys(msg, ["type", "sessionId", "nodeId"]) || typeof msg.nodeId !== "string") {
          diag("node_click malformed payload ignored");
          break;
        }
        writeStdout(msg);
        break;
      }
      default:
        // Any other/unrecognized inbound type: log + ignore (channel stays warm
        // without growing v1 surface). Never throws across the connection.
        diag(`ignoring inbound ws message type=${String(msg.type)}`);
    }
  }

  writeStdout({ type: "ready", port: server.port, token });
  diag(`ready protocol=${PROTOCOL_VERSION} port=${server.port}`);

  const timeoutMs = heartbeatTimeoutMs();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function shutdown(code = 0): void {
    if (stopped) {
      return;
    }
    stopped = true;
    if (watchdog) {
      clearTimeout(watchdog);
    }
    try {
      server.stop(true);
    } catch {
      // best-effort; we are exiting anyway
    }
    process.exit(code);
  }

  function armWatchdog(): void {
    if (watchdog) {
      clearTimeout(watchdog);
    }
    watchdog = setTimeout(() => {
      diag("heartbeat timeout; exiting");
      shutdown(0);
    }, timeoutMs);
  }

  function handleMessage(message: ProtocolMessage): void {
    switch (message.type) {
      case "session_open":
        if (typeof message.sessionId === "number") {
          sessions.register(message.sessionId);
        }
        break;
      case "session_close":
        if (typeof message.sessionId === "number") {
          sessions.unregister(message.sessionId);
        }
        break;
      case "render": {
        // Relay the SAME envelope verbatim to exactly this session's subscribers.
        // Never cross sessions; unknown session or zero subscribers is a silent
        // no-op (not an error). Do NOT mint/mutate `v` here — it is carried as-is
        // from the Neovim source (Story 1.5 owns the policy).
        if (typeof message.sessionId === "number") {
          const payload = JSON.stringify(message); // one JSON object per WS frame
          for (const ws of sessions.subscribersOf(message.sessionId)) {
            safeSend(ws, payload);
          }
          // Store for replay to late-connecting browsers (cold-open race fix).
          sessions.setLastGoodRender(message.sessionId, message);
        }
        break;
      }
      case "ping":
        writeStdout({ type: "pong" });
        break;
      case "emphasize": {
        // Story 6.1: forward-relay a transient highlight to exactly this session's
        // subscribers (like `render`, but NOT stored as lastGoodRender — emphasize
        // is transient, not a replayable render). `subscribersOf` is structurally
        // single-session, so this never crosses sessions. No `v` minted/carried.
        if (typeof message.sessionId === "number") {
          if (
            !hasExactlyKeys(message, ["type", "sessionId", "nodeId"]) ||
            !(typeof message.nodeId === "string" || message.nodeId === null)
          ) {
            diag("emphasize malformed payload ignored");
            break;
          }
          const payload = JSON.stringify(message); // one JSON object per WS frame
          for (const ws of sessions.subscribersOf(message.sessionId)) {
            safeSend(ws, payload);
          }
        }
        break;
      }
      case "shutdown":
        shutdown(0);
        break;
      default:
        diag(`ignoring message type=${String(message.type)}`);
    }
  }

  armWatchdog();

  void (async () => {
    const decoder = new TextDecoder();
    const buffer = new LineBuffer();
    try {
      for await (const chunk of Bun.stdin.stream()) {
        armWatchdog(); // any stdin traffic counts as liveness
        for (const line of buffer.push(decoder.decode(chunk, { stream: true }))) {
          let parsed: ProtocolMessage;
          try {
            parsed = JSON.parse(line) as ProtocolMessage;
          } catch {
            diag(`bad json line dropped: ${line}`);
            continue;
          }
          handleMessage(parsed);
        }
      }
    } catch (err) {
      diag(`stdin error: ${String(err)}`);
    }
    // stdin closed (EOF) → parent gone → self-terminate. This is the load-bearing
    // no-orphan guarantee (survives `kill -9` of the parent).
    diag("stdin EOF; exiting");
    shutdown(0);
  })();

  return 0;
}

if (import.meta.main) {
  main();
}
