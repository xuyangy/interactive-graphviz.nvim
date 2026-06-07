local M = {}

-- Prebuilt trust root: this tag's assets must match committed checksums.txt.
local GITHUB_REPO = "xuyangy/interactive-graphviz.nvim"
local RELEASE_TAG = "v0.1.1"
local BIN_DIR = "dist/bin"
-- Source-build fallback artifacts live under an ignored path (dist/ is gitignored)
-- and are NEVER added to the committed checksums.txt trust root.
local FALLBACK_DIR = "dist/source-build"
-- Minimum Bun required to `--compile` the server from source. Local validation
-- environment runs Bun 1.3.10; keep this in sync with the documented prerequisite.
local MIN_BUN_VERSION = { 1, 3, 10 }
local MIN_BUN_STRING = "1.3.10"

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
  arch = trim(arch):lower()
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

  -- Windows ships a single x64 prebuilt (`bun --compile` has no windows-arm64
  -- target). Windows-arm64 falls through to the source-build fallback.
  if os_name == "Windows" and arch == "x64" then
    return { artifact = "server-windows-x64.exe", platform = os_name .. "-" .. trim(arch_name) }
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

-- Resolves the raw uname triple. Detection failures (uname itself failing, or an
-- unknown Linux libc) still hard-fail: we cannot source-build for a host we cannot
-- even name. Only a *known* host with no prebuilt artifact becomes fallback.
local function detect_host()
  -- Windows has no `uname`; identify it with Vim's own platform predicate and
  -- read the CPU from the environment. PROCESSOR_ARCHITEW6432 is set when a 32-bit
  -- process runs under WoW64 and reports the true (64-bit) host arch.
  if vim.fn.has("win32") == 1 or vim.fn.has("win64") == 1 then
    local arch_name = trim(vim.env.PROCESSOR_ARCHITEW6432 or vim.env.PROCESSOR_ARCHITECTURE or "")
    if arch_name == "" then
      arch_name = "AMD64"
    end
    return "Windows", arch_name, nil
  end

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
  return os_name, arch_name, libc
end

-- Returns structured platform context instead of throwing on an unsupported host,
-- so resolve_server_cmd() can route a known-but-uncovered platform into the
-- source-build fallback rather than the Story 3.2 terminal error. A truly
-- undetectable host (uname failure / unknown libc) still propagates as an error.
local function resolve_platform()
  local os_name, arch_name, libc = detect_host()
  local label = os_name == "Linux"
      and (trim(os_name) .. "-" .. trim(arch_name) .. "-" .. tostring(libc or "unknown-libc"))
    or (trim(os_name) .. "-" .. trim(arch_name))

  local ok, mapped = pcall(map_platform, os_name, arch_name, libc)
  if ok then
    mapped.supported = true
    mapped.os_name = os_name
    return mapped
  end

  return {
    supported = false,
    os_name = os_name,
    arch_name = arch_name,
    platform = label,
  }
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

-- Pull the first 64-hex (SHA-256) token out of a hashing tool's stdout. Works for
-- `sha256sum`/`shasum` ("<hash>  <path>") and `openssl dgst` ("...= <hash>").
local function extract_sha256(text)
  for token in tostring(text):gmatch("%x+") do
    if #token == 64 then
      return token:lower()
    end
  end
  return nil
end

-- SHA-256 of a file's bytes. We deliberately do NOT use vim.fn.sha256: Neovim
-- converts a Lua string containing NUL bytes into a Blob at the Lua/Vimscript
-- boundary, and sha256() rejects a Blob ("E976: Using a Blob as a String"), so it
-- cannot hash a real (NUL-containing) binary at all. Shell out (list-form, no shell
-- string) to a standard tool instead; its hex digest matches the Node crypto digests
-- committed in checksums.txt. Returns nil on a missing file (treated as a cache miss).
local function digest_file(path)
  if vim.fn.filereadable(path) ~= 1 then
    return nil, "not readable: " .. tostring(path)
  end

  local candidates = {
    { "sha256sum", path },
    { "shasum", "-a", "256", path },
    { "openssl", "dgst", "-sha256", path },
  }

  local tried = false
  for _, cmd in ipairs(candidates) do
    if vim.fn.executable(cmd[1]) == 1 then
      tried = true
      local result = run(cmd, { text = true })
      if result.code == 0 then
        local hex = extract_sha256(result.stdout)
        if hex then
          return hex
        end
      end
    end
  end

  if tried then
    return nil, "SHA-256 tool failed to produce a digest for " .. tostring(path)
  end
  return nil, "no SHA-256 tool found on PATH (need sha256sum, shasum, or openssl)"
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

