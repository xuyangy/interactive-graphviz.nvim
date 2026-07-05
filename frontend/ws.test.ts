import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

// Story 6.2 — sendNodeClick, the ONLY browser→Lua outbound path besides hello.
// ws.ts reads `window.location` at call time and constructs the global
// `WebSocket`; both are stubbed here (no happy-dom: a hand-rolled fake gives
// full control of open/close timing and captures every sent frame). Globals are
// saved/restored so this file cannot bleed into other suites in the same run.

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  throwOnSend = false;
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }

  send(data: string): void {
    if (this.throwOnSend) throw new Error("InvalidStateError: still in CLOSING state");
    this.sent.push(String(data));
  }

  close(): void {
    this.dispatch("close", {});
  }

  dispatch(type: string, event: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}

const g = globalThis as Record<string, unknown>;
const savedWindow = g.window;
const savedWebSocket = g.WebSocket;

function setUrl(search: string): void {
  g.window = {
    location: { protocol: "http:", host: "127.0.0.1:9876", search },
  };
}

// Controllable reconnect timer: makeClient injects this so no real setTimeout
// fires (which would construct stray sockets that bleed across tests). Reconnect
// tests fire the pending timer explicitly with flushTimers().
interface FakeTimer {
  fn: () => void;
  ms: number;
}
let pendingTimers: FakeTimer[] = [];
function fakeSetTimer(fn: () => void, ms: number): unknown {
  const handle: FakeTimer = { fn, ms };
  pendingTimers.push(handle);
  return handle;
}
function fakeClearTimer(handle: unknown): void {
  pendingTimers = pendingTimers.filter((t) => t !== handle);
}
function flushTimers(): void {
  const due = pendingTimers;
  pendingTimers = [];
  for (const t of due) t.fn();
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  pendingTimers = [];
  g.WebSocket = FakeWebSocket;
  setUrl("?sessionId=3&token=tok-abc");
});

afterEach(() => {
  g.window = savedWindow;
  g.WebSocket = savedWebSocket;
});

afterAll(() => {
  g.window = savedWindow;
  g.WebSocket = savedWebSocket;
});

async function makeClient(handlers = {}) {
  const { createWebSocketClient } = await import("./ws");
  const client = createWebSocketClient(handlers, {
    setTimer: fakeSetTimer,
    clearTimer: fakeClearTimer,
  });
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  return { client, socket };
}

function latestSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
}

describe("sendNodeClick (Story 6.2)", () => {
  test("before the socket is open: returns false, nothing sent", async () => {
    const { client, socket } = await makeClient();
    expect(client.sendNodeClick("a")).toBe(false);
    expect(socket.sent).toEqual([]);
  });

  test("after open: sends EXACTLY {type,sessionId,nodeId} — no v, token, or extra keys", async () => {
    const { client, socket } = await makeClient();
    socket.dispatch("open", {});

    expect(client.sendNodeClick("node one")).toBe(true);

    // sent[0] is the hello handshake; the node_click is the second frame.
    expect(socket.sent).toHaveLength(2);
    const frame = JSON.parse(socket.sent[1]!) as Record<string, unknown>;
    expect(Object.keys(frame).sort()).toEqual(["nodeId", "sessionId", "type"]);
    expect(frame).toEqual({ type: "node_click", sessionId: 3, nodeId: "node one" });
    expect(typeof frame.sessionId).toBe("number");
  });

  test("after close: returns false again (connected tracks the socket)", async () => {
    const { client, socket } = await makeClient();
    socket.dispatch("open", {});
    socket.dispatch("close", {});

    expect(client.sendNodeClick("a")).toBe(false);
    expect(socket.sent).toHaveLength(1); // hello only
  });

  test("non-numeric URL sessionId: returns false, nothing beyond hello", async () => {
    setUrl("?sessionId=banana&token=tok-abc");
    const { client, socket } = await makeClient();
    socket.dispatch("open", {});

    expect(client.sendNodeClick("a")).toBe(false);
    // Exactly the hello handshake went out — no node_click frame at all.
    expect(socket.sent).toHaveLength(1);
    expect((JSON.parse(socket.sent[0]!) as { type: string }).type).toBe("hello");
  });

  test("sessionId must be strict decimal digits: '1e3', '0x10', ' 3' all refuse", async () => {
    for (const bad of ["1e3", "0x10", "%203"]) {
      // %203 decodes to " 3" (leading whitespace) via URLSearchParams.
      setUrl(`?sessionId=${bad}&token=tok-abc`);
      const { client, socket } = await makeClient();
      socket.dispatch("open", {});

      expect(client.sendNodeClick("a")).toBe(false);
      expect(socket.sent.filter((f: string) => f.includes("node_click"))).toEqual([]);
    }
  });

  test("empty nodeId: returns false, nothing sent (defense-in-depth below the gate)", async () => {
    const { client, socket } = await makeClient();
    socket.dispatch("open", {});

    expect(client.sendNodeClick("")).toBe(false);
    expect(socket.sent).toHaveLength(1); // hello only
  });

  test("a throwing socket.send (CLOSING race) is contained: returns false, no throw", async () => {
    const { client, socket } = await makeClient();
    socket.dispatch("open", {});
    socket.throwOnSend = true;

    expect(() => client.sendNodeClick("a")).not.toThrow();
    expect(client.sendNodeClick("a")).toBe(false);
  });

  test("missing sessionId: returns false", async () => {
    setUrl("?token=tok-abc");
    const { client, socket } = await makeClient();
    socket.dispatch("open", {});

    expect(client.sendNodeClick("a")).toBe(false);
    expect(socket.sent).toEqual([]); // no sessionId → no hello either
  });
});

