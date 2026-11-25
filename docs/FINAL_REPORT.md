# Student Election Voting – Final Technical Evidence Pack
Module 26CSCN29H · Team 41 · Mo'men Mohamed (244238) · Mohamed Osama (246405) · Mohamed Khaled (248822)

---

## 1. Problem definition
Student elections are often run with paper, spreadsheets or generic forms. This makes it hard to (a) check that only eligible students vote, (b) guarantee that nobody votes twice, (c) stop results leaking before voting ends and (d) prove afterwards that nobody altered the records. A voting system must also keep each ballot **secret** while still preventing double voting – two goals that conflict if the data model is careless.

**Our system** is a cloud web application that runs an election end to end: administrators prepare and schedule elections, eligible students cast one secret ballot during the voting window, and an independent auditor verifies results and a tamper-evident audit trail.

| Role | Who | Needs |
|---|---|---|
| Admin | University election staff | Create elections, positions, candidates, student roster and eligibility; schedule, cancel or close early; publish results |
| Student | Eligible voter | See only elections they may vote in, vote once while open, get a receipt, see published results |
| Auditor | Independent reviewer | Read results and the audit log, verify that the log was not tampered with, watch security events |

**Benefit:** one source of eligibility, one-vote rule enforced by the database, secret ballots, no early results, automatic opening/closing, full traceability.
**In scope:** election lifecycle, roster and eligibility, registration with email verification, voting, receipts, tally, publication, audit, monitoring, deployment on Floci (AWS emulator) with Neon Postgres.
**Out of scope:** university SSO integration (no access), biometric identity, cryptographic end-to-end verifiable voting (research-level), production-scale deployment.

## 2. Architecture diagram
![Diagram A – architecture](diagrams/architecture.png)
*Diagram A – Frontend (browser + S3 website), API layer (API Gateway), business logic (3 Lambda functions, one per service) and data/platform layer (Secrets Manager, DynamoDB, S3, CloudWatch, IAM) on Floci; Neon Postgres and the two external APIs outside Floci.*

How the layers communicate: **1** the browser loads the pages from S3 · **2** pages call the API with `fetch` (JSON, Bearer JWT; CORS allows only the website origin) · **3** API Gateway sends each route to the Lambda of the service that owns it · **4** each Lambda calls AWS services through the SDK, limited by its own IAM role · **5** all three Lambdas use Neon Postgres over TLS (connection pool) · **6** voting-svc calls Cloudflare Turnstile and Brevo over HTTPS.

## 3. Services, API and data model
### 3.1 Service 1 – Election Management (Mo'men)
Business rules: state machine (DRAFT→SCHEDULED→OPEN→CLOSED, CANCELLED); automatic OPEN/CLOSED by time; readiness check before scheduling; creator-only changes (ownership); setup locked after DRAFT, eligibility locked once OPEN; every change audited. Communicates with Results & Audit (turnout panel, audit trail) and Voting (eligibility, candidates).

| Method | Endpoint | Validates | Codes |
|---|---|---|---|
| POST | /api/elections | title 3-120, ISO dates, end>start, window ≥ 60 min, start in future, unknown fields ignored | 201, 400, 401, 403, 409 |
| GET | /api/elections?status=&search= | status enum, search ≤50 | 200, 400, 401 |
| GET | /api/elections/:id | UUID; students only if eligible & not DRAFT | 200, 400, 401, 404 |
| PATCH | /api/elections/:id | creator, DRAFT/SCHEDULED, same field rules | 200, 400, 401, 403, 404, 409 |
| DELETE | /api/elections/:id | creator, DRAFT/CANCELLED only | 204, 401, 403, 404, 409 |
| POST | /api/elections/:id/transition | to ∈ SCHEDULED/CANCELLED/CLOSED; readiness; reason ≥10 for early close | 200, 400, 401, 403, 404, 409 |
| GET | /api/elections/:id/readiness | – | 200, 401, 403, 404 |
| GET/POST | /api/elections/:id/positions | title 2-80, seats 1-10, DRAFT | 200/201, 400, 401, 403, 404, 409 |
| PATCH/DELETE | /api/positions/:id | DRAFT, creator | 200/204, 400, 401, 403, 404, 409 |
| POST | /api/positions/:id/candidates | name 2-80 unique per position, manifesto ≤1000 | 201, 400, 401, 403, 404, 409 |
| PATCH/DELETE | /api/candidates/:id | DRAFT, no votes | 200/204, 400, 401, 403, 404, 409 |
| POST | /api/students | number 4-12 alnum, name, email, faculty | 201, 400, 401, 403, 409 |
| POST | /api/students/import | 1-500 rows, per-row report | 201, 207, 400, 401, 403 |
| GET | /api/students?search=&active= | search ≤50 (LIKE escaped), paging | 200, 400, 401, 403 |
| PATCH/DELETE | /api/students/:id | delete refused if voted/has account/in active election | 200/204, 400, 401, 403, 404, 409 |
| GET/POST | /api/elections/:id/eligible-students | bulk: student_ids[] or all_active | 200, 400, 401, 403, 404, 409 |
| PUT/DELETE | /api/elections/:id/eligible-students/:studentId | active student; before OPEN | 201/200/204, 401, 403, 404, 409 |


**Screenshots**

![Figure 1 – Admin: list of elections with status, search and filter](evidence/EM-elections-list.jpg)  
*Figure 1 – Admin: list of elections with status, search and filter*

![Figure 2 – Roster import report: valid rows added, invalid rows explained](evidence/EM-roster-import-report.jpg)  
*Figure 2 – Roster import report: valid rows added, invalid rows explained*

![Figure 3 – Positions, candidates and the students who may vote](evidence/EM-positions-and-eligibility.jpg)  
*Figure 3 – Positions, candidates and the students who may vote*

![Figure 4 – Readiness check before scheduling (draft election)](evidence/EM-election-draft-readiness.jpg)  
*Figure 4 – Readiness check before scheduling (draft election)*

