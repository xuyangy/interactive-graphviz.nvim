import { describe, expect, test } from "bun:test";

const SERVER = `${import.meta.dir}/server.ts`;

interface Ready {
  type: string;
  port: number;
  token: string;
}

// Spawn the real server and read its `ready{port,token}` announcement. Mirrors
// the supervisor.test.ts live-server idiom; always kill in `finally`.
async function spawnServer(): Promise<{ proc: Bun.Subprocess; ready: Ready }> {
  const proc = Bun.spawn(["bun", "run", SERVER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, IG_HEARTBEAT_TIMEOUT_MS: "10000" },
  });
  const ready = JSON.parse(await readFirstLine(proc.stdout!, 8000)) as Ready;
  return { proc, ready };
}

async function readFirstLine(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const nl = buf.indexOf("\n");
      if (nl >= 0) return buf.slice(0, nl);
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error("no line received before timeout");
}

// Continuing stdout line reader: keeps one reader open on the child's stdout and
// surfaces NDJSON lines AFTER the `ready` line that spawnServer already consumed.
// Needed to observe the browser->server->Lua return channel (frames the server
// writes to stdout in response to inbound WS messages, e.g. a relayed node_click).
// spawnServer's readFirstLine calls reader.releaseLock() (not cancel) and nothing
// else is written to stdout at startup, so a fresh getReader() here loses nothing.
function makeStdoutLineStream(stream: ReadableStream<Uint8Array>): Record<string, unknown>[] {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const lines: Record<string, unknown>[] = [];
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
    } catch {
      // stream closed on proc.kill(); the test is already finishing.
    }
  })();
  return lines;
}

