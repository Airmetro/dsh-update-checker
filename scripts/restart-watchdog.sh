#!/bin/sh

PORT="${DSH_RESTART_PORT:-3080}"
TARGET_PID="${DSH_RESTART_PID:-0}"
WORKDIR="${DSH_RESTART_WORKDIR:-.}"
LOG="${DSH_RESTART_LOG:-}"
RESULT="${DSH_RESTART_RESULT:-}"
OUT_LOG="${DSH_RESTART_OUT_LOG:-}"
ERR_LOG="${DSH_RESTART_ERR_LOG:-}"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ATTEMPTS=0
RELAUNCHES=0
PROCESS_EXITS=0
LAUNCHED_PID=""
LISTENING=false
RECOVERED_BY=""
NOTE=""
ERRMSG=""
WAIT_SEC="${DSH_RESTART_WAIT_SEC:-120}"
MAX_WAIT_SEC="${DSH_RESTART_MAX_WAIT_SEC:-420}"
MOUNT_GRACE_SEC="${DSH_RESTART_MOUNT_GRACE_SEC:-45}"

NR_NODE_FILE="${DSH_RESTART_NODE_FILE:-}"
NR_NODE_ARGS="${DSH_RESTART_NODE_ARGS:-}"
NR_LAUNCHER="${DSH_RESTART_LAUNCHER:-}"

if [ -z "$OUT_LOG" ] && [ -n "$LOG" ]; then OUT_LOG="$LOG.relaunch.out"; fi
if [ -z "$ERR_LOG" ] && [ -n "$LOG" ]; then ERR_LOG="$LOG.relaunch.err"; fi

