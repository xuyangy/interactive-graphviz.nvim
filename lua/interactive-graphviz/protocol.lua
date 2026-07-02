local M = {}

-- server/protocol.ts is the canonical message contract. Keep this mirror in sync
-- only after changing the TypeScript source of truth.
M.MESSAGE_TYPES = {
  "session_open",
  "render",
  "set_engine",
  "session_close",
  "ping",
  "shutdown",
  "ready",
  "pong",
  "log",
  "error_display",
  "session_closed",
  "hello",
  "ack",
  "node_click",
  "emphasize",
}

return M