![Figure 5 – Scheduling asks for confirmation](evidence/EM-schedule-confirm-dialog.jpg)  
*Figure 5 – Scheduling asks for confirmation*

![Figure 6 – Election scheduled – it opens automatically at the start time](evidence/EM-election-scheduled.jpg)  
*Figure 6 – Election scheduled – it opens automatically at the start time*

![Figure 7 – Setup is locked once the election is scheduled](evidence/EM-setup-locked-after-scheduling.jpg)  
*Figure 7 – Setup is locked once the election is scheduled*

### 3.2 Service 2 – Voter Access & Voting (Mohamed Osama)
Business rules: only students on the roster (number + matching roster e-mail) can register; e-mail ownership proved with a 6-digit code (SHA-256 stored, 10 min, 5 tries); identity only from the token; one vote per student enforced by the vote_receipts primary key inside one transaction; WHO voted and WHAT was chosen are never linked; login/register/code/vote limited in DynamoDB. Communicates with Election Management (eligibility, positions, candidates, status) and Results & Audit (receipts and ballots are counted there).
| Method | Endpoint | Validates | Codes |
|---|---|---|---|
| POST | /api/auth/register | Turnstile, student number 4-12, roster number + matching e-mail, password 12-200, not registered | 201, 400, 403, 409, 429, 503 |
| POST | /api/auth/verify-email | exactly 6 digits, 10 min expiry, max 5 tries | 200, 400, 401, 429 |
| POST | /api/auth/resend-code | e-mail; always 200 (no account enumeration) | 200, 400, 429 |
| POST | /api/auth/login | Turnstile, generic error, lockout after 5 failures, per address+e-mail limit | 200, 400, 401, 403, 423, 429 |
| POST | /api/auth/logout · GET /api/me | token | 204/200, 401 |
| GET | /api/me/elections | STUDENT; only my eligible, non-draft elections + has_voted | 200, 401, 403 |
| GET | /api/elections/:id/ballot | eligible (else 404), OPEN, not voted; no vote counts | 200, 400, 401, 403, 404, 409 |
| POST | /api/elections/:id/votes | Turnstile, each position chosen 1..max, candidate belongs to position, one transaction | 201, 400, 401, 403, 404, 409, 429 |
| GET | /api/elections/:id/receipt | only my own receipt | 200, 400, 401, 403, 404 |


**Screenshots**

![Figure 8 – Student registration: roster number + matching e-mail, Turnstile check](evidence/VT-register-form.png)  
*Figure 8 – Student registration: roster number + matching e-mail, Turnstile check*

![Figure 9 – 6-digit code sent by e-mail (Brevo)](evidence/VT-register-code-sent.png)  
*Figure 9 – 6-digit code sent by e-mail (Brevo)*

![Figure 10 – E-mail verified](evidence/VT-verify-success.png)  
*Figure 10 – E-mail verified*

![Figure 11 – Login with the Cloudflare Turnstile "I am human" check](evidence/VT-login-turnstile.png)  
*Figure 11 – Login with the Cloudflare Turnstile "I am human" check*

![Figure 12 – My elections: only elections the student may vote in](evidence/VT-07-my-elections.png)  
*Figure 12 – My elections: only elections the student may vote in*

![Figure 13 – The ballot: one choice per position](evidence/VT-ballot.png)  
*Figure 13 – The ballot: one choice per position*

![Figure 14 – Review before submitting](evidence/VT-review.png)  
*Figure 14 – Review before submitting*

![Figure 15 – Final confirmation – a vote cannot be changed](evidence/VT-confirm-dialog.png)  
*Figure 15 – Final confirmation – a vote cannot be changed*

![Figure 16 – Receipt code shown once after voting](evidence/VT-12-receipt-code.png)  
*Figure 16 – Receipt code shown once after voting*

![Figure 17 – Receipt page: proves THAT the student voted, not WHAT they chose](evidence/VT-18-receipt-page.png)  
*Figure 17 – Receipt page: proves THAT the student voted, not WHAT they chose*

![Figure 18 – My elections after voting: "Voted ✔"](evidence/VT-07-my-elections-voted.png)  
*Figure 18 – My elections after voting: "Voted ✔"*

### 3.3 Service 3 – Results & Audit (Mohamed Khaled)
Business rules: counting only after CLOSED; integrity check ballots = receipts; 0-vote candidates included; ties at the last winning place reported (never decided randomly); result saved in Neon and as a file in S3 with a SHA-256 fingerprint; students see results only after PUBLISHED and only for elections they were listed in; admins cannot read the audit log (separation of duties); hash-chain verification. Communicates with Election Management (status, positions, candidates, eligibility) and Voting (receipts, ballots).
| Method | Endpoint | Validates | Codes |
|---|---|---|---|
| POST | /api/elections/:id/tally | ADMIN; CLOSED; integrity check; safe to repeat (same hash, restores a missing S3 file) | 200, 400, 401, 403, 404, 409 |
| GET | /api/elections/:id/results | ADMIN/AUDITOR after counting; STUDENT only PUBLISHED and listed | 200, 400, 401, 403, 404, 409 |
| POST | /api/elections/:id/results/publish | ADMIN; TALLIED → PUBLISHED (one transaction, strict audit) | 200, 401, 403, 404, 409 |
| GET | /api/elections/:id/results/export | ADMIN/AUDITOR; re-hash the S3 file and compare (tampered/missing → 500) | 200, 401, 403, 404, 409, 500 |
| GET | /api/elections/:id/results/verify | ADMIN/AUDITOR; recount from the ballots and compare with the stored hash | 200, 401, 403, 404, 409 |
| GET | /api/elections/:id/turnout | ADMIN/AUDITOR; counts only, never choices | 200, 400, 401, 403, 404 |
| GET | /api/audit-logs?election=&action=&from=&to= | AUDITOR only; filters validated | 200, 400, 401, 403 |
| GET | /api/audit-logs/verify | AUDITOR; recompute the hash chain | 200, 401, 403 |
| GET | /api/monitoring/security-summary?hours= | AUDITOR; hours 1-168; failed logins, locks, blocked, rate-limited, wrong codes | 200, 400, 401, 403 |


