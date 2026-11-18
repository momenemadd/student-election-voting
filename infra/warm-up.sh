#!/usr/bin/env bash
# Run 1-2 minutes before a demo: wakes the Neon database (it sleeps when idle) and starts all three
# Lambda functions, so the first login and page loads are fast.
# Usage (Git Bash, repo root):  bash infra/warm-up.sh
set -uo pipefail
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
EVENT='{"version":"2.0","rawPath":"/api/health","rawQueryString":"deep=1","queryStringParameters":{"deep":"1"},"headers":{},"requestContext":{"http":{"method":"GET","path":"/api/health","sourceIp":"127.0.0.1"}},"isBase64Encoded":false}'
mkdir -p out
# A page sends several requests at once, and each one needs its own warm container,
# so start 5 containers per function in parallel (each also opens its database connection).
START=$(date +%s)
for SVC in election voting results; do
  for i in 1 2 3 4 5; do
    aws lambda invoke --function-name $SVC-svc --cli-binary-format raw-in-base64-out --payload "$EVENT" out/warm-$SVC-$i.json >/dev/null &
  done
done
wait
for SVC in election voting results; do
  echo "$SVC-svc: $(cat out/warm-$SVC-*.json | grep -o '"statusCode":200' | wc -l)/5 containers warm"
done
echo "took $(( $(date +%s) - START ))s"
echo "warm. Open http://localhost:4566/election-web/index.html"
