---
baseline_commit: ed658a21fdd0f7b2ab2ae4b3ddd36b2cf7e77c41
---

# Story 6.1: Activate the return channel (protocol spine)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system,
I want `node_click` and `emphasize` messages flowing through all three tiers under contract test,
so that both sync directions build on a verified protocol spine with no user-visible risk.

This is the **first protocol expansion since Story 1.3** and the change the browser→server return
channel has been kept warm for since v1. It activates the channel at the protocol/relay level only:
the wire types exist, the server relays them both directions with the v1 security posture enforced,
and the Lua side **logs-and-ignores** `node_click`. **No user-visible behavior ships in this story** —
the actual click→jump (6.2), cursor→emphasis (6.3), and `sync` config (6.4) build on this spine.

## Acceptance Criteria

_Verbatim from `epics.md` Story 6.1 [Source: _bmad-output/planning-artifacts/epics.md#L562-L584]._

1. **(AC1 — protocol)** **Given** the canonical contract in `server/protocol.ts`, **When** this story
   is complete, **Then** `node_click{sessionId,nodeId}` (browser→server→Lua) and
   `emphasize{sessionId,nodeId|null}` (Lua→server→browser) are defined in `protocol.ts` and mirrored
   in `protocol.lua`, with **camelCase fields + snake_case types**, and **neither message carries `v`**.
2. **(AC2 — inbound relay + auth)** **And** the server relays a `node_click` from a **subscribed,
   token-validated** socket verbatim to Lua over stdout; a `node_click` from an un-subscribed/invalid
   socket is **rejected, not relayed**.
3. **(AC3 — forward relay scoping)** **And** the server relays `emphasize` to **exactly that session's
   subscribers** (never cross-session).
4. **(AC4 — contract test)** **And** a contract test round-trips browser→server→Lua and
   Lua→server→browser, asserting the **same envelope shape on every hop**.
5. **(AC5 — Lua log-and-ignore)** **And** the Lua handler for `node_click` **logs-and-ignores** (no
   user-visible behavior yet); unknown types remain logged-and-ignored on every hop.
6. **(AC6 — cross-boundary config contract)** **And** a cross-boundary contract test asserts
   `commands.lua` and `frontend/urlconfig.ts` agree on the URL-param names and defaults (closes the
   deferred-work Lua↔TS config-contract item).

## Tasks / Subtasks

- [x] **Task 1 — Protocol definitions, canonical-first (AC1)**
  - [x] In `server/protocol.ts`, append `"node_click"` and `"emphasize"` to the `MessageType` union
    (after `"ack"`, currently line 14). [Source: server/protocol.ts:1-14]
  - [x] In `server/protocol.ts`, add `nodeId?: string | null;` to the `ProtocolMessage` interface
    immediately after `v?: number;` (line 19) to document the new field in the existing optional-field
    style. Do **not** add a `v` field expectation — neither new message carries `v`. [Source: server/protocol.ts:16-21]
  - [x] In `lua/interactive-graphviz/protocol.lua`, append `"node_click"` and `"emphasize"` to
    `M.MESSAGE_TYPES` (after `"ack",`, line 18), same order + trailing-comma style as the TS union.
    Per the in-file rule, change the TS canonical **first**, then this mirror. [Source: lua/interactive-graphviz/protocol.lua:5-19]
  - [x] `frontend/protocol.ts` needs **no change** — it re-exports `ProtocolMessage`/`PROTOCOL_VERSION`
    from `../server/protocol`, so the new union members reach every frontend consumer via the
    re-exported `ProtocolMessage.type` (no frontend code references `MessageType` by name). [Source: frontend/protocol.ts:1-2]
- [x] **Task 2 — Server: accept + relay `node_click` browser→server→Lua (AC2)**
  - [x] In `server/server.ts`, add a `case "node_click"` to `handleWsMessage` **between** the `ack`
    case and the `default` (currently lines 155-163). [Source: server/server.ts:113-164]
  - [x] Gate on the socket being subscribed + token-validated: `ws.data.subscribed === true` **and**
    `typeof ws.data.sessionId === "number"` (both are set together only after a valid `hello`, lines
    145-146). On failure, `diag(...)` and `break` (no relay). [Source: server/server.ts:125-154]
  - [x] Reject cross-session injection: if `msg.sessionId !== ws.data.sessionId`, `diag(...)` and
    `break`. Then relay **verbatim** with `writeStdout(msg)` (see Dev Notes "sessionId trust" — verbatim
    relay keeps the envelope byte-identical for the AC4 assertion). [Source: server/server.ts:42-44]
- [x] **Task 3 — Server: forward-relay `emphasize` Lua→server→browser (AC3)**
  - [x] In `server/server.ts`, add a `case "emphasize"` to `handleMessage` (the stdin/Lua switch),
    **before** the `default` (currently lines 232-234). Copy the `render` case fan-out (lines 211-225):
    iterate `sessions.subscribersOf(message.sessionId)` and `safeSend` the `JSON.stringify`'d envelope.
    [Source: server/server.ts:211-225]
  - [x] Do **NOT** call `sessions.setLastGoodRender(...)` for `emphasize` — it is transient highlight,
    not a replayable render. [Source: server/server.ts:217-222]
  - [x] Confirm cross-session safety is structural: `subscribersOf` returns only that session's `Set`
    (or empty). Do not add new mutation in `server.ts` — the single-owner invariant keeps subscriber-set
    writes inside `sessions.ts`. [Source: server/sessions.ts:1-4,79-81]
- [x] **Task 4 — Lua: `node_click` log-and-ignore (AC5)**
  - [x] In `lua/interactive-graphviz/server.lua`, add an `elseif t == "node_click" then` branch to
    `dispatch` (after the `log` branch body, before the closing `end` at line 94). Body:
    `log.debug("node_click received (no-op): " .. tostring(msg.nodeId))`. No buffer/cursor work — that
    is Story 6.2. [Source: lua/interactive-graphviz/server.lua:54-96]
  - [x] Unknown types must still fall through to the existing silent-ignore tail (line 95 comment); do
    not add an `else` that warns on unknowns. [Source: lua/interactive-graphviz/server.lua:95]
- [x] **Task 5 — Contract tests: both directions + rejection (AC4)**
  - [x] Add a **continuing stdout line reader** helper to `server/relay.test.ts` (the existing
    `readFirstLine` consumes only the `ready` line and releases the reader — it cannot observe later
    stdout). See Dev Notes for the exact helper. [Source: server/relay.test.ts:24-41]
  - [x] Add `node_click` WS→server→Lua round-trip: `hello` to subscribe, `ws.send` a `node_click`,
    assert exactly one frame lands on the server's stdout (Lua channel) with **identical envelope
    shape** (key-set + values; see "Envelope assertion" note re: byte-identity). [Source: server/relay.test.ts:64-98]
  - [x] Add `emphasize` Lua→server→browser round-trip: `writeLine` an `emphasize{sessionId,nodeId}`,
    assert the browser `received` it with identical shape. Add a **second** variant for
    `emphasize{sessionId,nodeId:null}` (clear) asserting `nodeId` is preserved as `null` — do **not**
    use the `.not.toBeNull()` per-key assertion here (see Dev Notes "the null trap"). [Source: server/relay.test.ts:64-98]
  - [x] Add a rejection test: `node_click` from a socket that never `hello`'d (un-subscribed) and from
    a token-rejected socket is **not** relayed to Lua; include a **control** assertion that a properly
    subscribed socket's `node_click` relays exactly once (guards against a false-green from an unwired
    channel). Model on the existing `token rejection` test. [Source: server/relay.test.ts:100-131]
