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

if ($targetPid -gt 0) {
  & 'C:\Windows\System32\taskkill.exe' /PID $targetPid /F 2>&1 | Out-Null
  W "killed PID $targetPid"
}
Start-Sleep -Seconds 1
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($p in $pids) {
    & 'C:\Windows\System32\taskkill.exe' /PID $p /T /F 2>&1 | Out-Null
    W "killed port owner PID $p"
  }
}

$portFree = $false
for ($i = 0; $i -lt 20; $i++) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if (-not $c) { $portFree = $true; break }
  Start-Sleep -Milliseconds 500
}
if (-not $portFree) {
  $err = 'port still listening after kill - refusing to relaunch'
  W $err
  Write-Result @{ startedAt = $started; port = $port; pid = $targetPid; recovered = $false; attempts = 0; error = $err }
  exit 1
}
W 'port free'

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
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) {
      $pids = $c | Select-Object -ExpandProperty OwningProcess -Unique
      foreach ($p in $pids) {
        & 'C:\Windows\System32\taskkill.exe' /PID $p /T /F 2>&1 | Out-Null
        W "retry: killed port owner PID $p"
      }
      for ($i = 0; $i -lt 20; $i++) {
        $c2 = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if (-not $c2) { break }
        Start-Sleep -Milliseconds 500
      }
    }
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
