# restart-service.ps1 — 重启 dsh web 服务（供 dsh-update-checker 与手动激活使用）
# 注意：本文件必须为 UTF-8 with BOM（Windows PowerShell 5.1 无 BOM 时按 ANSI 解码，中文会乱码）。
# 用法（ExecutionPolicy 受限，必须带 -ExecutionPolicy Bypass 运行）：
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File restart-service.ps1 [-DelaySeconds 3]
# 本脚本不硬编码任何机器路径：端口 / 启动器 / 工作目录 / 日志路径均由参数或环境变量提供。
#   参数优先：-Port / -Launcher / -WorkingDir / -Log；
#   缺省回退到环境变量 DSH_RESTART_PORT / DSH_RESTART_LAUNCHER / DSH_RESTART_WORKDIR / DSH_RESTART_LOG
#   （dsh-update-checker 的重看门狗流程正是这样注入的）；Launcher 仍缺失则报错退出。
# 流程：等待 DelaySeconds → 杀掉端口监听进程 → 等待端口释放 → 拉起启动脚本。
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

# 等待端口释放（最长 20 秒）
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