- [x] **Task 6 — Cross-boundary Lua↔TS URL-param contract test (AC6)**
  - [x] Add a test that reads **both** `lua/interactive-graphviz/commands.lua` (emitter) and
    `frontend/urlconfig.ts` (parser) as text and asserts they reference the **same 6 config param
    literals**: `preserve_view`, `highlight_mode`, `animate`, `search_scope`, `search_case`,
    `search_regex`. Optionally also assert default agreement (config.lua defaults ↔ urlconfig setter
    defaults). Closes deferred-work.md:14. [Source: lua/interactive-graphviz/commands.lua:147-164] [Source: frontend/urlconfig.ts:59-83]
- [x] **Task 7 — Verify, gate, and bookkeeping**
  - [x] Run `bun test` in `server/` and `frontend/`; run busted (`tests/*_spec.lua`); run Stylua. All green.
  - [x] Grep-verify no `v` is ever attached to a `node_click` or `emphasize` envelope on any tier.
  - [x] Confirm `:GraphvizPreview` still behaves identically (no new user-visible behavior); the only
    runtime change is a `log.debug` line if a `node_click` ever arrives (it won't until 6.2).
  - [x] Update `deferred-work.md`: mark the Lua↔TS URL-param contract item resolved by this story.

### Review Findings

- [x] [Review][Patch] Closed/stale sessions can still relay `node_click` from an old subscribed socket [server/server.ts:224]
- [x] [Review][Patch] `node_click` relays unvalidated/non-contract payloads, including invalid `nodeId` or sync `v` [server/server.ts:159]
- [x] [Review][Patch] `emphasize` broadcasts unvalidated/non-contract payloads, including invalid `nodeId` or sync `v` [server/server.ts:247]
- [x] [Review][Patch] URL-param defaults are not asserted cross-boundary as required by AC6 [frontend/urlparam-contract.test.ts:59]
- [x] [Review][Defer] Valid non-object WebSocket JSON can still throw outside malformed-frame handling [server/server.ts:119] — deferred, pre-existing

## Dev Notes

### Scope boundary — build the spine, nothing more

**This story is plumbing.** Touch only the protocol/relay/test surfaces. Explicitly **DO NOT**:

- ❌ Create `lua/interactive-graphviz/sync.lua` or any node→line buffer scan → **Story 6.2**.
- ❌ Emit `node_click` from the browser, expose a sender on `ws.ts`, or wire `render.ts`'s
  `handleAppClick` to send → **Story 6.2**.
- ❌ Add a CursorMoved/CursorHold watcher or **send** `emphasize` from Lua → **Story 6.3**.
- ❌ Create `frontend/sync.ts` or render any emphasis treatment → **Story 6.3**.
- ❌ Add the `sync = { jump_on_click, highlight_on_cursor, cursor_debounce_ms }` config table or its
  validation, or warn-on-unknown-keys → **Story 6.4**.
- ❌ Add README/vimdoc/UX docs → **Story 6.4**.
- ❌ Implement echo suppression logic (the invariant is documented for 6.3; nothing to suppress yet).

The server **does** relay both new types in this story (that is what makes the AC4 round-trip real),
and the Lua side **does** log-and-ignore `node_click`. That is the whole behavioral footprint.

### Architecture compliance (the contract — highest priority)

[Source: _bmad-output/planning-artifacts/architecture.md#L465-L475, #L489-L491, #L562-L573]

- **Canonical-first, every time.** Change `server/protocol.ts` first → mirror `protocol.lua` → update
  the contract test. Never edit one tier's view of a message in isolation. `frontend/protocol.ts`
  re-exports, so it follows automatically.
- **Wire naming:** `type` values are **snake_case** (`node_click`); field keys are **camelCase**
  (`sessionId`, `nodeId`) — this holds **even in Lua** (build wire tables with camelCase keys via
  `vim.json.encode`; snake_case only for internal locals).
- **Envelope:** `{ type, v?, sessionId?, ... }`, one JSON object per line/frame, **no `{data:…}`
  wrapping** — the message *is* the object; `type` discriminates. [Source: _bmad-output/planning-artifacts/architecture.md#L521-L525]
- **`v` is render-only.** `v` is minted/mutated **only at the Neovim source for `render`**. Sync
  messages (`node_click`, `emphasize`) **never carry or mutate `v`**; sync is stateless last-wins and
  can never displace or reorder renders (NFR-8). [Source: _bmad-output/planning-artifacts/architecture.md#L357-L359, #L531-L538]
- **`omit-never-null`, with one sanctioned exception.** The wire rule is "absent/optional fields are
  omitted, never `null`." **Exception:** `emphasize{nodeId: null}` uses `null` as a *value* meaning
  "clear emphasis," not as a stand-in for an absent field. This is the only place an explicit wire
  `null` is correct. See "the null trap" below. [Source: _bmad-output/planning-artifacts/architecture.md#L471-L475, #L354-L355]
- **Security pre-paid in v1; no new exposure decision.** Token-gated `hello`, un-subscribed sockets
  rejected, literal `127.0.0.1` bind — `node_click` rides this unchanged. The per-session token, minted
  in v1 *specifically* for this moment, is now load-bearing. [Source: _bmad-output/planning-artifacts/architecture.md#L343-L348, #L379-L387]
- **stdout stays the protocol channel; diagnostics via `diag`/`log`.** The new server case writes the
  relayed envelope to `stdout` via `writeStdout`; never write diagnostics to stdout.

### Files to touch

| File | Action | What | Anchor |
|------|--------|------|--------|
| `server/protocol.ts` | UPDATE | `node_click`+`emphasize` in union; `nodeId?: string\|null` field | union L1-14; iface L16-21 |
| `lua/interactive-graphviz/protocol.lua` | UPDATE | mirror the two type strings into `MESSAGE_TYPES` | L5-19 |
| `server/server.ts` | UPDATE | `node_click` inbound case; `emphasize` forward case | `handleWsMessage` L113-164; `handleMessage` L199-235 |
| `lua/interactive-graphviz/server.lua` | UPDATE | `node_click` log-and-ignore branch in `dispatch` | L54-96 |
| `server/relay.test.ts` | UPDATE | stdout reader helper + node_click/emphasize/rejection round-trips | helpers L1-61; contract test L64-98 |
| `frontend/urlparam-contract.test.ts` (or extend `urlconfig.test.ts`) | NEW | Lua↔TS 6-param agreement | new |
| `frontend/protocol.ts` | NONE | re-export — auto-propagates | L1-2 |
| `server/sessions.ts` | NONE | read-only via `subscribersOf`; do not mutate here | L79-81 |

### Tier 1 — Protocol (current state → change)

Current `server/protocol.ts` [Source: server/protocol.ts:1-23]: a 13-member `MessageType` union, an
open `ProtocolMessage` interface (`type`, `sessionId?`, `v?`, `[key]: unknown`), and
`PROTOCOL_VERSION = 1`. The index signature already *permits* `nodeId`, so adding the field is for
documentation/type-safety, not to compile. Result:

```ts
export type MessageType =
  | "session_open" | "render" | "set_engine" | "session_close" | "ping" | "shutdown"
  | "ready" | "pong" | "log" | "error_display" | "session_closed" | "hello" | "ack"
  | "node_click"   // browser→server→Lua (FR-19 spine); no `v`
  | "emphasize";   // Lua→server→browser (FR-20 spine); nodeId may be null to clear; no `v`

export interface ProtocolMessage {
  type: MessageType;
  sessionId?: number;
  v?: number;
  nodeId?: string | null; // node_click: set; emphasize: set, or null to clear
  [key: string]: unknown;
}
```

Lua mirror `protocol.lua`: append `"node_click",` and `"emphasize",` to `M.MESSAGE_TYPES` after
`"ack",`. The Lua mirror enumerates `type` strings only (no field schema). [Source: lua/interactive-graphviz/protocol.lua:5-19]

### Tier 2 — Server relay (current state → change)

**Inbound (`handleWsMessage`, server.ts:113-164).** Today: `hello` validates `typeof sessionId ===
"number" && supplied === token` (else `ws.close()`, no subscribe) then `sessions.subscribe` + sets
`ws.data.subscribed = true` and `ws.data.sessionId`; `ack` is a no-op; `default` logs-and-ignores via
`diag(...)`. A `node_click` currently falls into `default` and is dropped. [Source: server/server.ts:125-163]
Add the new case between `ack` and `default`:

```ts
      case "node_click": {
        // Only a subscribed + token-validated socket may originate inbound events.
        // `ws.data.subscribed` flips true only after a valid `hello` (token + numeric sessionId).
        if (!ws.data.subscribed || typeof ws.data.sessionId !== "number") {
          diag("node_click from un-subscribed socket ignored");
          break;
        }
        // No cross-session injection: the frame's sessionId must be the socket's bound session.
        // (The browser knows its own sessionId from the URL it was opened with.)
        if (msg.sessionId !== ws.data.sessionId) {
          diag("node_click sessionId mismatch ignored");
          break;
        }
        // Relay verbatim to Lua over the stdout protocol channel (byte-shape preserved).
        writeStdout(msg);
        break;
      }
```

`writeStdout` (server.ts:42-44) → `encodeLine` NDJSON-frames to Lua's stdin reader; no new plumbing.
[Source: server/server.ts:42-44] [Source: server/stdio.ts:4-6]

**Forward (`handleMessage`, server.ts:199-235).** The `render` case (server.ts:211-225) is the exact
pattern: `if typeof sessionId === "number"`, `JSON.stringify(message)`, fan out over
`sessions.subscribersOf(sessionId)` with `safeSend`. Add before `default`:

```ts
      case "emphasize": {
        // Forward a transient highlight to exactly this session's subscribers.
        // subscribersOf returns only this session's Set (or empty) — never cross-session.
        // Unknown/zero-subscriber session is a silent no-op. Do NOT setLastGoodRender (transient).
        if (typeof message.sessionId === "number") {
          const payload = JSON.stringify(message);
          for (const ws of sessions.subscribersOf(message.sessionId)) {
            safeSend(ws, payload);
          }
        }
        break;
      }
```

`subscribersOf` (sessions.ts:79-81) → `this.sessions.get(sessionId)?.subscribers ?? []` — structurally
single-session. `safeSend` (server.ts:46-53) guards one dead socket from throwing the broadcast loop.
[Source: server/server.ts:46-53] [Source: server/sessions.ts:79-81]

#### sessionId trust (a real decision — recommended resolution)

A subscribed socket for session A could send `node_click{sessionId: B}` to try to inject into session
B. Two ways to be safe: **(recommended)** *validate-then-relay-verbatim* — reject if `msg.sessionId !==
ws.data.sessionId`, otherwise relay the frame unchanged; or *stamp* — overwrite with `ws.data.sessionId`.
Prefer validate-then-verbatim: it honors the architecture's "relayed **verbatim**" wording
[Source: _bmad-output/planning-artifacts/architecture.md#L351-L353] **and** keeps the envelope
byte-identical across the hop, so the AC4 contract test can assert exact shape. Stamping would reorder
keys and break a byte-identity assertion. A well-behaved browser always sends its own (correct)
`sessionId` (it has it from `ws.ts` `readConnectParams`). [Source: frontend/ws.ts:22-26]

### Tier 3 — Lua dispatch (current state → change)

`server.lua` `dispatch` (lines 54-96) is an `if/elseif` over `ready`/`pong`/`log` with a **silent**
fall-through for unknown types (the line-95 comment; note it is silently ignored, not logged — only
*parse* failures are logged, at line 125). [Source: lua/interactive-graphviz/server.lua:54-96,98-130]
Add a `node_click` branch (this story's only Lua behavior):

```lua
  elseif t == "log" then
    local level = string.lower(tostring(msg.level or "info"))
    local fn = log[level] or log.info
    fn(tostring(msg.message or ""))
  elseif t == "node_click" then
    -- Story 6.1: spine only. Log-and-ignore; cursor jump is Story 6.2.
    log.debug("node_click received (no-op): " .. tostring(msg.nodeId))
  end
```

The inbound message arrives via the existing `on_stdout` → `vim.json.decode` → `vim.schedule(dispatch)`
path; no change to `on_stdout`. Keep the unknown-type silent fall-through intact. [Source: lua/interactive-graphviz/server.lua:98-130]

> **Note for the dev:** `dispatch` is a *local* function in `server.lua` and there is **no
> `tests/server_spec.lua`** today (busted suite has commands/config/render/session/etc. but not server).
> The load-bearing envelope proof for AC4 is the **server-side bun contract test**. The **expected
> resolution for this spine story** is: the bun contract test + a direct assertion that the `node_click`
> branch exists. Exposing `dispatch` (or a `handle_line`) for a busted unit test is **optional and should
> be skipped unless trivial** — do **not** refactor `server.lua` to add a test seam just for this. Note
> your choice in the Dev Agent Record.

### Tests — harness, idioms, and the two traps

**Harness (all in `server/relay.test.ts:1-61`).** `spawnServer()` runs the real server
(`Bun.spawn(["bun","run",SERVER], {stdin:"pipe", stdout:"pipe", stderr:"ignore",
IG_HEARTBEAT_TIMEOUT_MS:"10000"})`) and parses `ready{port,token}`. `openSocket(port)` is the fake
browser (global `WebSocket`, collects every inbound frame into `received[]`). `writeLine(proc, obj)`
feeds the Lua-side stdin (`{json}\n`). `sleep(ms)` for propagation. **Port is ephemeral — always use
`ready.port`, never hardcode.** [Source: server/relay.test.ts:1-61]

**Idioms:** import `test` (not `it`) from `"bun:test"`; one `describe`; live tests take a `20000`ms
3rd-arg timeout; always `try { … } finally { proc.kill(); }`; fixed `await sleep(...)` (no event-driven
frame waits exist). [Source: server/relay.test.ts:64-98]

**The existing envelope contract test** (the model, `relay.test.ts:64-98`) asserts on the
Lua→server→browser hop: `JSON.stringify(got) === JSON.stringify(sent)` + `Object.keys(got).sort()` +
`.not.toHaveProperty("data")` + per-key `.not.toBeNull()`.

**Trap 1 — no stdout reader exists.** `readFirstLine` consumes only the `ready` line then releases the
reader, so there is **no way to observe later server stdout** (the Lua-bound channel) for the
`node_click` direction. Add this continuing reader near `readFirstLine`:

```ts
function makeStdoutLineStream(stream: ReadableStream<Uint8Array>) {
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
      // stream closed on proc.kill(); test is already finishing.
    }
  })();
  return lines;
}
```

`spawnServer`'s `readFirstLine` calls `reader.releaseLock()` (not cancel), so a fresh `getReader()`
here is valid. Bind the return value at the call site — `const luaInbox =
makeStdoutLineStream(proc.stdout!);` — then the `node_click` test asserts `luaInbox.length === 1` and
the envelope shape (the helper returns the array; `luaInbox` is just the local you name it).

**Trap 2 — the `null` trap.** The `emphasize{nodeId:null}` (clear) round-trip must assert `nodeId`
survives as `null`. Do **not** copy the existing test's `for (const k of Object.keys(got))
expect(got[k]).not.toBeNull()` loop into the clear-variant — `null` is the intended value there. Use it
freely for `node_click` and for `emphasize` with a concrete `nodeId`; the existing per-key loop
(`relay.test.ts:91-92`) stays valid for every 6.1-touched envelope, since none carries a *present*
`null` except the `emphasize`-clear case above (which uses its own assertion). Also: because `node_click` is
relayed **verbatim** (per the recommended sessionId resolution), byte-identity (`JSON.stringify`
equality) is a valid assertion; if you instead choose to *stamp* sessionId, switch that test to a
key-set + value assertion (`Object.keys().sort()` + per-field `expect(got.x).toBe(...)`) since stamping
reorders keys.

**Rejection test needs a control.** A return channel that relays nothing at all would also make
`luaInbox.length === 0` — a false green. End the rejection test with a properly-subscribed socket whose
`node_click` relays exactly once, proving the zero is real rejection. [Source: server/relay.test.ts:100-131]

**AC6 — cross-boundary URL-param contract.** The blind spot (deferred-work.md:14): `commands.lua`
emits the params and `frontend/urlconfig.ts` parses them with no shared source of truth — a rename on
either side keeps both suites green while config silently stops applying. `commands.lua:147-164` emits
**8** URL params; **6 are config-derived with defaults** and form the contract:

| Param | commands.lua source | default | urlconfig.ts |
|-------|--------------------|---------|--------------|
| `preserve_view` | `b01(cfg.preserve_view)` | `1` (true) | `parseBoolParam` |
| `highlight_mode` | `cfg.highlight_mode` (raw enum) | `bidirectional` | passthrough |
| `animate` | `b01(cfg.animate)` | `1` (true) | `parseBoolParam` |
| `search_scope` | `cfg.search.scope` (raw enum) | `both` | passthrough |
| `search_case` | `b01(cfg.search.case_sensitive)` | `0` (false) | `parseBoolParam` |
| `search_regex` | `b01(cfg.search.regex)` | `0` (false) | `parseBoolParam` |

(`sessionId` and `token` are the other 2 — runtime values, not part of the config contract.) Write a
test (a `bun test`, e.g. `frontend/urlparam-contract.test.ts`, can read both files via `Bun.file`) that
extracts the literal param strings from **both** `lua/interactive-graphviz/commands.lua` and
`frontend/urlconfig.ts` and asserts the two sets are identical (and, ideally, that their defaults
agree). Keep it focused on the **literal names** — that is the exact thing a rename would break.
[Source: lua/interactive-graphviz/commands.lua:147-164] [Source: frontend/urlconfig.ts:59-83]

**Run:** `cd server && bun test`; `cd frontend && bun test`; busted `tests/*_spec.lua` (local harness
is busted/Lua 5.4 under `~/.luarocks`; CI runs Lua 5.1 and now globs `tests/*_spec.lua`); `stylua`.

### Previous-story & git intelligence

- **Story 6.1 is the first story of Epic 6** (no prior story in this epic). The protocol spine it
  extends was laid in **Story 1.3** ("Message protocol and WebSocket relay"), whose ACs already
  established the warm-but-dormant return channel and the "round-trips an envelope, asserting the same
  envelope shape on both hops" contract-test pattern this story mirrors. [Source: _bmad-output/planning-artifacts/epics.md#L242-L263]
- **Most relevant recent commit — `1af7d69` "feat(config): promote interactivity config to real Lua
  setup() keys"** created `frontend/urlconfig.ts` (+ `urlconfig.test.ts`) and extended `commands.lua`
  (+27), `config.lua` (+79), `tests/commands_spec.lua`, `tests/config_spec.lua`. That is precisely the
  URL-param plumbing AC6's contract test locks down — the contract exists *because* of that commit, and
  the deferred-work item was filed in the same review. Read `urlconfig.test.ts` for the param-name +
  default expectations to mirror.
- **Browser sends only `hello` today** (not even `ack` — `ack` appears only in tests). `node_click`
  will be the first new outbound browser message since `hello`, but **that emission is Story 6.2** — in
  6.1 the browser is unchanged. [Source: frontend/ws.ts:42-55]
- **Toolchain (no new deps — SM-C1):** Bun runtime (unpinned, no `tsconfig.json`); pinned deps
  `@hpcc-js/wasm-graphviz 1.21.2`, `d3-graphviz 5.6.0`, `d3-zoom 3.0.0`, `d3-ease/d3-transition 3.0.1`,
  dev `@happy-dom/global-registrator ^20.10.2`. This story adds **zero** dependencies. [Source: server/package.json] [Source: frontend/package.json]

### Project Structure Notes

- All changes sit inside the established three-tier layout (`server/`, `frontend/`,
  `lua/interactive-graphviz/`, `tests/`). No new modules required for 6.1 (`sync.lua`/`sync.ts` are
  6.2/6.3). The one new file is a test.
- Single-owner invariant respected: the new server cases only **read** session subscribers
  (`subscribersOf`) and **write** to Lua/sockets (`writeStdout`/`safeSend`) — no subscriber-set mutation
  outside `sessions.ts`. [Source: server/sessions.ts:1-4]
- After this lands, update the architecture's "Data flow (one-way in v1)" note is already done in the
  doc (the v3 annotation exists); the doc-prose pass (README/vimdoc) is **Story 6.4**, not here.
  [Source: _bmad-output/planning-artifacts/architecture.md#L739-L742]

### References

- [Source: _bmad-output/planning-artifacts/epics.md#L555-L584] — Epic 6 framing + Story 6.1 ACs.
- [Source: _bmad-output/planning-artifacts/architecture.md#L343-L377] — "Return Channel Activation (v3)": message-set additions, invariants, `v`-token boundary, echo-suppression (6.3), stale-node (6.2).
- [Source: _bmad-output/planning-artifacts/architecture.md#L288-L307] — Transport & Message Protocol + v1 message set.
- [Source: _bmad-output/planning-artifacts/architecture.md#L465-L475, #L489-L491, #L521-L543, #L562-L573] — wire naming, canonical-protocol rule, format/communication patterns, agent enforcement.
- [Source: _bmad-output/planning-artifacts/architecture.md#L379-L387, #L450] — Security/token (now load-bearing).
- [Source: _bmad-output/planning-artifacts/prds/prd-interactive-graphviz.nvim-2026-06-02/prd.md#L210-L231, #L367-L370, #L295-L298] — §4.6, FR-19, FR-20, NFR-8, §6.1c.
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-06-11.md] — the v3 change proposal (§4C Story 6.1 scope; deferred-work triage).
- [Source: _bmad-output/implementation-artifacts/deferred-work.md#L14] — the Lua↔TS URL-param contract item this story closes.
- Code anchors: `server/protocol.ts:1-23`, `lua/interactive-graphviz/protocol.lua:3-19`, `server/server.ts:42-44,113-164,199-235`, `server/sessions.ts:1-4,79-81`, `server/stdio.ts:4-28`, `lua/interactive-graphviz/server.lua:54-96,98-130,144-154`, `lua/interactive-graphviz/commands.lua:147-164`, `frontend/urlconfig.ts:59-83`, `frontend/ws.ts:22-55`, `frontend/render.ts:529-561` (6.2 context only — **do not edit in 6.1**), `server/relay.test.ts:1-131`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Opus 4.8)

### Debug Log References

- `bun test server/relay.test.ts` — RED first: 9 pass / 5 fail (new spine tests fail against the
  pre-change server, confirming they exercise the relay). After implementation: 14 pass / 0 fail.
- `bun test server` → 71 pass / 0 fail (9 files) after review fixes.
- `bun test frontend` → 121 pass / 0 fail (9 files), incl. the new `urlparam-contract.test.ts` (2).
- `TMPDIR=$PWD/.tmp-busted /Users/xuyangy/.luarocks/bin/busted tests/*_spec.lua` → 120 successes / 0 failures.
- `stylua --check lua/ tests/` → exit 0 (clean).

### Completion Notes List

- **Protocol (AC1):** added `"node_click"` + `"emphasize"` to the canonical `server/protocol.ts`
  `MessageType` union and a documenting `nodeId?: string | null` field; mirrored the two type strings
  into `protocol.lua` `M.MESSAGE_TYPES`. `frontend/protocol.ts` unchanged (re-export). Neither message
  carries `v`.
- **Server inbound (AC2):** new `node_click` case in `handleWsMessage`. Gated on
  `ws.data.subscribed && typeof ws.data.sessionId === "number"` (set only by a valid `hello`).
  **Design decision** (resolving the Dev Notes "sessionId trust" open point): chose
  *validate-then-relay-verbatim* — reject when `msg.sessionId !== ws.data.sessionId` (no cross-session
  injection), otherwise `writeStdout(msg)` unchanged. This keeps the envelope byte-identical for the
  AC4 assertion *and* closes the injection hole; preferred over stamping (which would reorder keys).
- **Server forward (AC3):** new `emphasize` case in `handleMessage`, copying the `render` fan-out over
  `sessions.subscribersOf(sessionId)` (structurally single-session) but **not** calling
  `setLastGoodRender` (emphasize is transient, not a replayable render).
- **Lua (AC5):** added an `elseif t == "node_click"` log-and-ignore branch to `server.lua` `dispatch`
  (`log.debug` only); unknown types still fall through to the silent tail. Per the story's stated
  expectation, did **not** add a busted seam (no `tests/server_spec.lua`; `dispatch` is local) — the
  server-side bun contract test is the load-bearing envelope proof.
- **Tests (AC4):** added a continuing-stdout reader helper (`makeStdoutLineStream`) to `relay.test.ts`
  (the existing `readFirstLine` only yields the `ready` line), plus 5 tests: node_click WS→server→Lua
  byte-identical round-trip; emphasize Lua→server→WS round-trip; emphasize`{nodeId:null}` clear
  (asserts the explicit `null` survives — the one sanctioned wire-null); node_click rejection from an
  un-subscribed/token-rejected socket **with a control** that a subscribed socket relays exactly once;
  and node_click cross-session-injection rejection.
- **Cross-boundary contract (AC6):** new `frontend/urlparam-contract.test.ts` extracts param names from
  both `commands.lua` (emitter) and `urlconfig.ts` (parser) and asserts set-equality against the
  canonical 6 (catches a rename on either side), plus asserts `config.lua` defaults resolve to the same
  frontend defaults through `urlconfig.ts`. Marked the deferred-work item resolved.
- **Review fixes:** rejected `node_click` from stale closed sessions; rejected malformed sync envelopes
  with invalid `nodeId`, stray `v`, or non-contract extra fields; added regression tests for each path.
- **Invariants verified:** sync messages never carry `v` (asserted via `.not.toHaveProperty("v")`); no
  cross-session leakage; single-owner session-map (new cases only read `subscribersOf` / write via
  `writeStdout`/`safeSend`); security/token posture unchanged. **No user-visible behavior** — the new
  relay cases only act on `node_click`/`emphasize`, which nothing emits until 6.2/6.3; `:GraphvizPreview`
  is unchanged (full suite green).

### File List

- `server/protocol.ts` — modified: `node_click`/`emphasize` union members + `nodeId?` field.
- `lua/interactive-graphviz/protocol.lua` — modified: mirrored the two type strings.
- `server/server.ts` — modified: `node_click` inbound case + `emphasize` forward case.
- `lua/interactive-graphviz/server.lua` — modified: `node_click` log-and-ignore dispatch branch.
- `server/relay.test.ts` — modified: `makeStdoutLineStream` helper + 5 spine contract tests.
- `frontend/urlparam-contract.test.ts` — added: Lua↔TS URL-param cross-boundary contract test.
- `_bmad-output/implementation-artifacts/deferred-work.md` — modified: marked the URL-param item resolved.

## Change Log

- 2026-06-22 — Implemented Story 6.1: return-channel protocol spine. `node_click` (browser→server→Lua)
  and `emphasize` (Lua→server→browser) defined canonically and relayed both directions with the v1
  security posture enforced; Lua logs-and-ignores `node_click`; 5 server contract tests + 1
  cross-boundary URL-param contract test (closes deferred-work Lua↔TS item). No user-visible behavior.
  Status → review.
