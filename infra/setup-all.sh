#!/usr/bin/env bash
# Builds the whole stack on Floci with AWS CLI commands (same commands work on real AWS).
# UNTESTED until Docker + Floci are installed: run it step by step the first time and fix what Floci rejects.
# Usage (Git Bash, repo root):  bash infra/setup-all.sh
set -euo pipefail
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
REGION=us-east-1; ACCT=000000000000
ENV_FILE=backend/.env

[ -f "$ENV_FILE" ] || { echo "Create backend/.env first (see .env.example)"; exit 1; }
# .env is parsed by dotenv (not bash `source`: connection strings contain '&'). Values are never printed.

echo "== 1. DynamoDB tables"
aws dynamodb create-table --table-name AuditLog \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=seq,AttributeType=N \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=seq,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST >/dev/null || echo "(AuditLog exists)"
aws dynamodb create-table --table-name RateLimits \
  --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST >/dev/null || echo "(RateLimits exists)"
# rate-limit counters delete themselves: items carry expires_at (epoch seconds)
aws dynamodb update-time-to-live --table-name RateLimits \
  --time-to-live-specification "Enabled=true,AttributeName=expires_at" >/dev/null 2>&1 || true

echo "== 2. Secrets Manager (value built from backend/.env, not printed)"
SECRET_JSON=$(node -e "require('./backend/node_modules/dotenv').config({path:'$ENV_FILE',quiet:true});const e=process.env;console.log(JSON.stringify({DATABASE_URL:e.DATABASE_URL,JWT_SECRET:e.JWT_SECRET,TURNSTILE_SECRET_KEY:e.TURNSTILE_SECRET_KEY,MAIL_API_KEY:e.MAIL_API_KEY||'',MAIL_FROM:e.MAIL_FROM||''}))")
aws secretsmanager create-secret --name election/app-secrets --secret-string "$SECRET_JSON" >/dev/null \
  || aws secretsmanager put-secret-value --secret-id election/app-secrets --secret-string "$SECRET_JSON" >/dev/null

echo "== 3. S3 buckets"
aws s3 mb s3://election-web >/dev/null || true       # PUBLIC: frontend files only
aws s3 mb s3://election-results >/dev/null || true   # result snapshots (private)

echo "== 4. IAM: one least-privilege role per service"
for SVC in election voting results; do
  aws iam create-role --role-name $SVC-svc-role --assume-role-policy-document file://infra/iam/trust-policy.json >/dev/null || true
  if ! aws iam create-policy --policy-name $SVC-svc-policy --policy-document file://infra/iam/$SVC-svc-policy.json >/dev/null 2>&1; then
    # policy exists: publish the current JSON as the new default version (keeps IAM in sync with the repo)
    aws iam create-policy-version --policy-arn arn:aws:iam::$ACCT:policy/$SVC-svc-policy \
      --policy-document file://infra/iam/$SVC-svc-policy.json --set-as-default >/dev/null 2>&1 || true
  fi
  aws iam attach-role-policy --role-name $SVC-svc-role --policy-arn arn:aws:iam::$ACCT:policy/$SVC-svc-policy
done

echo "== 5. Lambda package + functions"
( cd backend && npm install --omit=dev >/dev/null && npm install --no-save adm-zip >/dev/null && npm run zip )
for SVC in election voting results; do
  ENVVARS="Variables={SECRETS_ID=election/app-secrets,AUDIT_TABLE=AuditLog,RATE_TABLE=RateLimits,RESULTS_BUCKET=election-results,CORS_ORIGINS=http://localhost:4566,NODE_ENV=production}"
  if aws lambda get-function --function-name $SVC-svc >/dev/null 2>&1; then
    aws lambda update-function-code --function-name $SVC-svc --zip-file fileb://backend/lambda.zip >/dev/null
    aws lambda wait function-updated-v2 --function-name $SVC-svc
    aws lambda update-function-configuration --function-name $SVC-svc --environment "$ENVVARS" >/dev/null
  else
    aws lambda create-function --function-name $SVC-svc --runtime nodejs24.x --handler lambda/$SVC.handler \
      --role arn:aws:iam::$ACCT:role/$SVC-svc-role --zip-file fileb://backend/lambda.zip \
      --timeout 15 --memory-size 512 --environment "$ENVVARS" >/dev/null
  fi
