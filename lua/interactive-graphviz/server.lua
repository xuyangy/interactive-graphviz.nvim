local M = {}

local config = require("interactive-graphviz.config")
local log = require("interactive-graphviz.log")
local install = require("interactive-graphviz.install")
local session = require("interactive-graphviz.session")

-- One server per Neovim instance. The handle is a vim.system() SystemObj whose
-- stdin pipe is simultaneously the control channel AND the parent-death signal:
-- when this Neovim dies (incl. `kill -9`), the OS closes the pipe and the server
-- self-terminates on EOF. Lua-side teardown is the graceful path only.
local state = {
  handle = nil, -- vim.system SystemObj, or nil when not running
  alive = false, -- spawned and not yet exited
  running = false, -- true once `ready{port,token}` has been received
  port = nil,
  token = nil,
  stdout_buf = "",
  heartbeat = nil, -- vim.uv timer
  pending = {}, -- wire messages queued until `ready`
  on_ready_cbs = {}, -- one-shot callbacks fired when `ready` arrives (Story 1.4)
}

M.state = state

local function write_msg(msg)
  return pcall(function()
    state.handle:write(vim.json.encode(msg) .. "\n")
  end)
end

local function start_heartbeat()
  if state.heartbeat then
    return
  end
  local interval = config.get().heartbeat_ms or 2000
  local timer = vim.uv.new_timer()
  state.heartbeat = timer
  timer:start(interval, interval, function()
    if state.handle and state.running then
      write_msg({ type = "ping" })
    end
  end)
end

local function stop_heartbeat()
  if state.heartbeat then
    state.heartbeat:stop()
    state.heartbeat:close()
    state.heartbeat = nil
  end
end

local function dispatch(msg)
  local t = msg.type
  if t == "ready" then
    if state.running then
      -- already announced; ignore a duplicate/late `ready` rather than re-binding
      log.debug("ignoring duplicate ready announcement")
      return
    end
    if
      type(msg.port) ~= "number"
      or msg.port <= 0
      or type(msg.token) ~= "string"
      or msg.token == ""
    then
      log.error("Server sent a malformed ready announcement; not starting preview")
      return
    end
    state.port = msg.port
    state.token = msg.token
    state.running = true
    start_heartbeat()
    local queued = state.pending
    state.pending = {}
    for _, qm in ipairs(queued) do
      write_msg(qm)
    end
    local cbs = state.on_ready_cbs
    state.on_ready_cbs = {}
    for _, cb in ipairs(cbs) do
      local ok, err = pcall(cb)
      if not ok then
        log.warn("on_ready callback error: " .. tostring(err))
      end
    end
  elseif t == "pong" then
    -- liveness ack; nothing required
  elseif t == "log" then
    local level = string.lower(tostring(msg.level or "info"))
    local fn = log[level] or log.info
    fn(tostring(msg.message or ""))
  elseif t == "node_click" then
    -- Story 6.1: spine only — log-and-ignore. The cursor jump is Story 6.2.
    log.debug("node_click received (no-op): " .. tostring(msg.nodeId))
  end
  -- unknown server->Lua types are ignored (channel stays warm without v1 surface)
end

local function on_stdout(err, data)
  if err then
    vim.schedule(function()
      log.debug("server stdout error: " .. tostring(err))
    end)
    return
  end
  if data == nil then
    return -- stream end; exit handled by on_exit
  end
  state.stdout_buf = state.stdout_buf .. data
  while true do
    local nl = state.stdout_buf:find("\n", 1, true)
    if not nl then
      break
    end
    local line = state.stdout_buf:sub(1, nl - 1)
    state.stdout_buf = state.stdout_buf:sub(nl + 1)
    if line ~= "" then
      local ok, decoded = pcall(vim.json.decode, line)
      if ok and type(decoded) == "table" then
        vim.schedule(function()
          dispatch(decoded)
        end)
      else
        local dropped = line
        vim.schedule(function()
          log.debug("dropped unparseable stdout line: " .. dropped)
        end)
      end
    end
  end
