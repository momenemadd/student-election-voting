# 7-day schedule (today Wed 2026-11-18 → deadline Wed 2026-11-25)

Rule: **features freeze Sun 22 evening.** Mon/Tue are for security tests, evidence, report, video. Wed is buffer + submit.
Aim to be fully submitted by Tue 24 night; Wed morning is only for problems.

## Scope for 7 days ("Lean core") – what changed vs FINAL_PHASE_PLAN.md
| Kept | Cut / simplified (document under Limitations) |
|---|---|
| 3 Lambda services behind API Gateway, S3 site, Neon, DynamoDB audit chain, Secrets Manager, CloudWatch logs + metric filter + alarm | SQS audit pipeline (services write audit directly via `shared/audit.js`) |
| State machine with **lazy automatic OPEN/CLOSE** (DB clock) + admin early-close + explicit publish | EventBridge Scheduler (optional extra only if time remains) |
| Split ballots (vote secrecy), one-vote DB constraint, JWT auth, lockout, roles ADMIN/STUDENT/AUDITOR | HIBP password check, SNS, CSV export, candidate photo upload (S3 still hosts the site + result snapshot) |
| Turnstile + **email OTP/receipt** (one email provider) = 2 real external integrations | Cognito |
| 17 security tests, integrated tests, video, report | Vercel+Neon fallback only if Floci blocks you by Sun |

## Day by day
| Day | Everyone | Mo'men (Election Mgmt) | Mohamed Osama (Voting) | Mohamed Khaled (Results & Audit) |
|---|---|---|---|---|
| **Wed 18** (today) | Install Docker Desktop (enable virtualization, restart), AWS CLI v2, `floci` profile. Create Neon project, run `db/schema.sql` (direct URL), create `backend/.env`, `npm run seed`. Push scaffold to GitHub, each person creates branch `feat/<name>`. Pick the email provider. | Install + start Floci, run `bash infra/setup-all.sh` once, note what fails | Neon + `.env` + seed; run `npm run dev`, call `/api/auth/login` | Read `shared/audit.js`; confirm DynamoDB path works on Floci |
| **Thu 19** | **Spikes (go/no-go by evening):** Lambda→Neon; Secrets Manager read; API Gateway→Lambda; DynamoDB audit write; S3 site; email test send; Turnstile test key | Positions/candidates/students endpoints + state transition + readiness | register + verify-email (OTP) + email send; `/me/elections` | tally query + results gating + turnout |
| **Fri 20** | Merge PRs, daily 10 min sync | eligibility endpoints, PATCH/DELETE guards (409), admin UI skeleton | ballot + **vote transaction** + receipt; race test | publish, export, security-summary; auditor UI |
| **Sat 21** | **First end-to-end run locally (`npm run dev` + frontend on :8080)** | admin UI complete | student UI complete | results + audit UI |
| **Sun 22** | Deploy full stack to Floci (`setup-all.sh`), run main scenario on Floci. **FEATURE FREEZE tonight.** | frontend → S3, API routes check | secrets via Secrets Manager | log group + metric filter + alarm evidence |
| **Mon 23** | Run all security tests ST-01…17 together, fix, rerun; capture screenshots into `docs/evidence/`; gitleaks scan of full history; record demo video | tests for own service + individual statement draft | same | same; monitoring evidence |
| **Tue 24** | Assemble report (Khaled compiles), proofread aloud, upload video ("anyone with link"), repo public + fresh-clone test, rehearse demo twice (each explains own request flow) | | | |
| **Wed 25** | Buffer. Submit early (report + repo link + video link). Confirm the live-demo date. | | | |

## Report writing split (start Day 4, don't leave to the end)
- Mo'men: §6 deployment, §9 cost/recovery, architecture diagram, own statement
- Osama: §5 external integrations, §8 security controls, §3 API tables for auth/voting, own statement
- Khaled: §7 threat model, §11 logs, §12 test table, §13 integrated tests, §16 limitations, compiles and proofreads, own statement

## If something breaks (fallbacks decided in advance)
| Problem | Fallback |
|---|---|
| Docker/Floci won't install or run | Vercel + Neon deployment of the same Express code (Lab 5 route) – accepted as minimum submission |
| Lambda can't reach Neon from Floci | try `-pooler` host, check Docker network/DNS; else run Neon calls via Vercel fallback and keep Floci for S3/API GW/DynamoDB/Secrets |
| Secrets Manager read fails | set the same values as Lambda environment variables (documented limitation) |
| Floci DynamoDB/CloudWatch gaps | audit falls back to Postgres `audit_log` (already implemented); logs shown via `aws logs tail` |
| Email provider blocks sending | log OTP to CloudWatch in dev only, clearly labelled; keep real provider evidence if one send worked |

## Spike results (run 2026-11-18 on Floci, all PASS)
| Spike | Result |
|---|---|
| Floci container (floci/floci:latest) | healthy on :4566, account 000000000000 |
| Lambda (nodejs24.x) → public internet | Turnstile siteverify returned success with test key; `neon.tech` DNS resolves |
| Lambda → Secrets Manager (SDK, no keys in code) | secret read OK; Floci injects `AWS_ENDPOINT_URL` automatically |
| Lambda → DynamoDB PutItem | OK |
| API Gateway HTTP API → Lambda (`ANY /api/x/{id}`) | 200; unknown route blocked by gateway with 404 |
| S3 static page | served at `http://localhost:4566/<bucket>/index.html` |
| CloudWatch Logs | `/aws/lambda/<fn>` log group created automatically |
Still open: Lambda → Neon query (needs your DATABASE_URL).
