# How the Student Election system works – step by step

A walkthrough of what really happens in the cloud and the backend, one action at a time.
Read it top to bottom once; use the scenes as your demo script.

---

## Scene 0 – Building the cloud (done once with `bash infra/setup-all.sh`)
Docker Desktop is open → Floci runs inside a Docker container on port **4566** → the AWS CLI (profile `floci`) sends every `aws` command to Floci instead of Amazon.

The script then builds, in this order:
1. **DynamoDB** tables: `AuditLog` (tamper-proof log) and `RateLimits` (counters that delete themselves).
2. **Secrets Manager** secret `election/app-secrets`: copies the database address, JWT secret, Turnstile secret and Brevo key from `backend/.env`.
3. **S3** buckets: `election-web` (the website files) and `election-results` (saved results).
4. **IAM**: 3 roles, one per Lambda, each allowed only what its service needs.
5. **Lambda**: zips the `backend/` code once and creates 3 functions from it: `election-svc`, `voting-svc`, `results-svc`.
6. **API Gateway**: one HTTP API with 28 routes; each route points to the right Lambda.
7. **CloudWatch**: a log group per Lambda, a "FailedLogins" counter and an alarm.
8. **Website**: writes the API address into `js/config.js` and uploads all pages to S3.

After code changes only `bash infra/deploy-code.sh` is needed (new zip → 3 Lambdas, new pages → S3).

---

## Scene 1 – Opening the website
1. You type `http://localhost:4566/election-web/index.html`.
2. **S3** (in Floci) sends the HTML, CSS and JS files to the browser. No code runs yet.
3. `config.js` tells the page the API address: `http://28a0b6493f.execute-api.localhost.floci.io:4566`.
4. The page calls `GET /api/health` → **API Gateway** finds the route → starts **Lambda `election-svc`**.
5. Answer `{"status":"ok","runtime":"lambda"}` → the top bar shows **"API online: lambda"**.

---

## Scene 2 – What happens inside a Lambda (every request)
1. **First request after a pause ("cold start")**: Floci asks Docker for a new container, loads our zip, runs `lambda/election.js`.
2. `serverless-http` turns the API Gateway message into a normal **Express** request.
3. The code reads the secrets **once** from **Secrets Manager** (Floci gives the Lambda its address automatically – no keys in the code) and opens one connection to **Neon** over the internet (encrypted).
4. Every request then passes the same chain:
   `log the request` → `CORS check (only our website)` → `read the JSON body` → `find the route` → `check token` → `check role` → `check input` → `run SQL` → `write audit record` → `send the answer`.
5. One JSON log line per request goes to **CloudWatch** (time, path, status, how long – never passwords or tokens).
6. The container stays "warm" for a while, so the next requests are fast.

---

## Scene 3 – Logging in (Voting service)
1. You type email + password; **Cloudflare Turnstile** gives the page a one-time "human" token.
2. Browser → `POST /api/auth/login` → API Gateway → **Lambda `voting-svc`**.
3. **DynamoDB `RateLimits`**: counter `login:<address>:<email>` +1. More than 10 in 5 minutes → **429**.
4. **Turnstile check**: the Lambda asks Cloudflare over the internet "is this token real?" → no → **403**.
5. **Neon**: find the user. Locked? → **423**. Password checked with **bcrypt** against the stored hash.
6. Wrong → failure counter +1 (5 failures = locked 15 minutes) → audit `LOGIN_FAILED` → **401** with the same message for any mistake.
7. Right → a **JWT token** is created (role inside, valid 30 minutes, signed with the secret) → audit `LOGIN_OK` → **200**.
8. The browser keeps the token for this tab and opens the page for the role (admin / student / auditor).

From now on **every request carries the token**. The backend checks it each time and re-reads the role from the database – hiding a button is never the protection.

---

## Scene 4 – Admin prepares an election (Election Management)
1. **Create**: `POST /api/elections` → **`election-svc`** → checks title, dates, window ≥ 60 min, start in the future → `INSERT` with status **DRAFT** and `created_by` = you (from the token) → audit `ELECTION_CREATED` → **201**.
2. **Positions + candidates**: allowed only while DRAFT and only for the creator; duplicates → **409**.
3. **Students**: add one, or paste a list (up to 500) → the answer reports which rows were added, skipped or wrong.
4. **Who can vote**: links students to the election (table `eligibility`).
5. **Readiness**: one SQL query checks: ≥ 1 position, every position has ≥ 2 candidates, ≥ 1 student can vote.
6. **Schedule**: only when ready → status **SCHEDULED** → positions and candidates are now locked.
Every change writes an **audit record** to DynamoDB.

---

