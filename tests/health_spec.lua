package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path

-- Stubs the install module's health introspection so health.lua can be exercised
-- without a real Neovim or filesystem. Verifies each :checkhealth report path
-- (Neovim version, checksum, Bun, port-bind) emits the right severity.

local function load_health(opts)
  opts = opts or {}
  package.loaded["interactive-graphviz.health"] = nil
  package.loaded["interactive-graphviz.install"] = nil

  local reports = { start = {}, ok = {}, warn = {}, error = {}, info = {} }

  _G.vim = {
    health = {
      start = function(name)
        table.insert(reports.start, name)
      end,
      ok = function(msg)
        table.insert(reports.ok, msg)
      end,
      warn = function(msg)
        table.insert(reports.warn, msg)
      end,
      error = function(msg)
        table.insert(reports.error, msg)
      end,
      info = function(msg)
        table.insert(reports.info, msg)
      end,
    },
    version = function()
      return opts.version or { major = 0, minor = 11, patch = 2 }
    end,
    uv = {
      new_tcp = function()
        if opts.tcp_create_fails then
          return nil
        end
        return {
          bind = function(_, _host, _port)
            if opts.bind_fails then
              error("bind: EADDRNOTAVAIL")
            end
            return true
          end,
          getsockname = function()
            return { ip = "127.0.0.1", port = 54321 }
          end,
          close = function() end,
        }
      end,
    },
  }

  -- Stub the install module entirely with the introspection contract.
  package.loaded["interactive-graphviz.install"] = {
    MIN_BUN_STRING = "1.3.10",
    plugin_root = function()
      if opts.root_fails then
        return nil, nil, "no checksums.txt"
      end
      return "/plugin", "/plugin/checksums.txt"
    end,
    inspect_prebuilt = function()
      return opts.prebuilt
        or {
          supported = true,
          present = true,
          checksum_match = true,
          artifact = "server-darwin-arm64",
        }
    end,
    inspect_bun = function()
      return opts.bun or { present = true, ok = true, version = "1.3.10", min = "1.3.10" }
    end,
  }

  local health = require("interactive-graphviz.health")
  return health, reports
end

local function any(list, needle)
  for _, v in ipairs(list) do
    if tostring(v):find(needle, 1, true) then
      return true
    end
  end
  return false
end

describe("health :checkhealth diagnostics", function()
  after_each(function()
    package.loaded["interactive-graphviz.health"] = nil
    package.loaded["interactive-graphviz.install"] = nil
    _G.vim = nil
  end)

  it("reports all-ok on a supported, verified, Bun-capable host", function()
    local health, reports = load_health()
    health.check()

    assert.are.equal("interactive-graphviz.nvim", reports.start[1])
    assert.is_true(any(reports.ok, "0.10")) -- neovim version
    assert.is_true(any(reports.ok, "checksum matches"))
    assert.is_true(any(reports.ok, "source-build capable"))
    assert.is_true(any(reports.ok, "bind a localhost port"))
    assert.are.equal(0, #reports.error)
  end)

  it("errors when Neovim is below 0.10", function()
    local health, reports = load_health({ version = { major = 0, minor = 9, patch = 5 } })
    health.check()
    assert.is_true(any(reports.error, "below the required 0.10"))
  end)

  it("errors on an installed-binary checksum mismatch", function()
    local health, reports = load_health({
      prebuilt = {
        supported = true,
        present = true,
        checksum_match = false,
        artifact = "server-darwin-arm64",
        expected = "aaa",
        actual = "bbb",
        binary_path = "/plugin/dist/bin/server-darwin-arm64",
      },
    })
    health.check()
    assert.is_true(any(reports.error, "checksum MISMATCH"))
  end)

  it("warns (does not require Bun) when the platform has a prebuilt but Bun is missing", function()
    local health, reports = load_health({ bun = { present = false, min = "1.3.10" } })
    health.check()
    assert.is_true(any(reports.warn, "Bun not found"))
    assert.are.equal(0, #reports.error)
  end)

  it("warns about source-build on an unsupported platform", function()
    local health, reports = load_health({
      prebuilt = { supported = false, platform = "Linux-riscv64-glibc" },
    })
    health.check()
    assert.is_true(any(reports.warn, "No prebuilt binary for this platform"))
  end)

  it("errors when a localhost port cannot be bound", function()
    local health, reports = load_health({ bind_fails = true })
    health.check()
    assert.is_true(any(reports.error, "Could not bind a localhost port"))
  end)
end)
