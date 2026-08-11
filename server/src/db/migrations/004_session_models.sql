-- 004_session_models.sql
--
-- The council a session defaults to. §7's ERD has no table for it, but §4's
-- second use case and §6 both describe a council belonging to a session and
-- changeable mid-conversation — so this is a gap in the diagram rather than a
-- deviation from it. Recorded in docs/decisions.md 22.
--
-- Three tables now hold a council, at three different lifetimes, and confusing
-- them is the trap this comment exists to prevent:
--
--   preset_models   a reusable template the user saved. Applies to nothing
--                   until it is loaded into a session.
--   session_models  the session default. Mutable: PATCH /api/sessions/:id
--                   replaces it, and every LATER round picks it up.
--   round_models    the immutable per-round snapshot the engine writes. Never
--                   updated after the round is created, which is what lets an
--                   old round still show exactly who debated in it.
--
-- Shaped to match preset_models exactly — same composite primary key, same
-- is_chairman flag, same ON DELETE pairing — because they are the same idea at
-- two lifetimes and a reader who has understood one should not have to read the
-- other.

CREATE TABLE session_models (
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  model_id     uuid NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  is_chairman  boolean NOT NULL DEFAULT false,

  -- A model sits on a council at most once. The engine's planCouncil refuses a
  -- duplicate before it spends anything; this makes it unrepresentable.
  PRIMARY KEY (session_id, model_id)
);

-- The composite primary key already indexes session_id as its leading column,
-- so the "council for this session" lookup is covered. model_id is not, which
-- matches preset_models and every other RESTRICT-ed model FK in 001.

-- Defence in depth, uniformly with every other table: RLS on, zero policies.
-- The Express connection uses a role that bypasses RLS, so the server is
-- unaffected; anything arriving over PostgREST is denied.
ALTER TABLE session_models ENABLE ROW LEVEL SECURITY;
