/**
 * The leaderboard aggregate — §4's "win rate over rounds drafted".
 *
 * WHY THIS FILE IS NOT NAMED AFTER A TABLE. Every other file in `src/models/` is
 * one table (or, in `presetModel` and `sessionModelModel`, one table and its
 * child). This query reads four — `rounds`, `round_models`, `model_responses`
 * and `models` — and belongs to none of them: its grain is "one model over a
 * window", which is not a row in anything. Putting it in `llmModel.js` because
 * the output is per-model would hide it from the three other tables it actually
 * depends on, and putting it in `roundModel.js` would hide it from the fourth.
 * So it is named for the question. It is still the only place this SQL lives,
 * which is the rule that matters.
 *
 * ---------------------------------------------------------------------------
 * THE THREE TRAPS. All three are conventions in CLAUDE.md, all three are
 * silent when got wrong, and all three are in this query.
 *
 *   1. THE SCORE COMES FROM STAGE 2's `winnerLabels`, NEVER FROM
 *      `rounds.verdict_type`.
 *      Stage 2 is the blind evaluation: the chairman sees the drafts
 *      anonymised and shuffled, and picks on the answer alone. Stage 4 rules
 *      again after the rebuttals, and frequently returns `unanimous` once every
 *      drafter has conceded — three of four rounds in Session 6 did. Scoring
 *      from `rounds.verdict_type` would therefore erase the fact that a model
 *      won stage 2 and record a decisive round as a draw. `rounds.verdict_type`
 *      stays as the user-facing outcome of the debate; it is not a measurement
 *      of a model. (Decisions 20 and 26.)
 *
 *      Reading stage 2 has a trap of its own: a chairman stage may have TWO
 *      `model_responses` rows, because a retried parse failure is persisted
 *      alongside the attempt that succeeded. The row that counts is the LAST
 *      one for the stage whose `error_text` is null — hence the DISTINCT ON …
 *      ORDER BY created_at DESC in `verdicts` below, not "the row for that
 *      stage".
 *
 *   2. THE DRAFTING DENOMINATOR IS `role IN ('drafter', 'both')`, NEVER
 *      `role = 'drafter'`.
 *      `round_models.role` is three-valued because the composite primary key
 *      lets a model appear once per round, so a chairman that does not abstain
 *      needs a role saying it did both jobs. A bare equality silently excludes
 *      every round in which the chairman also drafted — the model's real drafts,
 *      scored against a smaller denominator, which inflates its win rate. On
 *      this database today that is the difference between 11 drafts and 7 for
 *      Claude Haiku 4.5, and nothing about the output says so.
 *
 * The denominator is `round_models`, not the draft rows: a drafter whose call
 * failed was still seated to draft and still failed to win, and dropping it
 * would score a model that errors out as though the round never happened.
 *
 *   3. `is_active = false` KEEPS ITS DRAFTED ROWS, AND WITHOUT A FILTER THAT
 *      MEANS IT KEEPS A SEAT ON THE BOARD.
 *      `model_id` on `round_models` and `model_responses` is RESTRICT, never
 *      CASCADE, precisely so retiring a model cannot orphan a round's history —
 *      which means a retired model's rows are still here for this query to
 *      find. Deactivating a model turns off the council picker, not the
 *      leaderboard; the `WHERE m.is_active = true` at the end of the main
 *      SELECT is what has to do the second job, and it does it once, for
 *      every user-facing slice of this result (ranked, unranked, the podium)
 *      at once. Found via "Ghost Model (test)" — the deliberately unroutable
 *      Session 8 fixture, one drafted round that always fails — sitting in the
 *      unranked list, below the five-draft line but still visible.
 * ---------------------------------------------------------------------------
 *
 * ONE QUERY, NOT A LOOP OVER MODELS. Six CTEs and a single grouped select, so
 * the window is scanned once regardless of how many models are in the
 * catalogue and a new model costs no extra round trip.
 */
import { query } from '../db/pool.js';

/**
 * `outcome` in `scored` is the whole of §4's scoring table, as three integers:
 *
 *   0  no win — the label is absent from winner_labels, or the chairman
 *      synthesised its own answer (no winner, and §4 still counts the round as
 *      drafted), or this model's draft call failed so it has no label at all.
 *   1  sole winner — §4's "chairman picks one draft", worth 1.0.
 *   2  shared winner — §4's "chairman merges two drafts", worth 0.5 each.
 *
 * Note what decides between 1 and 2: the LENGTH of `winner_labels`, not stage
 * 2's `verdictType`. A chairman that answers `unanimous` at stage 2 with two
 * labels has named two winners, and that is a shared win however it worded the
 * verdict — the labels are the evaluation, the word is the summary.
 */
