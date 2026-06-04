local M = {}

-- Prebuilt trust root: this tag's assets must match committed checksums.txt.
-- Source-build fallback is intentionally deferred to Story 3.3.
local GITHUB_REPO = "xuyangy/interactive-graphviz.nvim"
local RELEASE_TAG = "v0.1.0"
local BIN_DIR = "dist/bin"

local function fail(message)
  error("interactive-graphviz: " .. message, 0)
end

local function trim(value)
  return (tostring(value or ""):gsub("^%s+", ""):gsub("%s+$", ""))
end

local function path_join(...)
  local parts = { ... }
  local path = table.concat(parts, "/")
  path = path:gsub("/+", "/")
  return path
end

local function basename(path)
  return tostring(path):match("([^/]+)$") or "download"
end

local function read_binary(path)
  local file, err = io.open(path, "rb")
  if not file then
    return nil, err
  end
  local data = file:read("*a")
  file:close()
  return data
end

local function run(cmd, opts)
  local ok, obj = pcall(vim.system, cmd, opts or { text = true })
  if not ok or not obj then
    return { code = 127, stdout = "", stderr = tostring(obj) }
  end
  local result = obj:wait()
  return {
    code = result.code or 0,
    stdout = result.stdout or "",
    stderr = result.stderr or "",
  }
end

local function normalize_arch(arch)
  arch = trim(arch)
  if arch == "x86_64" or arch == "amd64" then
    return "x64"
  end
  if arch == "aarch64" or arch == "arm64" then
    return "arm64"
  end
  return nil
end

local function map_platform(os_name, arch_name, libc)
  local arch = normalize_arch(arch_name)
  if os_name == "Darwin" and arch then
    return { artifact = "server-darwin-" .. arch, platform = os_name .. "-" .. trim(arch_name) }
  end

  if os_name == "Linux" and arch then
    if libc == "glibc" then
      return {
        artifact = "server-linux-" .. arch,
        platform = os_name .. "-" .. trim(arch_name) .. "-glibc",
      }
    end
    if libc == "musl" then
      return {
        artifact = "server-linux-" .. arch .. "-musl",
        platform = os_name .. "-" .. trim(arch_name) .. "-musl",
      }
    end
    fail(
      "no prebuilt binary for Linux-" .. trim(arch_name) .. "-" .. tostring(libc or "unknown-libc")
    )
  end

  fail("no prebuilt binary for " .. trim(os_name) .. "-" .. trim(arch_name))
end

local function detect_linux_libc()
  local getconf = run({ "getconf", "GNU_LIBC_VERSION" })
  if getconf.code == 0 and trim(getconf.stdout):lower():find("glibc", 1, true) then
    return "glibc"
  end

  local ldd = run({ "ldd", "--version" })
  local ldd_text = (ldd.stdout .. "\n" .. ldd.stderr):lower()
  if ldd_text:find("musl", 1, true) then
    return "musl"
  end
  if ldd_text:find("glibc", 1, true) or ldd_text:find("gnu libc", 1, true) then
    return "glibc"
  end

  if vim.fn.glob("/lib/ld-musl-*.so.*") ~= "" or vim.fn.glob("/usr/lib/ld-musl-*.so.*") ~= "" then
    return "musl"
  end

  fail("no prebuilt binary for Linux-unknown-libc")
end

local function detect_platform()
  local os_result = run({ "uname", "-s" })
  if os_result.code ~= 0 or trim(os_result.stdout) == "" then
    fail("failed to detect OS with uname -s: " .. trim(os_result.stderr))
  end

  local arch_result = run({ "uname", "-m" })
  if arch_result.code ~= 0 or trim(arch_result.stdout) == "" then
    fail("failed to detect architecture with uname -m: " .. trim(arch_result.stderr))
  end

  local os_name = trim(os_result.stdout)
  local arch_name = trim(arch_result.stdout)
  local libc = os_name == "Linux" and detect_linux_libc() or nil
  return map_platform(os_name, arch_name, libc)
end

local function plugin_root()
  local matches = vim.api.nvim_get_runtime_file("checksums.txt", false)
  local manifest_path = matches[1]
  if not manifest_path then
    fail("could not locate committed checksums.txt on runtimepath")
  end
  local root = manifest_path:gsub("/checksums%.txt$", "")
  if root == manifest_path then
    fail("could not derive plugin root from checksums.txt path")
  end
  return root, manifest_path
end

