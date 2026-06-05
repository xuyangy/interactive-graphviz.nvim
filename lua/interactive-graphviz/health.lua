local M = {}

local H = vim.health or {}

-- Neovim 0.10 renamed the report_* API to start/ok/warn/error/info. We target
-- >= 0.10 so prefer the new names and fall back defensively just in case.
local function start(name)
  (H.start or H.report_start)(name)
end
local function ok(msg)
  (H.ok or H.report_ok)(msg)
end
local function warn(msg, ...)
  (H.warn or H.report_warn)(msg, ...)
end
local function err(msg, ...)
  (H.error or H.report_error)(msg, ...)
end
local function info(msg)
  (H.info or H.report_info)(msg)
end

-- AC 7: Neovim >= 0.10.
local function check_neovim()
  local v = vim.version()
  local label = string.format("Neovim %d.%d.%d", v.major, v.minor, v.patch)
  if v.major > 0 or v.minor >= 10 then
    ok(label .. " (>= 0.10)")
  else
    err(label .. " is below the required 0.10", { "Upgrade Neovim to 0.10 or newer" })
  end
end

-- AC 7: committed checksums.txt can be found and parsed; mapped prebuilt binary
-- presence and checksum match/mismatch where a prebuilt mapping exists.
local function check_install(install)
  local root, manifest_path, root_err = install.plugin_root()
  if not root then
    err("Could not locate the plugin's checksums.txt: " .. tostring(root_err))
    return
  end
  info("Plugin root: " .. root)

  local probe = install.inspect_prebuilt()
  if probe.error then
    err("Install diagnostics failed: " .. probe.error)
    return
  end

  if not probe.supported then
    warn(
      "No prebuilt binary for this platform ("
        .. tostring(probe.platform)
        .. "); the server will be built from source with Bun on first use"
    )
    return
  end

  ok("checksums.txt found and parsed: " .. manifest_path)
  info("Mapped prebuilt artifact: " .. tostring(probe.artifact))

  if not probe.present then
    warn(
      "Prebuilt binary not yet installed at "
        .. tostring(probe.binary_path)
        .. "; it will be downloaded and verified on first use"
    )
    return
  end

  if probe.checksum_match then
    ok("Installed binary present and checksum matches checksums.txt")
  else
    err("Installed binary checksum MISMATCH for " .. tostring(probe.artifact), {
      "Expected: " .. tostring(probe.expected),
      "Actual:   " .. tostring(probe.actual),
      "Delete " .. tostring(probe.binary_path) .. " to force a verified re-download",
    })
  end
end

-- AC 7: Bun availability/version for source-build fallback (not required when a
-- verified prebuilt cache hit exists).
local function check_bun(install)
  local bun = install.inspect_bun()
  if not bun.present then
    warn(
      "Bun not found on PATH; required only for source-build fallback (Bun >= " .. bun.min .. ")"
    )
    return
  end
  if bun.ok then
    ok("Bun " .. tostring(bun.version) .. " (>= " .. bun.min .. ", source-build capable)")
  else
    warn(
      "Bun "
        .. tostring(bun.version)
        .. " is older than the required "
        .. bun.min
        .. " for source-build fallback"
    )
  end
end

-- AC 7: localhost port-bind capability via a short-lived loopback probe; the
-- probe binds an ephemeral port and releases it immediately.
local function check_port_bind()
  local server = vim.uv.new_tcp()
  if not server then
    err("Could not create a TCP handle to probe localhost port binding")
    return
  end
  local bind_ok, bind_err = pcall(function()
    return server:bind("127.0.0.1", 0)
  end)
  local sockname = bind_ok and server:getsockname() or nil
  pcall(function()
    server:close()
  end)

  if bind_ok and sockname then
    ok("Can bind a localhost port (probe bound 127.0.0.1:" .. tostring(sockname.port) .. ")")
  else
    err(
      "Could not bind a localhost port: " .. tostring(bind_err),
      { "Check firewall/sandbox restrictions on 127.0.0.1 binding" }
    )
  end
end

function M.check()
  start("interactive-graphviz.nvim")

  local loaded, install = pcall(require, "interactive-graphviz.install")
  if not loaded then
    err("Could not load the install module: " .. tostring(install))
    return
  end

  check_neovim()
  check_install(install)
  check_bun(install)
  check_port_bind()
end

return M
