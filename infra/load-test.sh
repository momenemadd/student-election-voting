#!/usr/bin/env bash
# Lab 8: run the k6 load test and keep the evidence in docs/load-testing/<run>.txt (+ .json summary).
#   bash infra/load-test.sh run-a     Run A: 1 worker   (start first: bash infra/scale-test.sh vertical)
#   bash infra/load-test.sh run-b     Run B: 3 workers  (start first: bash infra/scale-test.sh horizontal 3)
#   bash infra/load-test.sh run-c     Run C: 3 workers, worker 2 is crashed 30 s into the test (failover)
# Remember (Lab 8): raise the limit BEFORE starting the workers: export RATE_LIMIT_MAX=100000
# The admin login is read from backend/.env and passed to k6 without being printed or saved.
set -uo pipefail
cd "$(dirname "$0")/.."
RUNNAME=${1:?run-a, run-b or run-c}
OUT=docs/load-testing
mkdir -p "$OUT"
K6=$(command -v k6 || echo /d/tools/k6/k6-v2.4.0-windows-amd64/k6.exe)

ADMIN_EMAIL=$(node -e "require('./backend/node_modules/dotenv').config({path:'backend/.env',quiet:true});process.stdout.write(process.env.SEED_ADMIN_EMAIL||'')")
ADMIN_PASSWORD=$(node -e "require('./backend/node_modules/dotenv').config({path:'backend/.env',quiet:true});process.stdout.write(process.env.SEED_ADMIN_PASSWORD||'')")
export ADMIN_EMAIL ADMIN_PASSWORD

curl -s -m 3 http://localhost:8080/api/health | grep -q '"status":"ok"' || { echo "nothing answers on :8080 - start the workers first (infra/scale-test.sh)"; exit 1; }

if [ "$RUNNAME" = "run-c" ]; then
  ( sleep 30; bash infra/scale-test.sh kill 2; echo "$(date -u +%H:%M:%S) worker 2 crashed by the drill" >> "$OUT/run-c-events.txt" ) &
fi

echo "== $RUNNAME started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee "$OUT/$RUNNAME.txt"
"$K6" run --no-color --summary-export "$OUT/$RUNNAME.json" -e BASE_URL=http://localhost:8080 \
  -e "ADMIN_EMAIL=$ADMIN_EMAIL" -e "ADMIN_PASSWORD=$ADMIN_PASSWORD" tests/load/election-load-test.js 2>&1 | tee -a "$OUT/$RUNNAME.txt"
# never keep the login token from setup() in the evidence file (it goes to a public repo)
node -e "const f=process.argv[1],fs=require('fs');const j=JSON.parse(fs.readFileSync(f,'utf8'));delete j.setup_data;fs.writeFileSync(f,JSON.stringify(j,null,4))" "$OUT/$RUNNAME.json"
echo "evidence saved: $OUT/$RUNNAME.txt and $OUT/$RUNNAME.json"
