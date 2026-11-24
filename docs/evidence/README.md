# Where each screenshot goes in the report

Put each picture under the report section named here, with a one-line caption saying what it shows.
Every picture is from the real app on Floci (or the local API where noted). None of them shows a password, key or token.

| Report section | Screenshot(s) | Caption idea |
|---|---|---|
| §3.1 Election Management | `EM-elections-list.jpg`, `EM-election-draft-readiness.jpg`, `EM-positions-and-eligibility.jpg`, `EM-roster-import-report.jpg` | Admin creates the election, adds positions/candidates and the voters; the readiness check |
| §3.1 / §4 state machine | `EM-schedule-confirm-dialog.jpg`, `EM-election-scheduled.jpg`, `EM-setup-locked-after-scheduling.jpg` | Scheduling, and setup locked once scheduled |
| §3.2 Voting | `VT-register-form.png`, `VT-register-code-sent.png`, `VT-verify-success.png`, `VT-login-turnstile.png`, `VT-07-my-elections.png`, `VT-ballot.png`, `VT-review.png`, `VT-confirm-dialog.png`, `VT-12-receipt-code.png`, `VT-18-receipt-page.png`, `VT-07-my-elections-voted.png` | Register with roster number + e-mail code, log in, vote, receipt |
| §3.3 Results & Audit | `RS-results-counted.jpg`, `RS-auditor-security-summary.jpg`, `RS-auditor-verify-chain.jpg` | Counted results with SHA-256, auditor summary, chain verified |
| §5 External integration | `VT-register-code-sent.png` (Brevo e-mail code), `VT-login-turnstile.png` (Turnstile) | The two external APIs at work |
| §11 Logs and monitoring | `MON-cloudwatch-failed-logins.png`, `MON-cloudwatch-denied-403.png`, `MON-floci-log-groups.png`, `RS-auditor-security-summary.jpg` | CloudWatch Logs filtered for failed logins / denied access; log groups per Lambda; auditor summary |
| §12 ST-01, ST-02, ST-05, ST-10, ST-17 | `VT-security-smoke.png` | 16/16 security smoke checks |
| §12 ST-06 duplicate vote | `VT-13-second-vote-409.png`, `VT-13-double-vote-api-409.png`, `VT-14-race-test.png` | Second vote refused; 20 votes at once → exactly one accepted |
| §12 ST-07 vote outside window | `VT-08-ballot-before-opening.png`, `VT-08-ballot-before-opening-api-409.png` | Ballot refused before opening (409) |
| §12 ST-11 brute force | `ST-11-lockout.png` | Correct password refused after 5 wrong ones (423) |
| §12 ST-14 audit chain | `RS-auditor-verify-chain.jpg` | Chain valid |
| §12 ST-16 secret ballot | `VT-20-no-link-receipts-ballots.png` | No column links who voted and what was chosen |
| §12 bot check | `VT-19-no-turnstile-403.png` | Vote without the "I am human" token → 403 |
| §13 Integrated testing | `VT-tests-summary.png` + frames from the demo video | All end-to-end tests passing |
| §13.1 Lab 8 | `docs/lab8/*.txt` (copy the k6 summary lines as text or screenshot them) | Run A/B/C numbers, failover log |
