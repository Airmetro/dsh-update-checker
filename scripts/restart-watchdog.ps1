$ErrorActionPreference = 'Continue'
$port = [int]$env:DSH_RESTART_PORT
$targetPid = [int]$env:DSH_RESTART_PID
$nodeFile = $env:DSH_RESTART_NODE_FILE
$nodeArgsJson = $env:DSH_RESTART_NODE_ARGS
$launcher = $env:DSH_RESTART_LAUNCHER
$workingDir = $env:DSH_RESTART_WORKDIR
$log = $env:DSH_RESTART_LOG
$resultFile = $env:DSH_RESTART_RESULT
$outLog = $env:DSH_RESTART_OUT_LOG
$errLog = $env:DSH_RESTART_ERR_LOG
if (-not $outLog -and $log) { $outLog = $log + '.relaunch.out' }
if (-not $errLog -and $log) { $errLog = $log + '.relaunch.err' }

$waitSec = 120
if ($env:DSH_RESTART_WAIT_SEC) { try { $waitSec = [int]$env:DSH_RESTART_WAIT_SEC } catch { $waitSec = 120 } }
$maxWaitSec = 420
if ($env:DSH_RESTART_MAX_WAIT_SEC) { try { $maxWaitSec = [int]$env:DSH_RESTART_MAX_WAIT_SEC } catch { $maxWaitSec = 420 } }
$mountGraceSec = 45
if ($env:DSH_RESTART_MOUNT_GRACE_SEC) { try { $mountGraceSec = [int]$env:DSH_RESTART_MOUNT_GRACE_SEC } catch { $mountGraceSec = 45 } }
if ($maxWaitSec -lt $waitSec) { $maxWaitSec = $waitSec }

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$script:lastPid = 0
$script:relaunchCount = 0

function W($msg) {
  if (-not $log) { return }
  try {
    [System.IO.File]::AppendAllText($log, "$(Get-Date -Format 'HH:mm:ss') $msg`r`n", $utf8NoBom)
  } catch {
  }
}

function Tail([string]$path, [int]$lines) {
  if (-not $path) { return '' }
  try {
    if (-not (Test-Path -LiteralPath $path)) { return '' }
    return (@(Get-Content -LiteralPath $path -Tail $lines -ErrorAction Stop) -join ' | ')
  } catch {
    return ''
  }
}

function Write-Result([hashtable]$r) {
  if (-not $resultFile) { return }
  try {
    $json = $r | ConvertTo-Json -Compress -Depth 4
    [System.IO.File]::WriteAllText($resultFile, $json, $utf8NoBom)
  } catch {
    W "result write failed: $_"
  }
}

function Start-Reload {
  if ($script:relaunchCount -gt 0) {
    $prevOut = Tail $outLog 20
    $prevErr = Tail $errLog 20
    if ($prevOut) { W "previous relaunch stdout: $prevOut" }
    if ($prevErr) { W "previous relaunch stderr: $prevErr" }
  }
  if ($nodeFile -and $nodeArgsJson) {
    try {
      $nodeArgs = @($nodeArgsJson | ConvertFrom-Json)
      $quoted = @($nodeArgs | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' })
      $startArgs = @{
        FilePath = $nodeFile
        ArgumentList = $quoted
        WorkingDirectory = $workingDir
        WindowStyle = 'Hidden'
        PassThru = $true
      }
      if ($outLog) { $startArgs['RedirectStandardOutput'] = $outLog }
      if ($errLog) { $startArgs['RedirectStandardError'] = $errLog }
      $proc = Start-Process @startArgs
      $script:lastPid = $proc.Id
      $script:relaunchCount = $script:relaunchCount + 1
      W "relaunched node pid $($proc.Id) file=$nodeFile args=$($quoted -join ' ') workdir=$workingDir"
      W "relaunch-logs stdout=$outLog stderr=$errLog"
      W "relaunch-env DSH_HOME=$($env:DSH_HOME) DSH_PROFILE=$($env:DSH_PROFILE) DSH_PROFILE_DIR=$($env:DSH_PROFILE_DIR) DSH_UC_PROFILE_NODE_MODULES=$($env:DSH_UC_PROFILE_NODE_MODULES) NPM_CONFIG_LEGACY_PEER_DEPS=$($env:NPM_CONFIG_LEGACY_PEER_DEPS) PATH_LEN=$($env:PATH.Length)"
      return $true
    } catch {
      W "node relaunch failed: $_"
    }
  }
  if ($launcher) {
    try {
      $lp = Start-Process -FilePath $launcher -WorkingDirectory $workingDir -WindowStyle Hidden -PassThru
      $script:lastPid = $lp.Id
      $script:relaunchCount = $script:relaunchCount + 1
      W "relaunched launcher pid $($lp.Id): $launcher workdir=$workingDir"
      return $true
    } catch {
      W "launcher relaunch failed: $_"
    }
  }
  return $false
}

$started = (Get-Date).ToString('o')
W 'watchdog-start'
Write-Result @{
  startedAt = $started
  port = $port
  pid = $targetPid
  recovered = $false
  recoveredAt = $null
  recoveredBy = $null
  attempts = 0
  relaunches = 0
  processExits = 0
  listening = $false
  mounted = $false
  error = ''
  note = ''
  relaunchPid = 0
  relaunchLog = $outLog
  relaunchErrLog = $errLog
  outputTail = ''
  waitSec = $waitSec
  maxWaitSec = $maxWaitSec
}

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
  Write-Result @{
    startedAt = $started
    port = $port
    pid = $targetPid
    recovered = $false
    recoveredAt = $null
    recoveredBy = $null
    attempts = 0
    relaunches = 0
    processExits = 0
    listening = $true
    mounted = $false
    error = $err
    note = ''
    relaunchPid = 0
    relaunchLog = $outLog
    relaunchErrLog = $errLog
    outputTail = ''
    waitSec = $waitSec
    maxWaitSec = $maxWaitSec
  }
  exit 1
}
W 'port free'

