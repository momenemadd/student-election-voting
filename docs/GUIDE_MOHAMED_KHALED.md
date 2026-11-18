# Guide for Mohamed Khaled – Results & Audit Service

Read this guide once from top to bottom, then do **Part 4 (your steps)** in order.
If you use an AI assistant, give it this whole file – **Part 0** is written for it.
Stuck for more than 30 minutes? Message Mo'men.

---

## Part 0 – Brief for an AI assistant (exact specification)
**Role:** you are helping Mohamed Khaled build the **Results & Audit service** of a 3-service student-election web app. Mohamed Khaled is the owner and must understand, review and be able to explain every line you write (it is assessed coursework with an individual oral discussion; follow the module's AI-use rules). Explain each change briefly as you make it. Work in small steps; after each step tell him to commit.

**Stack (do not change):** Node.js 20+, Express 5 (CommonJS `require`), plain HTML/CSS/JS frontend (no frameworks, no build step), PostgreSQL on Neon via `pg`, deployed as AWS Lambda (serverless-http) on Floci. Express 5 forwards errors from `async` handlers automatically – **do not wrap handlers in try/catch**; throw `AppError`.

**Files Mohamed Khaled MAY create or edit (nothing else):**
| Path | Purpose |
|---|---|
| `backend/services/results/routes.js` | all results/audit endpoints (already has turnout, audit list, audit verify – keep them working) |
| `backend/services/results/*.js` (new helpers, e.g. `tally.js`, `snapshots.js`) | counting and S3 helpers |
| `frontend/results/**` (new) | results page for all roles + optional `results/results.css` |
| `frontend/auditor/**` (new) | auditor page + optional `auditor/auditor.css` |
| `tests/results-e2e.js` (new) | his tests |
| `docs/evidence/RS-*.png` (new) | screenshots |
| `docs/REPORT_DRAFT.md` and the final report file in `docs/` | he assembles the report |

**Files Mohamed Khaled must NOT edit** (owned by others – ask Mo'men if a change is needed): everything in `backend/shared/`, `backend/services/election/`, `backend/services/voting/`, `backend/lambda/`, `backend/server.js`, `backend/package.json`, `backend/package-lock.json`, `db/`, `infra/`, `frontend/admin/`, `frontend/student/`, `frontend/index.html`, `frontend/register.html`, `frontend/css/style.css`, `frontend/js/**`, other people's tests, `CODEOWNERS`, `.env.example`. **No new npm packages** – `@aws-sdk/client-s3`, `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` are already installed; use built-in `crypto`.

**Existing functions to reuse (exact signatures):**
| Module | Function | Behaviour |
|---|---|---|
| `../../shared/auth` | `requireAuth` (middleware) | 401 if no/invalid token; sets `req.user = { id, role, studentNumber }` |
| | `requireRole(...roles)` | 403 + audit `ACCESS_DENIED` if role not in list |
| `../../shared/validate` | `v.uuid(x, name)` · `v.int(x, name, {min, max})` · `v.date(x, name)` (returns Date) · `v.string(x, name, {min, max})` · `v.oneOf(x, name, list)` · `pick(body, keys)` | throw 400 `VALIDATION_ERROR` |
| `../../shared/errors` | `new AppError(status, code, message, details?)` | response `{ error: { code, message, details } }` |
| `../../shared/db` | `query(sql, params)` → `{ rows, rowCount }` · `withTx(async (client) => …)` | always `$1, $2`; inside `withTx` use `client.query` only |
| `../../shared/electionState` | `syncStatus(query, electionId)` → election row or `undefined` · `assertTransition(from, to)` (throws 409 `INVALID_TRANSITION`) | `syncStatus` closes the election automatically when its end time passed |
| `../../shared/audit` | `audit.record({ actor_id, role, action, resource, outcome, election_id })` (fire-and-forget) · `audit.recordStrict({…})` (await it) · `audit.list(pk, limit≤500)` → newest first, items `{ pk, seq, ts, actor_id, role, action, resource, outcome, prev_hash, hash }` · `audit.verifyChain(pk)` → `{ valid, count, brokenAt? }` | `pk` = election id or `'GLOBAL'`; DynamoDB `AuditLog` on Floci, Postgres `audit_log` locally – chosen automatically |
| frontend `js/api.js` | `api(path, { method, body })` → data, or throws `Error{ status, data }` · `Auth.user` (`{ id, role }`) | adds the Bearer token |
| frontend `js/ui.js` | `el(tag, {class, text, onclick…}, ...children)` · `guard(role)` · `renderNav(activeLabel)` · `flash(msg, 'error'|'ok'|'warn')` · `act(button, asyncFn, okMsg)` · `askDialog({ title, fields, ok, danger })` → values or null · `badge(status)` · `STATUS_LABEL` · `fmtDate(iso)` · `qs(name)` | `renderNav('Audit')` for auditors |

**Fixed names shared by all services (never rename):**
- Roles: `ADMIN`, `STUDENT`, `AUDITOR`. Election status: `DRAFT`, `SCHEDULED`, `OPEN`, `CLOSED`, `TALLIED`, `PUBLISHED`, `CANCELLED`.
- Audit actions Mohamed Khaled writes: `RESULTS_TALLIED`, `RESULTS_PUBLISHED`, `RESULTS_EXPORTED`, `INTEGRITY_MISMATCH`, `SNAPSHOT_TAMPERED`.
- Audit actions the **security summary counts** (written by others): `LOGIN_FAILED`, `LOGIN_LOCKED`, `ACCESS_DENIED`, `RATE_LIMITED`, `EMAIL_CODE_FAILED`.
- Error codes he returns: `ELECTION_NOT_FOUND` (404), `NOT_CLOSED` (409), `NOT_COUNTED` (409), `RESULTS_NOT_PUBLISHED` (403), `INTEGRITY_MISMATCH` (409), `SNAPSHOT_TAMPERED` (500), `INVALID_TRANSITION` (409, from `assertTransition`), plus shared `VALIDATION_ERROR`, `FORBIDDEN`, `AUTH_REQUIRED`.
- His page URL (others link to it): `frontend/results/index.html?id=<election_id>`.
- Environment: `RESULTS_BUCKET` (= `election-results` on Floci, empty locally), S3 key `snapshots/<election_id>.json`.

**Result JSON shape (stored in `result_snapshots.result_json`, in S3, and returned by R2):**
```json
{ "election_id": "…", "title": "…", "tallied_at": "ISO date",
  "turnout": { "eligible": 5, "voted": 4, "percent": 80 },
  "positions": [ { "position_id": "…", "title": "President", "max_selections": 1, "total_votes": 4, "tie": false,
      "candidates": [ { "candidate_id": "…", "name": "…", "votes": 3 }, { "candidate_id": "…", "name": "…", "votes": 1 } ],
      "winners": [ "candidate_id" ] } ] }
```
Candidates sorted by votes (highest first), then name. R2 response: `{ "status", "sha256", "tallied_at", "published_at", "result" }`.

**Tables he uses (from `db/schema.sql`):**
`elections(election_id, title, start_time, end_time, status, …)` · `positions(position_id, election_id, title, max_selections)` · `candidates(candidate_id, position_id, name)` · `eligibility(election_id, student_id)` · `students(student_id, student_number, …)` · `vote_receipts(election_id, student_id, receipt_hash, voted_on)` (who voted) · `ballots(ballot_id, election_id)` + `ballot_selections(ballot_id, position_id, candidate_id)` (what was chosen) · `result_snapshots(election_id PK, tallied_at, result_json jsonb, sha256, published_at, published_by)`.
Read `ballot_selections` **only grouped by candidate**; never output or log anything that links a student to a choice.

**Done =** every endpoint in Part 6 behaves as specified, all tests in Part 9 pass with `node ../tests/results-e2e.js` from `backend/`, the existing `node ../tests/security-smoke.js` still shows 16 PASS, and every box in Part 14 is ticked.

---

## Part 1 – The project in simple words
We are building a **website for student elections**.
- An **Admin** prepares an election: name, dates, positions (e.g. President), candidates, and the list of students who can vote.
- A **Student** logs in, sees the elections they can vote in, votes **once**, and nobody can know what they chose.
- An **Auditor** checks the results and a log of everything that happened, and can prove nobody changed the log.

| Service | Owner | In one sentence |
|---|---|---|
| Election Management | **Mo'men** | The admin prepares and controls elections ✅ **DONE** |
| Voting | Fouda (Mohamed Osama) | Students register, log in and vote once, secretly |
| **Results & Audit** | **You (Mohamed Khaled)** | Count votes, publish results, check the audit log and security events |

**Where it runs:** on Mo'men's laptop in **Floci** (a free copy of Amazon Web Services that runs in Docker). The data is in **Neon** (an online database). You write and test on **your own PC**; Mo'men puts it on Floci.
```
Browser (HTML/CSS/JS pages) ──► API Gateway ──► Lambda (Express code) ──► Neon database
                                                   ├─► DynamoDB (audit log)
                                                   ├─► S3 (saved results files)
                                                   └─► CloudWatch (logs, alarm)
```
**Life of an election** (you handle the last two steps): `Draft → Scheduled → Voting open → Voting closed →` **`Counted → Results published`**

---

## Part 2 – What Mo'men already finished (use it, don't rebuild it)
| Done by Mo'men | What it means for you |
|---|---|
| All cloud setup on Floci (website, API Gateway, 3 Lambdas, DynamoDB, S3, Secrets Manager, CloudWatch, IAM) | No cloud work for you. Your routes exist; bucket `election-results`, metric filter `FailedLogins` and alarm `election-failed-logins` exist. |
| Neon database with all tables | `ballots`, `ballot_selections`, `vote_receipts`, `result_snapshots` are ready. |
| Shared code in `backend/shared/` including the **audit log with hash chain** | You **use** it (Part 0 table). You never edit it. |
| 3 working endpoints in **your** file `backend/services/results/routes.js`: turnout, audit list, audit verify | **Read it first – copy its style.** |
| Election Management (elections, positions, candidates, student list, who can vote, schedule/cancel/close) | His election page already shows an **"Open results"** button that opens **your** page `frontend/results/index.html?id=…`. |
| Design and page helpers (`style.css`, `ui.js`, `api.js`) | Your pages look the same automatically. |
| 48 tests for his part (`tests/election-e2e.js`) | Copy its style for your tests. |
| The S3 library `@aws-sdk/client-s3` is already installed | You do not change `package.json`. |
| The report draft `docs/REPORT_DRAFT.md` | You complete it and assemble the final report. |
| GitHub repository and your branch `feat/khaled-results` | You work only on this branch. |

---

## Part 3 – Your part in simple words
You build **everything after voting closes, and the checking tools**:
1. **Count the votes** – when voting is closed, the admin clicks "Count votes"; you count correctly, find the winners, save the result.
2. **Show results** – only to the right people at the right time: admin and auditor after counting, students **only after publishing**.
3. **Publish** – the admin officially publishes (the Phase 1 feedback asked for this step).
4. **Download and check** – the saved results file has a fingerprint (hash); if anyone changes it, your code notices.
5. **Audit log** – the auditor sees every important action and can **prove nobody edited the log**.
6. **Security summary** – the auditor sees failed logins and blocked requests (suspicious activity).
7. **Monitoring evidence** – screenshots of CloudWatch logs, a search filter and the alarm.
8. **Assemble the final report** (everyone sends you their text).

Your **AWS services** (say these in the report): Lambda `results-svc` · S3 `election-results` · DynamoDB `AuditLog` · CloudWatch (logs, filter, alarm) · IAM role `results-svc-role`.

---

## Part 4 – Your steps (in this order, as fast as you can)
| Step | What to do | Done when… |
|---|---|---|
| 1 | Send Mo'men your GitHub username; accept the invitation | you can push |
| 2 | Setup (Part 5) | `npm run dev` works and the smoke test shows 16 PASS |
| 3 | **Count votes** (R1) using test votes you create (Part 9) | counts are correct and saved in Neon |
| 4 | Save to S3 + download with hash check (R1 step 8, R4) | a changed file is detected |
| 5 | Show results with the rules (R2) + publish (R3) | students blocked before publishing |
| 6 | Audit filters (R6) + security summary (R5) | the auditor gets the numbers |
| 7 | Pages (Part 8) | results page + auditor page work in the browser |
| 8 | Tests (Part 9) | all your tests PASS |
| 9 | Pull request → Mo'men merges and deploys (Part 11) | it works on Floci |
| 10 | CloudWatch screenshots on Mo'men's PC (Part 10) | logs, filter, alarm captured |
| 11 | Your report sections + assemble the whole report (Part 12) | complete report |
**You do not need to wait for Fouda** – you create test votes directly in the database (Part 9).
**Commit after every step.** Your commits are your proof of work.

---

## Part 5 – Setup on your PC (≈20 minutes)
1. Install **Git** and **Node.js 20+**.
2. In Git Bash:
   ```bash
   git clone https://github.com/momenemadd/student-election-voting.git
   cd student-election-voting
   git checkout feat/khaled-results
   ```
3. Copy `.env.example` to `backend/.env`. Mo'men sends you the real values **privately**. **Never upload `.env`.**
4. ```bash
   cd backend
   npm install
   npm run dev
   ```
   Open http://localhost:3000/api/health → `"status":"ok"`.
5. Second terminal: `cd frontend` → `npx serve -l 8080` → http://localhost:8080. Log in as **auditor** (`auditor@example.edu`, password from Mo'men).
6. From `backend/`: `node ../tests/security-smoke.js` → 16 PASS lines.

On your PC `RESULTS_BUCKET` is empty (skip S3, use the database copy) and the audit log is saved in the Neon table `audit_log` (on Floci: DynamoDB). Nothing to configure.

---

## Part 6 – Backend (your folder `backend/services/results/`)
**Every endpoint follows the same 7 steps** (the turnout code already does this):
1 check token (`requireAuth`) → 2 check role (`requireRole(…)`) → 3 check state (`syncStatus`) → 4 check input (`v.*`) → 5 SQL with `$1, $2` → 6 audit → 7 correct status code.

### 6.1 Your endpoints
| # | What | Method + path | Who | Rules the backend must check | Success | Errors |
|---|---|---|---|---|---|---|
| R1 | **Count votes** | `POST /api/elections/:id/tally` | ADMIN | see 6.2 | 200 | 400, 401, 403, 404, 409 |
| R2 | Show results | `GET /api/elections/:id/results` | ADMIN, AUDITOR, STUDENT | `v.uuid`, `syncStatus`, unknown → 404 · ADMIN/AUDITOR: status `TALLIED`/`PUBLISHED` else 409 `NOT_COUNTED` · STUDENT: must be on the election's list (else 404 `ELECTION_NOT_FOUND`) **and** status `PUBLISHED` (else 403 `RESULTS_NOT_PUBLISHED`) · return `{ status, sha256, tallied_at, published_at, result }` | 200 | 400, 401, 403, 404, 409 |
| R3 | **Publish** | `POST /api/elections/:id/results/publish` | ADMIN | `assertTransition(status, 'PUBLISHED')` · in `withTx`: `UPDATE elections SET status='PUBLISHED' … WHERE status='TALLIED'` and set `result_snapshots.published_at = now()`, `published_by = req.user.id` · `await audit.recordStrict` `RESULTS_PUBLISHED` | 200 | 401, 403, 404, 409 |
| R4 | Download + check | `GET /api/elections/:id/results/export` | ADMIN, AUDITOR | status `TALLIED`/`PUBLISHED` else 409 · read `snapshots/<id>.json` from S3 (`GetObjectCommand`), or the database copy if `RESULTS_BUCKET` is empty · **re-calculate SHA-256 and compare** with `result_snapshots.sha256` · different → audit `SNAPSHOT_TAMPERED`, 500 `SNAPSHOT_TAMPERED` · same → audit `RESULTS_EXPORTED`, send with `Content-Disposition: attachment; filename="results-<id>.json"` | 200 | 401, 403, 404, 409, 500 |
| R5 | Security summary | `GET /api/monitoring/security-summary?hours=24` | AUDITOR | `hours` int 1–168 (default 24) · from `audit.list('GLOBAL', 500)` keep records newer than now − hours · count each of `LOGIN_FAILED`, `LOGIN_LOCKED`, `ACCESS_DENIED`, `RATE_LIMITED`, `EMAIL_CODE_FAILED` · top 5 `resource` values of `ACCESS_DENIED` · return `{ hours, counts: {…}, top_denied: [{ resource, count }] }` | 200 | 400, 401, 403 |
| R6 | Audit filters | change `GET /api/audit-logs` | AUDITOR | add optional `action` (`v.string` max 40), `from`, `to` (`v.date`), filter the list · **admins still get 403** (whoever runs elections must not control the log) | 200 | 400, 401, 403 |
(The existing turnout and verify endpoints stay as they are.)

### 6.2 Count votes (R1) – exact order
1. `v.uuid` · `syncStatus` · unknown → 404. Status `TALLIED`/`PUBLISHED` → return the saved result (200, same hash). Status not `CLOSED` → 409 `NOT_CLOSED`.
2. **Integrity check:** `count(*) FROM ballots WHERE election_id=$1` must equal `count(*) FROM vote_receipts WHERE election_id=$1`. Different → `await audit.recordStrict` `INTEGRITY_MISMATCH`, 409 `INTEGRITY_MISMATCH`.
3. One SQL query including **0-vote candidates**: `FROM candidates c JOIN positions p ON p.position_id=c.position_id LEFT JOIN ballot_selections bs ON bs.candidate_id=c.candidate_id WHERE p.election_id=$1 GROUP BY p.position_id, c.candidate_id` with `count(bs.ballot_id)::int AS votes`.
4. Turnout: eligible = `count(*) FROM eligibility`, voted = `count(*) FROM vote_receipts`, percent rounded.
5. Winners per position: the top `max_selections` by votes. If the candidate just after the last winner has the **same votes** as the last winner → `tie: true` and put all tied candidates in `winners` (never choose randomly). A position with 0 total votes → `winners: []`.
6. Build the JSON exactly as in Part 0. `sha256 = crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex')`.
7. `withTx`: `INSERT INTO result_snapshots(election_id, result_json, sha256) … ON CONFLICT DO NOTHING`, then `UPDATE elections SET status='TALLIED', updated_at=now() WHERE election_id=$1 AND status='CLOSED'` → 0 rows → 409.
8. If `RESULTS_BUCKET` is set: `PutObjectCommand({ Bucket, Key: 'snapshots/<id>.json', Body: JSON.stringify(result), ContentType: 'application/json' })`.
9. `await audit.recordStrict` `RESULTS_TALLIED`, resource `election:<id>:sha256=<first 12 chars>`. Return 200 like R2.

---

## Part 7 – Your cloud permissions (already ready – understand them)
The IAM role `results-svc-role` allows only: S3 put/get on `election-results/snapshots/*`, DynamoDB **Query** and **PutItem** on `AuditLog`, writing logs. **No delete anywhere.** In the discussion explain why: if the results code were hacked, it still could not delete the audit log or the saved results.

---

## Part 8 – Your web pages
Copy the top of `frontend/admin/index.html` (security `<meta>` line, `<body data-root="../">`, `<header></header>`, `<p id="flash">`, the 4 `<script>` lines).
| Page | Who | What they see |
|---|---|---|
| `frontend/results/index.html?id=` + `results/js/results.js` | everyone logged in (redirect to `../index.html` if `Auth.user` is empty) | `renderNav` with no active item; title, `badge(status)`; results as bars (div width = % of position votes), numbers, winners, "tie" note, the hash · **ADMIN** also sees **Count votes** (status CLOSED → R1) and **Publish results** (status TALLIED → R3), both confirmed with `askDialog` · **Download** button (R4) for ADMIN/AUDITOR · if the API answers 403/409, show its message with `flash` |
| `frontend/auditor/index.html` + `auditor/js/auditor.js` | AUDITOR | `guard('AUDITOR')`, `renderNav('Audit')` · elections list (`GET /api/elections`) with links to `../results/index.html?id=` · **audit log table** for one election or `GLOBAL` with filters (action, from, to) · **Verify chain** button → green "valid, N records" / red "broken at record X" · **security summary** card (R5) |
**Rules:** show server data only with `el(…, { text: … })` – never `innerHTML`. Extra styles go in `results/results.css` or `auditor/auditor.css`, not in `style.css`.

---

## Part 9 – Your tests (`tests/results-e2e.js`)
Copy `tests/election-e2e.js` (temporary users and data, checks, clean-up).
**Make test votes yourself:** in the setup insert into `vote_receipts` (who), `ballots` (`RETURNING ballot_id`) and `ballot_selections` (what). Close the election by moving its times into the past: `start_time = now() - interval '2 hours'`, `end_time = now() - interval '1 minute'`.
| ID | Test | Must return |
|---|---|---|
| RS-01 | Count while voting is open | 409 NOT_CLOSED |
| RS-02 | Count after closing | 200, correct numbers, 0-vote candidates included |
| RS-03 | Count again | 200, same sha256 |
| RS-04 | Equal votes at last winning place | `tie: true` |
| RS-05 | Ballots ≠ receipts | 409 INTEGRITY_MISMATCH |
| RS-06 | Student reads results before publishing | 403 RESULTS_NOT_PUBLISHED |
| RS-07 | Student not on the list reads published results | 404 |
| RS-08 | Admin reads before counting | 409 NOT_COUNTED |
| RS-09 | Auditor tries to publish | 403 |
| RS-10 | Admin publishes | 200, status PUBLISHED |
| RS-11 | Publish again | 409 |
| RS-12 | Student reads after publishing | 200 |
| RS-13 | Download: hash matches | 200 |
| RS-14 | Download after changing the saved copy | 500 SNAPSHOT_TAMPERED |
| RS-15 | Admin reads the audit log | 403 |
| RS-16 | Audit filter with a wrong date | 400 |
| RS-17 | Change one row of `audit_log` (locally), then verify | `valid: false` |
| RS-18 | Security summary counts failed logins | numbers match |
| RS-19 | No token on every endpoint | 401 |
Run from `backend/`: `node ../tests/results-e2e.js`.

---

## Part 10 – Monitoring evidence (on Mo'men's PC, after your code is on Floci)
In Git Bash: `export AWS_PROFILE=floci MSYS_NO_PATHCONV=1`
1. **Make it happen:** wrong password 6 times on the login page.
2. **Logs:** `aws logs tail /aws/lambda/voting-svc --since 15m --format short` → screenshot lines with `"status":401`.
3. **Search filter:** `aws logs filter-log-events --log-group-name /aws/lambda/voting-svc --filter-pattern '{ $.status = 401 }' --query 'events[].message' --output text` → screenshot.
4. **Alarm:** `aws cloudwatch describe-alarms --alarm-names election-failed-logins --query 'MetricAlarms[].[AlarmName,StateValue]'` → screenshot. If it stays `INSUFFICIENT_DATA`, say so honestly and use the filter result as the evidence.
5. **Your auditor page:** security summary + "Verify chain".
Under each screenshot write 1–2 sentences: **what it shows** and **why it matters**. No passwords or tokens may be visible.

---

## Part 11 – GitHub (your proof of work)
- Work only on `feat/khaled-results`. After every step: `git add .` → `git commit -m "Add vote counting with integrity check"` → `git push`.
- Before every push: `git status` must **not** show `.env`.
- When a feature works: GitHub → **Compare & pull request** → into `main`. Mo'men reviews, merges, deploys to Floci.
- Aim for **10+ clear commits**.

---

## Part 12 – Screenshots and the report (you assemble it)
**Screenshots** → `docs/evidence/RS-*.png`: results before counting · after counting (bars, winners, hash) · publish confirm box · student view after publishing · student 403 before publishing · download · audit table · verify chain valid · verify chain broken (local test) · security summary · CloudWatch logs, filter, alarm.
**Your sections:** 3.3 endpoint table · 11 logs and monitoring · 12 security test table (collect everyone's rows) · 13 integrated testing (the full run, Part 13 step 2) · 16 limitations.
**Your Individual Contribution Statement:** component + functions, pages, endpoints, data stored/read, security controls, tests, how you connect to Mo'men's and Fouda's parts, decisions, problems solved, commit links.
**Assembling:** start from `docs/REPORT_DRAFT.md`, add everyone's text and screenshots, replace every ⟨placeholder⟩, check that all 16 sections and all 3 statements exist (all are mandatory), export to PDF/Word.

---

## Part 13 – After all three of us finish (in this order)
| Step | What happens | Who |
|---|---|---|
| 1 | All pull requests merged into `main`; Mo'men runs every test and deploys to Floci | Mo'men |
| 2 | **Full test together:** admin creates election → students register and vote → voting closes → count → publish → students see results → auditor checks the log | all 3 |
| 3 | Fix what breaks; take the last screenshots | all 3 |
| 4 | Report assembled (all 16 sections + 3 statements) | **you** collect, everyone checks |
| 5 | **Demo video ≤ 5 min**: main scenario first, then security (wrong role, wrong input, double vote) | Mo'men records |
| 6 | Final repository check (public, no secrets), final commit | Mo'men |
| 7 | **Practise the demo twice** – each person shows and explains their own part without notes | all 3 |
| 8 | Submit: report + GitHub link + video link (deadline Wed 25 Nov) | Mo'men |
| 9 | Live demo and discussion – **everyone must attend (absent = 0%)** | all 3 |

---

## Part 14 – Done checklist (before you open your final pull request)
- [ ] R1–R6 work and all RS tests pass; the smoke test still shows 16 PASS
- [ ] Results saved in Neon **and** S3; download detects a changed file
- [ ] Results rules enforced in the backend (not only hidden buttons)
- [ ] Results page + auditor page work in the browser; no `innerHTML`
- [ ] Only files from the Part 0 "MAY edit" list were changed
- [ ] CloudWatch screenshots with explanations
- [ ] 10+ commits on my branch, pull request merged
- [ ] My report sections written; full report assembled

**Discussion questions to prepare:** How do you know the count is correct? · Why can't the admin read the audit log? · What does the hash chain prove, and what doesn't it prove? · What if someone changes the saved results file? · Why does your role have no delete permission? · What would you check if there were many failed logins at night? · Which 3 AWS services does your part use and why?

---

## Small dictionary
| Word | Meaning |
|---|---|
| Endpoint / route | one URL the website calls, e.g. `POST /api/elections/:id/tally` |
| Token (JWT) | the "logged in" pass the browser sends with every request |
| Status code | 200 OK, 201 created, 400 bad input, 401 not logged in, 403 not allowed, 404 not found, 409 conflict (wrong state / already done), 500 server problem |
| Snapshot | the saved copy of the counted results |
| Hash (SHA-256) | fingerprint of a file; if one letter changes, the fingerprint changes |
| Hash chain | each audit record contains the fingerprint of the previous one, so editing or deleting a record breaks the chain |
| Transaction (`withTx`) | several database steps that succeed together or fail together |
| Floci | free local copy of AWS on Mo'men's laptop |
