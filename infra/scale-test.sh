#!/usr/bin/env bash
# Lab 8: run the backend as ONE server (scale up / vertical) or as N servers behind a load balancer
# (scale out / horizontal), crash one of them, and stop everything.
#
#   bash infra/scale-test.sh vertical          one worker on :8080            (instance ecs-task-vertical)
#   bash infra/scale-test.sh horizontal 3      workers on :3001-:3003 + load balancer on :8080
#   bash infra/scale-test.sh kill 2            crash worker 2 (failover drill)
#   bash infra/scale-test.sh status            which workers answer
#   bash infra/scale-test.sh stop              stop all workers and the load balancer
#
# The workers behave like the ECS tasks of Lab 8: stateless, with their settings read from
# Secrets Manager and the audit log + rate-limit counters in DynamoDB - all on Floci (Docker must run).
# For a load test raise the limit first, as in Lab 8:  export RATE_LIMIT_MAX=100000
set -uo pipefail
cd "$(dirname "$0")/.."
RUN=infra/.run
LOGS=$RUN/logs
mkdir -p "$LOGS"

export AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL:-http://localhost:4566} AWS_REGION=us-east-1 \
       AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_PROFILE= \
       SECRETS_ID=election/app-secrets AUDIT_TABLE=AuditLog RATE_TABLE=RateLimits RESULTS_BUCKET=election-results \
       CORS_ORIGINS=http://localhost:8080,http://localhost:4566 NODE_ENV=production
unset AWS_PROFILE

stop_pid() { # stop one process started by this script (Git Bash pid, with a Windows fallback)
  local f=$1 pid winpid
  [ -f "$f" ] || return 0
  pid=$(cat "$f")
  winpid=$(cat /proc/"$pid"/winpid 2>/dev/null || true)
  kill "$pid" 2>/dev/null || { [ -n "$winpid" ] && taskkill //F //PID "$winpid" >/dev/null 2>&1; }
  rm -f "$f"
}

stop_all() {
  for f in "$RUN"/*.pid; do [ -e "$f" ] && stop_pid "$f"; done
  # leftover node.exe still holding the ports (as in the Lab 8 "port already in use" fix)
  powershell -NoProfile -Command "foreach (\$p in 8080,3001,3002,3003,3004) { Get-NetTCPConnection -LocalPort \$p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue } }" >/dev/null 2>&1
}

start_worker() { # name port trustLb
  INSTANCE_ID=$1 PORT=$2 TRUST_LB=$3 node backend/server.js > "$LOGS/$1.log" 2>&1 &
  echo $! > "$RUN/$1.pid"
}

wait_healthy() { # port
  for _ in $(seq 1 40); do
    curl -s -m 2 "http://localhost:$1/api/health?deep=1" | grep -q '"status":"ok"' && return 0
    sleep 0.5
  done
  echo "  worker on :$1 did not become healthy - see $LOGS" >&2
  return 1
}

case "${1:-}" in
  vertical)
    stop_all
    start_worker ecs-task-vertical 8080 false
    wait_healthy 8080 && echo "vertical: 1 worker on http://localhost:8080 (instance ecs-task-vertical), limit ${RATE_LIMIT_MAX:-from Secrets Manager}"
    ;;
  horizontal)
    n=${2:-3}
    [ "$n" -ge 1 ] && [ "$n" -le 4 ] || { echo "use 1 to 4 workers (Auto Scaling max 4 in Lab 8)"; exit 2; }
    stop_all
    ports=()
    for i in $(seq 1 "$n"); do
      start_worker "ecs-task-$i" $((3000 + i)) true
      ports+=($((3000 + i)))
    done
    for p in "${ports[@]}"; do wait_healthy "$p"; done
    node infra/scale/lb.js 8080 "${ports[@]}" > "$LOGS/lb.log" 2>&1 &
    echo $! > "$RUN/lb.pid"
    sleep 1
    echo "horizontal: $n workers on :${ports[*]} behind the load balancer http://localhost:8080"
    ;;
  kill)
    i=${2:?which worker? e.g. kill 2}
    stop_pid "$RUN/ecs-task-$i.pid"
    echo "worker ecs-task-$i stopped (crash simulated)"
    ;;
  status)
    for f in "$RUN"/*.pid; do
      [ -e "$f" ] || continue
      name=$(basename "$f" .pid)
      echo "$name pid $(cat "$f")"
    done
    for p in 8080 3001 3002 3003 3004; do
      out=$(curl -s -m 2 "http://localhost:$p/api/health" | grep -o '"instanceId":"[^"]*"')
      [ -n "$out" ] && echo ":$p -> $out"
    done
    ;;
  stop)
    stop_all
    echo "stopped all workers and the load balancer"
    ;;
  *)
    sed -n '2,12p' "$0"
    exit 2
    ;;
esac
