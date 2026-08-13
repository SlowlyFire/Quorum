-- 009 — mark a round as belonging to a named research sample.
--
-- WHY THIS COLUMN EXISTS.
--
-- Session 13's self-preference study selected its 48 rounds as "every completed
-- round the research account owns" — `WHERE r.user_id = $1 AND status =
-- 'complete'`. That predicate is correct exactly until somebody runs anything
-- else under that account, at which point the sample silently grows and the
-- analysis reports a different result with no error and no warning. Session 16
-- came within one instruction of doing precisely that, by aiming 40 rounds of
-- leaderboard volume at the same user.
--
-- A sample defined by "whatever this account happens to own" is fragile
-- whichever account it is. `research_tag` names the sample on the round itself,
-- so membership is a property of the data rather than of who created it.
--
--   NULL                  ordinary product traffic — the overwhelming majority
--   'self-preference-v1'  Session 13's study (docs/self-preference-study.md)
--
-- NOT a reuse of `prompt_version`, which was considered and rejected: that
-- column answers "which template produced this round" and is read by
-- calibrate:estimate and by any future prompt regression. Overloading it would
-- make two unrelated questions share one answer.
--
-- The leaderboard's research exclusion still keys on `users.role` and is NOT
-- changed here (decision 54, leaderboardModel line 93). The two mechanisms
-- answer different questions — "is this account's traffic user behaviour?"
-- versus "which sample is this round part of?" — and a round can need one
-- without the other.

ALTER TABLE rounds ADD COLUMN research_tag text;

-- Partial: research rounds are a rounding error against ordinary traffic, so an
-- index over the whole table would be mostly NULLs nobody queries for.
CREATE INDEX rounds_research_tag_idx ON rounds (research_tag) WHERE research_tag IS NOT NULL;

COMMENT ON COLUMN rounds.research_tag IS
  'Names the research sample this round belongs to. NULL for ordinary product traffic.';

-- Backfill: the study rounds as they stood when this migration was written —
-- every completed round owned by a research-role account. That predicate is the
-- fragile one this column replaces, used here once, deliberately, because it is
-- the only description of the sample that exists before the column does.
UPDATE rounds r
   SET research_tag = 'self-preference-v1'
  FROM users u
 WHERE u.id = r.user_id
   AND u.role = 'research'
   AND r.status = 'complete';

DO $$
DECLARE tagged int;
BEGIN
  SELECT COUNT(*) INTO tagged FROM rounds WHERE research_tag = 'self-preference-v1';
  -- A notice rather than an assertion: 48 is right for this database and 0 is
  -- right for a fresh one, and a migration that refused to run on an empty
  -- database would be worse than one that says what it did.
  RAISE NOTICE 'research_tag backfill: % round(s) tagged self-preference-v1 (48 expected on the live database)', tagged;
END $$;
