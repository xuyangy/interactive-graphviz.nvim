import { describe, expect, test } from "bun:test";
import { getHealth } from "./health";
import { PROTOCOL_VERSION } from "./protocol";

const SERVER = `${import.meta.dir}/server.ts`;

async function readReady(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<{ line: string; rest: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buf += decoder.decode(value, { stream: true });
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        return { line: buf.slice(0, nl), rest: buf.slice(nl + 1) };
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error("no line received before timeout");
}

describe("getHealth() payload (AC 8)", () => {
  test("returns ok, protocol/version, pid, port, bind, and session count", () => {
    const health = getHealth({ port: 4321, bind: "127.0.0.1", sessions: 3 });

    expect(health.ok).toBe(true);
    expect(health.protocol).toBe(PROTOCOL_VERSION);
    expect(health.version).toBe(PROTOCOL_VERSION);
    expect(health.pid).toBe(process.pid);
    expect(health.port).toBe(4321);
    expect(health.bind).toBe("127.0.0.1");
    expect(health.sessions).toBe(3);
  });

  test("reflects the bind address it is given (loopback vs LAN)", () => {
    expect(getHealth({ port: 0, bind: "0.0.0.0", sessions: 0 }).bind).toBe("0.0.0.0");
  });

  test("is JSON-serializable (route returns JSON, not stdout)", () => {
    const json = JSON.stringify(getHealth({ port: 1, bind: "127.0.0.1", sessions: 0 }));
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.pid).toBe("number");
  });
});

describe("GET /health route (AC 8)", () => {
  test("serves JSON diagnostics without polluting the stdout protocol channel", async () => {
    const proc = Bun.spawn(["bun", "run", SERVER], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, IG_HEARTBEAT_TIMEOUT_MS: "4000", IG_BIND: "127.0.0.1" },
    });

    try {
      const { line, rest } = await readReady(proc.stdout, 8000);
      const ready = JSON.parse(line) as { type: string; port: number };
      expect(ready.type).toBe("ready");
      expect(ready.port).toBeGreaterThan(0);

      const res = await fetch(`http://127.0.0.1:${ready.port}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.protocol).toBe(PROTOCOL_VERSION);
      expect(body.version).toBe(PROTOCOL_VERSION);
      expect(typeof body.pid).toBe("number");
      expect(body.port).toBe(ready.port);
      expect(body.bind).toBe("127.0.0.1");
      expect(body.sessions).toBe(0);

      // Any stdout after `ready` must still be valid protocol JSON lines — the
      // /health request must not have written diagnostics to stdout.
      const trailing = rest.trim();
      if (trailing.length > 0) {
        for (const l of trailing.split("\n")) {
          if (l.trim().length === 0) {
            continue;
          }
          expect(() => JSON.parse(l)).not.toThrow();
        }
      }

      proc.stdin.end();
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill();
    }
  }, 15000);
});
