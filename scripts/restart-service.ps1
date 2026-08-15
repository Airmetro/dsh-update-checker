# restart-service.ps1 — 重启 dsh web 服务（供 dsh-update-checker 与手动激活使用）
# 注意：本文件为 UTF-8 with BOM（Windows PowerShell 5.1 无 BOM 时按 ANSI 解码，中文路径会乱码）。
# 用法（ExecutionPolicy 受限，必须带 -ExecutionPolicy Bypass 运行）：
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File restart-service.ps1 [-DelaySeconds 3]
# 流程：等待 DelaySeconds → 杀掉 3080 端口监听进程 → 等待端口释放 → 拉起 start-dsh.cmd
param([int]$DelaySeconds = 3)

$ErrorActionPreference = "Stop"
$port = 3080
$launcher = "D:\应用\DeepSeek-Harness\start-dsh.cmd"
$workingDir = "D:\应用\DeepSeek-Harness"
$log = "D:\AI办公\dsh-update-checker\restart-log.txt"

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $log -Value $line -Encoding utf8
}

Log "restart scheduled (delay ${DelaySeconds}s)"
Start-Sleep -Seconds $DelaySeconds

$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($p in $pids) {
    Log "killing PID $p on port $port"
    & 'C:\Windows\System32\taskkill.exe' /PID $p /F 2>&1 | Out-Null
  }
} else {
  Log "no listener on port $port"
}

# 等待端口释放（最长 20 秒）
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if (-not $still) { break }
  Start-Sleep -Milliseconds 500
}
$still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($still) {
  Log "PORT $port STILL LISTENING AFTER KILL — ABORT (no relaunch)"
  exit 1
}

Start-Sleep -Seconds 1
Log "relaunching $launcher"
Start-Process -FilePath $launcher -WorkingDirectory $workingDir -WindowStyle Hidden
Log "done"