done

echo "== 6. API Gateway (HTTP API) + routes -> the right Lambda"
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='election-http-api']|[0].ApiId" --output text)
if [ "$API_ID" = "None" ] || [ -z "$API_ID" ]; then
  API_ID=$(aws apigatewayv2 create-api --name election-http-api --protocol-type HTTP --query ApiId --output text)
fi
declare -A INTEG
for SVC in election voting results; do
  URI=arn:aws:lambda:$REGION:$ACCT:function:$SVC-svc
  ID=$(aws apigatewayv2 get-integrations --api-id $API_ID --query "Items[?IntegrationUri=='$URI']|[0].IntegrationId" --output text)
  if [ "$ID" = "None" ] || [ -z "$ID" ]; then      # reuse on re-runs, create only the first time
    ID=$(aws apigatewayv2 create-integration --api-id $API_ID --integration-type AWS_PROXY --payload-format-version 2.0 \
      --integration-uri $URI --query IntegrationId --output text)
  fi
  INTEG[$SVC]=$ID
  aws lambda add-permission --function-name $SVC-svc --statement-id apigw-invoke --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:$REGION:$ACCT:$API_ID/*" >/dev/null 2>&1 || true
done
EXISTING_ROUTES=$(aws apigatewayv2 get-routes --api-id $API_ID --query "Items[].RouteKey" --output text | tr '\t' '\n')
route() {   # create the route only if this exact method+path does not exist yet
  grep -qxF "ANY $2" <<<"$EXISTING_ROUTES" && return 0
  aws apigatewayv2 create-route --api-id $API_ID --route-key "ANY $2" --target integrations/${INTEG[$1]} >/dev/null
}
# election-svc
for R in /api/elections /api/elections/{id} /api/elections/{id}/transition /api/elections/{id}/positions /api/elections/{id}/readiness \
         /api/elections/{id}/eligible-students /api/elections/{id}/eligible-students/{studentId} \
         /api/positions/{id} /api/positions/{id}/candidates /api/candidates/{id} /api/students /api/students/{id} /api/students/import; do route election "$R"; done
# voting-svc
for R in /api/auth/{action} /api/me /api/me/elections /api/elections/{id}/ballot /api/elections/{id}/votes /api/elections/{id}/receipt; do route voting "$R"; done
# results-svc
for R in /api/elections/{id}/turnout /api/elections/{id}/tally /api/elections/{id}/results /api/elections/{id}/results/publish \
         /api/elections/{id}/results/export /api/audit-logs /api/audit-logs/verify /api/monitoring/security-summary; do route results "$R"; done
route election /api/health
aws apigatewayv2 create-stage --api-id $API_ID --stage-name '$default' --auto-deploy >/dev/null 2>&1 || true

echo "== 7. CloudWatch: log groups + failed-login metric filter + alarm"
for SVC in election voting results; do aws logs create-log-group --log-group-name /aws/lambda/$SVC-svc 2>/dev/null || true; done
aws logs put-metric-filter --log-group-name /aws/lambda/voting-svc --filter-name FailedLogins \
  --filter-pattern '{ $.status = 401 }' --metric-transformations metricName=FailedLogins,metricNamespace=Election,metricValue=1 || echo "(metric filter unsupported on this Floci build)"
aws cloudwatch put-metric-alarm --alarm-name election-failed-logins --namespace Election --metric-name FailedLogins \
  --statistic Sum --period 300 --evaluation-periods 1 --threshold 5 --comparison-operator GreaterThanOrEqualToThreshold || echo "(alarm unsupported)"

echo "== 8. Frontend to S3 (frontend files only)"
API_URL=http://$API_ID.execute-api.localhost.floci.io:4566
sed "s#__API_URL__#$API_URL#" frontend/js/config.template.js > frontend/js/config.js
aws s3 sync frontend s3://election-web --exclude "*.template.js" --exclude "node_modules/*" >/dev/null
aws s3 cp frontend s3://election-web --recursive --exclude "*" --include "*.css" --content-type text/css >/dev/null
aws s3 cp frontend s3://election-web --recursive --exclude "*" --include "*.js" --exclude "*.template.js" --content-type text/javascript >/dev/null

echo; echo "API:  $API_URL/api/health"; echo "SITE: http://localhost:4566/election-web/index.html"
