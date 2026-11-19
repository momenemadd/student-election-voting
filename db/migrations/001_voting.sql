-- Voting service (owner: Mohamed Osama): e-mail verification code columns.
-- Only the SHA-256 hash of the 6-digit code is stored, never the code itself.
-- Run once in the Neon SQL editor (safe to re-run).
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_tries int NOT NULL DEFAULT 0;