end

local function on_stderr(_, data)
  if data and data ~= "" then
    vim.schedule(function()
      log.debug(data)
    end)
  end
end

function M.is_running()
  return state.handle ~= nil and state.alive
end

-- Send a wire message; queues it until `ready` if the server is still starting.
function M.send(msg)
  if not state.handle then
    return false
  end
  if not state.running then
    table.insert(state.pending, msg)
    return true
  end
  return write_msg(msg)
end

-- The server self-terminates if it sees no stdin traffic for this long. Derived
-- as a multiple of the Lua ping interval so the two never silently disagree (a
-- ping interval >= the timeout would let the server kill a live Neovim). An
-- explicit IG_HEARTBEAT_TIMEOUT_MS in the environment wins (used by the tests).
local function heartbeat_timeout_ms()
  local explicit = vim.env.IG_HEARTBEAT_TIMEOUT_MS
  if explicit and explicit ~= "" then
    return explicit
  end
  local interval = config.get().heartbeat_ms or 2000
  return tostring(interval * 3)
end

-- Idempotent: spawn exactly one server per Neovim instance.
function M.ensure_started()
  if M.is_running() then
    return state
  end

  local resolved, cmd = pcall(install.resolve_server_cmd)
  if not resolved then
    log.error("Failed to locate the interactive-graphviz server: " .. tostring(cmd))
    return nil
  end

  state.stdout_buf = ""
  state.pending = {}
  state.running = false
  state.port = nil
  state.token = nil

  local ok, handle = pcall(vim.system, cmd, {
    stdin = true,
    stdout = on_stdout,
    stderr = on_stderr,
    text = true,
    env = {
      IG_HEARTBEAT_TIMEOUT_MS = heartbeat_timeout_ms(),
      IG_BIND = config.get().bind,
      IG_PORT = tostring(config.get().port),
    },
  }, function(obj)
    vim.schedule(function()
      M._on_exit(obj)
    end)
  end)

  if not ok or not handle then
    log.error("Failed to spawn interactive-graphviz server")
    return nil
  end

  state.handle = handle
  state.alive = true

  -- Register graceful teardown only once a server actually exists.
  require("interactive-graphviz.lifecycle").setup()

  return state
end

-- Open (or reuse) a session for a buffer and tell the server about it.
-- Returns false (and registers nothing) if the server could not be spawned.
function M.open_session(bufnr)
  if not M.ensure_started() then
    return false
  end
  session.register(bufnr)
  M.send({ type = "session_open", sessionId = bufnr })
  return true
end

-- Close a session (graceful, in-process). Does NOT kill the server.
function M.close_session(bufnr)
  session.unregister(bufnr)
  M.send({ type = "session_close", sessionId = bufnr })
end

-- Graceful shutdown: send `shutdown`, then close stdin so the server sees EOF.
-- Correctness (no-orphan) never depends on this running — EOF/heartbeat cover it.
function M.shutdown()
  stop_heartbeat()
  if state.handle then
    write_msg({ type = "shutdown" })
    pcall(function()
      state.handle:write(nil) -- close stdin => EOF on the server
    end)
  end
  state.running = false
end

-- Register a one-shot callback to run when `ready` is processed. If the server
-- is already running (port/token known), calls `fn` via vim.schedule immediately.
-- Minimal seam for the browser-open deferral in commands.lua.
function M.on_ready(fn)
  if state.running then
    vim.schedule(fn)
  else
    table.insert(state.on_ready_cbs, fn)
  end
end

function M._on_exit(_)
  stop_heartbeat()
  if #state.on_ready_cbs > 0 then
    log.warn("GraphvizPreview: server exited before ready — browser will not open")
  end
  state.handle = nil
  state.alive = false
  state.running = false
  state.port = nil
  state.token = nil
  state.stdout_buf = ""
  state.pending = {}
  state.on_ready_cbs = {}
end

return M