**Screenshots**

![Figure 19 – Results after counting, with turnout and the SHA-256 fingerprint](evidence/RS-results-counted.jpg)  
*Figure 19 – Results after counting, with turnout and the SHA-256 fingerprint*

![Figure 20 – Auditor: security summary (wrong passwords, locked accounts, blocked requests)](evidence/RS-auditor-security-summary.jpg)  
*Figure 20 – Auditor: security summary (wrong passwords, locked accounts, blocked requests)*

![Figure 21 – Auditor: audit log with filters and "Verify chain" → valid](evidence/RS-auditor-verify-chain.jpg)  
*Figure 21 – Auditor: audit log with filters and "Verify chain" → valid*

### 3.4 Data model
![Diagram B – ER diagram](diagrams/er-diagram.png)
*Diagram B – entities, keys and relationships; colour = the service that writes the table.*

Entities (Neon): users, students, elections, positions, candidates, eligibility, vote_receipts, ballots, ballot_selections, result_snapshots (+ audit_log fallback). DynamoDB: AuditLog (pk, seq), RateLimits.
Relationships: election 1-N positions 1-N candidates · election N-N students via eligibility · election 1-N vote_receipts (WHO voted) · election 1-N ballots 1-N ballot_selections (WHAT was chosen) · **no relationship between vote_receipts and ballots** (secret ballot) · election 1-1 result_snapshots.
| Service | Create | Read/Query | Update | Delete |
|---|---|---|---|---|
| Election Mgmt | elections, positions, candidates, students, eligibility | all of these + search/filter | elections, positions, candidates, students | elections (draft/cancelled), positions, candidates, students, eligibility |
| Voting | users, vote_receipts, ballots, ballot_selections | elections, eligibility, positions | users (lockout, token version) | – |
| Results & Audit | result_snapshots, AuditLog | aggregate ballots, AuditLog query | elections status | – (audit is append-only) |

## 4. Role / permission matrix
Enforced in the backend by `requireAuth` → `requireRole()` → ownership/state checks (shared code in `backend/shared/auth.js`), and by API Gateway (only defined routes reach Lambda).
| Action | Anonymous | Student | Admin | Auditor |
|---|---|---|---|---|
| Log in | ✔ | – | – | – |
| Create/edit/schedule/cancel/close election | 401 | 403 | ✔ (edit only own) | 403 |
| Positions, candidates, roster, eligibility | 401 | 403 | ✔ (own election, state rules) | 403 |
| List/view elections | 401 | eligible only | all | all |
| Ballot / vote / own receipt | 401 | ✔ eligible, once | 403 | 403 |
| Turnout | 401 | 403 | ✔ | ✔ |
| Results | 401 | only PUBLISHED | from TALLIED | from TALLIED |
| Publish results | 401 | 403 | ✔ | 403 |
| Audit log / verify chain | 401 | 403 | 403 | ✔ |

## 5. External integration
| Service | Workflow | Secret storage |
|---|---|---|
| Cloudflare Turnstile siteverify | Login, registration and vote are rejected (403 BOT_CHECK_FAILED) without a valid token | Secret key in AWS Secrets Manager `election/app-secrets`; site key is public |
| Brevo transactional e-mail API | 6-digit verification code at registration; vote receipt after voting (never the choices). If sending fails the vote is still stored | API key (transactional-email permission only) in Secrets Manager |
Locally, secrets live in `backend/.env` (git-ignored); only `.env.example` with placeholders is committed.
Evidence: Figure 9 (Brevo e-mail code) and Figure 11 (Turnstile check) in §3.2; Figure 33 (vote without the Turnstile token → 403) in §12.

## 6. Deployment approach
Serverless on Floci (AWS emulator): S3 static website, API Gateway HTTP API, three Lambda functions (one per service, Express wrapped with serverless-http), IAM role per function, Secrets Manager, DynamoDB, CloudWatch Logs; Neon Postgres as managed external database. Floci runs in persistent mode (Docker volume) so state survives restarts; `infra/setup-all.sh` builds everything idempotently, `infra/deploy-code.sh` updates code.
Why: same model as the labs, scales to zero, each owner has an independent deploy unit and role, no cost. Trade-offs: cold starts, Floci is not identical to AWS (IAM policies are stored but not enforced), HTTP on localhost instead of HTTPS, Neon free tier may suspend when idle.
Deployed URLs: website `http://localhost:4566/election-web/index.html` · API `http://28a0b6493f.execute-api.localhost.floci.io:4566` (the id changes only if Floci is reset; `setup-all.sh` prints it).

