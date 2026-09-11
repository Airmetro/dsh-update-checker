#!/bin/sh
# POSIX counterpart of scripts/restart-watchdog.ps1 (systemd/user services on Linux/macOS).
# Env: DSH_RESTART_PORT, DSH_RESTART_PID, DSH_RESTART_NODE_FILE,
#      DSH_RESTART_NODE_ARGS (JSON array), DSH_RESTART_LAUNCHER,
#      DSH_RESTART_WORKDIR, DSH_RESTART_LOG, DSH_RESTART_RESULT
PORT="${DSH_RESTART_PORT:-3080}"
TARGET_PID="${DSH_RESTART_PID:-0}"
WORKDIR="${DSH_RESTART_WORKDIR:-.}"
LOG="${DSH_RESTART_LOG:-}"
RESULT="${DSH_RESTART_RESULT:-}"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ATTEMPTS=0

W() {
  if [ -n "$LOG" ]; then
    printf '%s %s\n' "$(date '+%H:%M:%S')" "$1" >> "$LOG" 2>/dev/null
  fi
}

write_result() {
  # $1=recovered(true/false) $2=recoveredAt-or-empty $3=error
  if [ -n "$RESULT" ]; then
    if [ -n "$2" ]; then REC_AT="\"$2\""; else REC_AT="null"; fi
    ERR=$(printf '%s' "$3" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"startedAt":"%s","port":%s,"pid":%s,"recovered":%s,"recoveredAt":%s,"attempts":%s,"error":"%s"}' \
      "$STARTED" "$PORT" "$TARGET_PID" "$1" "$REC_AT" "$ATTEMPTS" "$ERR" > "$RESULT" 2>/dev/null
  fi
}

port_pids() {
  {
    ss -tlnp 2>/dev/null | grep -oE 'pid=[0-9]+' | grep -oE '[0-9]+'
    lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -oE '^[0-9]+$'
  } 2>/dev/null | sort -un
}

http_200() {
  if command -v curl >/dev/null 2>&1; then
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/dsh-update-checker/status.json" 2>/dev/null)" = "200" ]
    return $?
  fi
  [ "$(node -e 'fetch("http://127.0.0.1:'"$PORT"'/dsh-update-checker/status.json").then(r=>console.log(r.status)).catch(()=>console.log(0))' 2>/dev/null)" = "200" ]
  return $?
}

W "watchdog-start"
write_result "false" "" ""

sleep 2
case "$TARGET_PID" in
  ''|*[!0-9]*) ;;
  *) if [ "$TARGET_PID" -gt 0 ]; then kill -9 "$TARGET_PID" 2>/dev/null; W "killed PID $TARGET_PID"; fi ;;
esac
sleep 1

for p in $(port_pids); do
  kill -9 "$p" 2>/dev/null
  W "killed port owner PID $p"
done

FREE=0
i=0
while [ "$i" -lt 20 ]; do
  if [ -z "$(port_pids)" ]; then FREE=1; break; fi
  sleep 1
  i=$((i + 1))
done
if [ "$FREE" -ne 1 ]; then
  write_result "false" "" "port still listening after kill - refusing to relaunch"
  W "port still listening after kill"
  exit 1
fi
W "port free"

cd "$WORKDIR" 2>/dev/null || true
RELAUNCHED=0
if [ -n "${DSH_RESTART_NODE_FILE:-}" ] && [ -n "${DSH_RESTART_NODE_ARGS:-}" ]; then
  if node -e '
const { spawn } = require("node:child_process");
const f = process.env.DSH_RESTART_NODE_FILE;
const a = JSON.parse(process.env.DSH_RESTART_NODE_ARGS || "[]");
const c = spawn(f, a, { cwd: process.env.DSH_RESTART_WORKDIR || process.cwd(), detached: true, stdio: "ignore" });
c.unref();' 2>/dev/null; then
    W "relaunched node"
    RELAUNCHED=1
  else
    W "node relaunch failed"
  fi
fi
if [ "$RELAUNCHED" -ne 1 ] && [ -n "${DSH_RESTART_LAUNCHER:-}" ]; then
  if node -e '
const { spawn } = require("node:child_process");
const parts = (process.env.DSH_RESTART_LAUNCHER || "").split(" ").filter(Boolean);
if (!parts.length) process.exit(1);
const c = spawn(parts[0], parts.slice(1), { cwd: process.env.DSH_RESTART_WORKDIR || process.cwd(), detached: true, stdio: "ignore", shell: false });
c.unref();' 2>/dev/null; then
    W "relaunched launcher"
    RELAUNCHED=1
  fi
fi
if [ "$RELAUNCHED" -ne 1 ]; then
  write_result "false" "" "no launcher available (no node args and no launcher)"
  W "no launcher available"
  exit 1
fi

RECOVERED=0
round=1
while [ "$round" -le 3 ] && [ "$RECOVERED" -ne 1 ]; do
  end=$(( $(date +%s) + 30 ))
  while [ "$(date +%s)" -lt "$end" ] && [ "$RECOVERED" -ne 1 ]; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ -n "$(port_pids)" ] && http_200; then RECOVERED=1; break; fi
    sleep 2
  done
  if [ "$RECOVERED" -ne 1 ] && [ "$round" -lt 3 ]; then
    W "watchdog retry $round"
    for p in $(port_pids); do kill -9 "$p" 2>/dev/null; done
    sleep 2
    # relaunch again via node helper
    node -e '
const { spawn } = require("node:child_process");
const f = process.env.DSH_RESTART_NODE_FILE;
const a = JSON.parse(process.env.DSH_RESTART_NODE_ARGS || "[]");
if (f && a.length) { const c = spawn(f, a, { cwd: process.env.DSH_RESTART_WORKDIR || process.cwd(), detached: true, stdio: "ignore" }); c.unref(); }' 2>/dev/null || true
  fi
  round=$((round + 1))
done

if [ "$RECOVERED" -eq 1 ]; then
  write_result "true" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ""
  W "watchdog recovered (${ATTEMPTS} tries)"
else
  write_result "false" "" "service did not recover within 90s"
  W "watchdog FAILED after 3 retries"
fi
W "watchdog-done"
