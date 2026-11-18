# Student Election Voting – Team 41

Cloud Computing & Cloud Security group project. Express APIs (3 services) + plain HTML/CSS/JS frontend, Neon Postgres, deployed on Floci (local AWS).

| Service | Owner | Code |
|---|---|---|
| Election Management | Mo'men Mohamed | `backend/services/election`, `frontend/admin` |
| Voter Access & Voting | Mohamed Osama | `backend/services/voting`, `frontend/student`, `backend/shared` |
| Results & Audit | Mohamed Khaled | `backend/services/results`, `frontend/auditor`, `docs` |

Full design: `FINAL_PHASE_PLAN.md`. Schedule: `docs/seven-day-schedule.md`.

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
bash infra/setup-all.sh        # tables, secret, buckets, IAM roles, 3 Lambdas, API Gateway, S3 site
```

## Rules
- No secrets in git (`.env` is ignored; only `.env.example`). Run gitleaks before every push to `main`.
- Every state-changing route: `requireAuth` → `requireRole` → ownership/state check → validated input → audit event.
- Each student commits to their own folders through pull requests.