-- ── Source-build fallback (AC 1-6) ───────────────────────────────────────────
-- Used only for a *known* host that has no prebuilt artifact. Builds the server
-- with Bun's single-file `--compile` (same shape as scripts/release.ts), promotes
-- the verified output under an ignored path, and returns it so server.lua can
-- spawn the compiled executable directly (no `bun run` wrapper => no orphan risk).

-- Loud, user-visible notice. Surfaced through vim.notify so it is discoverable
-- and not buried in debug logs (AC 2).
local function notify(message, level)
  pcall(vim.notify, "interactive-graphviz: " .. message, level or vim.log.levels.WARN)
end

-- Parse a bun --version string ("1.3.10" possibly with trailing build text)
-- into a numeric {major, minor, patch}. Returns nil on unparseable input.
local function parse_semver(text)
  local major, minor, patch = trim(text):match("^v?(%d+)%.(%d+)%.(%d+)")
  if not major then
    return nil
  end
  return { tonumber(major), tonumber(minor), tonumber(patch) }
end

-- Numeric semver comparison: returns true when `have` >= `want`.
local function semver_at_least(have, want)
  for i = 1, 3 do
    local h = have[i] or 0
    local w = want[i] or 0
    if h > w then
      return true
    end
    if h < w then
      return false
    end
  end
  return true
end

-- Discover Bun and verify it meets the minimum. Fails fast (no download, compile,
-- or spawn) with copy naming Bun as the missing prerequisite (AC 3).
local function require_bun(platform_label)
  if not executable("bun") then
    fail(
      "no prebuilt binary for "
        .. platform_label
        .. "; source-build fallback requires Bun >= "
        .. MIN_BUN_STRING
        .. " but `bun` was not found on PATH"
    )
  end

  local result = run({ "bun", "--version" })
  local have = result.code == 0 and parse_semver(result.stdout) or nil
  if not have then
    fail(
      "source-build fallback requires Bun >= "
        .. MIN_BUN_STRING
        .. " but `bun --version` could not be parsed: "
        .. trim(result.stdout .. " " .. result.stderr)
    )
  end

  if not semver_at_least(have, MIN_BUN_VERSION) then
    fail(
      "source-build fallback requires Bun >= "
        .. MIN_BUN_STRING
        .. " but found "
        .. table.concat(have, ".")
    )
  end
end

