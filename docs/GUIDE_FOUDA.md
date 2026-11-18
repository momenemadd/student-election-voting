# Guide for Fouda (Mohamed Osama) – Voting Service

Read this guide once from top to bottom, then do **Part 4 (your steps)** in order.
If you use an AI assistant, give it this whole file – **Part 0** is written for it.
Stuck for more than 30 minutes? Message Mo'men.

---

## Part 0 – Brief for an AI assistant (exact specification)
**Role:** you are helping Fouda (Mohamed Osama) build the **Voting service** of a 3-service student-election web app. Fouda is the owner and must understand, review and be able to explain every line you write (it is assessed coursework with an individual oral discussion; follow the module's AI-use rules). Explain each change briefly as you make it. Work in small steps; after each step tell Fouda to commit.

**Stack (do not change):** Node.js 20+, Express 5 (CommonJS `require`), plain HTML/CSS/JS frontend (no frameworks, no build step), PostgreSQL on Neon via `pg`, deployed as AWS Lambda (serverless-http) on Floci. Express 5 forwards errors from `async` handlers automatically – **do not wrap handlers in try/catch**; throw `AppError`.

**Files Fouda MAY create or edit (nothing else):**
| Path | Purpose |
|---|---|
| `backend/services/voting/routes.js` | all voting endpoints (already contains login/logout/me – keep them working) |
| `backend/services/voting/rateLimit.js` (new) | DynamoDB rate limiter |
| `backend/services/voting/mail.js` (new) | Brevo email sender |
| `db/migrations/001_voting.sql` (new) | the 3 OTP columns |
| `frontend/index.html`, `frontend/js/index.js` | login page: only add Turnstile + "Create account" link |
| `frontend/register.html`, `frontend/js/register.js` (new) | register + verify email |
| `frontend/student/**` (new) | student pages + optional `student/student.css` |
| `tests/voting-e2e.js` (new) | Fouda's tests |
| `docs/evidence/VT-*.png` (new) | screenshots |

**Files Fouda must NOT edit** (owned by others – ask Mo'men if a change is needed): everything in `backend/shared/`, `backend/services/election/`, `backend/services/results/`, `backend/lambda/`, `backend/server.js`, `backend/package.json`, `backend/package-lock.json`, `db/schema.sql`, `infra/`, `frontend/admin/`, `frontend/results/`, `frontend/auditor/`, `frontend/css/style.css`, `frontend/js/api.js`, `frontend/js/ui.js`, `frontend/js/config*.js`, other people's tests, `docs/REPORT_DRAFT.md`, `CODEOWNERS`, `.env.example`. **No new npm packages** (use built-in `fetch` and `crypto`; `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` are already installed).

**Existing functions to reuse (exact signatures):**
| Module | Function | Behaviour |
|---|---|---|
| `../../shared/auth` | `requireAuth` (middleware) | 401 if no/invalid token; sets `req.user = { id, role, studentNumber }` |
| | `requireRole(...roles)` | 403 + audit `ACCESS_DENIED` if role not in list |
| | `hashPassword(plain)` → Promise<string> · `verifyPassword(plain, hash)` → Promise<bool> · `dummyCompare(plain)` · `signToken(userRow)` | bcrypt cost 12; JWT 30 min (row needs `user_id, role, token_version`) |
| `../../shared/validate` | `v.string(x, name, {min, max})` (returns trimmed) · `v.email(x)` (lowercased) · `v.uuid(x, name)` · `v.int(x, name, {min, max})` · `v.date(x, name)` · `v.oneOf(x, name, list)` · `pick(body, allowedKeys)` | throw 400 `VALIDATION_ERROR` |
| `../../shared/errors` | `new AppError(status, code, message, details?)` | response `{ error: { code, message, details } }`; Postgres unique violation `23505` becomes 409 `CONFLICT` automatically unless you catch it |
| `../../shared/db` | `query(sql, params)` → `{ rows, rowCount }` · `withTx(async (client) => …)` | always `$1, $2` parameters; inside `withTx` use `client.query` only |
| `../../shared/electionState` | `syncStatus(query, electionId)` → election row or `undefined` | applies automatic OPEN/CLOSED by database time first |
| `../../shared/audit` | `audit.record({ actor_id, role, action, resource, outcome, election_id })` | fire-and-forget; `election_id` empty → stored under `GLOBAL` |
| `../../shared/turnstile` | `verifyTurnstile(token, req.ip)` | throws 403 `BOT_CHECK_FAILED` / 503 |
| `../../shared/config` | `loadSecrets()` → `{ DATABASE_URL, JWT_SECRET, TURNSTILE_SECRET_KEY, MAIL_API_KEY, MAIL_FROM }` | env locally, Secrets Manager on Floci |
| frontend `js/api.js` | `api(path, { method, body })` → data, or throws `Error{ status, data }` · `Auth.token`, `Auth.user`, `Auth.set(token, user)`, `Auth.clear()` | adds the Bearer token |
| frontend `js/ui.js` | `el(tag, {class, text, onclick…}, ...children)` · `guard(role)` · `renderNav(activeLabel)` · `flash(msg, 'error'|'ok'|'warn')` · `act(button, asyncFn, okMsg)` · `askDialog({ title, fields:[{name,label,value,required,minlength,maxlength,type}], ok, danger })` → values or null · `badge(status)` · `fmtDate(iso)` · `qs(name)` | `renderNav('My elections')` for students |

**Fixed names shared by all services (never rename):**
- Roles: `ADMIN`, `STUDENT`, `AUDITOR`. Election status: `DRAFT`, `SCHEDULED`, `OPEN`, `CLOSED`, `TALLIED`, `PUBLISHED`, `CANCELLED`.
- Audit actions Fouda writes: `REGISTER`, `EMAIL_VERIFIED`, `EMAIL_CODE_FAILED`, `VOTE_CAST`, `VOTE_REJECTED`, `RATE_LIMITED` (plus existing `LOGIN_OK`, `LOGIN_FAILED`, `LOGIN_LOCKED`, `LOGOUT`). Mohamed Khaled's security summary counts `LOGIN_FAILED`, `LOGIN_LOCKED`, `ACCESS_DENIED`, `RATE_LIMITED`, `EMAIL_CODE_FAILED` – spell them exactly.
- Error codes Fouda returns: `NOT_ON_ROSTER` (403), `ALREADY_REGISTERED` (409), `INVALID_CODE` (401), `CODE_EXPIRED` (401), `ELECTION_NOT_OPEN` (409), `ALREADY_VOTED` (409), `TOO_MANY_REQUESTS` (429), `ELECTION_NOT_FOUND` (404), `RECEIPT_NOT_FOUND` (404), plus shared `VALIDATION_ERROR`, `BOT_CHECK_FAILED`, `FORBIDDEN`, `AUTH_REQUIRED`.
- Results page link (owned by Mohamed Khaled): `../results/index.html?id=<election_id>`.

**Tables Fouda uses (from `db/schema.sql`):**
`users(user_id, student_number, email, password_hash, role, email_verified, failed_logins, locked_until, token_version, created_at)` + new `otp_hash, otp_expires_at, otp_tries` ·
`students(student_id, student_number, full_name, email, faculty, active)` · `elections(election_id, title, description, start_time, end_time, status, …)` · `positions(position_id, election_id, title, max_selections)` · `candidates(candidate_id, position_id, name, manifesto)` · `eligibility(election_id, student_id)` · `vote_receipts(election_id, student_id, receipt_hash, voted_on)` PK (election_id, student_id) · `ballots(ballot_id, election_id)` · `ballot_selections(ballot_id, position_id, candidate_id)`.
**Never** add a column, join or log that connects `vote_receipts` (who) to `ballots`/`ballot_selections` (what).

**Done =** every endpoint in Part 7 behaves as specified, all tests in Part 9 pass with `node ../tests/voting-e2e.js` from `backend/`, the existing `node ../tests/security-smoke.js` still shows 16 PASS, and every box in Part 13 is ticked.

---

## Part 1 – The project in simple words
We are building a **website for student elections**.
- An **Admin** prepares an election: name, dates, positions (e.g. President), candidates, and the list of students who can vote.
- A **Student** logs in, sees the elections they can vote in, votes **once**, and nobody can know what they chose.
- An **Auditor** checks the results and a log of everything that happened, and can prove nobody changed the log.

| Service | Owner | In one sentence |
|---|---|---|
| Election Management | **Mo'men** | The admin prepares and controls elections ✅ **DONE** |
| **Voting** | **You (Fouda)** | Students register, log in and vote once, secretly |
| Results & Audit | Mohamed Khaled | Count votes, publish results, check the audit log |

**Where it runs:** on Mo'men's laptop in **Floci** (a free copy of Amazon Web Services that runs in Docker). The data is in **Neon** (an online database). You write and test on **your own PC**; Mo'men puts it on Floci.
```
Browser (HTML/CSS/JS pages) ──► API Gateway ──► Lambda (Express code) ──► Neon database
                                                   ├─► DynamoDB (audit log, rate limits)
                                                   ├─► Secrets Manager (passwords and keys)
                                                   └─► CloudWatch (logs)
```

---

## Part 2 – What Mo'men already finished (use it, don't rebuild it)
| Done by Mo'men | What it means for you |
|---|---|
| All cloud setup on Floci (website, API Gateway, 3 Lambdas, DynamoDB, Secrets Manager, CloudWatch, IAM) | No cloud work for you. Your API routes already exist. |
| Neon database with all tables | Your tables exist; you only add 3 columns. |
| Shared code in `backend/shared/` (tokens, roles, input checks, errors, database, audit log, election status rules, Turnstile check, email settings) | You **use** it (Part 0 table). You never edit it. |
| Login, logout, `/api/me` in **your** file `backend/services/voting/routes.js` | **Read it first – copy its style.** |
| Election Management: elections, positions, candidates, student list, who can vote, schedule/cancel/close | The students and candidates you use come from here. |
| Design and page helpers (`style.css`, `ui.js`, `api.js`) | Your pages look the same automatically. |
| 48 tests for his part (`tests/election-e2e.js`) | Copy its style for your tests. |
| GitHub repository and your branch `feat/osama-voting` | You work only on this branch. |

---

## Part 3 – Your part in simple words
You build **everything a student does**:
1. **Register** – create an account (only if the school added the student to the list).
2. **Verify email** – we email a 6-digit code; typing it proves the email is theirs.
3. **Log in** – already works; you add the anti-robot check (Turnstile) to the page.
4. **My elections** – the student sees only elections they are allowed to vote in.
5. **Ballot** – the positions and candidates of an open election.
6. **Vote** – **once**; a second vote is refused; nobody can see who voted for whom.
7. **Receipt** – proof that their vote was counted.

Two **outside services** (a coursework requirement): **Cloudflare Turnstile** (stops robots) and **Brevo** (sends the code and the receipt).
Your **AWS services** (say these in the report): Lambda `voting-svc` · DynamoDB `RateLimits` · Secrets Manager · IAM role `voting-svc-role` · CloudWatch Logs.

---

## Part 4 – Your steps (in this order, as fast as you can)
| Step | What to do | Done when… |
|---|---|---|
| 1 | Setup (Part 5) | `npm run dev` works and the smoke test shows 16 PASS |
| 2 | Create Brevo + Turnstile accounts (Part 6) | keys are in your `backend/.env` and sent to Mo'men privately |
| 3 | Add the 3 database columns (Part 7.1) | columns exist in Neon |
| 4 | Email sender `mail.js` (Part 7.4) | a test email arrives |
| 5 | Register + verify email (V1, V2) | you receive a real code and can verify |
| 6 | My elections + ballot (V4, V5) | a student sees only their elections and the candidates |
| 7 | **Vote** (V6) + receipt (V7) | vote works, a second vote gives 409 |
| 8 | Rate limiter `rateLimit.js` (Part 7.5) | too many tries gives 429 (on Floci) |
| 9 | Pages (Part 8) | a student can do everything in the browser |
| 10 | Tests (Part 9) | all your tests PASS |
| 11 | Pull request → Mo'men merges and deploys (Part 10) | it works on Floci |
| 12 | Screenshots + report text (Part 11) | files in `docs/evidence/`, text sent to Mohamed Khaled |
**Commit after every step.** Your commits are your proof of work.

---

## Part 5 – Setup on your PC (≈20 minutes)
1. Install **Git** and **Node.js 20+**. Accept Mo'men's GitHub invitation (check your email).
2. In Git Bash:
   ```bash
   git clone https://github.com/momenemadd/student-election-voting.git
   cd student-election-voting
   git checkout feat/osama-voting
   ```
3. Copy `.env.example` to `backend/.env`. Mo'men sends you the real values **privately**. **Never upload `.env`.**
4. ```bash
   cd backend
   npm install
   npm run dev
   ```
   Open http://localhost:3000/api/health → `"status":"ok"`.
5. Second terminal: `cd frontend` → `npx serve -l 8080` → open http://localhost:8080.
6. From `backend/`: `node ../tests/security-smoke.js` → 16 PASS lines.

On your PC `RATE_TABLE` is empty, so the rate limiter must simply allow everything there.

---

## Part 6 – The two outside services
**A. Brevo (email)** – free account at brevo.com.
1. Sign up and verify the email address you will send **from**.
2. Create an **API key** (Settings → SMTP & API → API keys).
3. In `backend/.env`: `MAIL_API_KEY=<key>` and `MAIL_FROM=<your verified sender email>`. Send both to Mo'men privately (they go into Secrets Manager).
4. (Check Brevo's current free limits on their website.)

**B. Cloudflare Turnstile** – Cloudflare dashboard → Turnstile → Add widget → hostname `localhost`.
- **Site key** (public) → used in your web pages.
- **Secret key** (private) → `TURNSTILE_SECRET_KEY=` in `backend/.env`, sent to Mo'men privately.
- If Cloudflare does not accept `localhost`, keep the test keys from `.env.example` and write it under Limitations.

---

## Part 7 – Backend (your folder `backend/services/voting/`)
**Every endpoint follows the same 7 steps** (the login code already does this):
1 check token (`requireAuth`) → 2 check role (`requireRole('STUDENT')`) → 3 check state (open? mine?) → 4 check input (`v.*`, `pick`) → 5 SQL with `$1, $2` → 6 audit (`audit.record`) → 7 correct status code.

### 7.1 Database change
Create `db/migrations/001_voting.sql` and run it in Neon's SQL editor:
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_tries int NOT NULL DEFAULT 0;
```
Save only a **SHA-256 hash** of the code (`crypto.createHash('sha256')`), never the code.

### 7.2 Your endpoints
| # | What | Method + path | Rules the backend must check | Success | Errors |
|---|---|---|---|---|---|
| V1 | Register | `POST /api/auth/register` `{student_number, email, password, turnstileToken}` | rate limit `register:<ip>` · Turnstile · number exists in `students` and `active` · **email equals the roster email** (else 403 `NOT_ON_ROSTER`) · password 12–200 chars · no user with that email or number (409 `ALREADY_REGISTERED`) · create user `STUDENT`, `email_verified=false` · 6-digit code `String(crypto.randomInt(0, 1000000)).padStart(6, '0')`, store hash + expiry now+10 min, `otp_tries=0` · email the code · **never return the code** · audit `REGISTER` | 201 | 400, 403, 409, 429 |
| V2 | Verify email | `POST /api/auth/verify-email` `{email, code}` | code = exactly 6 digits (400) · `otp_tries` ≥ 5 → 429 · expired → 401 `CODE_EXPIRED` · wrong → `otp_tries+1`, audit `EMAIL_CODE_FAILED`, 401 `INVALID_CODE` · right → `email_verified=true`, clear otp columns, audit `EMAIL_VERIFIED` | 200 | 400, 401, 429 |
| V3 | New code (optional) | `POST /api/auth/resend-code` `{email}` | rate limit `otp:<email>` · only if not verified · new code + expiry, `otp_tries=0` · always answer 200 (do not reveal if the email exists) | 200 | 400, 429 |
| V4 | My elections | `GET /api/me/elections` | `STUDENT` only · elections where I am in `eligibility`, status not `DRAFT`/`CANCELLED` · add `has_voted` · identity **only** from `req.user.studentNumber` | 200 | 401, 403 |
| V5 | Ballot | `GET /api/elections/:id/ballot` | `v.uuid` · `syncStatus` · not on my list → 404 `ELECTION_NOT_FOUND` · not `OPEN` → 409 `ELECTION_NOT_OPEN` · already voted → 409 `ALREADY_VOTED` · return positions with candidates, **no vote counts** | 200 | 400, 401, 403, 404, 409 |
| V6 | **Vote** | `POST /api/elections/:id/votes` `{selections:[{position_id, candidate_id}], turnstileToken}` | see 7.3 | 201 `{receipt_code}` | 400, 401, 403, 404, 409, 429 |
| V7 | My receipt | `GET /api/elections/:id/receipt` | only **my own** receipt · return `{ election_id, voted_on, receipt_ref }` where `receipt_ref` = first 8 chars of `receipt_hash` · none → 404 `RECEIPT_NOT_FOUND` | 200 | 400, 401, 403, 404 |
Also add rate limit `login:<ip>` at the start of the existing login.

### 7.3 Vote (V6) – exact order
1. Rate limit `vote:<user id>`. 2. `verifyTurnstile` → 403.
3. Validate `selections` (array of `{position_id, candidate_id}` UUIDs): each position of **this** election chosen at least once and at most `max_selections` times, no candidate twice, every candidate belongs to its position → else 400 (audit `VOTE_REJECTED`).
4. `student_id` from `SELECT student_id FROM students WHERE student_number=$1 AND active` with `req.user.studentNumber` (**never** from the body).
5. `withTx(async (client) => { … })`:
   - `SELECT … FROM elections WHERE election_id=$1 AND status='OPEN' AND now() < end_time` → none → 409 `ELECTION_NOT_OPEN`
   - eligibility row → none → 404
   - `INSERT INTO vote_receipts(election_id, student_id, receipt_hash)` → error code `23505` → 409 `ALREADY_VOTED`
   - `INSERT INTO ballots(election_id) VALUES($1) RETURNING ballot_id`
   - one `INSERT INTO ballot_selections` per choice
6. After commit: audit `VOTE_CAST` with `election_id` – **no candidate data**.
7. Email the receipt code (no choices). Return 201 `{ receipt_code }`. Only its SHA-256 is stored.

**Why (you will be asked):** `vote_receipts` knows **who** voted, not the choice. `ballots` knows **what**, not who. They are never linked, so not even an admin with database access can see a student's vote. The primary key on `vote_receipts` makes a second vote impossible, even if two requests arrive at the same moment.

### 7.4 Email sender (`backend/services/voting/mail.js`)
`async function sendMail(to, subject, text)`: get `MAIL_API_KEY` and `MAIL_FROM` from `loadSecrets()`; `fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify({ sender: { email: FROM }, to: [{ email: to }], subject, textContent: text }), signal: AbortSignal.timeout(8000) })`. If it fails, throw `AppError(503, 'EMAIL_UNAVAILABLE', …)` – and **never** put the code in logs.

### 7.5 Rate limiter (`backend/services/voting/rateLimit.js`) – one of your AWS services
`async function hit(key, limit, windowSeconds)`:
- `process.env.RATE_TABLE` empty → return (allow).
- Else DynamoDB `UpdateCommand` (from `@aws-sdk/lib-dynamodb`) on `RATE_TABLE`, `Key: { pk: key }`, `UpdateExpression: 'ADD #c :one SET expires_at = if_not_exists(expires_at, :exp)'`, `ExpressionAttributeNames: { '#c': 'count' }`, `ExpressionAttributeValues: { ':one': 1, ':exp': nowSeconds + windowSeconds }`, `ReturnValues: 'UPDATED_NEW'`.
- If `count > limit` → audit `RATE_LIMITED`, throw `AppError(429, 'TOO_MANY_REQUESTS', 'Too many attempts, try again later')`.
- Limits: `login:<ip>` 10/300 s · `register:<ip>` 5/600 s · `otp:<email>` 5/600 s · `vote:<user id>` 10/60 s.
- Mo'men already enabled automatic expiry on `expires_at` and gave your Lambda role permission.

---

## Part 8 – Your web pages
Copy the top of `frontend/admin/index.html` (security `<meta>` line, `<body data-root="../">` – use `data-root=""` for pages directly in `frontend/` – `<header></header>`, `<p id="flash">`, the 4 `<script>` lines). For pages with Turnstile add `https://challenges.cloudflare.com` to `script-src` and `frame-src`, and load `https://challenges.cloudflare.com/turnstile/v0/api.js`.
| Page | What the student sees |
|---|---|
| `frontend/register.html` + `frontend/js/register.js` | student number, email, password, Turnstile → code box → "Go to sign in" |
| `frontend/index.html` + `frontend/js/index.js` (login – change only this) | Turnstile widget; send its real token instead of `XXXX.DUMMY.TOKEN`; "Create account" link |
| `frontend/student/index.html` + `student/js/home.js` | `guard('STUDENT')`, `renderNav('My elections')`; my elections with `badge`, and a button: **Vote** (OPEN, not voted) / **Voted ✔** / **See results** (PUBLISHED → `../results/index.html?id=`) |
| `frontend/student/vote.html?id=` + `student/js/vote.js` | one group per position (radio, or checkboxes if more than 1 winner), Turnstile, "Review my vote" → `askDialog` confirm → show the receipt code once ("save this code") |
| `frontend/student/receipt.html?id=` + `student/js/receipt.js` | my receipt |
**Rules:** show server data only with `el(…, { text: … })` – never `innerHTML`. Extra styles go in `frontend/student/student.css`, not in `style.css`.

---

## Part 9 – Your tests (`tests/voting-e2e.js`)
Copy `tests/election-e2e.js` (it creates temporary users and students, runs checks, cleans up). Open an election in a test with `UPDATE elections SET start_time = now() - interval '1 minute' WHERE election_id=$1`.
| ID | Test | Must return |
|---|---|---|
| VT-01 | Register with a number not on the list | 403 NOT_ON_ROSTER |
| VT-02 | Real number, different email | 403 NOT_ON_ROSTER |
| VT-03 | Short password | 400 |
| VT-04 | Register twice | 409 ALREADY_REGISTERED |
| VT-05 | Wrong code 6 times | 401 ×5, then 429 |
| VT-06 | Login before verifying | 403 EMAIL_NOT_VERIFIED |
| VT-07 | My elections shows only mine | 200 |
| VT-08 | Ballot before opening | 409 ELECTION_NOT_OPEN |
| VT-09 | Ballot for an election I am not on | 404 |
| VT-10 | Candidate from another position | 400 |
| VT-11 | A position missing | 400 |
| VT-12 | Correct vote | 201 + receipt code |
| VT-13 | Vote again | 409 ALREADY_VOTED |
| VT-14 | **20 votes at the same time** (`tests/race-test.js`) | exactly one 201 |
| VT-15 | Vote after closing | 409 |
| VT-16 | Admin / auditor tries to vote | 403 |
| VT-17 | No token | 401 |
| VT-18 | Receipt returns only my own | 200 mine / 404 if I did not vote |
| VT-19 | No Turnstile token | 403 BOT_CHECK_FAILED |
| VT-20 | Database check: nothing links `vote_receipts` and `ballots` | written in the report |
Run from `backend/`: `node ../tests/voting-e2e.js`. Tests needing real email may set the code directly in the database for the test user.

---

## Part 10 – GitHub (your proof of work)
- Work only on `feat/osama-voting`. After every step: `git add .` → `git commit -m "Add vote endpoint"` → `git push`.
- Before every push: `git status` must **not** show `.env`.
- When a feature works: GitHub → **Compare & pull request** → into `main`. Mo'men reviews, merges, deploys to Floci.
- Aim for **10+ clear commits**.

---

## Part 11 – Screenshots and report text
**Screenshots** → `docs/evidence/VT-*.png`: register form · email received (hide the code) · verify success · my elections · ballot · confirm box · receipt · second vote 409 (F12 → Network) · ballot before opening 409 · race test result · no-Turnstile 403.
**Send to Mohamed Khaled** (he assembles the report): your endpoint table (7.2) · what Turnstile and Brevo do and that keys are in Secrets Manager · your security-test rows (double vote, vote outside time, lockout, robot check) · **your Individual Contribution Statement** (component + functions, pages, endpoints, data stored/read, security controls, tests, how you connect to Mo'men's and Mohamed Khaled's parts, decisions, problems solved, commit links).

---

## Part 12 – After all three of us finish (in this order)
| Step | What happens | Who |
|---|---|---|
| 1 | All pull requests merged into `main`; Mo'men runs every test and deploys to Floci | Mo'men |
| 2 | **Full test together:** admin creates election → students register and vote → voting closes → count → publish → students see results → auditor checks the log | all 3 |
| 3 | Fix what breaks; take the last screenshots | all 3 |
| 4 | Report assembled (all 16 sections + 3 statements) | Mohamed Khaled collects, everyone checks |
| 5 | **Demo video ≤ 5 min**: main scenario first, then security (wrong role, wrong input, double vote) | Mo'men records |
| 6 | Final repository check (public, no secrets), final commit | Mo'men |
| 7 | **Practise the demo twice** – each person shows and explains their own part without notes | all 3 |
| 8 | Submit: report + GitHub link + video link (deadline Wed 25 Nov) | Mo'men |
| 9 | Live demo and discussion – **everyone must attend (absent = 0%)** | all 3 |

---

## Part 13 – Done checklist (before you open your final pull request)
- [ ] V1–V7 work and all VT tests pass; the smoke test still shows 16 PASS
- [ ] A real email arrives; the code never appears in responses or logs
- [ ] Turnstile on register, login and vote; the backend refuses without it
- [ ] Too many attempts → 429 (checked on Floci after merge)
- [ ] 20 votes at once → exactly one accepted
- [ ] Student pages work in the browser; no `innerHTML`
- [ ] Only files from the Part 0 "MAY edit" list were changed
- [ ] 10+ commits on my branch, pull request merged
- [ ] Screenshots saved, report text sent

**Discussion questions to prepare:** Why can nobody see how a student voted? · What stops a double vote if two requests come at the same time? · Where does the student's identity come from? · Why is the email code stored as a hash? · What if the email service is down? · What if a token is stolen? · Which 3 AWS services does your part use and why?

---

## Small dictionary
| Word | Meaning |
|---|---|
| Endpoint / route | one URL the website calls, e.g. `POST /api/elections/:id/votes` |
| Token (JWT) | the "logged in" pass the browser sends with every request |
| Status code | 200 OK, 201 created, 400 bad input, 401 not logged in, 403 not allowed, 404 not found, 409 conflict (wrong state / already done), 429 too many tries |
| Transaction (`withTx`) | several database steps that succeed together or fail together |
| Hash | one-way fingerprint of a value: you can check it but not reverse it |
| Lambda | our Express code running in the cloud only when a request arrives |
| Floci | free local copy of AWS on Mo'men's laptop |
