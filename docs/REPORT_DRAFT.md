# Student Election Voting – Final Technical Evidence Pack (DRAFT)
Module 26CSCN29H · Team 41 · Mo'men Mohamed (244238) · Mohamed Osama (246405) · Mohamed Khaled (248822)

> Draft status (18 Nov): sections marked **[READY]** are written from the working system; **[NEEDS …]** shows what is still missing. Copy into the final Word/PDF report when complete. Replace every ⟨placeholder⟩.

---

## 1. Problem definition **[READY]**
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

## 2. Architecture diagram **[READY – redraw in draw.io with these labels]**
```
            ┌────────────── Floci (AWS emulator on Docker, http://localhost:4566) ───────────────┐
Browser ──1─▶ Amazon S3  bucket election-web  (index.html, admin/, student/, auditor/, js/, css/) │
   │                                                                                            │
   └──2 fetch JSON + Bearer JWT ─▶ API Gateway HTTP API "election-http-api" (28 routes, $default)│
                                     │ 3 invoke (AWS_PROXY, payload v2)                          │
              ┌──────────────────────┼───────────────────────┐                                   │
              ▼                      ▼                       ▼                                   │
     Lambda election-svc      Lambda voting-svc        Lambda results-svc     (nodejs24.x, Express│
     (Mo'men)                 (Osama)                  (Khaled)               via serverless-http)│
       role election-svc-role   role voting-svc-role     role results-svc-role  (IAM, least priv.) │
              │  4 SDK            │                        │                                     │
              ├────────▶ Secrets Manager  election/app-secrets (DB URL, JWT secret, API keys)     │
              ├────────▶ DynamoDB  AuditLog (hash chain) · RateLimits                             │
              └────────▶ CloudWatch Logs /aws/lambda/<fn> + metric filter FailedLogins + alarm    │
            └───────────────────────────────────────────────────────────────────────────────────┘
   all 3 Lambdas ──5 SQL over TLS (pooled)──▶ Neon Postgres (managed, AWS eu-central-1)
   voting-svc ──6 HTTPS──▶ Cloudflare Turnstile siteverify · Email API ⟨provider⟩
```

## 3. Services, API and data model
### 3.1 Service 1 – Election Management (Mo'men) **[READY]**
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

### 3.2 Service 2 – Voter Access & Voting (Mohamed Osama) **[READY – Osama to check wording]**
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

### 3.3 Service 3 – Results & Audit (Mohamed Khaled) **[READY]**
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

### 3.4 Data model **[READY]**
Entities (Neon): users, students, elections, positions, candidates, eligibility, vote_receipts, ballots, ballot_selections, result_snapshots (+ audit_log fallback). DynamoDB: AuditLog (pk, seq), RateLimits.
Relationships: election 1-N positions 1-N candidates · election N-N students via eligibility · election 1-N vote_receipts (WHO voted) · election 1-N ballots 1-N ballot_selections (WHAT was chosen) · **no relationship between vote_receipts and ballots** (secret ballot) · election 1-1 result_snapshots.
| Service | Create | Read/Query | Update | Delete |
|---|---|---|---|---|
| Election Mgmt | elections, positions, candidates, students, eligibility | all of these + search/filter | elections, positions, candidates, students | elections (draft/cancelled), positions, candidates, students, eligibility |
| Voting | users, vote_receipts, ballots, ballot_selections | elections, eligibility, positions | users (lockout, token version) | – |
| Results & Audit | result_snapshots, AuditLog | aggregate ballots, AuditLog query | elections status | – (audit is append-only) |

## 4. Role / permission matrix **[READY]**
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

## 5. External integration **[NEEDS email provider name]**
| Service | Workflow | Secret storage |
|---|---|---|
| Cloudflare Turnstile siteverify | Login, registration and vote are rejected (403 BOT_CHECK_FAILED) without a valid token | Secret key in AWS Secrets Manager `election/app-secrets`; site key is public |
| ⟨Email provider⟩ API | Email verification code at registration, vote receipt | API key in Secrets Manager |
Locally, secrets live in `backend/.env` (git-ignored); only `.env.example` with placeholders is committed.

