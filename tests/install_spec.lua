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
    },
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
      end
      return {
        wait = function()
          return { code = code, stdout = stdout .. "\n", stderr = stderr }
        end,
      }
    end,
  }

  local install = require("interactive-graphviz.install")
  return install, system_calls, promoted, chmodded
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
