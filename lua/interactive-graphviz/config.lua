local M = {}

M.defaults = {
  engine = "dot",
  engines = { "dot", "neato" },
  debounce_ms = 200,
  bind = "127.0.0.1",
  port = 0,
  expose_to_lan = false,
  open_cmd = nil,
  preserve_view = true,
  highlight_mode = "bidirectional",
  animate = true,
  search = {
    scope = "both",
    case_sensitive = false,
    regex = false,
  },
  -- Editor↔graph sync (Epic 6). jump_on_click gates graph→buffer (Story 6.2);
  -- highlight_on_cursor + cursor_debounce_ms gate buffer→graph (Story 6.3).
  sync = {
    jump_on_click = true,
    highlight_on_cursor = true,
    cursor_debounce_ms = 150,
  },
  heartbeat_ms = 2000,
  log_level = "warn",
}

M.options = vim.deepcopy(M.defaults)

local VALID_LOG_LEVELS = { off = true, error = true, warn = true, info = true, debug = true }

local VALID_HIGHLIGHT_MODES =
  { single = true, upstream = true, downstream = true, bidirectional = true }

local VALID_SEARCH_SCOPES = { both = true, nodes = true, edges = true }

local function engine_list()
  return table.concat(M.options.engines or {}, ", ")
end

local function has_engine(engine)
  for _, candidate in ipairs(M.options.engines or {}) do
    if candidate == engine then
      return true
    end
  end
  return false
end