## 7. Threat model
| # | Threat | Area | Implemented control | Test |
|---|---|---|---|---|
| T1 | Password guessing / credential stuffing | Identity | bcrypt (cost 12), lockout after 5 failures for 15 min, Turnstile, same error for unknown user and wrong password | ST-11 |
| T2 | Forged, tampered or stolen token | Identity | JWT HS256 pinned, 30 min expiry, secret in Secrets Manager, logout bumps token version | ST-10 |
| T3 | Double voting (incl. parallel requests) | Data integrity | PK (election_id, student_id) on vote_receipts inside one transaction → 409 | ST-06 |
| T4 | Linking a voter to their choice | Data confidentiality | separate receipt and ballot tables, random UUIDs, no timestamps on ballots | ST-16 |
| T5 | Reading/changing another user's data by changing an ID (IDOR) | API | identity from token only; creator-only election changes; students get 404 for elections they are not listed in | ST-03, EM-09, EM-34 |
| T6 | Changing the rules during voting / early results | Business logic | state machine, setup locked after DRAFT, window locked once OPEN, results gated by status | ST-08, ST-12 |
| T7 | SQL injection / malformed input / mass assignment | API | parameterised SQL, validators, field whitelist, 100 KB body limit | ST-04, ST-05 |
| T8 | Secrets committed to Git | Cloud config | .gitignore, Secrets Manager, pre-push scan | ST-09 |
| T9 | Over-broad IAM or public bucket leaking data | Cloud config | one role per Lambda with only needed actions; website bucket holds frontend only | ST-13 |
| T10 | Audit log tampering | Data integrity | no update/delete route, IAM allows only PutItem/Query, SHA-256 hash chain + verify | ST-14 |
| T11 | Bots / request flooding | Availability | Turnstile, lockout, rate limit on every request (60 s sliding window, limit from Secrets Manager) + DynamoDB counters for login/register/vote | ST-11, ST-20 |
| T12 | Stored XSS in names/manifestos | Application | server removes HTML/script tags before saving, frontend renders with textContent only, CSP, length limits | ST-15 |
| T13 | CORS misconfiguration | Cloud config | exact origin allow-list from configuration | ST-17 |

## 8. Security controls
- **Authentication:** email + password, bcryptjs cost 12, JWT HS256 (30 min) signed with a 96-char secret from Secrets Manager; logout/compromise invalidates all tokens via `token_version`.
- **Authorization:** central middleware, roles ADMIN/STUDENT/AUDITOR from the database (not only the token); ownership rule for elections; separation of duties (admins cannot read audit logs).
- **Least privilege:** each Lambda has its own IAM role (`infra/iam/*.json`) – e.g. election-svc may only read its one secret and write/query audit items (an unused photo-upload permission was removed during review); no `*` actions on data. Broad admin access is inappropriate because a single bug or stolen token in one function could then alter votes, delete the audit log or read all secrets.
- **Secrets:** no secrets in code or Git; `.env` locally, Secrets Manager on Floci; `.env.example` contains placeholders only.
- **Input validation:** types, lengths, ranges, enums, UUIDs, date windows, per-row import validation; uniform `{error:{code,message}}`; no stack traces.
- **Ownership checks:** creator-only election changes (EM-09, EM-29), students see only their elections (EM-34).
- **Transport/at rest:** TLS to Neon and external APIs; Neon encrypts at rest; on Floci the browser↔API hop is HTTP on localhost (real AWS: HTTPS endpoints).
- **Shared responsibility:** Provider (AWS/Floci, Neon, Cloudflare): physical security, runtime/OS patching for Lambda, database storage durability and encryption, availability of managed services. Team: application code and business rules, authentication/authorization, IAM policy design, secret handling, input validation, logging/monitoring and response, backup/recreation scripts.

## 9. GitHub repository
https://github.com/momenemadd/student-election-voting · branches per owner · CODEOWNERS · no secrets.

## 10. Demo video
Link: ⟨paste link here – sharing set to "anyone with the link can view"⟩ · length 4:55 · no commentary, captions on screen.
Part 1 – main scenario on the deployed app (Floci): admin creates an election, adds positions, candidates and voters, schedules it → it opens automatically → a student signs in (Turnstile), votes and gets a receipt; opening the ballot again is refused (409) → admin closes voting early, counts, recounts and compares, publishes → the student sees the results → the auditor checks the security summary and verifies the audit hash chain.
Part 2 – security scenarios: no token (401), student and admin blocked from the audit log (403), student cannot create an election (403), edited token (401), invalid dates (400), SQL injection harmless, `<script>` removed from a title, brute force → account locked (423), auditor sees the locked account in the audit log.

