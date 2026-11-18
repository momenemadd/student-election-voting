# Team Guide – Student Election Voting (Team 41)

For: Mo'men (Election Management) · Mohamed Osama (Voting) · Mohamed Khaled (Results & Audit)
Deadline: **Wed 25 Nov 2026**. Target: **everything finished by Sat 21 Nov**, Sun–Tue = buffer, rehearsal, submission.

---

## 1. The project in one paragraph
A website where an **Admin** creates a student election (positions, candidates, which students may vote, start/end time), **Students** log in and vote once, secretly, while it is open, and an **Auditor** checks the results and a tamper-proof log of everything that happened. It runs on **Floci** (a free copy of AWS on Mo'men's laptop) with the database on **Neon**.

## 2. How the pieces fit
```
Browser ──> S3 (website files)
   │
   └──> API Gateway ──> Lambda election-svc  (Mo'men)  ─┐
                    ──> Lambda voting-svc    (Osama)   ─┼──> Neon Postgres (main data)
                    ──> Lambda results-svc   (Khaled)  ─┘    DynamoDB AuditLog (audit chain)
                                                             Secrets Manager (passwords/keys)
                                                             CloudWatch Logs (monitoring)
External: Cloudflare Turnstile (anti-bot) + email API (codes and receipts)
```
Words you will hear: **Lambda** = code that runs only when a request arrives · **API Gateway** = the front door that sends each URL to the right Lambda · **S3** = file storage that serves the website · **DynamoDB** = AWS database (we use it for the audit log) · **Neon** = online Postgres database (all main data) · **Floci** = runs all the AWS parts locally in Docker · **JWT token** = the "logged in" pass the browser sends with every request.

## 3. Status (updated 18 Nov)
### Done and tested
| Item | Proof |
|---|---|
| Docker, WSL, AWS CLI, Floci installed on Mo'men's PC | Floci healthy; data survives restarts (persistent mode) |
| Neon database: 11 tables, admin + auditor accounts | `npm run migrate`, `npm run seed` |
| Shared code everyone uses: login check (JWT), roles, input validation, error format, logging, audit hash chain, election state rules, Turnstile check | `backend/shared/` |
| Working endpoints: login, logout, `/api/me`, create/list elections, turnout, audit log, audit verify | 16/16 security checks pass on Floci |
| Full deployment to Floci with one command, safe to re-run | `bash infra/setup-all.sh` |
| Fast code update command | `bash infra/deploy-code.sh` |
| Website on S3 shows "API online: lambda" | browser |
| GitHub repo + one branch per person | github.com/momenemadd/student-election-voting |

### Not done yet
| Item | Owner |
|---|---|
| ~~Election Management endpoints + admin pages~~ **DONE 18 Nov** – 25 endpoints, 3 admin pages, 48/48 tests pass locally and on Floci (`tests/election-e2e.js`) | Mo'men |
| Click through the admin pages once yourself and take screenshots for the report | Mo'men |
| Register, email code, ballot, **vote**, receipt + student pages; choose email provider | Osama |
| Tally, results, publish, export, security summary + auditor pages; CloudWatch alarm evidence | Khaled |
| Security test table (17 tests), screenshots, integrated test | all (Khaled collects) |
| Report (16 sections + 3 individual statements), demo video ≤ 5 min | all (Khaled compiles) |
| Invite Khaled to GitHub (username still unknown) | Mo'men |
| Make repo **Public** before submission; final commit/push | Mo'men, last step |

## 4. Who does what (each person owns frontend + backend + data + security + tests for their service)
**Step-by-step guides:** Fouda (Mohamed Osama) → [`docs/GUIDE_FOUDA.md`](GUIDE_FOUDA.md) · Mohamed Khaled → [`docs/GUIDE_MOHAMED_KHALED.md`](GUIDE_MOHAMED_KHALED.md). Each explains the project in simple words, what Mo'men already finished, the to-do list day by day, every endpoint, page, test, screenshot and report section, what happens after all three finish, and a "done" checklist.

Full endpoint tables with status codes: `FINAL_PHASE_PLAN.md` §5. Code locations have `TODO` comments.

**Mo'men – Election Management** (`backend/services/election/routes.js`, `frontend/admin/`)
1. Get / edit / delete one election (edit only before it opens → else 409).
2. Status changes: schedule, cancel, close early (use `assertTransition`).
3. Readiness check (≥1 position, every position ≥2 candidates, ≥1 eligible student).
4. Positions and candidates (add/edit/delete only in DRAFT).
5. Student roster (add, import list, search) and eligibility per election.
6. Admin pages: election list, create form, edit page with positions/candidates/eligible students.
Report: deployment, cost, recovery, architecture diagram.

