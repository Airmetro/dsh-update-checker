param(
  [int]$DelaySeconds = 3,
  [int]$Port = 3080,
  [string]$Launcher = $env:DSH_RESTART_LAUNCHER,
  [string]$WorkingDir = $env:DSH_RESTART_WORKDIR,
  [string]$Log = $env:DSH_RESTART_LOG
)

$ErrorActionPreference = "Stop"

if (-not $Launcher) {
  Write-Host "launcher 未指定：请传 -Launcher <path> 或设置环境变量 DSH_RESTART_LAUNCHER" -ForegroundColor Red
  exit 2
}
if (-not $WorkingDir) { $WorkingDir = Split-Path -Parent $Launcher }
if (-not $Log) { $Log = Join-Path $env:TEMP "dsh-update-checker-restart.log" }

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $Log -Value $line -Encoding utf8
}

Log "restart scheduled (delay ${DelaySeconds}s, port $Port)"
Start-Sleep -Seconds $DelaySeconds

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($p in $pids) {
    Log "killing PID $p on port $Port"
    & 'C:\Windows\System32\taskkill.exe' /PID $p /F 2>&1 | Out-Null
  }
} else {
  Log "no listener on port $Port"
}

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $still) { break }
  Start-Sleep -Milliseconds 500
}
$still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($still) {
  Log "PORT $Port STILL LISTENING AFTER KILL - ABORT (no relaunch)"
  exit 1
}

Start-Sleep -Seconds 1
Log "relaunching $Launcher"
Start-Process -FilePath $Launcher -WorkingDirectory $WorkingDir -WindowStyle Hidden
Log "done"
