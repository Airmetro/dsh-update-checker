# restart-watchdog.ps1 — kill -> relaunch -> watchdog (runs as detached grandchild)
# Parameters passed via environment variables (avoids -Command/-ArgumentList CJK path encoding issues):
#   DSH_RESTART_PORT        — 服务监听端口（恢复探测用）
#   DSH_RESTART_PID         — 当前 dsh web 进程 PID（首选击杀目标）
#   DSH_RESTART_NODE_FILE   — 派生启动：node 全路径（与 DSH_RESTART_NODE_ARGS 成对）
#   DSH_RESTART_NODE_ARGS   — 派生启动：进程 argv 剩余部分（JSON 数组）
#   DSH_RESTART_LAUNCHER    — 回退启动：启动脚本路径（仅当上面两者缺失时使用）
#   DSH_RESTART_WORKDIR     — 工作目录
#   DSH_RESTART_LOG         — 日志文件
#   DSH_RESTART_RESULT      — 结果 JSON 文件（供 /restart-status.json 读取）
$ErrorActionPreference = 'Continue'
$port = [int]$env:DSH_RESTART_PORT
$targetPid = [int]$env:DSH_RESTART_PID
$nodeFile = $env:DSH_RESTART_NODE_FILE
$nodeArgsJson = $env:DSH_RESTART_NODE_ARGS
$launcher = $env:DSH_RESTART_LAUNCHER
$workingDir = $env:DSH_RESTART_WORKDIR
$log = $env:DSH_RESTART_LOG
$resultFile = $env:DSH_RESTART_RESULT

function W($msg) {
  if ($log) { "$(Get-Date -Format 'HH:mm:ss') $msg" | Out-File -FilePath $log -Append -Encoding utf8 }
}

function Write-Result([hashtable]$r) {
  if ($resultFile) {
    try { $r | ConvertTo-Json -Compress | Out-File -FilePath $resultFile -Encoding utf8 }
    catch { W "result write failed: $_" }
  }
}

$started = (Get-Date).ToString('o')
W 'watchdog-start'
Write-Result @{ startedAt = $started; port = $port; pid = $targetPid; recovered = $false; attempts = 0; error = '' }

Start-Sleep -Seconds 2

# ── 击杀：首选按 PID（当前进程），再按端口兜底 ──
if ($targetPid -gt 0) {
  & 'C:\Windows\System32\taskkill.exe' /PID $targetPid /F 2>&1 | Out-Null
  W "killed PID $targetPid"
}
Start-Sleep -Seconds 1
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($p in $pids) {
    & 'C:\Windows\System32\taskkill.exe' /PID $p /F 2>&1 | Out-Null
    W "killed port owner PID $p"
  }
}
Start-Sleep -Seconds 1

# ── 拉起：派生启动（node + argv，最可靠）→ 回退启动脚本 ──
function Start-Reload {
  if ($nodeFile -and $nodeArgsJson) {
    try {
      $nodeArgs = @($nodeArgsJson | ConvertFrom-Json)
      $quoted = @($nodeArgs | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' })
      Start-Process -FilePath $nodeFile -ArgumentList $quoted -WorkingDirectory $workingDir -WindowStyle Hidden
      W "relaunched node: $nodeFile"
      return $true
    }
    catch { W "node relaunch failed: $_" }
  }
  if ($launcher) {
    Start-Process -FilePath $launcher -WorkingDirectory $workingDir -WindowStyle Hidden
    W "relaunched launcher: $launcher"
    return $true
  }
  return $false
}

$relaunched = Start-Reload
if (-not $relaunched) {
  $err = 'no launcher available (no node args and no launcher)'
  W $err
  Write-Result @{ startedAt = $started; port = $port; pid = $targetPid; recovered = $false; attempts = 0; error = $err }
  exit 1
}

# ── 恢复确认：端口监听 + HTTP 200（/dsh-update-checker/status.json），最多 3 轮 × 30 秒 ──
$recovered = $false
$attempts = 0
for ($round = 1; $round -le 3 -and -not $recovered; $round++) {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and -not $recovered) {
    $attempts++
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) {
      try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $port + "/dsh-update-checker/status.json") -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $recovered = $true; break }
      }
      catch { }
    }
    Start-Sleep -Milliseconds 2000
  }
  if (-not $recovered -and $round -lt 3) {
    W "watchdog retry $round"
    Start-Reload | Out-Null
  }
}

$recoveredAt = if ($recovered) { (Get-Date).ToString('o') } else { $null }
if ($recovered) {
  W "watchdog recovered (${attempts} tries)"
  Write-Result @{ startedAt = $started; port = $port; pid = $targetPid; recovered = $true; recoveredAt = $recoveredAt; attempts = $attempts; error = '' }
}
else {
  W 'watchdog FAILED after 3 retries'
  Write-Result @{ startedAt = $started; port = $port; pid = $targetPid; recovered = $false; attempts = $attempts; error = 'service did not recover within 90s' }
}
W 'watchdog-done'
