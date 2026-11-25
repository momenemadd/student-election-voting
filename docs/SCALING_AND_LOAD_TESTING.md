# Lab 8 – Scale and Secure: results for the Student Election app

Measured on 24 Nov 2026 on Mo'men's laptop (Floci on Docker, database on Neon in Frankfurt).
Raw evidence: `docs/load-testing/` (k6 output + JSON summaries, round-robin and failover logs, S1–S7 checks, checker output).

## How we followed Lab 8 (without adding AWS services)
| Lab 8 idea | In our project |
|---|---|
| Scale up (vertical): one bigger server | `bash infra/scale-test.sh vertical` → one worker `ecs-task-vertical` on :8080 |
| Scale out (horizontal): copies behind a load balancer | `bash infra/scale-test.sh horizontal 3` → workers `ecs-task-1..3` on :3001–:3003 behind `infra/scale/load-balancer.js` on :8080 (round robin, health check `GET /api/health` every 3 s, failover). Lab 8 also uses a local load balancer that plays the role of the ALB. |
| Stateless app | Workers keep nothing important in memory: login = signed token checked against the database; data in Neon; audit log + login/vote rate limits in DynamoDB; settings from Secrets Manager. Any worker can answer any request. |
| Load test with Grafana k6 | `tests/load/election-load-test.js` + `bash infra/load-test.sh run-a / run-b / run-c` (ramp-up, steady, spike, hold, ramp-down; thresholds p(95) < 500 ms and failures < 5%) |
| Failover drill | Run C kills worker 2 after 30 s (`scale-test.sh kill 2`) |
| Security in layers | Least-privilege IAM, rate limit on every request (60 s sliding window, N from Secrets Manager), input validation, sanitising, security headers, secrets in Secrets Manager, audit log |
| ALB, ECS, Auto Scaling, SQS, SNS, EventBridge | **Not added**: the team decided to stay with our 7 AWS services. The local load balancer + workers demonstrate the same behaviour; our main deployment is serverless (API Gateway + Lambda), where AWS adds copies automatically. |

## Load test results (k6, up to 50 virtual users, 3 minutes)
| | Run A – 1 worker (vertical) | Run B – 3 workers (horizontal) | Run C – 3 workers, worker 2 crashed at 30 s |
|---|---|---|---|
| Requests | 2,763 | 3,688 | 3,408 |
| Throughput | 15.2 req/s | **20.3 req/s** | 18.6 req/s |
| Average | 653 ms | **237 ms** | 341 ms |
| p(90) | 1,538 ms | **413 ms** | 804 ms |
| p(95) (threshold 500 ms) | 2,102 ms ✗ | **587 ms** ✗ (close) | 1,055 ms ✗ |
| http_req_failed (threshold 5%) | **0.00%** ✓ | **0.00%** ✓ | **0.00%** ✓ |
| Served by | vertical: 2,761 | task-1: 1,229 · task-2: 1,229 · task-3: 1,228 | task-1: 1,675 · task-2: 57 (then crashed) · task-3: 1,674 |
| 429 answers | 0 (limit raised for the test) | 0 | 0 |

### What the numbers show
- **Scaling out works:** three workers cut p(95) from 2.1 s to 0.59 s (3.6× faster) and raised throughput by a third, with zero errors. Round robin shares the work almost exactly (1,229 / 1,229 / 1,228).
- **Why one worker is slow:** each request needs about two database round trips to Neon in Frankfurt (~0.2 s each). One worker has only 5 database connections, so at 50 users requests queue for a connection. Three workers have 15 connections between them. A bigger single worker (scale up) would not help: Node.js runs our code on one CPU core and the waiting is for the network, not the CPU – the Lab 8 lesson that scaling up has a ceiling.
- **Why p(95) is still above 500 ms in Run B:** all three workers share one laptop, one Docker/Floci and one database far away. The threshold is missed by 87 ms; on real AWS each task gets its own CPU and the database would sit in the same region (a few ms per query).
- **Failover works (Run C):** worker 2 was stopped at 21:27:15. The load balancer logged `upstream http://localhost:3002/ failed: ECONNREFUSED`, retried the request on a healthy worker and stopped sending traffic to worker 2. Not one request failed (0.00%); workers 1 and 3 carried the rest. On real AWS, ECS would then start a replacement task.

## Security checks S1–S7 (one worker, normal limit 60 per 60 s)
| Test | Result | Layer |
|---|---|---|
| S1 security headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` on every answer | Security headers |
| S2 80 quick requests | 59 answered, then **21 × 429** | Rate limiting (sliding window) |
| S3 fake `X-Forwarded-For: 9.9.9.9` | still **429** – the header is ignored unless it comes from our own load balancer | Rate limiting, no bypass |
| S4 1,001-character description | **400** "must be at most 1000 characters" | Input validation |
| S5 `<script>alert(1)</script>hi` | **saved as "hi"** | Sanitising |
| S6 audit trail | `ELECTION_CREATED` recorded in DynamoDB AuditLog; **17 `RATE_LIMITED`** records for blocked requests | Audit log |
| S7 audit chain | `{"valid":true,"count":260}` | Tamper-evident log |
Result: **8 passed, 0 failed** (`docs/load-testing/security-checks.txt`). Automatic checker: **20 passed, 0 failed** (`docs/load-testing/deployment-verification.txt`).

## How to repeat (Git Bash, project folder, Docker running)
```bash
export RATE_LIMIT_MAX=100000                 # raise the limit for load tests (Lab 8)
bash infra/scale-test.sh vertical && bash infra/load-test.sh run-a
bash infra/scale-test.sh horizontal 3 && bash infra/load-test.sh run-b
bash infra/load-test.sh run-c                 # same 3 workers, worker 2 is killed after 30 s
unset RATE_LIMIT_MAX; bash infra/scale-test.sh stop
RATE_LIMIT_MAX=60 bash infra/scale-test.sh vertical && bash infra/security-checks.sh
bash infra/scale-test.sh stop && bash infra/verify-deployment.sh
```
