# restart-watchdog.ps1 — kill port listener -> relaunch -> watchdog (runs as detached grandchild)
# Parameters passed via environment variables (avoids -Command/-ArgumentList CJK path encoding issues):
#   DSH_RESTART_PORT / DSH_RESTART_LAUNCHER / DSH_RESTART_WORKDIR / DSH_RESTART_LOG
$ErrorActionPreference = 'Continue'
$port = [int]$env:DSH_RESTART_PORT
$launcher = $env:DSH_RESTART_LAUNCHER
$workingDir = $env:DSH_RESTART_WORKDIR
$log = $env:DSH_RESTART_LOG

function W($msg) {
  if ($log) { "$(Get-Date -Format 'HH:mm:ss') $msg" | Out-File -FilePath $log -Append -Encoding utf8 }
}

W 'watchdog-start'
Start-Sleep -Seconds 2

$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($p in $pids) { & 'C:\Windows\System32\taskkill.exe' /PID $p /F 2>&1 | Out-Null }
}

Start-Sleep -Seconds 1
Start-Process -FilePath $launcher -WorkingDirectory $workingDir -WindowStyle Hidden

$recovered = $false
for ($i = 0; $i -lt 3 -and -not $recovered; $i++) {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) { $recovered = $true; break }
    Start-Sleep -Milliseconds 1500
  }
  if (-not $recovered -and $i -lt 2) {
    W "watchdog retry $($i + 1)"
    Start-Process -FilePath $launcher -WorkingDirectory $workingDir -WindowStyle Hidden
  }
}

if ($recovered) { W 'watchdog recovered' } else { W 'watchdog FAILED after 3 retries' }
W 'watchdog-done'
