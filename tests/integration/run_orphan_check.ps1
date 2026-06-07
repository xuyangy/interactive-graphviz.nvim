# Windows no-orphan verification — PowerShell mirror of run_orphan_check.sh.
#
# Spawns a headless Neovim that starts the server, force-kills the Neovim
# (Stop-Process -Force => TerminateProcess, so VimLeavePre never fires), and
# asserts the server is reaped within the window. This verifies the load-bearing
# no-orphan guarantee on Windows: when the parent dies, the OS closes the child's
# stdin pipe (EOF) and the Bun server self-terminates (server.ts stdin loop).
#
# IG_HEARTBEAT_TIMEOUT_MS is set far above the reap window so this gate can ONLY
# pass via the stdin-EOF path, never the heartbeat backstop — the same strict
# contract as the POSIX gate (orphan_spec.lua / run_orphan_check.sh). The
# heartbeat backstop itself is covered cross-platform by server/supervisor.test.ts
# (run under `bun test` on windows-latest in CI).
#
# Requires `nvim` on PATH and a resolvable server binary (resolve_server_cmd
# downloads the tag-pinned server-windows-x64.exe prebuilt on first run).

$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

$pidFile = Join-Path $env:TEMP ("ig_orphan_" + [System.Guid]::NewGuid().ToString("N") + ".pid")
if (Test-Path $pidFile) { Remove-Item $pidFile -Force }
$env:IG_PID_FILE = $pidFile
$env:IG_HEARTBEAT_TIMEOUT_MS = "30000"

$childLog = Join-Path $env:TEMP "ig_orphan_child.log"
$child = Start-Process -FilePath "nvim" `
  -ArgumentList @("--headless", "-u", "tests/minimal_init.lua", "-l", "tests/integration/orphan_child.lua") `
  -PassThru -NoNewWindow -RedirectStandardOutput $childLog -RedirectStandardError "$childLog.err"

$serverPid = ""
for ($i = 0; $i -lt 150; $i++) {
  if ((Test-Path $pidFile) -and ((Get-Item $pidFile).Length -gt 0)) {
    $serverPid = (Get-Content $pidFile -Raw).Trim()
    if ($serverPid -ne "") { break }
  }
  Start-Sleep -Milliseconds 100
}

if ($serverPid -eq "" -or $serverPid -eq "ERROR_NOT_READY") {
  Write-Host "FAIL: server never became ready (got '$serverPid')"
  if (Test-Path $childLog) { Get-Content $childLog }
  if (Test-Path "$childLog.err") { Get-Content "$childLog.err" }
  Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  exit 1
}

$serverPidInt = [int]$serverPid
if (-not (Get-Process -Id $serverPidInt -ErrorAction SilentlyContinue)) {
  Write-Host "FAIL: server pid=$serverPid not alive before kill"
  Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host "server pid=$serverPid alive; force-killing parent nvim pid=$($child.Id)"
Stop-Process -Id $child.Id -Force

$reaped = $false
for ($i = 1; $i -le 60; $i++) {
  if (-not (Get-Process -Id $serverPidInt -ErrorAction SilentlyContinue)) {
    $reaped = $true
    Write-Host "reaped within ~$($i)00ms"
    break
  }
  Start-Sleep -Milliseconds 100
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
if ($reaped) {
  Write-Host "PASS: no-orphan gate green (Windows, stdin-EOF path)"
  exit 0
}
Write-Host "FAIL: server pid=$serverPid orphaned after parent force-kill"
Stop-Process -Id $serverPidInt -Force -ErrorAction SilentlyContinue
exit 1
