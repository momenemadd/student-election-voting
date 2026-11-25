#!/usr/bin/env bash
# Lab 8 Part 6 "Attack your own app" - S1 to S7 against the worker on :8080.
# Run with ONE worker and the NORMAL limit (60 per 60 s, as in Lab 8):
#   unset RATE_LIMIT_MAX; RATE_LIMIT_MAX=60 bash infra/scale-test.sh vertical; bash infra/security-checks.sh
# Evidence is saved in docs/load-testing/security-checks.txt (no passwords or tokens are printed).
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=docs/load-testing/security-checks.txt
mkdir -p docs/load-testing
B=http://localhost:8080
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test MSYS_NO_PATHCONV=1
unset AWS_PROFILE
PASS=0; FAIL=0
ok()  { echo "PASS  $1" | tee -a "$OUT"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $1" | tee -a "$OUT"; FAIL=$((FAIL+1)); }
env_val() { node -e "require('./backend/node_modules/dotenv').config({path:'backend/.env',quiet:true});process.stdout.write(process.env['$1']||'')"; }
login() { curl -s -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$(env_val "$1")\",\"password\":\"$(env_val "$2")\",\"turnstileToken\":\"XXXX.DUMMY.TOKEN\"}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).token||'')}catch{}})"; }

echo "== Lab 8 security checks $(date -u +%Y-%m-%dT%H:%M:%SZ) against $B" | tee "$OUT"
curl -s -m 3 $B/api/health | grep -q '"status":"ok"' || { echo "nothing answers on :8080 - start: RATE_LIMIT_MAX=60 bash infra/scale-test.sh vertical"; exit 1; }

# S1 security headers
H=$(curl -sI $B/api/elections | tr -d '\r')
echo "$H" | grep -iE "x-content-type|x-frame|content-security" | sed 's/^/      /' | tee -a "$OUT"
[ "$(echo "$H" | grep -ciE '^x-content-type-options: nosniff|^x-frame-options: deny|^content-security-policy:')" = 3 ] \
  && ok "S1 security headers: nosniff, X-Frame-Options DENY, Content-Security-Policy" || bad "S1 security headers"

# S2 80 quick requests (limit 60 per 60 s)
C=$(for i in $(seq 1 80); do curl -s -o /dev/null -w "%{http_code}\n" $B/api/elections; done | sort | uniq -c)
echo "$C" | sed 's/^/      /' | tee -a "$OUT"
echo "$C" | grep -q " 429" && ok "S2 rate limiting: requests over the limit get 429" || bad "S2 rate limiting (start the worker with RATE_LIMIT_MAX=60)"

# S3 fake X-Forwarded-For does not bypass the limit
S3=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Forwarded-For: 9.9.9.9" $B/api/elections)
[ "$S3" = 429 ] && ok "S3 fake X-Forwarded-For is ignored: still 429" || bad "S3 fake X-Forwarded-For gave $S3"

echo "      waiting 61 s so the sliding window empties ..." | tee -a "$OUT"
sleep 61

ADMIN=$(login SEED_ADMIN_EMAIL SEED_ADMIN_PASSWORD)
[ -n "$ADMIN" ] || { bad "admin login for S4/S5 failed"; echo "Result: $PASS passed, $FAIL failed" | tee -a "$OUT"; exit 1; }
START=$(node -e "console.log(new Date(Date.now()+86400e3).toISOString())"); END=$(node -e "console.log(new Date(Date.now()+2*86400e3).toISOString())")

# S4 input that is too long -> 400
LONG=$(printf 'a%.0s' $(seq 1 1001))
R4=$(curl -s -w " %{http_code}" -X POST $B/api/elections -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d "{\"title\":\"S4 long\",\"description\":\"$LONG\",\"start_time\":\"$START\",\"end_time\":\"$END\"}")
echo "      ${R4: -60}" | tee -a "$OUT"
[ "${R4: -3}" = 400 ] && ok "S4 input validation: 1001-character description -> 400" || bad "S4 input validation gave ${R4: -3}"

# S5 a <script> in the text is removed before saving
R5=$(curl -s -X POST $B/api/elections -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d "{\"title\":\"S5 sanitise check $(date +%s)\",\"description\":\"<script>alert(1)</script>hi\",\"start_time\":\"$START\",\"end_time\":\"$END\"}")
EID=$(echo "$R5" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).election_id||'')}catch{}})")
DESC=$(echo "$R5" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.stringify(JSON.parse(s).description))}catch{}})")
echo "      saved description: $DESC" | tee -a "$OUT"
[ "$DESC" = '"hi"' ] && ok "S5 sanitising: <script> removed, saved text is \"hi\"" || bad "S5 sanitising saved $DESC"

# S6 the audit trail recorded it (DynamoDB AuditLog on Floci, written by the worker)
if [ -n "$EID" ]; then
  A6=$(aws dynamodb query --table-name AuditLog --key-condition-expression "pk = :p" \
       --expression-attribute-values "{\":p\":{\"S\":\"$EID\"}}" --query "Items[].action.S" --output text 2>/dev/null)
  echo "      AuditLog actions for the S5 election: $A6" | tee -a "$OUT"
  echo "$A6" | grep -q ELECTION_CREATED && ok "S6 audit trail: ELECTION_CREATED recorded in DynamoDB AuditLog" || bad "S6 audit trail"
  curl -s -o /dev/null -X DELETE $B/api/elections/$EID -H "Authorization: Bearer $ADMIN"  # clean up the test election
fi
G6=$(aws dynamodb query --table-name AuditLog --key-condition-expression "pk = :p" \
     --expression-attribute-values '{":p":{"S":"GLOBAL"}}' --query "Items[?action.S=='RATE_LIMITED'] | length(@)" --output text 2>/dev/null)
[ "${G6:-0}" -ge 1 ] 2>/dev/null && ok "S6 blocked requests are in the audit log: RATE_LIMITED records = $G6" || bad "S6 RATE_LIMITED not in the audit log"

# S7 the audit chain is intact (nobody edited or removed a record)
AUD=$(login SEED_AUDITOR_EMAIL SEED_AUDITOR_PASSWORD)
V7=$(curl -s $B/api/audit-logs/verify -H "Authorization: Bearer $AUD")
echo "      $V7" | tee -a "$OUT"
echo "$V7" | grep -q '"valid":true' && ok "S7 audit hash chain verifies (valid:true)" || bad "S7 audit hash chain"

echo "Result: $PASS passed, $FAIL failed" | tee -a "$OUT"
[ "$FAIL" = 0 ]
