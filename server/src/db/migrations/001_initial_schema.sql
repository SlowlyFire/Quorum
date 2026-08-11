-- 001_initial_schema.sql
--
-- Quorum initial schema: nine tables in four groups, per the ERD in
-- docs/quorum-product-document.md §7.
--
--   Accounts & billing  users, credit_transactions
--   Conversation        sessions, rounds, attachments
--   Debate execution    round_models, model_responses
--   Reference data      models, presets, preset_models
--
-- Conventions used throughout:
--   * uuid primary keys, DEFAULT gen_random_uuid()
--   * every timestamp is timestamptz DEFAULT now()
--   * enumerated columns are CHECK constraints, not Postgres enum types, so a
--     value can be added later with ALTER TABLE instead of ALTER TYPE
--   * money: per-call costs are numeric(14,8), wallet balances numeric(12,6)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

-- The model catalogue. Adding a model to Quorum is a row here, never a new
-- adapter — OpenRouter is the single gateway. Models are retired by clearing
-- is_active, never deleted, which is why every model_id FK below is RESTRICT:
-- deleting a model would otherwise erase the history that references it.
CREATE TABLE models (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL,
  openrouter_slug  text NOT NULL UNIQUE,
  display_name     text NOT NULL,
  input_per_1k     numeric(14,8) NOT NULL,
  output_per_1k    numeric(14,8) NOT NULL,
  supports_vision  boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------
-- Accounts & billing
-- ---------------------------------------------------------------------------

-- password_hash and google_id are each nullable — an account may be email-only
-- or Google-only — but users_credential_present makes an account with neither
-- impossible, which would otherwise be an unauthenticatable row.
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE,
  password_hash   text,
  google_id       text UNIQUE,
  display_name    text,
  role            text NOT NULL DEFAULT 'user'
                    CHECK (role IN ('user', 'admin')),
  credit_balance  numeric(12,6) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_credential_present
    CHECK (password_hash IS NOT NULL OR google_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Presets — a saved council line-up
-- ---------------------------------------------------------------------------

CREATE TABLE presets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               text NOT NULL,
  chairman_abstains  boolean NOT NULL DEFAULT true,
  rebuttal_enabled   boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE preset_models (
  preset_id    uuid NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
  model_id     uuid NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  is_chairman  boolean NOT NULL DEFAULT false,

  PRIMARY KEY (preset_id, model_id)
);

-- ---------------------------------------------------------------------------
-- Conversation
-- ---------------------------------------------------------------------------

-- share_token is nullable (sharing is opt-in) and unique. The uniqueness is
-- declared as an index rather than a column constraint so it doubles as the
-- lookup index for GET /api/share/:token — one object, not two.
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title              text,
  chairman_abstains  boolean NOT NULL DEFAULT true,
  rebuttal_enabled   boolean NOT NULL DEFAULT true,
  share_token        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- user_id is denormalised from sessions — see docs/decisions.md, Session 2.
-- The free-tier check counts a user's rounds in the current UTC day and runs
-- before every debate; routing that through sessions makes the hot path a join.
--
-- chairman_abstains and verdict_type are snapshotted per round, not per session,
-- because the council can change mid-conversation and an old round must still
-- show exactly how it ran.
CREATE TABLE rounds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_prompt        text NOT NULL,
  chairman_model_id  uuid NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  chairman_abstains  boolean NOT NULL DEFAULT true,
  verdict_type       text
                       CHECK (verdict_type IN ('picked', 'merged', 'synthesised', 'unanimous')),
  final_answer       text,
  status             text NOT NULL DEFAULT 'drafting'
                       CHECK (status IN ('drafting', 'verdict', 'rebuttal', 'final', 'complete', 'failed')),
  total_cost         numeric(14,8) NOT NULL DEFAULT 0,
  duration_ms        integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- round_id is nullable: POST /api/attachments uploads the file and returns a
-- signed URL before POST /api/sessions/:id/rounds creates the round it belongs
-- to, so the row exists unattached for the length of that window.
CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id      uuid REFERENCES rounds(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_path  text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Debate execution
-- ---------------------------------------------------------------------------

-- The council, snapshotted per round. The composite PK means a model appears at
-- most once per round, so a chairman that does not abstain needs a role that
-- says it did both jobs — hence 'both' alongside 'drafter' and 'chairman'.
--
-- Any query about drafting must therefore use role IN ('drafter', 'both') and
-- any query about judging role IN ('chairman', 'both'). A bare role = 'drafter'
-- silently drops every round in which the chairman also drafted.
CREATE TABLE round_models (
  round_id  uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  model_id  uuid NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  role      text NOT NULL
              CHECK (role IN ('drafter', 'chairman', 'both')),

  PRIMARY KEY (round_id, model_id)
);

-- One row per API call, including calls that failed: a failure carries
-- error_text and no content, and the round continues without it. Cost is
-- recorded from the token counts OpenRouter returns, never estimated, which is
-- what makes the wallet ledger auditable line by line.
--
-- anon_label ('Draft A', 'Draft B', …) is the shuffled identity the chairman
-- sees in stage 2; the real model_id stays on the row but is not sent upstream.
CREATE TABLE model_responses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id           uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  model_id           uuid NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  stage              text NOT NULL
                       CHECK (stage IN ('draft', 'verdict', 'rebuttal', 'final')),
  anon_label         text,
  content            text,
  stance             text
                       CHECK (stance IN ('defend', 'revise', 'concede')),
  prompt_tokens      integer,
  completion_tokens  integer,
  cost               numeric(14,8),
  latency_ms         integer,
  error_text         text,
  created_at         timestamptz NOT NULL DEFAULT now(),

  -- §7 scopes stance to the rebuttal stage; enforce it rather than trust it.
  CONSTRAINT model_responses_stance_is_rebuttal_only
    CHECK (stance IS NULL OR stage = 'rebuttal')
);

-- ---------------------------------------------------------------------------
-- Billing ledger
-- ---------------------------------------------------------------------------

-- round_id is ON DELETE SET NULL, not CASCADE: deleting a session must never
-- destroy financial history. balance_after is stored rather than computed so
-- the ledger is immutable and any past balance is readable without replay.
CREATE TABLE credit_transactions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  round_id           uuid REFERENCES rounds(id) ON DELETE SET NULL,
  type               text NOT NULL
                       CHECK (type IN ('topup', 'debit', 'refund', 'bonus')),
  amount             numeric(14,8) NOT NULL,
  balance_after      numeric(12,6) NOT NULL,
  stripe_payment_id  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX idx_sessions_user_id ON sessions (user_id);
CREATE UNIQUE INDEX idx_sessions_share_token ON sessions (share_token);

CREATE INDEX idx_rounds_session_id ON rounds (session_id);
-- The free-tier check: rounds for one user within the current UTC day.
CREATE INDEX idx_rounds_user_id_created_at ON rounds (user_id, created_at);

CREATE INDEX idx_model_responses_round_id ON model_responses (round_id);
-- Leaderboard aggregates group by model.
CREATE INDEX idx_model_responses_model_id ON model_responses (model_id);

CREATE INDEX idx_credit_transactions_user_id_created_at
  ON credit_transactions (user_id, created_at);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
--
-- Defence in depth. The Supabase Data API is disabled at project level, so
-- nothing reaches these tables over PostgREST today; RLS with zero policies
-- denies everything if that ever changes. The Express connection uses a role
-- that bypasses RLS, so the server is unaffected.

ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE models              ENABLE ROW LEVEL SECURITY;
ALTER TABLE presets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE preset_models       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE rounds              ENABLE ROW LEVEL SECURITY;
ALTER TABLE round_models        ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_responses     ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