## 11. Log and monitoring evidence
Structured JSON log line per request (time, service, method, path, status, duration, hashed user id; never bodies, tokens or passwords). To capture: CloudWatch log group per function; filter `{ $.status = 403 }`; metric `FailedLogins` + alarm (≥5 in 5 min) triggered by ST-11; auditor "verify chain" result.
Commands that work on Floci (for the screenshots): `aws logs filter-log-events --log-group-name /aws/lambda/voting-svc --filter-pattern 401` (failed logins: 17 lines in the last hour on 25 Nov), the same with `403` for denied access, and `SECURITY_ALERT` for rate-limit alerts; auditor page → Security summary and Verify chain (`docs/evidence/RS-auditor-*.jpg`). Limitation: Floci stores the `FailedLogins` metric filter and the alarm but does not turn log lines into metric values, so the alarm stays `INSUFFICIENT_DATA`; on real AWS (with Lambda's JSON log format turned on) the same setup would fire after 5 failures in 5 minutes.


**Screenshots**

![Figure 22 – CloudWatch Logs: failed logins (status 401) in the voting-svc log group](evidence/MON-cloudwatch-failed-logins.png)  
*Figure 22 – CloudWatch Logs: failed logins (status 401) in the voting-svc log group*

![Figure 23 – CloudWatch Logs: requests refused with 403 in all three services](evidence/MON-cloudwatch-denied-403.png)  
*Figure 23 – CloudWatch Logs: requests refused with 403 in all three services*

![Figure 24 – CloudWatch: one log group per Lambda, FailedLogins metric filter and alarm](evidence/MON-floci-log-groups.png)  
*Figure 24 – CloudWatch: one log group per Lambda, FailedLogins metric filter and alarm*

## 12. Security test table
| ID | Scenario | Expected | Actual (Floci) | Result | Evidence |
|---|---|---|---|---|---|
| ST-01 | No token on protected route | 401 | 401 | PASS | Fig. 25; video part 2 (S1) |
| ST-02 | Student creates election; admin reads audit log | 403 | 403 / 403 | PASS | Fig. 25; video part 2 (S2–S4) |
| ST-03 | Other admin edits someone else's election (ownership) | 403 | 403 (EM-09) | PASS | `tests/election-e2e.js` EM-09 (403 response) |
| ST-04 | Invalid input: end before start, seats 0, short name, bad UUID | 400 | 400 | PASS | `tests/election-e2e.js`; video part 2 (S6) |
| ST-05 | SQL injection in id and search | 400 / 0 rows | 400 / 200 empty | PASS | Fig. 25; video part 2 (S7) |
| ST-06 | Duplicate vote incl. 20 parallel requests | one 201, rest 409 | 409 ALREADY_VOTED (VT-13); 20 at once → exactly one 201, 1 receipt + 1 ballot stored (VT-14) | PASS | Fig. 26–28 |
| ST-07 | Vote outside window | 409 | before opening 409 (VT-08b); after closing 409 ELECTION_NOT_OPEN (VT-15) | PASS | Fig. 29–30; `tests/voting-e2e.js` VT-15 |
| ST-08 | Results before publish | 403/409 | student 403 RESULTS_NOT_PUBLISHED (RS-06); admin before counting 409 NOT_COUNTED (RS-08); student not listed 404 (RS-07) | PASS | `tests/results-e2e.js` RS-06/07/08 |
| ST-09 | Secret exposure review (repo + history + website bucket) | none found | none in 47 committed files; `.env` → 404 on website | PASS | history scan 25 Nov (only placeholders found); `.env` → 404 on S3 |
| ST-10 | Tampered token / token after logout | 401 | 401 / 401 | PASS | Fig. 25; video part 2 (S5) |
| ST-11 | Wrong password / unknown user / repeated failures | 401 same message; 423 after 5 | 401 INVALID_CREDENTIALS for both; after 5 wrong passwords even the right one → 423 ACCOUNT_LOCKED, locked 15 min (25 Nov, Floci) | PASS | Fig. 31; Fig. 22 (401 lines in CloudWatch); video |
| ST-12 | Edit window, delete candidate, change eligibility while OPEN | 409 | 409 / 409 / 409 (EM-38..40) | PASS | Fig. 7; `tests/election-e2e.js` EM-38..40 |
| ST-13 | IAM review: role per function, no wildcard data actions | documented | `infra/iam/*.json` | PASS | Diagram A; `infra/iam/*.json` |
| ST-14 | Audit chain verification | valid:true | valid:true | PASS | Fig. 21 |
| ST-15 | XSS payload as candidate name / description | shown as text, script removed | `<script>alert(1)</script>hi` saved as "hi" (Lab 8 S5); pages insert text with textContent only | PASS | video part 2 (S8); `docs/load-testing/security-checks.txt` S5 |
| ST-16 | No join path between receipts and ballots | none | schema review | PASS | Fig. 34 |
| ST-17 | CORS from evil origin | no allow header | no header; site origin allowed | PASS | Fig. 25 |
| ST-18 | Tampered result file in S3 / tampered audit record in DynamoDB | detected | export → 500 SNAPSHOT_TAMPERED (RS-14); chain verify → valid:false (RS-17), on Floci | PASS | `tests/results-e2e.js` RS-14, RS-17 (on Floci) |
| ST-19 | Two counts at the same moment | same result, no error | both 200 with the same SHA-256 (RS-22) | PASS | `tests/results-e2e.js` RS-22 |
| ST-20 | Request flood / fake X-Forwarded-For (Lab 8 S2, S3) | 429 | 59 answered then 21 × 429; fake header still 429 | PASS | `docs/load-testing/security-checks.txt` S2, S3 |
| ST-21 | Security headers (Lab 8 S1) | nosniff, DENY, CSP | present on every answer, also from Lambda | PASS | `docs/load-testing/security-checks.txt` S1; Fig. 23 |
Plus automated end-to-end tests (24 Nov): Election Management 48/48 (local and Floci), Voting 56/56 (local; not on Floci because it would e-mail made-up addresses), Results & Audit 22/22 (local and Floci), security smoke 16/16, Lab 8 S1–S7 8/8, Lab 8 checker 20/20.


**Screenshots**

![Figure 25 – Security smoke tests 16/16 (ST-01, ST-02, ST-05, ST-10, ST-17)](evidence/VT-security-smoke.png)  
*Figure 25 – Security smoke tests 16/16 (ST-01, ST-02, ST-05, ST-10, ST-17)*

![Figure 26 – ST-06: a second vote is refused](evidence/VT-13-second-vote-409.png)  
*Figure 26 – ST-06: a second vote is refused*

![Figure 27 – ST-06: second vote through the API → 409 ALREADY_VOTED](evidence/VT-13-double-vote-api-409.png)  
*Figure 27 – ST-06: second vote through the API → 409 ALREADY_VOTED*

![Figure 28 – ST-06: 20 votes at the same moment → exactly one accepted](evidence/VT-14-race-test.png)  
*Figure 28 – ST-06: 20 votes at the same moment → exactly one accepted*

![Figure 29 – ST-07: ballot before the election opens is refused](evidence/VT-08-ballot-before-opening.png)  
*Figure 29 – ST-07: ballot before the election opens is refused*

![Figure 30 – ST-07: same through the API → 409 ELECTION_NOT_OPEN](evidence/VT-08-ballot-before-opening-api-409.png)  
*Figure 30 – ST-07: same through the API → 409 ELECTION_NOT_OPEN*

![Figure 31 – ST-11: after 5 wrong passwords even the correct one is refused (423)](evidence/ST-11-lockout.png)  
*Figure 31 – ST-11: after 5 wrong passwords even the correct one is refused (423)*

![Figure 32 – Wrong e-mail code is refused (max 5 tries)](evidence/VT-05-wrong-code.png)  
*Figure 32 – Wrong e-mail code is refused (max 5 tries)*

![Figure 33 – Vote without the Turnstile token → 403](evidence/VT-19-no-turnstile-403.png)  
*Figure 33 – Vote without the Turnstile token → 403*

![Figure 34 – ST-16: no column links who voted (receipts) and what was chosen (ballots)](evidence/VT-20-no-link-receipts-ballots.png)  
*Figure 34 – ST-16: no column links who voted (receipts) and what was chosen (ballots)*

## 13. Integrated testing
Main scenario: admin creates election → positions/candidates → roster → eligibility → schedule → opens automatically → student registers, logs in, votes, gets receipt → closes → tally → publish → student sees results → auditor verifies chain. Invalid cases: ineligible student, duplicate vote, vote after close, illegal transitions, malformed JSON (400 INVALID_JSON verified on Lambda). Result (24 Nov, Floci, browser): the full scenario was run end to end — count, recount and compare, publish, student view, auditor security summary and "Verify chain" (screenshots `docs/evidence/RS-*.jpg`); every invalid case is covered by the automated tests above.
**How errors were handled:** every error returns the same JSON shape `{"error":{"code","message"}}` with the right status (400 validation, 401 no/invalid token, 403 wrong role or bot check, 404 not found or not listed, 409 wrong state or duplicate, 423 locked, 429 too many requests) and never a stack trace; the pages show the message as text; a failed e-mail does not undo a stored vote; refused actions are written to the audit log (e.g. VOTE_REJECTED, ACCESS_DENIED, LOGIN_FAILED). **Limitations of the tests:** Voting tests are run locally (they send real e-mails); time-based opening is tested by moving the start time in the test database; see §16.


**Screenshots**

![Figure 35 – End-to-end test run summary](evidence/VT-tests-summary.png)  
*Figure 35 – End-to-end test run summary*

### 13.1 Scaling, load testing and failover (Lab 8)
Following Lab 8 without adding AWS services: the same stateless backend ran as 1 worker (vertical) and as 3 workers behind a local load balancer on :8080 (round robin, health check every 3 s), then worker 2 was killed during the test. Grafana k6, up to 50 virtual users, 3 minutes each:
| | 1 worker | 3 workers | 3 workers, one crashed |
|---|---|---|---|
| Throughput | 15.2 req/s | 20.3 req/s | 18.6 req/s |
| p(95) | 2,102 ms | 587 ms | 1,055 ms |
| Failed requests | 0.00% | 0.00% | 0.00% |
Scaling out cut p(95) 3.6×; the load balancer logged the crash (`ECONNREFUSED`), retried on a healthy worker and no request failed. p(95) stays above 500 ms because each request makes ~2 round trips to Neon in Frankfurt (~0.2 s each) and all workers share one laptop. Security attack checks S1–S7: 8/8 passed; Lab 8 checker: 20/20 passed.

## 14. Cost / resource statement
Resources: 3 Lambda functions (512 MB, 15 s timeout), 1 HTTP API (29 routes), 3 S3 buckets, 2 DynamoDB on-demand tables, 1 secret, log groups + metric filter + alarm; Neon free plan; Turnstile and Brevo free. Cost: €0 (Floci is local; on real AWS these are pay-per-request and scale to zero). Avoiding waste: on-demand capacity, small zip (5 MB), one pooled DB connection per Lambda container, no always-on servers, a hard maximum on copies (Lab 8 Auto Scaling idea: max 4 workers in our scale script), expiring rate-limit counters (DynamoDB TTL). More load: API Gateway and Lambda add copies automatically; Lab 8 measurements show 3 copies serve 33% more requests 3.6× faster than one; the next bottleneck is the single Neon compute and its distance, solved by a larger compute in the same region.

## 15. Recovery approach
Everything is code: `db/schema.sql` + `npm run migrate` recreate the database structure, `npm run seed` recreates admin/auditor, `infra/setup-all.sh` recreates all cloud resources (idempotent), secrets are re-entered from `.env`. Data: Neon point-in-time restore/branching back to a moment before the mistake (within the restore window of the Neon plan, shown in the Neon console); result files in S3 are recreated by counting again (same SHA-256), and the audit chain can be checked with "Verify chain" after any restore. Compromise: rotate JWT secret (all tokens invalid), rotate DB password and API keys, verify audit chain, review CloudWatch logs.

## 16. Limitations
| Limitation | Reason | Improvement |
|---|---|---|
| IAM policies not enforced by Floci | emulator behaviour | deploy to a real AWS account |
| HTTP on localhost | Floci local endpoints | HTTPS via API Gateway/CloudFront on AWS |
| Ballot secrecy is design-level, not cryptographic | scope | verifiable voting / mix-nets |
| Self-managed JWT, no MFA | time | Cognito + TOTP for admins |
| Identity based on roster + email, not university SSO | no access | SSO/OIDC integration |
| Audit chain not anchored externally | scope | periodic hash anchoring to S3 Object Lock |
| Scheduler not used; time transitions applied on access | reliability and simplicity | EventBridge Scheduler for notifications |
| Turnstile runs with Cloudflare's official test keys | the deployment is local (localhost) | real site/secret keys on a public domain |
| E-mails are sent from a Gmail sender (no own domain, no DKIM/DMARC) and may land in Spam | free plan, no domain | verified domain with DKIM/DMARC |
| On Floci every request arrives as 127.0.0.1, so per-address limits act as per-container limits | emulator networking | real API Gateway passes the client address |
| The general rate limiter counts in memory, so each worker/container counts separately (Lab 8 lesson) | simplicity, no extra service | shared counter (DynamoDB, as already used for login/vote) or API Gateway throttling |
| p(95) above 500 ms under load | database in another region, all workers on one laptop | database in the same region, real separate compute |
| ALB, ECS, Auto Scaling not used (local load balancer instead) | team decision: keep 7 AWS services | ECS service + ALB on real AWS |
| Floci does not turn log lines into metric values, so the FailedLogins alarm never fires on Floci | emulator limitation | real CloudWatch with Lambda JSON log format |
| The Voting end-to-end tests are run locally only | on Floci they would e-mail made-up addresses | a test inbox / e-mail sandbox |

---
## Individual Contribution Statements (end of report)
### Mo'men Mohamed (244238) – Election Management
- **Component & functions:** election lifecycle (create, edit, delete, schedule/cancel/close early with state machine and readiness check), positions and candidates, student roster (add, import, search, edit, deactivate, delete), eligibility (single, bulk, remove).
- **Frontend:** `frontend/admin/index.html` (list, filter, create), `election.html` (details, status actions, readiness, turnout, positions/candidates, eligibility), `students.html` (roster, CSV import with per-row report).
- **Backend/API:** `backend/services/election/routes.js` – 25 endpoints, validation, status codes, ownership and state checks, audit events.
- **Data operations:** C/R/U/D/search on elections, positions, candidates, students, eligibility (Neon, parameterised SQL, transaction for import).
- **Security controls:** admin-only routes, creator ownership, setup/window locks, input validation and whitelisting, LIKE-escaped search, no info leak to ineligible students (404), audit logging.
- **Tests:** `tests/election-e2e.js` – 48 cases (normal, invalid, unauthorized, ownership, state locks, audit), 48/48 passing locally and on Floci.
- **Integration:** uses shared auth/validation/audit; reads turnout from Results & Audit; provides eligibility and candidates to Voting; owns Floci infrastructure scripts.
- **Decisions:** time-based OPEN/CLOSED applied lazily with the database clock (no dependency on a scheduler); creator-only ownership; delete only DRAFT/CANCELLED elections.
- **Difficulties:** Express 5 + serverless-http passed request bodies as raw Buffers on Lambda (every login failed with "email must be a string") – solved with a small parser in the shared app; Floci lost all resources on restart – solved with persistent storage mode; deploy script created duplicates on re-run – made idempotent.
- **Evidence:** screenshots Fig. 1–7 (admin pages), Fig. 19–24 (results, auditor, CloudWatch), Diagrams A and B, demo video; tests `tests/election-e2e.js` 48/48 and `tests/security-smoke.js` 16/16. Branch: https://github.com/momenemadd/student-election-voting/tree/feat/momen-election · merged pull request: https://github.com/momenemadd/student-election-voting/pull/1 · main commits: Election Management API https://github.com/momenemadd/student-election-voting/commit/77a31b2 · admin pages https://github.com/momenemadd/student-election-voting/commit/a8b2dea · infrastructure https://github.com/momenemadd/student-election-voting/commit/bbd5afe · tests https://github.com/momenemadd/student-election-voting/commit/1437ef1 · shared Lambda fixes https://github.com/momenemadd/student-election-voting/commit/cbbf292 · Results & Audit completion https://github.com/momenemadd/student-election-voting/commit/a2f1cbf · Lab 8 security https://github.com/momenemadd/student-election-voting/commit/a8ba612 · Lab 8 scaling https://github.com/momenemadd/student-election-voting/commit/52d7355.
- **Integration and completion work:** reviewed, tested and merged the Voting service (added its database columns, fixed the Brevo key permission, changed the login limit to address+e-mail because Floci shows every client as 127.0.0.1, verified a real e-mail flow on Floci); merged the Results & Audit backend and completed it (results page, auditor page, S3 restore + clear "missing file" error, simultaneous-count fix, Floci versions of RS-14/RS-17, test RS-22); Lab 8 work (security headers, rate limit on every request with a sliding window, sanitising, worker ids, local load balancer + scale script, k6 load tests Run A/B/C, failover drill, S1–S7 checks, Lab 8 checker).
### Mohamed Osama (246405) – Voter Access & Voting
- **Component & functions:** the student side of the election – register with the roster number + roster e-mail, prove the e-mail with a 6-digit code (verify, resend), log in/out, "My elections", ballot, cast a vote (once, secret), receipt. 9 endpoints (§3.2), all serving one capability: letting an eligible student vote exactly once, secretly.
- **Frontend:** login page with the Cloudflare Turnstile widget (`frontend/index.html`, `js/index.js`), register + code page (`register.html`, `js/register.js`), student pages in `frontend/student/`: My elections (`index.html`, `home.js`), ballot with review and confirm (`vote.html`, `vote.js`), receipt page with an in-browser code check (`receipt.html`, `receipt.js`), shared `student.css`. Screens: Fig. 8–18.
- **Backend/API:** `backend/services/voting/routes.js` (V1–V7 + login/logout/me), `mail.js` (Brevo e-mail sender for the code and the receipt), `rateLimit.js` (DynamoDB counters for login, register, code and vote), migration `db/migrations/001_voting.sql` (OTP hash, expiry, tries).
- **Data operations:** users – create (register), read (login), update (verify e-mail, failed logins/lockout, token version on logout, OTP fields); vote_receipts – create + read (own receipt); ballots and ballot_selections – create only (never read back per student); reads/queries elections, eligibility, positions and candidates ("My elections" is one query with eligibility and has_voted); DynamoDB RateLimits – UpdateItem counters with TTL.
- **Security controls:** bcrypt (cost 12) + JWT; lockout after 5 wrong passwords (423); Turnstile on register, login and vote; rate limits in DynamoDB; code stored only as SHA-256, 10 minutes, max 5 tries counted atomically; the same answer for unknown numbers/e-mails (no account enumeration); identity only from the token, never from the body; a receipt only for its owner (others get 404); one vote per student by the primary key inside one transaction; receipts (WHO) and ballots (WHAT) never linked.
- **Tests:** `tests/voting-e2e.js` VT-01–VT-22 (56 checks: roster rules, codes, lockout, eligibility, invalid ballots, roles, duplicate vote, vote after closing, secrecy, audit) – 56/56 passing; `tests/race-test.js` – 20 votes at the same moment → exactly one accepted (Fig. 28). Evidence: Fig. 25–30, 32–35.
- **Integration:** uses the shared login/roles/validation library; reads elections, eligibility, positions and candidates from Election Management; the receipts and ballots it writes are what Results & Audit counts (integrity check ballots = receipts); writes VOTE_CAST / VOTE_REJECTED / LOGIN_FAILED events to the shared audit chain (DynamoDB); external APIs Brevo and Turnstile with their keys in Secrets Manager.
- **Decisions:** separate receipt and ballot tables with no link, random ballot ids and a receipt date without a time (secret ballot); codes hashed, never stored in plain text; a `FOR SHARE` lock so an admin closing the election waits for a vote that is being saved; the vote is kept even if the receipt e-mail fails.
- **Difficulties and solutions:** parallel code guesses could get more than 5 tries → the try is counted first, in one atomic update; two registrations at the same moment → the UNIQUE constraints decide and the second gets 409; 20 simultaneous votes → primary key + one transaction (race test passes). Found during integration with Mo'men on Floci: the Brevo key needed the transactional-e-mail permission, and Floci shows every client as 127.0.0.1, so the login limit was changed to address + e-mail.
- **Evidence and repository links:** branch https://github.com/momenemadd/student-election-voting/tree/feat/osama-voting · pull request https://github.com/momenemadd/student-election-voting/pull/1 (merged) · Voting API https://github.com/momenemadd/student-election-voting/commit/0a4e6fb · rate limiter https://github.com/momenemadd/student-election-voting/commit/3fd65eb · Brevo sender https://github.com/momenemadd/student-election-voting/commit/8647a31 · migration https://github.com/momenemadd/student-election-voting/commit/1608aef · tests https://github.com/momenemadd/student-election-voting/commit/d52a15a · login page https://github.com/momenemadd/student-election-voting/commit/d9e8eac · register page https://github.com/momenemadd/student-election-voting/commit/465836e · My elections https://github.com/momenemadd/student-election-voting/commit/d5640c7 · ballot page https://github.com/momenemadd/student-election-voting/commit/66acab4 · receipt page https://github.com/momenemadd/student-election-voting/commit/f9eb742 · screenshots https://github.com/momenemadd/student-election-voting/commit/04742e6.

### Mohamed Khaled (248822) – Results & Audit
- **Component & functions:** everything after voting closes – count the votes, show the results, publish, download the result file with a hash check, recount and compare, turnout, the auditor's audit log with filters, hash-chain verification and the security summary (9 endpoints, §3.3), all serving one capability: a correct, provable result and an independent audit.
- **Frontend:** the results page (`frontend/results/`) and the auditor page (`frontend/auditor/`) show exactly what his endpoints return – result bars with winners and ties, turnout, the SHA-256 fingerprint, the recount comparison, the security summary and the filtered audit log (Fig. 19–21). The pages were finished during integration by Mo'men (https://github.com/momenemadd/student-election-voting/commit/a2f1cbf).
- **Backend/API:** `backend/services/results/tally.js` – pure counting logic: votes per candidate including 0-vote candidates, winners per position by `max_selections`, tie detection at the last winning place, canonical JSON + SHA-256; `routes.js` – R1 count (ADMIN, only CLOSED, integrity check, safe to repeat), R2 results (depends on role and status), R3 publish (one transaction), R4 export with hash check, R5 security summary, R6 audit-log filters, R7 recount; `snapshots.js` – result file in S3.
- **Data operations:** reads and aggregates ballots and ballot_selections (counts only, never who chose what) and counts vote_receipts; creates result_snapshots (result JSON + SHA-256) and the S3 file; updates the election status CLOSED → TALLIED → PUBLISHED and published_at/published_by; queries and filters the audit log (election, action, from/to) in DynamoDB; no deletes (the audit log is append-only).
- **Security controls:** ADMIN only for count and publish; AUDITOR only for the audit log (admins get 403 – separation of duties); students see results only after publishing and only for elections they were listed in (404 otherwise); integrity check ballots = receipts (409 on mismatch); tamper detection on export (500 SNAPSHOT_TAMPERED); hash-chain verification; validated filters (400 on a wrong date or hours value).
- **Tests:** `tests/results-e2e.js` RS-01–RS-21: counting before closing (409), correct numbers incl. a 0-vote candidate, same hash when counted twice, tie, integrity mismatch, results before publishing (403/409), wrong roles (403), publishing twice (409), download hash check, recount match/mismatch, tampered copy (500), admin denied the audit log, bad filter (400), tampered audit row → valid:false, security summary counts, no token on every endpoint (401). RS-22 and the Floci versions of RS-14/RS-17 were added during integration. 22/22 passing locally and on Floci.
- **Integration:** reads elections, positions, candidates and eligibility from Election Management and the receipts and ballots written by Voting; changes the election status through the shared state machine; reads the shared audit chain that all three services write; uses S3 and DynamoDB on Floci through the results-svc IAM role.
- **Decisions:** ties are reported, never broken at random; 0-vote candidates are always shown; the result is saved twice (Neon + S3 file) with one fingerprint, so any later change is detected; counting a second time returns the saved result instead of a new one; a recount endpoint added as an extra check.
- **Difficulties and solutions:** Postgres `jsonb` does not keep key order, so the same result gave a different hash after being read back → canonical JSON with sorted keys before hashing; equal votes at the last winning place → a `tie` flag with all tied candidates listed; making sure the count is honest → an integrity check that the number of ballots equals the number of receipts before saving. Found during integration: two counts at the same moment now both return the same result (RS-22).
- **Evidence and repository links:** branch https://github.com/momenemadd/student-election-voting/tree/feat/khaled-results · merge into main https://github.com/momenemadd/student-election-voting/commit/8bce9dc · tally logic https://github.com/momenemadd/student-election-voting/commit/9ed82da · count endpoint https://github.com/momenemadd/student-election-voting/commit/0487726 · integrity check + snapshot hash https://github.com/momenemadd/student-election-voting/commit/c3fb8ee · results, publish, export, recount, security summary, audit filters and tests https://github.com/momenemadd/student-election-voting/commit/eb4cbdb · screenshots Fig. 19–21, demo video.