const LEADERBOARD_SQL = `
  WITH scope_rounds AS (
    SELECT r.id
    FROM rounds r
    JOIN users u ON u.id = r.user_id
    WHERE r.status = 'complete'
      AND r.created_at >= now() - make_interval(days => $2::int)
      -- scope=all passes NULL and reads every user's rounds; scope=mine passes
      -- the signed-in user's id. One query, one optional filter (§4).
      AND ($1::uuid IS NULL OR r.user_id = $1::uuid)
      /**
       * RESEARCH ROUNDS ARE OUT OF scope=all AND IN scope=mine.
       *
       * Session 13's self-preference study runs 48 real debates through this
       * engine under one deliberately unusual configuration — the chairman
       * drafts every time, every council is three models. They are real rounds
       * and they stay inspectable, but they are not user behaviour, and at 144
       * drafted seats against the ~139 the board had they would swamp it.
       *
       * The filter is skipped when a user id is supplied, so the account that
       * owns them still sees them under "My council". See migration 008.
       */
      AND ($1::uuid IS NOT NULL OR u.role <> 'research')
  ),

  -- TRAP 2. The denominator: every model seated to draft, whether or not its
  -- call succeeded, and including the chairman when it did not abstain.
  drafted AS (
    SELECT rm.round_id, rm.model_id
    FROM round_models rm
    JOIN scope_rounds sr ON sr.id = rm.round_id
    WHERE rm.role IN ('drafter', 'both')
  ),

  -- The anonymous label a model drafted under, plus what that call cost and how
  -- long it took. One row per (round, model); DISTINCT ON is belt and braces —
  -- a drafter is called once per round — and costs nothing.
  draft_calls AS (
    SELECT DISTINCT ON (mr.round_id, mr.model_id)
           mr.round_id,
           mr.model_id,
           mr.anon_label,
           mr.cost,
           mr.latency_ms
    FROM model_responses mr
    JOIN drafted d ON d.round_id = mr.round_id AND d.model_id = mr.model_id
    WHERE mr.stage = 'draft'
      AND mr.error_text IS NULL
    ORDER BY mr.round_id, mr.model_id, mr.created_at DESC, mr.id DESC
  ),

  -- TRAP 1. Stage 2's blind evaluation, and the LAST usable row for it: a
  -- retried parse failure is persisted beside the attempt that worked.
  verdicts AS (
    SELECT DISTINCT ON (mr.round_id)
           mr.round_id,
           (mr.content::jsonb) -> 'winnerLabels' AS winner_labels
    FROM model_responses mr
    JOIN scope_rounds sr ON sr.id = mr.round_id
    WHERE mr.stage = 'verdict'
      AND mr.error_text IS NULL
      AND mr.content IS NOT NULL
    ORDER BY mr.round_id, mr.created_at DESC, mr.id DESC
  ),

  -- One row per drafted (round, model), carrying §4's scoring table as an int.
  scored AS (
    SELECT d.model_id,
           dc.cost,
           dc.latency_ms,
           CASE
             -- No label: the draft call failed. Seated, counted, did not win.
             WHEN dc.anon_label IS NULL THEN 0
             -- No parseable stage-2 verdict for this round: nobody scores. The
             -- jsonb_typeof guard is what stops a malformed row throwing rather
             -- than scoring zero.
             WHEN v.winner_labels IS NULL
               OR jsonb_typeof(v.winner_labels) <> 'array' THEN 0
             WHEN NOT (v.winner_labels @> to_jsonb(dc.anon_label)) THEN 0
             WHEN jsonb_array_length(v.winner_labels) = 1 THEN 1
             ELSE 2
           END AS outcome
    FROM drafted d
    LEFT JOIN draft_calls dc
      ON dc.round_id = d.round_id AND dc.model_id = d.model_id
    LEFT JOIN verdicts v
      ON v.round_id = d.round_id
  ),

  -- §4: "Model concedes during rebuttal — recorded separately as concession
  -- rate." Its own CTE because its denominator is rebuttals made, not rounds
  -- drafted: stage 3 is skipped on a unanimous verdict and when a session has
  -- rebuttals off, so dividing concessions by drafts would report a model that
  -- was never asked as one that never conceded.
  rebuttals AS (
    SELECT mr.model_id,
           count(*)::int AS rebuttals,
           count(*) FILTER (WHERE mr.stance = 'concede')::int AS conceded
    FROM model_responses mr
    JOIN scope_rounds sr ON sr.id = mr.round_id
    WHERE mr.stage = 'rebuttal'
      AND mr.error_text IS NULL
      AND mr.stance IS NOT NULL
    GROUP BY mr.model_id
  )

  SELECT m.id                                                   AS model_id,
         m.display_name,
         m.provider,
         m.openrouter_slug,
         count(*)::int                                          AS drafts,
         count(*) FILTER (WHERE s.outcome = 1)::int             AS wins,
         count(*) FILTER (WHERE s.outcome = 2)::int             AS merged,
         (count(*) FILTER (WHERE s.outcome = 1)
           + 0.5 * count(*) FILTER (WHERE s.outcome = 2))       AS score,
         coalesce(rb.rebuttals, 0)                              AS rebuttals,
         coalesce(rb.conceded, 0)                               AS conceded,
         -- avg() skips NULLs, so a failed draft counts in the drafts column and
         -- is out of these two — which is right: it cost what it cost and took
         -- no measurable time to produce nothing.
         avg(s.cost)                                            AS avg_cost,
         avg(s.latency_ms)                                      AS avg_latency
  FROM scored s
  JOIN models m ON m.id = s.model_id
  LEFT JOIN rebuttals rb ON rb.model_id = s.model_id
  -- Retired models keep their drafted rows forever (model_id is RESTRICT, never
  -- CASCADE, precisely so model_responses never dangles) but stop being seated,
  -- so their only path onto the board is the unranked list, sitting below the
  -- five-draft line with a handful of old drafts. "Ghost Model (test)" — the
  -- deliberately unroutable fixture from Session 8, is_active = false since the
  -- round that proved a failing drafter degrades gracefully — is exactly that
  -- shape. This filter is why it does not appear there, or anywhere else this
  -- query feeds: ranked and the podium are both slices of the same rows.
  WHERE m.is_active = true
  GROUP BY m.id, m.display_name, m.provider, m.openrouter_slug,
           rb.rebuttals, rb.conceded
  -- Win rate first, per §4 — "never raw wins, otherwise whichever model is
  -- toggled on most often wins by default". Drafts break the tie, so between
  -- two models at the same rate the better-evidenced one ranks higher.
  ORDER BY (count(*) FILTER (WHERE s.outcome = 1)
             + 0.5 * count(*) FILTER (WHERE s.outcome = 2)) / count(*) DESC,
           count(*) DESC,
           m.display_name ASC
`;