local function parse_manifest(manifest_path)
  local content, err = read_binary(manifest_path)
  if not content then
    fail("could not read checksums.txt: " .. tostring(err))
  end
  if content == "" then
    fail("checksums.txt is empty")
  end

  if content:sub(-1) == "\n" then
    content = content:sub(1, -2)
  end
  if content == "" then
    fail("checksums.txt is empty")
  end

  local entries = {}
  local count = 0
  local line_no = 0
  local pos = 1
  while pos <= #content do
    local newline = content:find("\n", pos, true)
    local line = newline and content:sub(pos, newline - 1) or content:sub(pos)
    line_no = line_no + 1
    if line == "" then
      fail("malformed checksum line " .. line_no .. " in checksums.txt")
    end
    local sha, artifact = line:match("^([0-9a-fA-F]+)  ([%w%-%.]+)$")
    if not sha or #sha ~= 64 then
      fail("malformed checksum line " .. line_no .. " in checksums.txt")
    end
    if entries[artifact] then
      fail("duplicate checksum entry for " .. artifact)
    end
    entries[artifact] = sha:lower()
    count = count + 1
    if not newline then
      break
    end
    pos = newline + 1
  end

  if count == 0 then
    fail("checksums.txt is empty")
  end
  return entries
end

local function expected_checksum(manifest, artifact)
  local checksum = manifest[artifact]
  if not checksum then
    fail("no checksum entry for " .. artifact)
  end
  return checksum
end

local function digest_file(path)
  local data, err = read_binary(path)
  if not data then
    return nil, err
  end
  return vim.fn.sha256(data)
end

local function verify_file(path, expected, artifact)
  local actual, err = digest_file(path)
  if not actual then
    fail("could not read " .. artifact .. " for checksum verification: " .. tostring(err))
  end
  if actual:lower() ~= expected then
    fail("checksum mismatch for " .. artifact .. ": expected " .. expected .. ", got " .. actual)
  end
end

local function executable(cmd)
  return vim.fn.executable(cmd) == 1
end

local function release_url(artifact)
  return "https://github.com/"
    .. GITHUB_REPO
    .. "/releases/download/"
    .. RELEASE_TAG
    .. "/"
    .. artifact
end

local function remove_file(path)
  pcall(vim.uv.fs_unlink, path)
end

local function download_to_tmp(url, tmp_path)
  local cmd
  if executable("curl") then
    cmd = { "curl", "-fL", "--retry", "3", "--output", tmp_path, url }
  elseif executable("wget") then
    cmd = { "wget", "-O", tmp_path, url }
  else
    fail("no supported download tool found; install curl or wget")
  end

  local result = run(cmd, { text = true })
  if result.code ~= 0 then
    remove_file(tmp_path)
    fail("download failed for " .. url .. ": " .. trim(result.stderr .. " " .. result.stdout))
  end
end

local function promote(tmp_path, final_path)
  local ok, err = vim.uv.fs_rename(tmp_path, final_path)
  if not ok then
    remove_file(tmp_path)
    fail("atomic rename failed for " .. final_path .. ": " .. tostring(err))
  end
end

local function quarantine_absent(text)
  text = text:lower()
  return text:find("no such xattr", 1, true) or text:find("attribute not found", 1, true)
end

local function strip_macos_quarantine(path)
  if not executable("xattr") then
    return
  end

  local result = run({ "xattr", "-d", "com.apple.quarantine", path }, { text = true })
  if result.code ~= 0 then
    local text = trim(result.stderr .. " " .. result.stdout)
    if text ~= "" and quarantine_absent(text) then
      return
    end
    fail("failed to strip macOS quarantine from " .. path .. ": " .. text)
  end
end

local function prepare_binary_for_spawn(final_path, os_name)
  local chmod_ok, chmod_err = vim.uv.fs_chmod(final_path, 493)
  if not chmod_ok then
    fail("failed to apply executable mode to " .. final_path .. ": " .. tostring(chmod_err))
  end

  if os_name == "Darwin" then
    strip_macos_quarantine(final_path)
  end
end

local function ensure_binary(root, artifact, expected, os_name)
  local bin_dir = path_join(root, BIN_DIR)
  local final_path = path_join(bin_dir, artifact)

  local existing_digest = digest_file(final_path)
  if existing_digest and existing_digest:lower() == expected then
    prepare_binary_for_spawn(final_path, os_name)
    return final_path
  end

  vim.fn.mkdir(bin_dir, "p")
  local tmp_path =
    path_join(bin_dir, "." .. artifact .. "." .. basename(vim.fn.tempname()) .. ".tmp")
  remove_file(tmp_path)

  local ok, err = pcall(function()
    download_to_tmp(release_url(artifact), tmp_path)
    verify_file(tmp_path, expected, artifact)
    promote(tmp_path, final_path)
    prepare_binary_for_spawn(final_path, os_name)
  end)
  if not ok then
    remove_file(tmp_path)
    error(err, 0)
  end

  return final_path
end

function M.resolve_server_cmd()
  local root, manifest_path = plugin_root()
  local platform = detect_platform()
  local manifest = parse_manifest(manifest_path)
  local expected = expected_checksum(manifest, platform.artifact)
  local binary_path = ensure_binary(
    root,
    platform.artifact,
    expected,
    platform.platform:match("^Darwin") and "Darwin" or nil
  )
  return { binary_path }
end

M._test = {
  map_platform = map_platform,
  parse_manifest = parse_manifest,
  expected_checksum = expected_checksum,
  verify_file = verify_file,
  release_url = release_url,
}

return M
