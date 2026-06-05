package.path = "./lua/?.lua;./lua/?/init.lua;" .. package.path

local function sha256(data)
  local known = {
    ["cached-binary"] = ("1"):rep(64),
    expected = ("2"):rep(64),
    ["release-binary"] = ("3"):rep(64),
    bad = ("4"):rep(64),
    truncated = ("5"):rep(64),
  }
  return known[data] or ("f"):rep(64)
end

local function write_file(path, data)
  local file = assert(io.open(path, "wb"))
  file:write(data)
  file:close()
end

local function load_install(opts)
  opts = opts or {}
  package.loaded["interactive-graphviz.install"] = nil

  local system_calls = {}
  local promoted = {}
  local chmodded = {}
  local notifications = {}
  local downloads = opts.downloads or {}
  local executable = opts.executable or { curl = 1, wget = 0, xattr = 0 }

  _G.vim = {
    api = {
      nvim_get_runtime_file = function(name, _)
        if name == "checksums.txt" then
          return { opts.manifest_path }
        end
        return {}
      end,
    },
    fn = {
      executable = function(cmd)
        return executable[cmd] or 0
      end,
      mkdir = function(path, _)
        os.execute("mkdir -p " .. path)
        return 1
      end,
      sha256 = sha256,
      tempname = function()
        return (opts.root or ".") .. "/tmp-" .. tostring(#system_calls + 1)
      end,
      glob = function(_)
        return opts.glob or ""
      end,
      filereadable = function(path)
        local f = io.open(path, "rb")
        if f then
          f:close()
          return 1
        end
        return 0
      end,
    },
    log = { levels = { ERROR = 1, WARN = 2, INFO = 3, DEBUG = 4, TRACE = 5 } },
    notify = function(message, level)
      table.insert(notifications, { message = message, level = level })
    end,
    uv = {
      fs_rename = function(src, dst)
        table.insert(promoted, { src = src, dst = dst })
        if opts.rename_fails then
          return nil, "rename failed"
        end
        os.rename(src, dst)
        return true
      end,
      fs_chmod = function(path, mode)
        table.insert(chmodded, { path = path, mode = mode })
        if opts.chmod_fails then
          return nil, "chmod failed"
        end
        return true
      end,
      fs_unlink = function(path)
        os.remove(path)
      end,
    },
    system = function(cmd, sys_opts)
      table.insert(system_calls, cmd)
      local name = cmd[1]
      local stdout = ""
      local stderr = ""
      local code = 0
      if name == "uname" and cmd[2] == "-s" then
        stdout = opts.os_name or "Darwin"
      elseif name == "uname" and cmd[2] == "-m" then
        stdout = opts.arch or "arm64"
      elseif name == "getconf" then
        stdout = opts.getconf or ""
        code = opts.getconf_code or 0
      elseif name == "ldd" then
        stdout = opts.ldd or ""
        stderr = opts.ldd_stderr or ""
        code = opts.ldd_code or 0
      elseif name == "curl" or name == "wget" then
        local output = name == "curl" and cmd[6] or cmd[3]
        write_file(output, downloads[cmd[#cmd]] or opts.download_data or "")
      elseif name == "xattr" then
        code = opts.xattr_code or 0
        stderr = opts.xattr_stderr or ""
      elseif name == "bun" and cmd[2] == "--version" then
        stdout = opts.bun_version or "1.3.10"
        code = opts.bun_version_code or 0
      elseif name == "bun" and cmd[2] == "build" then
        code = opts.bun_build_code or 0
        stderr = opts.bun_build_stderr or ""
        stdout = opts.bun_build_stdout or ""
        if code == 0 and not opts.bun_build_no_output then
          write_file(cmd[6], opts.bun_build_data or "fallback-binary")
        end
      end
      return {
        wait = function()
          return { code = code, stdout = stdout .. "\n", stderr = stderr }
        end,
      }
    end,
  }

  local install = require("interactive-graphviz.install")
  return install, system_calls, promoted, chmodded, notifications
end

local function make_root()
  local root = assert(io.popen("mktemp -d")):read("*l")
  assert(root ~= "")
  os.execute("mkdir -p " .. root .. "/dist/bin")
  return root
end

describe("install artifact mapping", function()
  after_each(function()
    package.loaded["interactive-graphviz.install"] = nil
    _G.vim = nil
  end)

  it("maps supported Darwin and Linux variants and rejects unsupported OS", function()
    local root = make_root()
    write_file(root .. "/checksums.txt", ("a"):rep(64) .. "  server-darwin-arm64\n")

    local install = load_install({ root = root, manifest_path = root .. "/checksums.txt" })
    assert.are.equal("server-darwin-x64", install._test.map_platform("Darwin", "x86_64").artifact)
    assert.are.equal("server-darwin-arm64", install._test.map_platform("Darwin", "arm64").artifact)
    assert.are.equal(
      "server-linux-x64",
      install._test.map_platform("Linux", "amd64", "glibc").artifact
    )
    assert.are.equal(
      "server-linux-arm64",
      install._test.map_platform("Linux", "aarch64", "glibc").artifact
    )
    assert.are.equal(
      "server-linux-x64-musl",
      install._test.map_platform("Linux", "x86_64", "musl").artifact
    )
    assert.are.equal(
      "server-linux-arm64-musl",
      install._test.map_platform("Linux", "arm64", "musl").artifact
    )
    assert.has_error(function()
      install._test.map_platform("Windows", "x86_64")
    end, "interactive-graphviz: no prebuilt binary for Windows-x86_64")
  end)
end)

describe("install manifest and verification", function()
  after_each(function()
    package.loaded["interactive-graphviz.install"] = nil
    _G.vim = nil
  end)

  it(
    "rejects malformed manifests, duplicates, missing artifacts, and checksum mismatches",
    function()
      local root = make_root()
      local install = load_install({ root = root, manifest_path = root .. "/checksums.txt" })

      assert.has_error(function()
        install._test.parse_manifest(root .. "/missing")
      end)

      write_file(root .. "/checksums.txt", "")
      assert.has_error(function()
        install._test.parse_manifest(root .. "/checksums.txt")
      end, "interactive-graphviz: checksums.txt is empty")

      write_file(root .. "/checksums.txt", "not-a-sha  server-darwin-arm64\n")
      assert.has_error(function()
        install._test.parse_manifest(root .. "/checksums.txt")
      end, "interactive-graphviz: malformed checksum line 1 in checksums.txt")

      write_file(
        root .. "/checksums.txt",
        ("a"):rep(64) .. "  server-darwin-arm64\n" .. ("b"):rep(64) .. "  server-darwin-arm64\n"
      )
      assert.has_error(function()
        install._test.parse_manifest(root .. "/checksums.txt")
      end, "interactive-graphviz: duplicate checksum entry for server-darwin-arm64")

      write_file(root .. "/checksums.txt", ("a"):rep(64) .. "  server-darwin-arm64\n")
      assert.has_error(function()
        install._test.expected_checksum(
          install._test.parse_manifest(root .. "/checksums.txt"),
          "server-linux-x64"
        )
      end, "interactive-graphviz: no checksum entry for server-linux-x64")

      write_file(root .. "/bad", "bad")
      assert.has_error(function()
        install._test.verify_file(root .. "/bad", ("a"):rep(64), "server-darwin-arm64")
      end)
    end
  )

  it("uses a verified cached binary without download", function()
    local root = make_root()
    local data = "cached-binary"
    local digest = sha256(data)
    write_file(root .. "/checksums.txt", digest .. "  server-darwin-arm64\n")
    write_file(root .. "/dist/bin/server-darwin-arm64", data)

    local install, calls = load_install({ root = root, manifest_path = root .. "/checksums.txt" })
    local cmd = install.resolve_server_cmd()

    assert.are.same({ root .. "/dist/bin/server-darwin-arm64" }, cmd)
    for _, call in ipairs(calls) do
      assert.are_not.equal("curl", call[1])
      assert.are_not.equal("wget", call[1])
    end
  end)

  it("prepares a verified cached binary before returning it", function()
    local root = make_root()
    local data = "cached-binary"
    local digest = sha256(data)
    write_file(root .. "/checksums.txt", digest .. "  server-darwin-arm64\n")
    write_file(root .. "/dist/bin/server-darwin-arm64", data)

    local install, calls, _, chmodded = load_install({
      root = root,
      manifest_path = root .. "/checksums.txt",
      executable = { curl = 1, wget = 0, xattr = 1 },
    })
    local cmd = install.resolve_server_cmd()

    assert.are.same({ root .. "/dist/bin/server-darwin-arm64" }, cmd)
    assert.are.equal(1, #chmodded)
    assert.are.equal(493, chmodded[1].mode)

    local saw_xattr = false
    for _, call in ipairs(calls) do
      if call[1] == "xattr" then
        saw_xattr = true
      end
    end
    assert.is_true(saw_xattr)
  end)

  it("does not hide macOS quarantine failures on a verified cached binary", function()
    local root = make_root()
    local data = "cached-binary"
    local digest = sha256(data)
    write_file(root .. "/checksums.txt", digest .. "  server-darwin-arm64\n")
    write_file(root .. "/dist/bin/server-darwin-arm64", data)

    local install = load_install({
      root = root,
      manifest_path = root .. "/checksums.txt",
      executable = { curl = 1, wget = 0, xattr = 1 },
      xattr_code = 1,
      xattr_stderr = "permission denied",
    })

    assert.has_error(function()
      install.resolve_server_cmd()
    end)
  end)

  it("does not promote corrupt downloads or return a runnable command", function()
    local root = make_root()
    write_file(root .. "/checksums.txt", sha256("expected") .. "  server-darwin-arm64\n")

    local install, _, promoted = load_install({
      root = root,
      manifest_path = root .. "/checksums.txt",
      download_data = "truncated",
    })

    assert.has_error(function()
      install.resolve_server_cmd()
    end)
    assert.are.equal(0, #promoted)
    assert.is_nil(io.open(root .. "/dist/bin/server-darwin-arm64", "rb"))
  end)

  it("downloads, verifies, promotes, chmods, and strips macOS quarantine", function()
    local root = make_root()
    local data = "release-binary"
    write_file(root .. "/checksums.txt", sha256(data) .. "  server-darwin-arm64\n")

    local install, calls, promoted, chmodded = load_install({
      root = root,
      manifest_path = root .. "/checksums.txt",
      download_data = data,
      executable = { curl = 1, wget = 0, xattr = 1 },
    })

    local cmd = install.resolve_server_cmd()
    assert.are.same({ root .. "/dist/bin/server-darwin-arm64" }, cmd)
    assert.are.equal(1, #promoted)
    assert.are.equal(root .. "/dist/bin/server-darwin-arm64", promoted[1].dst)
    assert.are.equal(493, chmodded[1].mode)

    local saw_xattr = false
    for _, call in ipairs(calls) do
      if call[1] == "xattr" then
        saw_xattr = true
        assert.are.equal("com.apple.quarantine", call[3])
      end
    end
    assert.is_true(saw_xattr)
  end)
end)

describe("source-build fallback for unsupported platforms", function()
  after_each(function()
    package.loaded["interactive-graphviz.install"] = nil
    _G.vim = nil
  end)

  local function fallback_opts(root, extra)
    local opts = {
      root = root,
      manifest_path = root .. "/checksums.txt",
      os_name = "Linux",
      arch = "riscv64", -- a known-named host with no prebuilt artifact
      getconf = "glibc 2.31",
      executable = { curl = 1, wget = 0, xattr = 0, bun = 1 },
    }
    for k, v in pairs(extra or {}) do
      opts[k] = v
    end
    return opts
  end

  it("builds from source and returns the compiled executable when Bun is present", function()
    local root = make_root()
    write_file(root .. "/checksums.txt", ("a"):rep(64) .. "  server-darwin-arm64\n")

    local install, calls, promoted, _, notifications =
      load_install(fallback_opts(root, { bun_version = "1.3.10" }))
    local cmd = install.resolve_server_cmd()

    assert.are.same({ root .. "/dist/source-build/server" }, cmd)
    assert.are.equal(root .. "/dist/source-build/server", promoted[#promoted].dst)

    local saw_build = false
    for _, call in ipairs(calls) do
      if call[1] == "bun" and call[2] == "build" then
        saw_build = true
        assert.are.equal("--compile", call[3])
      end
      assert.are_not.equal("curl", call[1]) -- never downloads on fallback
    end
    assert.is_true(saw_build)

    -- Loud, explicit, platform-named notice (AC 2).
    local saw_notice = false
    for _, n in ipairs(notifications) do
      if n.message:find("no prebuilt binary", 1, true) and n.message:find("Linux", 1, true) then
        saw_notice = true
      end
    end
    assert.is_true(saw_notice)
  end)

  it("fails fast naming Bun when Bun is missing (no download/compile/spawn)", function()
    local root = make_root()
    write_file(root .. "/checksums.txt", ("a"):rep(64) .. "  server-darwin-arm64\n")

    local install, calls = load_install(fallback_opts(root, {
      executable = { curl = 1, wget = 0, xattr = 0, bun = 0 },
    }))

    local ok, err = pcall(function()
      install.resolve_server_cmd()
    end)
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find("Bun", 1, true))

    for _, call in ipairs(calls) do
      assert.are_not.equal("curl", call[1])
      assert.is_false(call[1] == "bun" and call[2] == "build")
    end
  end)

  it("fails fast when Bun is older than the minimum", function()
    local root = make_root()
    write_file(root .. "/checksums.txt", ("a"):rep(64) .. "  server-darwin-arm64\n")

    local install, calls = load_install(fallback_opts(root, { bun_version = "1.2.9" }))

    local ok, err = pcall(function()
      install.resolve_server_cmd()
    end)
    assert.is_false(ok)
    assert.is_truthy(tostring(err):find("1.3.10", 1, true))

    for _, call in ipairs(calls) do
      assert.is_false(call[1] == "bun" and call[2] == "build")
    end
  end)

  it("cleans up and does not promote when the source build fails", function()
    local root = make_root()
    write_file(root .. "/checksums.txt", ("a"):rep(64) .. "  server-darwin-arm64\n")

    local install, _, promoted = load_install(fallback_opts(root, {
      bun_version = "1.3.10",
      bun_build_code = 1,
      bun_build_stderr = "compile error",
    }))

    local ok = pcall(function()
      install.resolve_server_cmd()
    end)
    assert.is_false(ok)
    assert.are.equal(0, #promoted)
    assert.is_nil(io.open(root .. "/dist/source-build/server", "rb"))
  end)

  it("returns a compiled executable path, never a `bun run` wrapper command", function()
    local root = make_root()
    write_file(root .. "/checksums.txt", ("a"):rep(64) .. "  server-darwin-arm64\n")

    local install = load_install(fallback_opts(root, { bun_version = "1.3.10" }))
    local cmd = install.resolve_server_cmd()

    assert.are.equal(1, #cmd)
    assert.are_not.equal("bun", cmd[1])
    assert.is_truthy(cmd[1]:find("source%-build"))
  end)

  it("parses and compares semver numerically", function()
    local root = make_root()
    write_file(root .. "/checksums.txt", ("a"):rep(64) .. "  server-darwin-arm64\n")
    local install = load_install(fallback_opts(root, { bun_version = "1.3.10" }))

    assert.are.same({ 1, 3, 10 }, install._test.parse_semver("1.3.10"))
    assert.are.same({ 1, 3, 10 }, install._test.parse_semver("v1.3.10+build"))
    assert.is_nil(install._test.parse_semver("not-a-version"))
    assert.is_true(install._test.semver_at_least({ 1, 3, 10 }, { 1, 3, 10 }))
    assert.is_true(install._test.semver_at_least({ 1, 4, 0 }, { 1, 3, 10 }))
    assert.is_false(install._test.semver_at_least({ 1, 3, 9 }, { 1, 3, 10 }))
    assert.is_false(install._test.semver_at_least({ 0, 9, 0 }, { 1, 3, 10 }))
  end)
end)