## 6. Deployment approach **[READY]**
Serverless on Floci (AWS emulator): S3 static website, API Gateway HTTP API, three Lambda functions (one per service, Express wrapped with serverless-http), IAM role per function, Secrets Manager, DynamoDB, CloudWatch Logs; Neon Postgres as managed external database. Floci runs in persistent mode (Docker volume) so state survives restarts; `infra/setup-all.sh` builds everything idempotently, `infra/deploy-code.sh` updates code.
Why: same model as the labs, scales to zero, each owner has an independent deploy unit and role, no cost. Trade-offs: cold starts, Floci is not identical to AWS (IAM policies are stored but not enforced), HTTP on localhost instead of HTTPS, Neon free tier may suspend when idle.
Deployed URLs: website `http://localhost:4566/election-web/index.html` · API `http://⟨api-id⟩.execute-api.localhost.floci.io:4566`.

## 7. Threat model **[READY]**
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
| T11 | Bots / request flooding | Availability | Turnstile, API Gateway routes only, lockout, (optional per-IP limit) | ST-11 |
| T12 | Stored XSS in names/manifestos | Application | frontend renders with textContent only, CSP meta tag, length limits | ST-15 |
| T13 | CORS misconfiguration | Cloud config | exact origin allow-list from configuration | ST-17 |

## 8. Security controls **[READY]**
- **Authentication:** email + password, bcryptjs cost 12, JWT HS256 (30 min) signed with a 96-char secret from Secrets Manager; logout/compromise invalidates all tokens via `token_version`.
- **Authorization:** central middleware, roles ADMIN/STUDENT/AUDITOR from the database (not only the token); ownership rule for elections; separation of duties (admins cannot read audit logs).
- **Least privilege:** each Lambda has its own IAM role (`infra/iam/*.json`) – e.g. election-svc may only read its one secret and write/query audit items (an unused photo-upload permission was removed during review); no `*` actions on data. Broad admin access is inappropriate because a single bug or stolen token in one function could then alter votes, delete the audit log or read all secrets.
- **Secrets:** no secrets in code or Git; `.env` locally, Secrets Manager on Floci; `.env.example` contains placeholders only.
- **Input validation:** types, lengths, ranges, enums, UUIDs, date windows, per-row import validation; uniform `{error:{code,message}}`; no stack traces.
- **Ownership checks:** creator-only election changes (EM-09, EM-29), students see only their elections (EM-34).
- **Transport/at rest:** TLS to Neon and external APIs; Neon encrypts at rest; on Floci the browser↔API hop is HTTP on localhost (real AWS: HTTPS endpoints).
- **Shared responsibility:** Provider (AWS/Floci, Neon, Cloudflare): physical security, runtime/OS patching for Lambda, database storage durability and encryption, availability of managed services. Team: application code and business rules, authentication/authorization, IAM policy design, secret handling, input validation, logging/monitoring and response, backup/recreation scripts.

## 9. GitHub repository **[READY – make Public before submission]**
https://github.com/momenemadd/student-election-voting · branches per owner · CODEOWNERS · no secrets.

## 10. Demo video **[NEEDS recording]** ⟨link, anyone with link can view⟩

## 11. Log and monitoring evidence **[NEEDS screenshots]**
Structured JSON log line per request (time, service, method, path, status, duration, hashed user id; never bodies, tokens or passwords). To capture: CloudWatch log group per function; filter `{ $.status = 403 }`; metric `FailedLogins` + alarm (≥5 in 5 min) triggered by ST-11; auditor "verify chain" result.