-- Validate merged options, collecting warnings. Returns the corrected options
-- table and a list of warning strings. Caller emits warnings after M.options is
-- fully written to avoid a log → config circular read with stale state.
local function validate(opts)
  local warnings = {}

  -- validate engines (non-empty list of strings) first — engine depends on it
  if
    type(opts.engines) ~= "table"
    or #opts.engines == 0
    or (function()
      for _, v in ipairs(opts.engines) do
        if type(v) ~= "string" then
          return true
        end
      end
      return false
    end)()
  then
    table.insert(
      warnings,
      "interactive-graphviz setup: engines must be a non-empty list of strings; using default"
    )
    opts.engines = vim.deepcopy(M.defaults.engines)
  end

  -- validate engine is a string in the engines list
  if type(opts.engine) ~= "string" then
    table.insert(
      warnings,
      "interactive-graphviz setup: engine must be a string; using default 'dot'"
    )
    opts.engine = M.defaults.engine
  else
    local found = false
    for _, e in ipairs(opts.engines) do
      if e == opts.engine then
        found = true
        break
      end
    end
    if not found then
      table.insert(
        warnings,
        "interactive-graphviz setup: engine '"
          .. opts.engine
          .. "' not in engines list; using default 'dot'"
      )
      opts.engine = M.defaults.engine
    end
  end

  -- validate debounce_ms is a positive integer (> 0)
  if
    type(opts.debounce_ms) ~= "number"
    or opts.debounce_ms <= 0
    or opts.debounce_ms ~= math.floor(opts.debounce_ms)
  then
    table.insert(warnings, "interactive-graphviz setup: debounce_ms must be > 0; using default 200")
    opts.debounce_ms = M.defaults.debounce_ms
  end

  -- validate heartbeat_ms is a positive integer (> 0)
  if
    type(opts.heartbeat_ms) ~= "number"
    or opts.heartbeat_ms <= 0
    or opts.heartbeat_ms ~= math.floor(opts.heartbeat_ms)
  then
    table.insert(
      warnings,
      "interactive-graphviz setup: heartbeat_ms must be > 0; using default 2000"
    )
    opts.heartbeat_ms = M.defaults.heartbeat_ms
  end

  -- validate port is 0 (ephemeral) or 1–65535
  if
    type(opts.port) ~= "number"
    or opts.port ~= math.floor(opts.port)
    or opts.port < 0
    or opts.port > 65535
  then
    table.insert(
      warnings,
      "interactive-graphviz setup: port must be 0 (ephemeral) or 1–65535; using default 0"
    )
    opts.port = M.defaults.port
  end

  -- validate log_level
  if type(opts.log_level) ~= "string" or not VALID_LOG_LEVELS[opts.log_level] then
    table.insert(
      warnings,
      "interactive-graphviz setup: log_level '"
        .. tostring(opts.log_level)
        .. "' is invalid; using default 'warn'"
    )
    opts.log_level = M.defaults.log_level
  end

  -- validate open_cmd is nil or a non-empty string
  if opts.open_cmd ~= nil and (type(opts.open_cmd) ~= "string" or opts.open_cmd == "") then
    table.insert(
      warnings,
      "interactive-graphviz setup: open_cmd must be nil or a non-empty string; using default nil"
    )
    opts.open_cmd = M.defaults.open_cmd
  end

  -- validate preserve_view is a boolean
  if type(opts.preserve_view) ~= "boolean" then
    table.insert(
      warnings,
      "interactive-graphviz setup: preserve_view must be a boolean; using default true"
    )
    opts.preserve_view = M.defaults.preserve_view
  end

  -- validate highlight_mode is one of the four click-highlight directions
  if type(opts.highlight_mode) ~= "string" or not VALID_HIGHLIGHT_MODES[opts.highlight_mode] then
    table.insert(
      warnings,
      "interactive-graphviz setup: highlight_mode '"
        .. tostring(opts.highlight_mode)
        .. "' is invalid; expected one of: single, upstream, downstream, bidirectional;"
        .. " using default 'bidirectional'"
    )
    opts.highlight_mode = M.defaults.highlight_mode
  end

  -- validate animate is a boolean
  if type(opts.animate) ~= "boolean" then
    table.insert(
      warnings,
      "interactive-graphviz setup: animate must be a boolean; using default true"
    )
    opts.animate = M.defaults.animate
  end

  -- validate search is a table; each subfield is validated independently so a
  -- partial table (e.g. { scope = "nodes" }) keeps the defaults for unset fields.
  if type(opts.search) ~= "table" then
    table.insert(warnings, "interactive-graphviz setup: search must be a table; using defaults")
    opts.search = vim.deepcopy(M.defaults.search)
  else
    -- Validate into a FRESH table: the merged opts.search can alias the very
    -- table the user passed to setup() (deep-extend assigns list-shaped tables
    -- by reference), and validation must never mutate caller-owned data.
    local user = opts.search
    local validated = vim.deepcopy(M.defaults.search)
    if user.scope ~= nil then
      if type(user.scope) == "string" and VALID_SEARCH_SCOPES[user.scope] then
        validated.scope = user.scope
      else
        table.insert(
          warnings,
          "interactive-graphviz setup: search.scope '"
            .. tostring(user.scope)
            .. "' is invalid; expected one of: both, nodes, edges; using default 'both'"
        )
      end
    end
    if user.case_sensitive ~= nil then
      if type(user.case_sensitive) == "boolean" then
        validated.case_sensitive = user.case_sensitive
      else
        table.insert(
          warnings,
          "interactive-graphviz setup: search.case_sensitive must be a boolean; using default false"
        )
      end
    end
    if user.regex ~= nil then
      if type(user.regex) == "boolean" then
        validated.regex = user.regex
      else
        table.insert(
          warnings,
          "interactive-graphviz setup: search.regex must be a boolean; using default false"
        )
      end
    end
    opts.search = validated
  end

  -- validate sync is a table; same fresh-table discipline as search above so
  -- validation never mutates caller-owned data. Known keys are validated here
  -- (Stories 6.2/6.3); unknown-key warnings are Story 6.4.
  if type(opts.sync) ~= "table" then
    table.insert(warnings, "interactive-graphviz setup: sync must be a table; using defaults")
    opts.sync = vim.deepcopy(M.defaults.sync)
  else
    local user = opts.sync
    local validated = vim.deepcopy(M.defaults.sync)
    if user.jump_on_click ~= nil then
      if type(user.jump_on_click) == "boolean" then
        validated.jump_on_click = user.jump_on_click
      else
        table.insert(
          warnings,
          "interactive-graphviz setup: sync.jump_on_click must be a boolean; using default true"
        )
      end
    end
    if user.highlight_on_cursor ~= nil then
      if type(user.highlight_on_cursor) == "boolean" then
        validated.highlight_on_cursor = user.highlight_on_cursor
      else
        table.insert(
          warnings,
          "interactive-graphviz setup: sync.highlight_on_cursor must be a boolean;"
            .. " using default true"
        )
      end
    end
    if user.cursor_debounce_ms ~= nil then
      if
        type(user.cursor_debounce_ms) == "number"
        and user.cursor_debounce_ms > 0
        and user.cursor_debounce_ms == math.floor(user.cursor_debounce_ms)
      then
        validated.cursor_debounce_ms = user.cursor_debounce_ms
      else
        table.insert(
          warnings,
          "interactive-graphviz setup: sync.cursor_debounce_ms must be > 0; using default 150"
        )
      end
    end
    opts.sync = validated
  end

  -- validate expose_to_lan is a boolean (AC2: invalid values warn and reset)
  if type(opts.expose_to_lan) ~= "boolean" then
    table.insert(
      warnings,
      "interactive-graphviz setup: expose_to_lan must be a boolean; using default false"
    )
    opts.expose_to_lan = M.defaults.expose_to_lan
  end

  -- Security invariant: bind is controlled exclusively by expose_to_lan.
  -- A user-provided bind key is always overridden — expose_to_lan is the ONLY
  -- way to move beyond loopback (NFR-4). This is a deliberate security downgrade
  -- that requires explicit opt-in.
  if opts.expose_to_lan == true then
    opts.bind = "0.0.0.0"
  else
    opts.bind = "127.0.0.1"
  end

  return opts, warnings
end

function M.setup(opts)
  local merged = vim.tbl_deep_extend("force", vim.deepcopy(M.defaults), opts or {})
  local corrected, warnings = validate(merged)
  -- Write options fully BEFORE emitting warnings: log.lua reads config.get() at
  -- call time to gate messages by log_level; stale options would produce wrong
  -- level comparisons (see circular dependency note in Dev Notes).
  M.options = corrected
  -- Emit collected warnings now that M.options is fully set.
  if #warnings > 0 then
    local log = require("interactive-graphviz.log")
    for _, msg in ipairs(warnings) do
      log.warn(msg)
    end
  end
  return M.options
end

function M.get()
  return M.options
end

function M.set_engine(engine)
  if type(engine) ~= "string" or not has_engine(engine) then
    return false,
      "GraphvizEngine: unknown engine '"
        .. tostring(engine)
        .. "'; expected one of: "
        .. engine_list()
  end

  M.options.engine = engine
  return true
end

return M