describe("auto-reconnect on unexpected close", () => {
  test("close schedules a reconnect; firing it opens a new socket that re-sends hello", async () => {
    const changes: boolean[] = [];
    const { socket } = await makeClient({ onConnectionChange: (c: boolean) => changes.push(c) });
    socket.dispatch("open", {});
    expect(changes).toEqual([true]);
    const before = FakeWebSocket.instances.length;

    socket.dispatch("close", {});
    expect(changes).toEqual([true, false]);
    // No new socket until the backoff timer fires; the first step is 500ms.
    expect(FakeWebSocket.instances.length).toBe(before);
    expect(pendingTimers).toHaveLength(1);
    expect(pendingTimers[0]!.ms).toBe(500);

    flushTimers();
    // A fresh socket is constructed; on open it re-authenticates with hello.
    expect(FakeWebSocket.instances.length).toBe(before + 1);
    const next = latestSocket();
    next.dispatch("open", {});
    expect(changes).toEqual([true, false, true]);
    expect((JSON.parse(next.sent[0]!) as { type: string }).type).toBe("hello");
  });

  test("backoff grows across successive failed attempts and resets after a good open", async () => {
    const { socket } = await makeClient();
    socket.dispatch("open", {});

    // Each reconnect attempt also fails (close before it ever opens).
    socket.dispatch("close", {});
    expect(pendingTimers[0]!.ms).toBe(500);
    flushTimers();
    latestSocket().dispatch("close", {});
    expect(pendingTimers[0]!.ms).toBe(1000);
    flushTimers();
    latestSocket().dispatch("close", {});
    expect(pendingTimers[0]!.ms).toBe(2000);
    flushTimers();

    // This attempt succeeds — the next drop starts backoff over at the first step.
    latestSocket().dispatch("open", {});
    latestSocket().dispatch("close", {});
    expect(pendingTimers[0]!.ms).toBe(500);
  });

  test("intentional close() does not schedule a reconnect", async () => {
    const { client, socket } = await makeClient();
    socket.dispatch("open", {});
    const before = FakeWebSocket.instances.length;

    client.close(); // FakeWebSocket.close() dispatches the "close" event
    expect(pendingTimers).toHaveLength(0);
    flushTimers();
    expect(FakeWebSocket.instances.length).toBe(before);
  });

  test("auth rejection (close code 4001) is terminal: onAuthRejected fires, NO reconnect", async () => {
    const { WS_CLOSE_AUTH_REJECTED } = await import("./protocol");
    const changes: boolean[] = [];
    let rejected = 0;
    const { socket } = await makeClient({
      onConnectionChange: (c: boolean) => changes.push(c),
      onAuthRejected: () => (rejected += 1),
    });
    socket.dispatch("open", {});
    const before = FakeWebSocket.instances.length;

    // The server rejects the stale hello by closing with the app-level code.
    socket.dispatch("close", { code: WS_CLOSE_AUTH_REJECTED });

    expect(rejected).toBe(1);
    expect(changes).toEqual([true, false]); // the drop is still reported
    expect(pendingTimers).toHaveLength(0); // but no retry is ever scheduled
    flushTimers();
    expect(FakeWebSocket.instances.length).toBe(before);
  });

  test("a normal-code close (e.g. 1006 network drop) still reconnects", async () => {
    let rejected = 0;
    const { socket } = await makeClient({ onAuthRejected: () => (rejected += 1) });
    socket.dispatch("open", {});

    socket.dispatch("close", { code: 1006 });

    expect(rejected).toBe(0);
    expect(pendingTimers).toHaveLength(1);
  });
});

describe("hostless page (file://) guard", () => {
  test("empty location.host: inert client, NO WebSocket constructed, no throw", async () => {
    // A truncated exported graph.html can lose its payload script entirely, so
    // main.ts sees no export marker and boots the live path from file:// —
    // where host is "" and `new WebSocket("ws:///")` would throw synchronously.
    g.window = { location: { protocol: "file:", host: "", search: "" } };
    const { createWebSocketClient } = await import("./ws");

    const client = createWebSocketClient();

    expect(FakeWebSocket.instances).toEqual([]);
    expect(client.connected).toBe(false);
    expect(() => client.close()).not.toThrow();
    expect(client.sendNodeClick("a")).toBe(false);
  });
});

describe("inbound emphasize dispatch (Story 6.3)", () => {
  test("emphasize frames reach onEmphasize (string and null nodeId); junk stays ignored", async () => {
    const { createWebSocketClient } = await import("./ws");
    const seen: unknown[] = [];
    createWebSocketClient({ onEmphasize: (msg) => seen.push(msg) });
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    socket.dispatch("open", {});

    socket.dispatch("message", {
      data: JSON.stringify({ type: "emphasize", sessionId: 3, nodeId: "a" }),
    });
    socket.dispatch("message", {
      data: JSON.stringify({ type: "emphasize", sessionId: 3, nodeId: null }),
    });
    socket.dispatch("message", { data: JSON.stringify({ type: "mystery" }) });
    socket.dispatch("message", { data: "not json at all" });

    expect(seen).toEqual([
      { type: "emphasize", sessionId: 3, nodeId: "a" },
      { type: "emphasize", sessionId: 3, nodeId: null },
    ]);
  });

  test("emphasize without an onEmphasize handler is a safe no-op", async () => {
    const { createWebSocketClient } = await import("./ws");
    createWebSocketClient({});
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    socket.dispatch("open", {});
    expect(() =>
      socket.dispatch("message", {
        data: JSON.stringify({ type: "emphasize", sessionId: 3, nodeId: "a" }),
      }),
    ).not.toThrow();
  });
});