case "$NR_NODE_FILE" in
  /*) NODE_BIN="$NR_NODE_FILE" ;;
  *) NODE_BIN="$(command -v node 2>/dev/null || printf 'node')" ;;
esac

export NR_PORT="$PORT" NR_PID="$TARGET_PID" NR_RESULT="$RESULT" NR_STARTED="$STARTED"
export NR_WORKDIR="$WORKDIR" NR_NODE_FILE NR_NODE_ARGS NR_LAUNCHER
export NR_OUT="$OUT_LOG" NR_ERR="$ERR_LOG"

W() {
  if [ -n "$LOG" ]; then
    printf '%s %s\n' "$(date '+%H:%M:%S')" "$1" >> "$LOG" 2>/dev/null
  fi
}

write_result() {
  NR_REC="$1"
  NR_RECAT="$2"
  NR_ERR="$3"
  NR_ATTEMPTS="$ATTEMPTS"
  NR_RELAUNCHES="$RELAUNCHES"
  NR_EXITS="$PROCESS_EXITS"
  NR_LISTEN="$LISTENING"
  NR_BY="$RECOVERED_BY"
  NR_NOTE="$NOTE"
  export NR_REC NR_RECAT NR_ERR NR_ATTEMPTS NR_RELAUNCHES NR_EXITS NR_LISTEN NR_BY NR_NOTE
  [ -n "$RESULT" ] || return 0
  "$NODE_BIN" -e 'const fs=require("node:fs");const lo=(v)=>String(v||"");const o={startedAt:lo(process.env.NR_STARTED),port:Number(process.env.NR_PORT),pid:Number(process.env.NR_PID),recovered:process.env.NR_REC==="true",recoveredAt:process.env.NR_RECAT||null,recoveredBy:process.env.NR_BY||null,attempts:Number(process.env.NR_ATTEMPTS||0),relaunches:Number(process.env.NR_RELAUNCHES||0),processExits:Number(process.env.NR_EXITS||0),listening:process.env.NR_LISTEN==="true",mounted:process.env.NR_BY==="plugin",error:lo(process.env.NR_ERR),note:lo(process.env.NR_NOTE),relaunchPid:Number(process.env.NR_LAUNCHED_PID||0),relaunchLog:lo(process.env.NR_OUT),relaunchErrLog:lo(process.env.NR_ERR),outputTail:""};fs.writeFileSync(process.env.NR_RESULT,JSON.stringify(o));' 2>/dev/null && return 0
  ERR_ESC="$(printf '%s' "$NR_ERR" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  if [ -n "$NR_RECAT" ]; then
    REC_AT="\"$NR_RECAT\""
  else
    REC_AT="null"
  fi
  printf '{"startedAt":"%s","port":%s,"pid":%s,"recovered":%s,"recoveredAt":%s,"recoveredBy":null,"attempts":%s,"relaunches":%s,"processExits":%s,"listening":%s,"mounted":%s,"error":"%s","note":"","relaunchPid":0,"relaunchLog":"","relaunchErrLog":"","outputTail":""}' \
    "$STARTED" "$PORT" "$TARGET_PID" "$NR_REC" "$REC_AT" "$NR_ATTEMPTS" "$NR_RELAUNCHES" "$NR_EXITS" "$NR_LISTEN" "$NR_BY" "$ERR_ESC" > "$RESULT" 2>/dev/null
  return 0
}

port_pids() {
  if command -v ss >/dev/null 2>&1; then
    ss -H -tlnp "sport = :$PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | grep -oE '[0-9]+' | sort -un
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -oE '^[0-9]+$' | sort -un
    return 0
  fi
  return 0
}

port_open() {
  "$NODE_BIN" -e 'const net=require("node:net");const s=net.connect(Number(process.env.NR_PORT),"127.0.0.1");let d=false;const f=(v)=>{if(d)return;d=true;try{s.destroy()}catch(e){}process.exit(v?0:1)};s.setTimeout(1200);s.on("connect",()=>f(true));s.on("timeout",()=>f(false));s.on("error",()=>f(false));' >/dev/null 2>&1
}

http_status() {
  "$NODE_BIN" -e 'fetch("http://127.0.0.1:"+process.env.NR_PORT+"/dsh-update-checker/status.json").then((r)=>{process.stdout.write(String(r.status));process.exit(0)}).catch(()=>{process.stdout.write("0");process.exit(0)});' 2>/dev/null
}

relaunch_node() {
  [ -n "$NR_NODE_FILE" ] || return 1
  [ -n "$NR_NODE_ARGS" ] || return 1
  LAUNCHED_PID="$("$NODE_BIN" -e 'const fs=require("node:fs");const{spawn}=require("node:child_process");const f=process.env.NR_NODE_FILE;const a=JSON.parse(process.env.NR_NODE_ARGS||"[]");if(!f||!a.length)process.exit(1);const out=process.env.NR_OUT?fs.openSync(process.env.NR_OUT,"a"):"ignore";const err=process.env.NR_ERR?fs.openSync(process.env.NR_ERR,"a"):"ignore";const c=spawn(f,a,{cwd:process.env.NR_WORKDIR||process.cwd(),detached:true,stdio:["ignore",out,err]});c.unref();process.stdout.write(String(c.pid||""));' 2>/dev/null)"
  [ -n "$LAUNCHED_PID" ] || return 1
  return 0
}

relaunch_launcher() {
  [ -n "$NR_LAUNCHER" ] || return 1
  "$NODE_BIN" -e 'const{spawn}=require("node:child_process");const p=process.env.NR_LAUNCHER;if(!p)process.exit(1);const c=spawn(p,[],{cwd:process.env.NR_WORKDIR||process.cwd(),detached:true,stdio:"ignore"});c.unref();' >/dev/null 2>&1 || return 1
  return 0
}

start_reload() {
  LAUNCHED_PID=""
  if relaunch_node; then
    RELAUNCHES=$((RELAUNCHES + 1))
    export NR_LAUNCHED_PID="$LAUNCHED_PID"
    W "relaunched node pid $LAUNCHED_PID: $NR_NODE_FILE"
    W "relaunch-logs stdout=$OUT_LOG stderr=$ERR_LOG"
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl --user restart dsh-web.service >/dev/null 2>&1; then
      RELAUNCHES=$((RELAUNCHES + 1))
      W "restarted dsh-web.service"
      return 0
    fi
  fi
  if relaunch_launcher; then
    RELAUNCHES=$((RELAUNCHES + 1))
    W "relaunched launcher: $NR_LAUNCHER"
    return 0
  fi
  return 1
}

alive() {
  [ -n "$LAUNCHED_PID" ] || return 1
  kill -0 "$LAUNCHED_PID" 2>/dev/null
}

W "watchdog-start"
write_result false "" ""

sleep 2

case "$TARGET_PID" in
  ''|*[!0-9]*) ;;
  *)
    if [ "$TARGET_PID" -gt 0 ]; then
      kill -9 "$TARGET_PID" 2>/dev/null
      W "killed PID $TARGET_PID"
    fi
    ;;
esac
sleep 1

for p in $(port_pids); do
  kill -9 "$p" 2>/dev/null
  W "killed port owner PID $p"
done

FREE=0
i=0
while [ "$i" -lt 20 ]; do
  if [ -z "$(port_pids)" ] && ! port_open; then
    FREE=1
    break
  fi
  sleep 1
  i=$((i + 1))
done
if [ "$FREE" -ne 1 ]; then
  W "port still listening after kill"
  write_result false "" "port still listening after kill - refusing to relaunch"
  exit 1
fi
W "port free"

if ! start_reload; then
  W "no launcher available"
  write_result false "" "no launcher available (no node args and no launcher)"
  exit 1
fi

END_AT=$(( $(date +%s) + MAX_WAIT_SEC ))
RECOVERED=0
LISTEN_SINCE=""

while [ "$(date +%s)" -lt "$END_AT" ]; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ -n "$LAUNCHED_PID" ] && ! alive; then
    PROCESS_EXITS=$((PROCESS_EXITS + 1))
    ERRMSG="relaunched process $LAUNCHED_PID exited (exit count $PROCESS_EXITS)"
    W "$ERRMSG"
    if [ -n "$ERR_LOG" ] && [ -f "$ERR_LOG" ]; then
      W "relaunch stderr tail: $(tail -n 20 "$ERR_LOG" 2>/dev/null | tr '\n' '|')"
    fi
    if [ "$RELAUNCHES" -lt 3 ]; then
      LISTEN_SINCE=""
      ERRMSG=""
      start_reload || break
      sleep 2
      continue
    fi
    break
  fi
  if port_open; then
    LISTENING=true
    if [ -z "$LISTEN_SINCE" ]; then
      LISTEN_SINCE="$(date +%s)"
      W "port $PORT is listening"
    fi
    CODE="$(http_status)"
    if [ "$CODE" = "200" ]; then
      RECOVERED=1
      RECOVERED_BY="plugin"
      break
    fi
    if [ -n "$CODE" ] && [ "$CODE" != "0" ]; then
      W "http $CODE from plugin route (service answering, route not ready yet)"
    fi
    if [ -n "$LISTEN_SINCE" ] && [ $(( $(date +%s) - LISTEN_SINCE )) -ge "$MOUNT_GRACE_SEC" ]; then
      RECOVERED=1
      RECOVERED_BY="port"
      NOTE="port $PORT is listening but /dsh-update-checker/status.json did not answer 200 within ${MOUNT_GRACE_SEC}s"
      break
    fi
  else
    LISTEN_SINCE=""
  fi
  sleep 2
done

if [ "$RECOVERED" -eq 1 ]; then
  W "watchdog recovered via $RECOVERED_BY (${ATTEMPTS} polls, ${RELAUNCHES} relaunch(es))"
  write_result true "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ""
else
  if [ -z "$ERRMSG" ]; then
    ERRMSG="service did not recover within ${MAX_WAIT_SEC}s (relaunches=$RELAUNCHES processExits=$PROCESS_EXITS listening=$LISTENING)"
  fi
  W "watchdog FAILED: $ERRMSG"
  if [ -n "$ERR_LOG" ] && [ -f "$ERR_LOG" ]; then
    W "relaunch stderr tail: $(tail -n 40 "$ERR_LOG" 2>/dev/null | tr '\n' '|')"
  fi
  write_result false "" "$ERRMSG"
fi
W "watchdog-done"