## 12. Security test table **[READY – add screenshots]**
| ID | Scenario | Expected | Actual (18 Nov, Floci) | Result |
|---|---|---|---|---|
| ST-01 | No token on protected route | 401 | 401 | PASS |
| ST-02 | Student creates election; admin reads audit log | 403 | 403 / 403 | PASS |
| ST-03 | Other admin edits someone else's election (ownership) | 403 | 403 (EM-09) | PASS |
| ST-04 | Invalid input: end before start, seats 0, short name, bad UUID | 400 | 400 | PASS |
| ST-05 | SQL injection in id and search | 400 / 0 rows | 400 / 200 empty | PASS |
| ST-06 | Duplicate vote incl. 20 parallel requests | one 201, rest 409 | 409 ALREADY_VOTED (VT-13); 20 at once → exactly one 201, 1 receipt + 1 ballot stored (VT-14) | PASS |
| ST-07 | Vote outside window | 409 | before opening 409 (VT-08b); after closing 409 ELECTION_NOT_OPEN (VT-15) | PASS |
| ST-08 | Results before publish | 403/409 | student 403 RESULTS_NOT_PUBLISHED (RS-06); admin before counting 409 NOT_COUNTED (RS-08); student not listed 404 (RS-07) | PASS |
| ST-09 | Secret exposure review (repo + history + website bucket) | none found | none in 47 committed files; `.env` → 404 on website | PASS |
| ST-10 | Tampered token / token after logout | 401 | 401 / 401 | PASS |
| ST-11 | Wrong password / unknown user / repeated failures | 401 same message; 423 after 5 | 401 / 401; ⟨lockout screenshot⟩ | PARTLY |
| ST-12 | Edit window, delete candidate, change eligibility while OPEN | 409 | 409 / 409 / 409 (EM-38..40) | PASS |
| ST-13 | IAM review: role per function, no wildcard data actions | documented | `infra/iam/*.json` | PASS |
| ST-14 | Audit chain verification | valid:true | valid:true | PASS |
| ST-15 | XSS payload as candidate name / description | shown as text, script removed | `<script>alert(1)</script>hi` saved as "hi" (Lab 8 S5); pages insert text with textContent only | PASS |
| ST-16 | No join path between receipts and ballots | none | schema review | PASS |
| ST-17 | CORS from evil origin | no allow header | no header; site origin allowed | PASS |
| ST-18 | Tampered result file in S3 / tampered audit record in DynamoDB | detected | export → 500 SNAPSHOT_TAMPERED (RS-14); chain verify → valid:false (RS-17), on Floci | PASS |
| ST-19 | Two counts at the same moment | same result, no error | both 200 with the same SHA-256 (RS-22) | PASS |
| ST-20 | Request flood / fake X-Forwarded-For (Lab 8 S2, S3) | 429 | 59 answered then 21 × 429; fake header still 429 | PASS |
| ST-21 | Security headers (Lab 8 S1) | nosniff, DENY, CSP | present on every answer, also from Lambda | PASS |
Plus automated end-to-end tests (24 Nov): Election Management 48/48 (local and Floci), Voting 56/56 (local; not on Floci because it would e-mail made-up addresses), Results & Audit 22/22 (local and Floci), security smoke 16/16, Lab 8 S1–S7 8/8, Lab 8 checker 20/20.

## 13. Integrated testing **[READY – add demo screenshots]**
Main scenario: admin creates election → positions/candidates → roster → eligibility → schedule → opens automatically → student registers, logs in, votes, gets receipt → closes → tally → publish → student sees results → auditor verifies chain. Invalid cases: ineligible student, duplicate vote, vote after close, illegal transitions, malformed JSON (400 INVALID_JSON verified on Lambda). Result (24 Nov, Floci, browser): the full scenario was run end to end — count, recount and compare, publish, student view, auditor security summary and "Verify chain" (screenshots `docs/evidence/RS-*.jpg`); every invalid case is covered by the automated tests above.

### 13.1 Scaling, load testing and failover (Lab 8) **[READY – full numbers in `docs/lab-08-results.md`]**
Following Lab 8 without adding AWS services: the same stateless backend ran as 1 worker (vertical) and as 3 workers behind a local load balancer on :8080 (round robin, health check every 3 s), then worker 2 was killed during the test. Grafana k6, up to 50 virtual users, 3 minutes each:
| | 1 worker | 3 workers | 3 workers, one crashed |
|---|---|---|---|
| Throughput | 15.2 req/s | 20.3 req/s | 18.6 req/s |
| p(95) | 2,102 ms | 587 ms | 1,055 ms |
| Failed requests | 0.00% | 0.00% | 0.00% |
Scaling out cut p(95) 3.6×; the load balancer logged the crash (`ECONNREFUSED`), retried on a healthy worker and no request failed. p(95) stays above 500 ms because each request makes ~2 round trips to Neon in Frankfurt (~0.2 s each) and all workers share one laptop. Security attack checks S1–S7: 8/8 passed; Lab 8 checker: 20/20 passed.

