-- Neon Postgres schema. Run in the Neon SQL editor (use the DIRECT, non-pooled URL for migrations).
-- IMPORTANT: vote_receipts (who voted) and ballots/ballot_selections (what was chosen) have NO link.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  user_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_number text UNIQUE,
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('ADMIN','STUDENT','AUDITOR')),
  email_verified boolean NOT NULL DEFAULT false,
  failed_logins  int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  token_version  int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS students (
  student_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_number text NOT NULL UNIQUE,
  full_name      text NOT NULL,
  email          text NOT NULL UNIQUE,
  faculty        text,
  active         boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS elections (
  election_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  start_time  timestamptz NOT NULL,
  end_time    timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'DRAFT'
              CHECK (status IN ('DRAFT','SCHEDULED','OPEN','CLOSED','TALLIED','PUBLISHED','CANCELLED')),
  created_by  uuid NOT NULL REFERENCES users(user_id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);

CREATE TABLE IF NOT EXISTS positions (
  position_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id    uuid NOT NULL REFERENCES elections(election_id) ON DELETE CASCADE,
  title          text NOT NULL,
  max_selections int NOT NULL DEFAULT 1 CHECK (max_selections BETWEEN 1 AND 10),
  UNIQUE (election_id, title)
);

CREATE TABLE IF NOT EXISTS candidates (
  candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id  uuid NOT NULL REFERENCES positions(position_id) ON DELETE CASCADE,
  name         text NOT NULL,
  manifesto    text NOT NULL DEFAULT '',
  photo_key    text,
  UNIQUE (position_id, name)
);

CREATE TABLE IF NOT EXISTS eligibility (
  election_id uuid NOT NULL REFERENCES elections(election_id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES students(student_id),
  PRIMARY KEY (election_id, student_id)
);

-- WHO voted (never WHAT). Primary key = the one-vote-per-student rule enforced by the database.
CREATE TABLE IF NOT EXISTS vote_receipts (
  election_id  uuid NOT NULL REFERENCES elections(election_id),
  student_id   uuid NOT NULL REFERENCES students(student_id),
  receipt_hash text NOT NULL,
  voted_on     date NOT NULL DEFAULT current_date,   -- date only, no time: harder to correlate with a ballot
  PRIMARY KEY (election_id, student_id)
);

-- WHAT was chosen (never WHO). Random UUIDs, no student column, no timestamp.
CREATE TABLE IF NOT EXISTS ballots (
  ballot_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id uuid NOT NULL REFERENCES elections(election_id)
);

CREATE TABLE IF NOT EXISTS ballot_selections (
  ballot_id    uuid NOT NULL REFERENCES ballots(ballot_id),
  position_id  uuid NOT NULL REFERENCES positions(position_id),
  candidate_id uuid NOT NULL REFERENCES candidates(candidate_id),
  PRIMARY KEY (ballot_id, position_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS result_snapshots (
  election_id  uuid PRIMARY KEY REFERENCES elections(election_id),
  tallied_at   timestamptz NOT NULL DEFAULT now(),
  result_json  jsonb NOT NULL,
  sha256       text NOT NULL,
  published_at timestamptz,
  published_by uuid REFERENCES users(user_id)
);

-- Audit hash chain. Used when AUDIT_TABLE (DynamoDB) is not set. Append-only by convention + by DB role.
CREATE TABLE IF NOT EXISTS audit_log (
  pk        text NOT NULL,          -- election_id or 'GLOBAL'
  seq       int  NOT NULL,
  ts        timestamptz NOT NULL,
  actor_id  text NOT NULL,
  role      text NOT NULL,
  action    text NOT NULL,
  resource  text NOT NULL,
  outcome   text NOT NULL,
  prev_hash text NOT NULL,
  hash      text NOT NULL,
  PRIMARY KEY (pk, seq)
);

CREATE INDEX IF NOT EXISTS idx_eligibility_student ON eligibility(student_id);
CREATE INDEX IF NOT EXISTS idx_positions_election  ON positions(election_id);
CREATE INDEX IF NOT EXISTS idx_candidates_position ON candidates(position_id);
CREATE INDEX IF NOT EXISTS idx_audit_action        ON audit_log(action, ts);