-- Build the server from source with Bun and promote a verified compiled binary.
-- Build runs from the plugin root (not caller cwd). On failure: surface concise
-- stdout/stderr, clean up the temp file, and never overwrite a known-good binary.
local function build_from_source(root, platform_label, os_name)
  notify(
    "no prebuilt binary for "
      .. platform_label
      .. "; building from source, requires Bun >= "
      .. MIN_BUN_STRING,
    vim.log.levels.WARN
  )

  require_bun(platform_label)

  local out_dir = path_join(root, FALLBACK_DIR)
  vim.fn.mkdir(out_dir, "p")
  local final_path = path_join(out_dir, os_name == "Windows" and "server.exe" or "server")
  local tmp_path = path_join(out_dir, ".server." .. basename(vim.fn.tempname()) .. ".tmp")
  remove_file(tmp_path)

  -- Single-file compile from the plugin root; static.ts embedding is preserved
  -- because `bun build --compile` bundles the server/static.ts -> frontend graph.
  local cmd = {
    "bun",
    "build",
    "--compile",
    path_join(root, "server", "server.ts"),
    "--outfile",
    tmp_path,
  }

  local ok, err = pcall(function()
    local result = run(cmd, { text = true, cwd = root })
    if result.code ~= 0 then
      fail(
        "source build failed for "
          .. platform_label
          .. " (`bun build --compile`): "
          .. trim(result.stderr .. " " .. result.stdout)
      )
    end
    if vim.fn.filereadable(tmp_path) ~= 1 then
      fail("source build for " .. platform_label .. " produced no output binary")
    end
    promote(tmp_path, final_path)
    prepare_binary_for_spawn(final_path, os_name)
  end)

  if not ok then
    remove_file(tmp_path)
    error(err, 0)
  end

  notify("source build complete: " .. final_path, vim.log.levels.INFO)
  return final_path
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
  local root = plugin_root()
  local platform = resolve_platform()
  local os_name = platform.os_name

  -- Known host with no prebuilt artifact: source-build fallback (AC 1, 9). The
  -- supported prebuilt path below never requires Bun on a verified cache hit.
  if not platform.supported then
    local binary_path = build_from_source(root, platform.platform, os_name)
    return { binary_path }
  end

  local _, manifest_path = plugin_root()
  local manifest = parse_manifest(manifest_path)
  local expected = expected_checksum(manifest, platform.artifact)
  local binary_path = ensure_binary(root, platform.artifact, expected, os_name)
  return { binary_path }
end

-- ── Health introspection (AC 7) ──────────────────────────────────────────────
-- Read-only helpers for :checkhealth. These never throw: callers get structured
-- results so health.lua can render ok/warn/error without aborting the report.

M.MIN_BUN_STRING = MIN_BUN_STRING

function M.plugin_root()
  local ok, root, manifest_path = pcall(plugin_root)
  if not ok then
    return nil, nil, tostring(root)
  end
  return root, manifest_path
end

-- Inspect the currently mapped prebuilt binary (if the host has one) and report
-- whether it is present and whether its checksum matches committed checksums.txt.
function M.inspect_prebuilt()
  local result = { supported = false }
  local ok, platform = pcall(resolve_platform)
  if not ok then
    result.error = tostring(platform)
    return result
  end
  result.platform = platform.platform
  result.supported = platform.supported
  if not platform.supported then
    return result
  end
  result.artifact = platform.artifact

  local root, manifest_path = M.plugin_root()
  if not root then
    result.error = manifest_path
    return result
  end

  local parsed, manifest = pcall(parse_manifest, manifest_path)
  if not parsed then
    result.error = tostring(manifest)
    return result
  end

  result.expected = manifest[platform.artifact]
  local final_path = path_join(root, BIN_DIR, platform.artifact)
  result.binary_path = final_path
  if vim.fn.filereadable(final_path) ~= 1 then
    result.present = false
    return result
  end
  result.present = true
  local digest = digest_file(final_path)
  result.actual = digest and digest:lower() or nil
  result.checksum_match = result.actual ~= nil
    and result.expected ~= nil
    and result.actual == result.expected
  return result
end

-- Report Bun availability/version for source-build fallback. Does not require Bun.
function M.inspect_bun()
  if not executable("bun") then
    return { present = false, min = MIN_BUN_STRING }
  end
  local out = run({ "bun", "--version" })
  local version = trim(out.stdout)
  local have = out.code == 0 and parse_semver(out.stdout) or nil
  return {
    present = true,
    version = version,
    parsed = have,
    ok = have ~= nil and semver_at_least(have, MIN_BUN_VERSION),
    min = MIN_BUN_STRING,
  }
end

M._test = {
  map_platform = map_platform,
  parse_manifest = parse_manifest,
  expected_checksum = expected_checksum,
  verify_file = verify_file,
  digest_file = digest_file,
  extract_sha256 = extract_sha256,
  release_url = release_url,
  parse_semver = parse_semver,
  semver_at_least = semver_at_least,
}

return M