/**
 * @param {{ userId?: string | null, days?: number }} options
 *   `userId` null is §4's "All time" — every user's rounds.
 * @returns rows in snake_case, ordered by win rate. Shaping for the wire is the
 *   service's job, as everywhere else in this directory.
 */
export async function aggregateLeaderboard({ userId = null, days = 30 }, exec = query) {
  const { rows } = await exec(LEADERBOARD_SQL, [userId, days]);

  return rows;
}

/**
 * The same query under EXPLAIN, for `npm run verify:leaderboard`. Exported
 * rather than reachable over HTTP: a plan names tables, row counts and index
 * choices, which is operational detail and not something an endpoint should
 * hand out.
 */
export async function explainLeaderboard({ userId = null, days = 30 }, exec = query) {
  const { rows } = await exec(`EXPLAIN (ANALYZE, BUFFERS) ${LEADERBOARD_SQL}`, [userId, days]);

  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

/**
 * THE PROOF OF TRAP 2, and the reason it is in this file rather than in the
 * verification script: the wrong query has to live next to the right one, or
 * the next person to write a leaderboard query writes the wrong one again.
 *
 * Identical to `drafted` above except for the predicate, so the two denominators
 * can be compared per model. `verify:leaderboard` prints them side by side and
 * asserts they differ wherever a chairman drafted.
 */
export async function draftDenominatorComparison({ userId = null, days = 30 }, exec = query) {
  const { rows } = await exec(
    `
      WITH scope_rounds AS (
        SELECT r.id
        FROM rounds r
        JOIN users u ON u.id = r.user_id
        WHERE r.status = 'complete'
          AND r.created_at >= now() - make_interval(days => $2::int)
          AND ($1::uuid IS NULL OR r.user_id = $1::uuid)
          -- Same research exclusion as the main query, for the same reason:
          -- the two denominators have to be comparable to the board's.
          AND ($1::uuid IS NOT NULL OR u.role <> 'research')
      )
      SELECT m.display_name,
             count(*) FILTER (WHERE rm.role IN ('drafter', 'both'))::int AS drafts_correct,
             count(*) FILTER (WHERE rm.role = 'drafter')::int            AS drafts_bare_equality,
             count(*) FILTER (WHERE rm.role = 'both')::int               AS also_chairman
      FROM round_models rm
      JOIN scope_rounds sr ON sr.id = rm.round_id
      JOIN models m ON m.id = rm.model_id
      GROUP BY m.id, m.display_name
      HAVING count(*) FILTER (WHERE rm.role IN ('drafter', 'both')) > 0
      ORDER BY drafts_correct DESC
    `,
    [userId, days],
  );

  return rows;
}
