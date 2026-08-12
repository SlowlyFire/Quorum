-- 008_research_role.sql
--
-- A third kind of account: 'research'.
--
-- Session 13 measures self-preference by running 48 real debates through the
-- real engine, under a deliberately unusual configuration — the chairman drafts
-- in every one of them, and every council is exactly three models. Those rounds
-- have to be REAL (the whole point is that the measurement describes the
-- product, not a lab variant of it) and they have to be inspectable afterwards,
-- which means they live in `rounds` like everything else.
--
-- But they are not user behaviour, and the leaderboard is a summary of user
-- behaviour. 48 rounds x 3 drafted seats is 144 seats against the ~139 the
-- board had before this migration, every one of them with the chairman also
-- drafting — so left alone they would more than double the sample and swamp it
-- with one configuration nobody chose.
--
-- Hence a role rather than a hardcoded user id or a magic session title:
-- `scope=all` on the leaderboard excludes rounds belonging to research accounts,
-- and `scope=mine` does not, so the rounds stay visible to whoever owns them.
-- See leaderboardModel.

ALTER TABLE users DROP CONSTRAINT users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
    CHECK (role IN ('user', 'admin', 'research'));

COMMENT ON COLUMN users.role IS
  'user | admin | research. A research account owns rounds produced by a measurement script: real debates, inspectable, and excluded from the leaderboard''s scope=all because they are not user behaviour.';
