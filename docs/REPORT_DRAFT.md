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

### 3.2 Service 2 – Voter Access & Voting (Osama) **[NEEDS Osama's final endpoint table]**
Implemented so far: POST /api/auth/login (200/400/401/403/423), POST /api/auth/logout (204/401), GET /api/me (200/401). To add: register, verify-email, my elections, ballot, votes, receipt.

### 3.3 Service 3 – Results & Audit (Khaled) **[NEEDS Khaled's final endpoint table]**
Implemented so far: GET /api/elections/:id/turnout (200/400/401/403/404), GET /api/audit-logs (200/400/401/403), GET /api/audit-logs/verify (200/401/403). To add: tally, results, publish, export, security summary.

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

## 12. Security test table **[PARTLY READY – add screenshots]**
| ID | Scenario | Expected | Actual (18 Nov, Floci) | Result |
|---|---|---|---|---|
| ST-01 | No token on protected route | 401 | 401 | PASS |
| ST-02 | Student creates election; admin reads audit log | 403 | 403 / 403 | PASS |
| ST-03 | Other admin edits someone else's election (ownership) | 403 | 403 (EM-09) | PASS |
| ST-04 | Invalid input: end before start, seats 0, short name, bad UUID | 400 | 400 | PASS |
| ST-05 | SQL injection in id and search | 400 / 0 rows | 400 / 200 empty | PASS |
| ST-06 | Duplicate vote incl. 20 parallel requests | one 201, rest 409 | ⟨run tests/race-test.js⟩ | – |
| ST-07 | Vote outside window | 409 | ⟨Osama⟩ | – |
| ST-08 | Results before publish | 403/409 | ⟨Khaled⟩ | – |
| ST-09 | Secret exposure review (repo + history + website bucket) | none found | none in 47 committed files; `.env` → 404 on website | PASS |
| ST-10 | Tampered token / token after logout | 401 | 401 / 401 | PASS |
| ST-11 | Wrong password / unknown user / repeated failures | 401 same message; 423 after 5 | 401 / 401; ⟨lockout screenshot⟩ | PARTLY |
| ST-12 | Edit window, delete candidate, change eligibility while OPEN | 409 | 409 / 409 / 409 (EM-38..40) | PASS |
| ST-13 | IAM review: role per function, no wildcard data actions | documented | `infra/iam/*.json` | PASS |
| ST-14 | Audit chain verification | valid:true | valid:true | PASS |
| ST-15 | XSS payload as candidate name | shown as text | ⟨screenshot⟩ | – |
| ST-16 | No join path between receipts and ballots | none | schema review | PASS |
| ST-17 | CORS from evil origin | no allow header | no header; site origin allowed | PASS |
Plus 48/48 Election Management tests (`tests/election-e2e.js`, local and Floci).

## 13. Integrated testing **[NEEDS full run after all services]**
Main scenario: admin creates election → positions/candidates → roster → eligibility → schedule → opens automatically → student registers, logs in, votes, gets receipt → closes → tally → publish → student sees results → auditor verifies chain. Invalid cases: ineligible student, duplicate vote, vote after close, illegal transitions, malformed JSON (400 INVALID_JSON verified on Lambda).

## 14. Cost / resource statement **[READY]**
Resources: 3 Lambda functions (256 MB, 15 s timeout), 1 HTTP API, 3 S3 buckets, 2 DynamoDB on-demand tables, 1 secret, log groups; Neon free plan; Turnstile free. Cost: €0 (Floci is local; on real AWS these are pay-per-request and scale to zero). Avoiding waste: on-demand capacity, small zip (4.3 MB), one pooled DB connection per Lambda container, no always-on servers. More load: API Gateway and Lambda scale out automatically; Neon pooler accepts many connections; bottleneck would be the single Neon compute, solved by a larger compute size.

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
### Mohamed Osama – Voter Access & Voting **[NEEDS Osama]**
### Mohamed Khaled – Results & Audit **[NEEDS Khaled]**