// Open a WS, collecting every inbound frame (parsed) into `received`.
async function openSocket(port: number): Promise<{ ws: WebSocket; received: Record<string, unknown>[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const received: Record<string, unknown>[] = [];
  ws.addEventListener("message", (e) => {
    received.push(JSON.parse(String((e as MessageEvent).data)) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  return { ws, received };
}

function writeLine(proc: Bun.Subprocess, obj: unknown): void {
  (proc.stdin as { write: (s: string) => void }).write(`${JSON.stringify(obj)}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("message protocol + WebSocket relay", () => {
  test("contract round-trip: Lua stdin -> server -> WS envelope is structurally identical", async () => {
    const { proc, ready } = await spawnServer();
    try {
      expect(ready.type).toBe("ready");

      // Serve the static frontend over HTTP (no bare 503).
      const httpRes = await fetch(`http://127.0.0.1:${ready.port}/`);
      expect(httpRes.status).toBe(200);
      const html = await httpRes.text();
      expect(html).toContain('id="app"');

      const { ws, received } = await openSocket(ready.port);
      ws.send(JSON.stringify({ type: "hello", sessionId: 3, token: ready.token }));
      await sleep(100);

      // The exact envelope Lua/stdin emits (camelCase keys, single `v`, snake_case type).
      const sent = { type: "render", v: 42, sessionId: 3, engine: "dot", dot: "digraph{a->b}" };
      writeLine(proc, sent);
      await sleep(250);

      expect(received.length).toBe(1);
      const got = received[0]!;
      // Structurally identical on both hops — byte-shape preserved.
      expect(JSON.stringify(got)).toBe(JSON.stringify(sent));
      expect(got.type).toBe("render");
      expect(Object.keys(got).sort()).toEqual(["dot", "engine", "sessionId", "type", "v"]);
      expect(got).not.toHaveProperty("data"); // no {data:…} wrapping
      for (const k of Object.keys(got)) {
        expect(got[k]).not.toBeNull(); // no null for absent fields
      }
      ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("token rejection: a hello with a wrong/missing token is closed and never receives a render", async () => {
    const { proc, ready } = await spawnServer();
    try {
      // Wrong token.
      const bad = await openSocket(ready.port);
      let closed = false;
      bad.ws.addEventListener("close", () => {
        closed = true;
      });
      bad.ws.send(JSON.stringify({ type: "hello", sessionId: 3, token: "not-the-token" }));
      await sleep(200);
      expect(closed).toBe(true);

      // Missing token.
      const missing = await openSocket(ready.port);
      let missingClosed = false;
      missing.ws.addEventListener("close", () => {
        missingClosed = true;
      });
      missing.ws.send(JSON.stringify({ type: "hello", sessionId: 3 }));
      await sleep(200);
      expect(missingClosed).toBe(true);

      // A render for that session must not reach the rejected sockets.
      writeLine(proc, { type: "render", v: 1, sessionId: 3, engine: "dot", dot: "g" });
      await sleep(200);
      expect(bad.received.length).toBe(0);
      expect(missing.received.length).toBe(0);
    } finally {
      proc.kill();
    }
  }, 20000);

  test("per-session isolation: a render for session A reaches only A's socket", async () => {
    const { proc, ready } = await spawnServer();
    try {
      const a = await openSocket(ready.port);
      const b = await openSocket(ready.port);
      a.ws.send(JSON.stringify({ type: "hello", sessionId: 1, token: ready.token }));
      b.ws.send(JSON.stringify({ type: "hello", sessionId: 2, token: ready.token }));
      await sleep(150);

      writeLine(proc, { type: "render", v: 7, sessionId: 1, engine: "dot", dot: "A" });
      await sleep(250);

      expect(a.received.length).toBe(1);
      expect((a.received[0] as { dot: string }).dot).toBe("A");
      expect(b.received.length).toBe(0); // never crosses sessions

      a.ws.close();
      b.ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("render to a session with zero subscribers is a silent no-op", async () => {
    const { proc, ready } = await spawnServer();
    try {
      // Subscribe to session 1 only; broadcast to unknown session 99.
      const a = await openSocket(ready.port);
      a.ws.send(JSON.stringify({ type: "hello", sessionId: 1, token: ready.token }));
      await sleep(150);

      writeLine(proc, { type: "render", v: 1, sessionId: 99, engine: "dot", dot: "X" });
      await sleep(200);
      expect(a.received.length).toBe(0);

      // Server still alive and still relays to a real subscriber afterward.
      writeLine(proc, { type: "render", v: 2, sessionId: 1, engine: "dot", dot: "Y" });
      await sleep(200);
      expect(a.received.length).toBe(1);
      a.ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("unknown/garbage inbound frame is logged+ignored and does not break the connection", async () => {
    const { proc, ready } = await spawnServer();
    try {
      const a = await openSocket(ready.port);
      a.ws.send(JSON.stringify({ type: "hello", sessionId: 1, token: ready.token }));
      await sleep(120);

      // Unknown type + malformed JSON — neither should tear the socket down.
      a.ws.send(JSON.stringify({ type: "totally_unknown", foo: 1 }));
      a.ws.send("{not valid json");
      a.ws.send(JSON.stringify({ type: "ack", v: 7 })); // dormant warm-channel ack
      await sleep(150);

      // The subscription survives: a subsequent render still arrives.
      writeLine(proc, { type: "render", v: 9, sessionId: 1, engine: "dot", dot: "Z" });
      await sleep(200);
      expect(a.received.length).toBe(1);
      expect((a.received[0] as { dot: string }).dot).toBe("Z");
      a.ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("close handler removes the socket from the set without disturbing co-session subscribers", async () => {
    const { proc, ready } = await spawnServer();
    try {
      // Two sockets on the SAME session: closing A must remove only A from the
      // set, while B keeps receiving. Asserting B still gets exactly one frame
      // proves the broadcast loop survived A's removal (not merely that a dead
      // socket received nothing).
      const a = await openSocket(ready.port);
      const b = await openSocket(ready.port);
      a.ws.send(JSON.stringify({ type: "hello", sessionId: 5, token: ready.token }));
      b.ws.send(JSON.stringify({ type: "hello", sessionId: 5, token: ready.token }));
      await sleep(150);
      a.ws.close();
      await sleep(150);

      writeLine(proc, { type: "render", v: 1, sessionId: 5, engine: "dot", dot: "gone" });
      await sleep(200);
      expect(a.received.length).toBe(0); // removed from the set
      expect(b.received.length).toBe(1); // co-session subscriber unaffected
      expect((b.received[0] as { dot: string }).dot).toBe("gone");
      b.ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("cold-open replay: render sent before browser connects is replayed on subscribe", async () => {
    // Mirrors the real :GraphvizPreview order: render flushed at `ready`, THEN
    // the browser opens and subscribes. Without replay-on-subscribe the first
    // render is silently dropped (AC2 would fail with a blank page).
    const { proc, ready } = await spawnServer();
    try {
      writeLine(proc, { type: "session_open", sessionId: 7 });
      const sent = { type: "render", v: 1, sessionId: 7, engine: "dot", dot: "digraph{cold->open}" };
      writeLine(proc, sent);
      await sleep(150); // render arrives before any browser exists

      // Now the browser connects and authenticates.
      const { ws, received } = await openSocket(ready.port);
      ws.send(JSON.stringify({ type: "hello", sessionId: 7, token: ready.token }));
      await sleep(200);

      // The cold render must have been replayed on subscribe.
      expect(received.length).toBe(1);
      expect(received[0]).toMatchObject({ type: "render", dot: "digraph{cold->open}", v: 1 });

      // A subsequent render is also received (normal live path still works).
      const sent2 = { type: "render", v: 2, sessionId: 7, engine: "dot", dot: "digraph{live->render}" };
      writeLine(proc, sent2);
      await sleep(150);
      expect(received.length).toBe(2);
      expect(received[1]).toMatchObject({ dot: "digraph{live->render}" });

      ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("cold-open replay: only the LAST render is replayed (not all historical)", async () => {
    const { proc, ready } = await spawnServer();
    try {
      writeLine(proc, { type: "session_open", sessionId: 8 });
      writeLine(proc, { type: "render", v: 1, sessionId: 8, engine: "dot", dot: "digraph{first}" });
      writeLine(proc, { type: "render", v: 2, sessionId: 8, engine: "dot", dot: "digraph{second}" });
      await sleep(150);

      const { ws, received } = await openSocket(ready.port);
      ws.send(JSON.stringify({ type: "hello", sessionId: 8, token: ready.token }));
      await sleep(200);

      // Only the last render replayed, not both.
      expect(received.length).toBe(1);
      expect(received[0]).toMatchObject({ dot: "digraph{second}", v: 2 });
      ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("re-hello to a new session drops the prior subscription (no cross-session leak)", async () => {
    const { proc, ready } = await spawnServer();
    try {
      // One socket subscribes to session 1, then re-`hello`s to session 2.
      const a = await openSocket(ready.port);
      a.ws.send(JSON.stringify({ type: "hello", sessionId: 1, token: ready.token }));
      await sleep(120);
      a.ws.send(JSON.stringify({ type: "hello", sessionId: 2, token: ready.token }));
      await sleep(120);

      // A render for the OLD session must NOT reach this socket anymore.
      writeLine(proc, { type: "render", v: 1, sessionId: 1, engine: "dot", dot: "OLD" });
      await sleep(200);
      expect(a.received.length).toBe(0);

      // A render for the NEW session still reaches it (exactly once — no dupes).
      writeLine(proc, { type: "render", v: 2, sessionId: 2, engine: "dot", dot: "NEW" });
      await sleep(200);
      expect(a.received.length).toBe(1);
      expect((a.received[0] as { dot: string }).dot).toBe("NEW");
      a.ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  // --- Story 6.1: return-channel protocol spine (node_click + emphasize) ---

  test("contract round-trip: node_click WS -> server -> Lua stdout envelope is structurally identical", async () => {
    const { proc, ready } = await spawnServer();
    const luaInbox = makeStdoutLineStream(proc.stdout!); // frames the server emits to Lua
    try {
      const { ws } = await openSocket(ready.port);
      ws.send(JSON.stringify({ type: "hello", sessionId: 3, token: ready.token }));
      await sleep(100);

      // The exact envelope the browser emits on a node click (Story 6.2 sends it
      // for real). camelCase fields, snake_case type, NO `v` (render-only token).
      const sent = { type: "node_click", sessionId: 3, nodeId: "n1" };
      ws.send(JSON.stringify(sent));
      await sleep(250);

      // Exactly one frame crossed to the Lua channel for this session.
      expect(luaInbox.length).toBe(1);
      const got = luaInbox[0]!;
      // Relayed verbatim — byte-shape preserved on the WS->stdout hop; no re-wrap.
      expect(JSON.stringify(got)).toBe(JSON.stringify(sent));
      expect(got.type).toBe("node_click");
      expect(Object.keys(got).sort()).toEqual(["nodeId", "sessionId", "type"]);
      expect(got).not.toHaveProperty("data"); // no {data:…} wrapping
      expect(got).not.toHaveProperty("v"); // sync messages never carry `v`
      ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("contract round-trip: emphasize Lua stdin -> server -> WS envelope is structurally identical", async () => {
    const { proc, ready } = await spawnServer();
    try {
      const { ws, received } = await openSocket(ready.port);
      ws.send(JSON.stringify({ type: "hello", sessionId: 4, token: ready.token }));
      await sleep(100);

      // Lua emits emphasize to highlight a node in the browser. NO `v`.
      const sent = { type: "emphasize", sessionId: 4, nodeId: "n1" };
      writeLine(proc, sent);
      await sleep(250);

      expect(received.length).toBe(1);
      const got = received[0]!;
      // One identical envelope shape on the stdin->WS hop — byte-shape preserved.
      expect(JSON.stringify(got)).toBe(JSON.stringify(sent));
      expect(got.type).toBe("emphasize");
      expect(Object.keys(got).sort()).toEqual(["nodeId", "sessionId", "type"]);
      expect(got).not.toHaveProperty("v");
      ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("emphasize with nodeId:null (clear) relays the explicit null verbatim", async () => {
    const { proc, ready } = await spawnServer();
    try {
      const { ws, received } = await openSocket(ready.port);
      ws.send(JSON.stringify({ type: "hello", sessionId: 4, token: ready.token }));
      await sleep(100);

      // `null` is the one sanctioned wire-null: it is a VALUE (clear emphasis), not
      // an absent field, so it must survive the hop. The render contract's per-key
      // not.toBeNull() guard deliberately does NOT apply here.
      const sent = { type: "emphasize", sessionId: 4, nodeId: null };
      writeLine(proc, sent);
      await sleep(250);

      expect(received.length).toBe(1);
      const got = received[0]!;
      expect(JSON.stringify(got)).toBe(JSON.stringify(sent));
      expect(got.nodeId).toBeNull();
      ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("emphasize with malformed/non-contract payloads is not relayed", async () => {
    const { proc, ready } = await spawnServer();
    try {
      const { ws, received } = await openSocket(ready.port);
      ws.send(JSON.stringify({ type: "hello", sessionId: 4, token: ready.token }));
      await sleep(100);

      writeLine(proc, { type: "emphasize", sessionId: 4 });
      writeLine(proc, { type: "emphasize", sessionId: 4, nodeId: ["n1"] });
      writeLine(proc, { type: "emphasize", sessionId: 4, nodeId: "n1", v: 99 });
      writeLine(proc, { type: "emphasize", sessionId: 4, nodeId: "n1", data: {} });
      await sleep(250);

      expect(received.length).toBe(0);

      const valid = { type: "emphasize", sessionId: 4, nodeId: "ok" };
      writeLine(proc, valid);
      await sleep(250);
      expect(received.length).toBe(1);
      expect(JSON.stringify(received[0])).toBe(JSON.stringify(valid));
      ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("rejection: node_click from an un-subscribed/invalid socket is NOT relayed to Lua", async () => {
    const { proc, ready } = await spawnServer();
    const luaInbox = makeStdoutLineStream(proc.stdout!);
    try {
      // (a) never sent a valid hello — socket is open but UN-subscribed.
      const unsub = await openSocket(ready.port);
      unsub.ws.send(JSON.stringify({ type: "node_click", sessionId: 3, nodeId: "x" }));
      await sleep(200);
      expect(luaInbox.length).toBe(0); // un-subscribed click never crosses to Lua

      // (b) hello rejected for a bad token -> socket closed -> still no relay.
      const bad = await openSocket(ready.port);
      let closed = false;
      bad.ws.addEventListener("close", () => {
        closed = true;
      });
      bad.ws.send(JSON.stringify({ type: "hello", sessionId: 3, token: "not-the-token" }));
      await sleep(200);
      expect(closed).toBe(true);
      try {
        bad.ws.send(JSON.stringify({ type: "node_click", sessionId: 3, nodeId: "y" }));
      } catch {
        // socket already closed — expected
      }
      await sleep(200);
      expect(luaInbox.length).toBe(0);

      // Control: a properly-subscribed socket's node_click DOES relay exactly once,
      // proving the zeros above are real rejection, not a dead return channel.
      const good = await openSocket(ready.port);
      good.ws.send(JSON.stringify({ type: "hello", sessionId: 3, token: ready.token }));
      await sleep(120);
      good.ws.send(JSON.stringify({ type: "node_click", sessionId: 3, nodeId: "z" }));
      await sleep(200);
      expect(luaInbox.length).toBe(1);
      expect(luaInbox[0]).toMatchObject({ type: "node_click", nodeId: "z", sessionId: 3 });

      unsub.ws.close();
      good.ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("node_click with malformed/non-contract payloads is not relayed to Lua", async () => {
    const { proc, ready } = await spawnServer();
    const luaInbox = makeStdoutLineStream(proc.stdout!);
    try {
      const { ws } = await openSocket(ready.port);
      ws.send(JSON.stringify({ type: "hello", sessionId: 3, token: ready.token }));
      await sleep(120);

      ws.send(JSON.stringify({ type: "node_click", sessionId: 3 }));
      ws.send(JSON.stringify({ type: "node_click", sessionId: 3, nodeId: null }));
      ws.send(JSON.stringify({ type: "node_click", sessionId: 3, nodeId: ["n1"] }));
      ws.send(JSON.stringify({ type: "node_click", sessionId: 3, nodeId: "n1", v: 99 }));
      ws.send(JSON.stringify({ type: "node_click", sessionId: 3, nodeId: "n1", data: {} }));
      await sleep(250);
      expect(luaInbox.length).toBe(0);

      const valid = { type: "node_click", sessionId: 3, nodeId: "ok" };
      ws.send(JSON.stringify(valid));
      await sleep(250);
      expect(luaInbox.length).toBe(1);
      expect(JSON.stringify(luaInbox[0])).toBe(JSON.stringify(valid));
      ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("node_click with a sessionId other than the socket's bound session is NOT relayed", async () => {
    const { proc, ready } = await spawnServer();
    const luaInbox = makeStdoutLineStream(proc.stdout!);
    try {
      const a = await openSocket(ready.port);
      a.ws.send(JSON.stringify({ type: "hello", sessionId: 1, token: ready.token }));
      await sleep(120);

      // Subscribed to session 1, but tries to inject into session 2 — rejected.
      a.ws.send(JSON.stringify({ type: "node_click", sessionId: 2, nodeId: "x" }));
      await sleep(200);
      expect(luaInbox.length).toBe(0); // no cross-session injection

      // Its own bound session still relays.
      a.ws.send(JSON.stringify({ type: "node_click", sessionId: 1, nodeId: "ok" }));
      await sleep(200);
      expect(luaInbox.length).toBe(1);
      expect(luaInbox[0]).toMatchObject({ sessionId: 1, nodeId: "ok" });
      a.ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);

  test("node_click for a closed session is not relayed from a stale subscribed socket", async () => {
    const { proc, ready } = await spawnServer();
    const luaInbox = makeStdoutLineStream(proc.stdout!);
    try {
      const { ws } = await openSocket(ready.port);
      ws.send(JSON.stringify({ type: "hello", sessionId: 6, token: ready.token }));
      await sleep(120);

      writeLine(proc, { type: "session_close", sessionId: 6 });
      await sleep(120);

      ws.send(JSON.stringify({ type: "node_click", sessionId: 6, nodeId: "stale" }));
      await sleep(250);
      expect(luaInbox.length).toBe(0);
      ws.close();
    } finally {
      proc.kill();
    }
  }, 20000);
});
