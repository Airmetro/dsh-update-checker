#!/bin/sh

PORT="${DSH_RESTART_PORT:-3080}"
TARGET_PID="${DSH_RESTART_PID:-0}"
WORKDIR="${DSH_RESTART_WORKDIR:-.}"
LOG="${DSH_RESTART_LOG:-}"
RESULT="${DSH_RESTART_RESULT:-}"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ATTEMPTS=0

NR_NODE_FILE="${DSH_RESTART_NODE_FILE:-}"
NR_NODE_ARGS="${DSH_RESTART_NODE_ARGS:-}"
NR_LAUNCHER="${DSH_RESTART_LAUNCHER:-}"

case "$NR_NODE_FILE" in
  /*) NODE_BIN="$NR_NODE_FILE" ;;
  *) NODE_BIN="$(command -v node 2>/dev/null || printf 'node')" ;;
esac

export NR_PORT="$PORT" NR_PID="$TARGET_PID" NR_RESULT="$RESULT" NR_STARTED="$STARTED"
export NR_WORKDIR="$WORKDIR" NR_NODE_FILE NR_NODE_ARGS NR_LAUNCHER

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
  export NR_REC NR_RECAT NR_ERR NR_ATTEMPTS
  [ -n "$RESULT" ] || return 0
  "$NODE_BIN" -e 'const fs=require("node:fs");const o={startedAt:process.env.NR_STARTED,port:Number(process.env.NR_PORT),pid:Number(process.env.NR_PID),recovered:process.env.NR_REC==="true",recoveredAt:process.env.NR_RECAT||null,attempts:Number(process.env.NR_ATTEMPTS||0),error:process.env.NR_ERR||""};fs.writeFileSync(process.env.NR_RESULT,JSON.stringify(o));' 2>/dev/null && return 0
  ERR_ESC="$(printf '%s' "$NR_ERR" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  if [ -n "$NR_RECAT" ]; then
    REC_AT="\"$NR_RECAT\""
  else
    REC_AT="null"
  fi
  printf '{"startedAt":"%s","port":%s,"pid":%s,"recovered":%s,"recoveredAt":%s,"attempts":%s,"error":"%s"}' \
    "$STARTED" "$PORT" "$TARGET_PID" "$NR_REC" "$REC_AT" "$NR_ATTEMPTS" "$ERR_ESC" > "$RESULT" 2>/dev/null
  return 0
}

port_pids() {
  if command -v ss >/dev/null 2>&1; then
    ss -H -tlnp "sport = :$PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | grep -oE '[0-9]+' | sort -un
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -oE '^[0-9]+$' | sort -un
  fi
  return 0
}

port_open() {
  "$NODE_BIN" -e 'const net=require("node:net");const s=net.connect(Number(process.env.NR_PORT),"127.0.0.1");let d=false;const f=(v)=>{if(d)return;d=true;try{s.destroy()}catch(e){}process.exit(v?0:1)};s.setTimeout(1200);s.on("connect",()=>f(true));s.on("timeout",()=>f(false));s.on("error",()=>f(false));' >/dev/null 2>&1
}

http_200() {
  "$NODE_BIN" -e 'fetch("http://127.0.0.1:"+process.env.NR_PORT+"/dsh-update-checker/status.json").then((r)=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1));' >/dev/null 2>&1
}

relaunch_node() {
  [ -n "$NR_NODE_FILE" ] || return 1
  [ -n "$NR_NODE_ARGS" ] || return 1
  "$NODE_BIN" -e 'const{spawn}=require("node:child_process");const f=process.env.NR_NODE_FILE;const a=JSON.parse(process.env.NR_NODE_ARGS||"[]");if(!f||!a.length)process.exit(1);const c=spawn(f,a,{cwd:process.env.NR_WORKDIR||process.cwd(),detached:true,stdio:"ignore"});c.unref();' >/dev/null 2>&1 || return 1
  return 0
}

relaunch_launcher() {
  [ -n "$NR_LAUNCHER" ] || return 1
  "$NODE_BIN" -e 'const{spawn}=require("node:child_process");const p=process.env.NR_LAUNCHER;if(!p)process.exit(1);const c=spawn(p,[],{cwd:process.env.NR_WORKDIR||process.cwd(),detached:true,stdio:"ignore"});c.unref();' >/dev/null 2>&1 || return 1
  return 0
}

start_reload() {
  if relaunch_node; then
    W "relaunched node: $NR_NODE_FILE"
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl --user restart dsh-web.service >/dev/null 2>&1; then
      W "restarted dsh-web.service"
      return 0
    fi
  fi
  if relaunch_launcher; then
    W "relaunched launcher: $NR_LAUNCHER"
    return 0
  fi
  return 1
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

RECOVERED=0
round=1
while [ "$round" -le 3 ]; do
  end=$(( $(date +%s) + 30 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if port_open && http_200; then
      RECOVERED=1
      break
    fi
    sleep 2
  done
  if [ "$RECOVERED" -eq 1 ]; then
    break
  fi
  if [ "$round" -lt 3 ]; then
    W "watchdog retry $round"
    for p in $(port_pids); do
      kill -9 "$p" 2>/dev/null
    done
    sleep 2
    start_reload || true
  fi
  round=$((round + 1))
done

if [ "$RECOVERED" -eq 1 ]; then
  W "watchdog recovered (${ATTEMPTS} tries)"
  write_result true "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ""
else
  W "watchdog FAILED after 3 retries"
  write_result false "" "service did not recover within 90s"
fi
W "watchdog-done"