## 14. Cost / resource statement **[READY]**
Resources: 3 Lambda functions (512 MB, 15 s timeout), 1 HTTP API (29 routes), 3 S3 buckets, 2 DynamoDB on-demand tables, 1 secret, log groups + metric filter + alarm; Neon free plan; Turnstile and Brevo free. Cost: €0 (Floci is local; on real AWS these are pay-per-request and scale to zero). Avoiding waste: on-demand capacity, small zip (5 MB), one pooled DB connection per Lambda container, no always-on servers, a hard maximum on copies (Lab 8 Auto Scaling idea: max 4 workers in our scale script), expiring rate-limit counters (DynamoDB TTL). More load: API Gateway and Lambda add copies automatically; Lab 8 measurements show 3 copies serve 33% more requests 3.6× faster than one; the next bottleneck is the single Neon compute and its distance, solved by a larger compute in the same region.

## 15. Recovery approach **[READY]**
Everything is code: `db/schema.sql` + `npm run migrate` recreate the database structure, `npm run seed` recreates admin/auditor, `infra/setup-all.sh` recreates all cloud resources (idempotent), secrets are re-entered from `.env`. Data: Neon point-in-time restore/branching ⟨check free-plan window⟩. Compromise: rotate JWT secret (all tokens invalid), rotate DB password and API keys, verify audit chain, review CloudWatch logs.

## 16. Limitations **[READY – extend at the end]**
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
| The Voting end-to-end tests are run locally only | on Floci they would e-mail made-up addresses | a test inbox / e-mail sandbox |

---
## Individual Contribution Statements (end of report)
### Mo'men Mohamed – Election Management **[READY to adapt, add screenshots + commit links]**
- **Component & functions:** election lifecycle (create, edit, delete, schedule/cancel/close early with state machine and readiness check), positions and candidates, student roster (add, import, search, edit, deactivate, delete), eligibility (single, bulk, remove).
- **Frontend:** `frontend/admin/index.html` (list, filter, create), `election.html` (details, status actions, readiness, turnout, positions/candidates, eligibility), `students.html` (roster, CSV import with per-row report).
- **Backend/API:** `backend/services/election/routes.js` – 25 endpoints, validation, status codes, ownership and state checks, audit events.
- **Data operations:** C/R/U/D/search on elections, positions, candidates, students, eligibility (Neon, parameterised SQL, transaction for import).
- **Security controls:** admin-only routes, creator ownership, setup/window locks, input validation and whitelisting, LIKE-escaped search, no info leak to ineligible students (404), audit logging.
- **Tests:** `tests/election-e2e.js` – 48 cases (normal, invalid, unauthorized, ownership, state locks, audit), 48/48 passing locally and on Floci.
- **Integration:** uses shared auth/validation/audit; reads turnout from Results & Audit; provides eligibility and candidates to Voting; owns Floci infrastructure scripts.
- **Decisions:** time-based OPEN/CLOSED applied lazily with the database clock (no dependency on a scheduler); creator-only ownership; delete only DRAFT/CANCELLED elections.
- **Difficulties:** Express 5 + serverless-http passed request bodies as raw Buffers on Lambda (every login failed with "email must be a string") – solved with a small parser in the shared app; Floci lost all resources on restart – solved with persistent storage mode; deploy script created duplicates on re-run – made idempotent.
- **Integration and completion work (add to Mo'men's statement):** reviewed, tested and merged the Voting service (added its database columns, fixed the Brevo key permission, changed the login limit to address+e-mail because Floci shows every client as 127.0.0.1, verified a real e-mail flow on Floci); merged the Results & Audit backend and completed it (results page, auditor page, S3 restore + clear "missing file" error, simultaneous-count fix, Floci versions of RS-14/RS-17, test RS-22); Lab 8 work (security headers, rate limit on every request with a sliding window, sanitising, worker ids, local load balancer + scale script, k6 load tests Run A/B/C, failover drill, S1–S7 checks, Lab 8 checker).
### Mohamed Osama – Voter Access & Voting **[Osama writes it in his own words – his draft notes exist]**
### Mohamed Khaled – Results & Audit **[Khaled writes it in his own words]**
Facts for his statement: he implemented the backend (`tally.js` counting with winners and ties and a canonical hash, `snapshots.js` S3 copy, `routes.js` with count, results, publish, export with hash check, recount, security summary, audit filters) and `tests/results-e2e.js` (RS-01–RS-21), 4 commits on `feat/khaled-results`. The results and auditor pages, the S3/simultaneous-count improvements and RS-22 were completed by Mo'men after the merge (commits under Mo'men's name).