## Scene 5 – The election opens and closes by itself
There is **no timer**. Every time anyone reads an election, one SQL statement compares the **database clock** with `start_time` / `end_time` and moves **SCHEDULED → OPEN → CLOSED** if it is time.
So it is always correct, even if nobody watched the clock. (An admin can also close early, with a reason.)

---

## Scene 6 – A student registers (Voting service)
1. Student number + email + password + Turnstile → `POST /api/auth/register` → **`voting-svc`**.
2. Rate limit (DynamoDB) → Turnstile (Cloudflare) → the number must be on the student list **and** the email must match it → else **403**.
3. Neon: create the user (STUDENT, not verified) + store only the **hash** of a random 6-digit code (valid 10 minutes).
4. **Brevo**: the Lambda calls Brevo's API with the key from Secrets Manager → Brevo emails the code.
5. Student types the code → `POST /api/auth/verify-email` → hash compared → max 5 tries → verified.

---

## Scene 7 – A student votes (the most important scene)
1. `GET /api/elections/:id/ballot` → only if the student is on the list, the election is OPEN and they have not voted.
2. Student chooses → `POST /api/elections/:id/votes` (+ Turnstile).
3. **`voting-svc`** checks every choice belongs to this election's positions, the right number per position.
4. One **database transaction** (all or nothing):
   - add a row to `vote_receipts` = **WHO voted** (no choice)
   - add a row to `ballots` + `ballot_selections` = **WHAT was chosen** (no student, no time)
5. A second vote fails because `vote_receipts` allows only **one row per student per election** → **409**, even if 20 requests arrive at once.
6. Audit `VOTE_CAST` (no choice inside) → **Brevo** emails the receipt code → **201** with the receipt code.
**Secret ballot:** the two tables are never linked, so nobody – not even an admin with database access – can see who voted for whom.

---

## Scene 8 – Counting and publishing (Results & Audit – Mohamed Khaled, being built)
1. After **CLOSED**, the admin clicks **Count votes** → **`results-svc`**.
2. Safety check: number of ballots = number of receipts.
3. One SQL query counts votes per candidate (0-vote candidates included), finds winners and ties.
4. The result is saved in Neon **and** as a file in **S3** with a **SHA-256 fingerprint** → status **COUNTED**.
5. Admin clicks **Publish** → status **PUBLISHED** → students can now see the results.
6. Download: the file is read from S3 and its fingerprint checked again – any change is detected.

---

## Scene 9 – The Auditor checks
1. Audit log: `GET /api/audit-logs` → **DynamoDB `AuditLog`** (admins are refused with 403 – the person running elections must not control the log).
2. **Verify chain**: every audit record contains the fingerprint of the one before it. The service recalculates all fingerprints; if any record was edited or removed, the chain "breaks" and it shows where.
3. Security summary: counts of failed logins, blocked requests and too-many-tries in the last hours.

---

## Scene 10 – Monitoring (CloudWatch)
1. Every Lambda writes one log line per request to its log group (`/aws/lambda/<name>`).
2. A **metric filter** counts the lines with status 401 → metric **FailedLogins**.
3. An **alarm** fires when there are ≥ 5 failed logins in 5 minutes.
4. Evidence: `aws logs tail`, `aws logs filter-log-events '{ $.status = 401 }'`, `aws cloudwatch describe-alarms`.

---

## Scene 11 – Where the secrets live
`backend/.env` (your PC, never on GitHub) → `setup-all.sh` → **Secrets Manager** → each Lambda reads them at its first request.
The website only gets public things (the API address, the Turnstile site key).

---

## Scene 12 – How code reaches the cloud
1. Each student works on their **branch** → pushes to GitHub → opens a **Pull Request**.
2. Mo'men reviews, tests, **merges** into `main`.
3. Mo'men: `git pull` → `bash infra/deploy-code.sh` (or `setup-all.sh` if secrets changed) → tests on Floci.

---

## The whole system in one picture
```
                 ┌────────────── Floci (fake AWS in Docker, port 4566) ──────────────┐
 Browser ──────► S3 election-web (pages)                                              │
    │                                                                                 │
    └─ token ──► API Gateway (28 routes) ──► Lambda election-svc  (Mo'men)            │
                                        ──► Lambda voting-svc    (Fouda)  ──► DynamoDB RateLimits
                                        ──► Lambda results-svc   (Khaled) ──► S3 election-results
                                               │  all three:
                                               ├─► Secrets Manager (keys)        
                                               ├─► DynamoDB AuditLog (hash chain)
                                               └─► CloudWatch Logs + alarm        │
                 └────────────────────────────────────────────────────────────────────┘
        all three Lambdas ──► Neon Postgres (internet, encrypted)
        voting-svc        ──► Cloudflare Turnstile, Brevo email (internet)
```