$relaunched = Start-Reload
if (-not $relaunched) {
  $err = 'no launcher available (no node args and no launcher)'
  W $err
  Write-Result @{
    startedAt = $started
    port = $port
    pid = $targetPid
    recovered = $false
    recoveredAt = $null
    recoveredBy = $null
    attempts = 0
    relaunches = 0
    processExits = 0
    listening = $false
    mounted = $false
    error = $err
    note = ''
    relaunchPid = 0
    relaunchLog = $outLog
    relaunchErrLog = $errLog
    outputTail = ''
    waitSec = $waitSec
    maxWaitSec = $maxWaitSec
  }
  exit 1
}

$deadline = (Get-Date).AddSeconds($maxWaitSec)
$recovered = $false
$listening = $false
$recoveredBy = $null
$note = ''
$errMsg = ''
$listenSince = $null
$attempts = 0
$processExits = 0

while ((Get-Date) -lt $deadline -and -not $recovered) {
  $attempts++
  if ($script:lastPid -gt 0) {
    $alive = Get-Process -Id $script:lastPid -ErrorAction SilentlyContinue
    if (-not $alive) {
      $processExits++
      $errMsg = "relaunched process $($script:lastPid) exited (exit count $processExits)"
      W $errMsg
      $tailErr = Tail $errLog 30
      if ($tailErr) { W "relaunch stderr tail: $tailErr" }
      $tailOut = Tail $outLog 30
      if ($tailOut) { W "relaunch stdout tail: $tailOut" }
      if ($script:relaunchCount -lt 3) {
        $listenSince = $null
        $errMsg = ''
        if (-not (Start-Reload)) { break }
        Start-Sleep -Seconds 2
        continue
      }
      break
    }
  }
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($c) {
    $listening = $true
    if (-not $listenSince) {
      $listenSince = Get-Date
      W "port $port is listening"
    }
    $code = 0
    try {
      $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $port + "/dsh-update-checker/status.json") -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
      $code = [int]$r.StatusCode
    } catch {
      try { $code = [int]$_.Exception.Response.StatusCode } catch { $code = 0 }
    }
    if ($code -ge 200 -and $code -lt 300) {
      $recovered = $true
      $recoveredBy = 'plugin'
      break
    }
    if ($code -ge 300 -and $code -lt 500) {
      W "http $code from plugin route (service answering, route not ready yet)"
    }
    if ($listenSince -and ((Get-Date) - $listenSince).TotalSeconds -ge $mountGraceSec) {
      $recovered = $true
      $recoveredBy = 'port'
      $note = "port $port is listening but /dsh-update-checker/status.json did not answer 2xx within ${mountGraceSec}s"
      break
    }
  } else {
    $listenSince = $null
  }
  Start-Sleep -Milliseconds 2000
}

$recoveredAt = $null
if ($recovered) { $recoveredAt = (Get-Date).ToString('o') }
if ($recovered) {
  W "watchdog recovered via $recoveredBy (${attempts} polls, $($script:relaunchCount) relaunch(es))"
} else {
  if (-not $errMsg) {
    $errMsg = "service did not recover within ${maxWaitSec}s (relaunches=$($script:relaunchCount) processExits=$processExits listening=$listening)"
  }
  W "watchdog FAILED: $errMsg"
  $tailErr = Tail $errLog 40
  if ($tailErr) { W "relaunch stderr tail: $tailErr" }
}
Write-Result @{
  startedAt = $started
  port = $port
  pid = $targetPid
  recovered = $recovered
  recoveredAt = $recoveredAt
  recoveredBy = $recoveredBy
  attempts = $attempts
  relaunches = [int]$script:relaunchCount
  processExits = $processExits
  listening = $listening
  mounted = [bool]($recoveredBy -eq 'plugin')
  error = $errMsg
  note = $note
  relaunchPid = [int]$script:lastPid
  relaunchLog = $outLog
  relaunchErrLog = $errLog
  outputTail = (Tail $errLog 20)
  waitSec = $waitSec
  maxWaitSec = $maxWaitSec
}
W 'watchdog-done'
