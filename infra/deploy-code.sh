#!/usr/bin/env bash
# FAST update after changing code: re-zips the backend, updates the 3 Lambda functions and re-uploads the website.
# Use this every time you change code. Use setup-all.sh only for first setup or after Floci was reset.
# Usage (Git Bash, repo root):  bash infra/deploy-code.sh
set -euo pipefail
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1

( cd backend && npm run zip )
for SVC in election voting results; do
  aws lambda update-function-code --function-name $SVC-svc --zip-file fileb://backend/lambda.zip --query LastUpdateStatus --output text
  aws lambda wait function-updated-v2 --function-name $SVC-svc
done

API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='election-http-api']|[0].ApiId" --output text)
API_URL=http://$API_ID.execute-api.localhost.floci.io:4566
sed "s#__API_URL__#$API_URL#" frontend/js/config.template.js > frontend/js/config.js
aws s3 sync frontend s3://election-web --exclude "*.template.js" --exclude "node_modules/*" >/dev/null
aws s3 cp frontend s3://election-web --recursive --exclude "*" --include "*.css" --content-type text/css >/dev/null
aws s3 cp frontend s3://election-web --recursive --exclude "*" --include "*.js" --exclude "*.template.js" --content-type text/javascript >/dev/null
echo "deployed. API: $API_URL/api/health  SITE: http://localhost:4566/election-web/index.html"
