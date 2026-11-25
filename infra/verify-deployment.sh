#!/usr/bin/env bash
# Lab 8 style automatic check: PASS/FAIL for the cloud (our 7 AWS services on Floci), the deployed API,
# the Lab 8 security layers, the scale-out evidence and the load-test evidence.
#   bash infra/verify-deployment.sh
set -u   # no pipefail: "cmd | grep -q" must not fail when grep stops reading early
cd "$(dirname "$0")/.."
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; echo "        fix: $2"; FAIL=$((FAIL+1)); }
info() { echo "  INFO  $1"; }
has()  { [ -n "$1" ] && [ "$1" != "None" ]; }

echo "== 1. Floci and our 7 AWS services"
docker ps --filter name=floci-floci-1 --format '{{.Status}}' 2>/dev/null | grep -q Up && ok "Floci container is running" || bad "Floci container" "open Docker Desktop, then: docker compose -f infra/floci/docker-compose.yml up -d"
T=$(aws dynamodb list-tables --query "TableNames" --output text 2>/dev/null)
echo "$T" | grep -q AuditLog && echo "$T" | grep -q RateLimits && ok "DynamoDB: AuditLog + RateLimits" || bad "DynamoDB tables" "bash infra/setup-all.sh"
S=$(aws s3 ls 2>/dev/null)
echo "$S" | grep -q election-web && echo "$S" | grep -q election-results && ok "S3: election-web + election-results" || bad "S3 buckets" "bash infra/setup-all.sh"
SEC=$(aws secretsmanager get-secret-value --secret-id election/app-secrets --query SecretString --output text 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(Object.keys(j).sort().join(','))}catch{}})")
echo "$SEC" | grep -q rateLimitMax && ok "Secrets Manager: election/app-secrets holds the config incl. rateLimitMax (values not shown)" || bad "Secrets Manager rateLimitMax" "bash infra/setup-all.sh"
R=$(aws iam list-roles --query "Roles[].RoleName" --output text 2>/dev/null)
[ "$(echo "$R" | tr '\t' '\n' | grep -cE '^(election|voting|results)-svc-role$')" = 3 ] && ok "IAM: one least-privilege role per Lambda (3)" || bad "IAM roles" "bash infra/setup-all.sh"
L=$(aws lambda list-functions --query "Functions[].FunctionName" --output text 2>/dev/null)
[ "$(echo "$L" | tr '\t' '\n' | grep -cE '^(election|voting|results)-svc$')" = 3 ] && ok "Lambda: election-svc, voting-svc, results-svc" || bad "Lambda functions" "bash infra/setup-all.sh"
API=$(aws apigatewayv2 get-apis --query "Items[?Name=='election-http-api']|[0].ApiId" --output text 2>/dev/null)
if has "$API"; then
  N=$(aws apigatewayv2 get-routes --api-id "$API" --query "length(Items)" --output text)
  aws apigatewayv2 get-routes --api-id "$API" --query "Items[].RouteKey" --output text | grep -q "results/verify" \
    && ok "API Gateway: election-http-api with $N routes (incl. /results/verify)" || bad "API Gateway route /results/verify" "bash infra/setup-all.sh"
else bad "API Gateway" "bash infra/setup-all.sh"; fi
aws logs describe-metric-filters --log-group-name /aws/lambda/voting-svc --query "metricFilters[].filterName" --output text 2>/dev/null | grep -q FailedLogins \
  && aws cloudwatch describe-alarms --query "MetricAlarms[].AlarmName" --output text 2>/dev/null | grep -q election-failed-logins \
  && ok "CloudWatch: log groups + FailedLogins metric filter + alarm" || bad "CloudWatch metric filter / alarm" "bash infra/setup-all.sh"

echo "== 2. Deployed API (API Gateway -> Lambda)"
if has "$API"; then
  U="http://$API.execute-api.localhost.floci.io:4566"
  H=$(curl -s -m 30 -D - -o /dev/null "$U/api/elections" | tr -d '\r')
  echo "$H" | grep -qi '^HTTP/1.1 401' && ok "no token -> 401 on the deployed API" || bad "deployed API 401" "bash infra/deploy-code.sh"
  [ "$(echo "$H" | grep -ciE '^x-content-type-options: nosniff|^x-frame-options: deny|^content-security-policy:')" = 3 ] \
    && ok "security headers on deployed API answers" || bad "security headers on Lambda answers" "bash infra/deploy-code.sh"
  [ "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$U/api/elections/not-a-uuid/results")" = 401 ] && ok "results routes are protected (401 without token)" || bad "results route protection" "bash infra/deploy-code.sh"
  P1=$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://localhost:4566/election-web/results/index.html)
  P2=$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://localhost:4566/election-web/auditor/index.html)
  [ "$P1" = 200 ] && [ "$P2" = 200 ] && ok "website on S3 has the results and auditor pages" || bad "results/auditor pages on S3 ($P1/$P2)" "bash infra/deploy-code.sh"
fi

echo "== 3. Lab 8 security layers (code)"
node -e "const {v}=require('./backend/shared/validate');process.exit(v.text('<script>alert(1)</script>hi','t',{max:500})==='hi'?0:1)" \
  && ok "sanitising removes <script> before saving" || bad "sanitising" "check backend/shared/validate.js"
node -e "const {v}=require('./backend/shared/validate');try{v.text('a'.repeat(501),'t',{max:500});process.exit(1)}catch(e){process.exit(e.status===400?0:1)}" \
  && ok "too-long input -> 400" || bad "length validation" "check backend/shared/validate.js"
grep -q "apiLimiter" backend/shared/http.js && grep -q "WINDOW_MS = 60_000" backend/shared/limiter.js \
  && ok "rate limiter on every API request (60 s sliding window, limit from Secrets Manager)" || bad "rate limiter" "check backend/shared/limiter.js"
[ -f docs/load-testing/security-checks.txt ] && grep -q "Result: .* 0 failed" docs/load-testing/security-checks.txt \
  && ok "S1-S7 attack checks passed ($(grep -c '^PASS' docs/load-testing/security-checks.txt) checks, docs/load-testing/security-checks.txt)" \
  || bad "S1-S7 evidence" "RATE_LIMIT_MAX=60 bash infra/scale-test.sh vertical && bash infra/security-checks.sh"

echo "== 4. Scale out and load tests (evidence)"
if curl -s -m 2 http://localhost:8080/api/health >/dev/null 2>&1; then
  SEEN=$(for i in 1 2 3 4 5 6; do curl -s -m 5 http://localhost:8080/api/health | grep -o '"instanceId":"[^"]*"'; done | sort -u | wc -l)
  [ "$SEEN" -ge 2 ] && ok "round robin: $SEEN different workers answered 6 requests" || info "one worker serves everything (instances seen: $SEEN)"
else info "no workers running on :8080 right now (start: bash infra/scale-test.sh horizontal 3)"; fi
for r in run-a run-b run-c; do
  [ -f "docs/load-testing/$r.json" ] && ok "k6 $r evidence: docs/load-testing/$r.txt + .json" || bad "k6 $r evidence" "bash infra/load-test.sh $r"
done
grep -q "upstream .* failed" infra/.run/logs/lb.log 2>/dev/null || grep -q "worker 2 crashed" docs/load-testing/run-c-events.txt 2>/dev/null \
  && ok "failover drill: worker 2 crashed during Run C and the load balancer routed around it" || bad "failover evidence" "bash infra/load-test.sh run-c"

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
