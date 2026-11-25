# Student Election Voting – Team 41

Cloud Computing & Cloud Security group project. Express APIs (3 services) + plain HTML/CSS/JS frontend, Neon Postgres, deployed on Floci (local AWS).

| Service | Owner | Code |
|---|---|---|
| Election Management | Mo'men Mohamed | `backend/services/election`, `frontend/admin` |
| Voter Access & Voting | Mohamed Osama | `backend/services/voting`, `frontend/student`, `backend/shared` |
| Results & Audit | Mohamed Khaled | `backend/services/results`, `frontend/auditor`, `docs` |

Final report: `docs/FINAL_REPORT.md` (architecture and ER diagrams in `docs/diagrams/`, screenshots in `docs/evidence/`, load-test results in `docs/SCALING_AND_LOAD_TESTING.md`).

## Run locally
```bash
cd backend
npm install
cp ../.env.example .env        # then fill DATABASE_URL, JWT_SECRET, SEED_* (never commit .env)
# Neon SQL editor: run db/schema.sql
npm run seed                   # creates admin + auditor
npm run dev                    # API on http://localhost:3000
cd ../frontend && npx serve -l 8080   # or any static server, open http://localhost:8080
npm test                       # unit tests (state machine, validators, audit hash)
```

## Deploy to Floci
```bash
docker compose -f infra/floci/docker-compose.yml up -d
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
bash infra/setup-all.sh        # first time: tables, secret, buckets, IAM roles, 3 Lambdas, API Gateway, S3 site (safe to re-run)
bash infra/deploy-code.sh      # after every code change: updates the 3 Lambdas + website
```
Floci runs in persistent mode (Docker volume `floci-data`), so everything survives restarts.

## Tests
```bash
cd backend && npm test                         # unit tests
node ../tests/election-e2e.js                  # Election Management (48)
node ../tests/voting-e2e.js                    # Voting (56, local only: it sends e-mails)
node ../tests/results-e2e.js                   # Results & Audit (22)
node ../tests/security-smoke.js                # security smoke (16)
```

## Lab 8 – scale and secure (no extra AWS services)
```bash
export RATE_LIMIT_MAX=100000                   # raise the limit for load tests
bash infra/scale-test.sh vertical && bash infra/load-test.sh run-a      # 1 worker
bash infra/scale-test.sh horizontal 3 && bash infra/load-test.sh run-b  # 3 workers behind lb on :8080
bash infra/load-test.sh run-c                  # failover: worker 2 is killed after 30 s
unset RATE_LIMIT_MAX; bash infra/scale-test.sh stop
RATE_LIMIT_MAX=60 bash infra/scale-test.sh vertical && bash infra/security-checks.sh   # S1-S7
bash infra/scale-test.sh stop && bash infra/verify-deployment.sh                              # PASS/FAIL checker
```
Results: `docs/SCALING_AND_LOAD_TESTING.md` (needs k6: https://grafana.com/docs/k6/).

## Demo day
```bash
# Git Bash in the project folder, Docker Desktop running (Floci starts with it)
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
bash infra/deploy-code.sh          # make sure the Lambdas and website have the latest code
bash infra/verify-deployment.sh    # PASS/FAIL check of the 7 AWS services, API and security layers
```
Website: http://localhost:4566/election-web/index.html · Floci dashboard: http://localhost:4566/_floci/ui
Scenario: create election → vote → duplicate vote (409) → student opens an admin route (403) → close voting early → count → publish → auditor verify chain → failed logins in CloudWatch Logs:
`aws logs filter-log-events --log-group-name /aws/lambda/voting-svc --filter-pattern 401`

## Rules
- No secrets in git (`.env` is ignored; only `.env.example`). Run gitleaks before every push to `main`.
- Every state-changing route: `requireAuth` → `requireRole` → ownership/state check → validated input → audit event.
- Each student commits to their own folders through pull requests.