**Osama – Voter Access & Voting** (`backend/services/voting/routes.js`, `frontend/student/`)
1. Register (must exist in roster, password ≥12, Turnstile) + email verification code.
2. My elections (only ones I'm eligible for, with "already voted" flag).
3. Ballot (only when OPEN, eligible, not voted).
4. **Cast vote** in one transaction: receipt row (who) + ballot rows (what), never linked → second vote = 409.
5. My receipt (only my own).
6. Student pages: register, verify, my elections, ballot, receipt. Run `tests/race-test.js`.
Report: external integrations, security controls.

**Khaled – Results & Audit** (`backend/services/results/routes.js`, `frontend/auditor/`)
1. Tally (only when CLOSED, saves snapshot + SHA-256) → status TALLIED.
2. Results (Admin/Auditor after TALLIED, Students only after PUBLISHED).
3. Publish (Admin, TALLIED → PUBLISHED, audit logged).
4. Export snapshot; security summary (failed logins / denied requests, last 24 h).
5. Auditor pages: results, audit log with filters, "verify chain" button, security summary.
6. CloudWatch screenshots (log query for 401/403, FailedLogins alarm).
Report: threat model, logs, test table, integrated testing, limitations; compiles the final document.

**Every endpoint follows the same 5 lines** (copy the reference endpoints):
`requireAuth` → `requireRole(...)` → check ownership/state (409 if wrong state) → validate input with `v.*` and `pick` → do the SQL with `$1` parameters → `audit.record(...)` → return the right status code.

## 5. Setup on Osama's and Khaled's PCs (about 15 minutes)
You do **not** need Docker/Floci to write code. You run the API locally against the same Neon database; Mo'men deploys to Floci.
1. Install **Git** and **Node.js 20+**. Accept the GitHub invitation from Mo'men.
2. `git clone https://github.com/momenemadd/student-election-voting.git`
3. `cd student-election-voting` then `git checkout feat/osama-voting` (or `feat/khaled-results`).
4. Copy `.env.example` to `backend/.env`. **Mo'men sends you the real values privately** (WhatsApp/in person) – never in GitHub.
5. `cd backend` → `npm install` → `npm run dev` → open http://localhost:3000/api/health.
6. Frontend: in another terminal `cd frontend` → `npx serve -l 8080` → open http://localhost:8080.
7. Test your endpoints with Postman or VS Code REST Client (`tests/security-tests.http`).
8. **Commit your own work often** on your branch with clear messages (`git add .` → `git commit -m "Add vote endpoint"` → `git push`). Your commits are your individual-mark evidence.
9. When a feature works, open a Pull Request into `main`; another member reviews.

## 6. Mo'men's daily commands (deploying)
```bash
# Git Bash in the project folder
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
docker compose -f infra/floci/docker-compose.yml up -d   # only if Floci is not running
git pull                                                 # get teammates' merged work
bash infra/deploy-code.sh                                # update Lambdas + website (fast)
# bash infra/setup-all.sh                                # only for first setup or if Floci was reset
```
Website: http://localhost:4566/election-web/index.html · Floci dashboard: http://localhost:4566/_floci/ui

## 7. Fast schedule
| Day | Goal |
|---|---|
| Thu 19 | Everyone set up; each writes the first 2–3 endpoints of their service |
| Fri 20 | All endpoints done; pages started; first full run: create election → vote → tally → publish |
| Sat 21 | Pages finished; deploy to Floci; 17 security tests + screenshots; report sections written |
| Sun 22 | Report assembled, video recorded, repo made public, final commit |
| Mon–Tue | Rehearse demo twice; each person explains their own request flow without notes |
| Wed 25 | Submit early |

## 8. Rules nobody may break
- Never put passwords, the database URL or keys in code, screenshots or GitHub. Only `.env` (ignored by Git).
- Hiding a button is not security: every protected endpoint checks the token and role in the backend.
- A student's identity always comes from the token, never from the request body.
- Each person must be able to explain every line of their own service in the oral discussion. Attendance is compulsory (absent = 0%).
- Follow the module's rules on AI tool use, and declare any assistance if the module requires it.

## 9. Short voting windows for the demo
Normally an election must last at least 60 minutes. For the live demo, allow 2-minute windows:
`aws lambda update-function-configuration --function-name election-svc --environment "Variables={SECRETS_ID=election/app-secrets,AUDIT_TABLE=AuditLog,RATE_TABLE=RateLimits,CORS_ORIGINS=http://localhost:4566,NODE_ENV=production,ELECTION_MIN_MINUTES=2}"`
(run `bash infra/setup-all.sh` afterwards to go back to 60).

## 10. Demo day checklist
Start Docker Desktop (Floci starts by itself) → run `bash infra/deploy-code.sh` → open website, Floci dashboard, Neon, Postman → log in as admin/student/auditor in three browser profiles → show: create election → vote → duplicate vote (409) → student opens admin page (403) → tally → publish → auditor verify chain → CloudWatch failed-login alarm.
