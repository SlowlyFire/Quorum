/**
 * rounds table — one four-stage debate.
 *
 * A round moves through `status` in one direction: drafting -> verdict ->
 * rebuttal -> final -> complete, or out to failed from anywhere. The engine owns
 * that progression; this file only writes what it is told.
 */
import { query } from '../db/pool.js';

const COLUMNS = `
  id,
  session_id,
  user_id,
  user_prompt,
  chairman_model_id,
  chairman_abstains,
  verdict_type,
  final_answer,
  open_questions,
  status,
  total_cost,
  duration_ms,
  prompt_version,
  research_tag,
  created_at
`;

/**
 * `researchTag` defaults to null, which is every caller in the product: an
 * ordinary round belongs to no sample. Only `measure:self-preference` passes
 * one, and it passes it HERE — at insert, in the same statement as the round
 * itself — rather than updating the row afterwards. A round tagged a moment
 * later is a round that is untagged if the process dies in between, and an
 * untagged study round is invisible to the analysis AND to the "which cells are
 * already done" check, so the next run would silently repeat it (migration 009).
 */
export async function insertRound(
  { sessionId, userId, userPrompt, chairmanModelId, chairmanAbstains, promptVersion, researchTag = null },
  exec = query,
) {
  const { rows } = await exec(
    `
      INSERT INTO rounds (
        session_id, user_id, user_prompt, chairman_model_id, chairman_abstains, prompt_version,
        research_tag
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING ${COLUMNS}
    `,
    [sessionId, userId, userPrompt, chairmanModelId, chairmanAbstains, promptVersion, researchTag],
  );

  return rows[0];
}

export async function findRoundById(id, exec = query) {
  const { rows } = await exec(`SELECT ${COLUMNS} FROM rounds WHERE id = $1`, [id]);

  return rows[0] ?? null;
}

export async function listRoundsBySession(sessionId, exec = query) {
  const { rows } = await exec(
    `SELECT ${COLUMNS} FROM rounds WHERE session_id = $1 ORDER BY created_at`,
    [sessionId],
  );

  return rows;
}

/** Stage transitions. The CHECK constraint rejects anything not in the enum. */
export async function updateRoundStatus(id, status, exec = query) {
  const { rows } = await exec(
    `UPDATE rounds SET status = $2 WHERE id = $1 RETURNING id, status`,
    [id, status],
  );

  return rows[0] ?? null;
}

/**
 * Stage 2 records the verdict it reached as it happens, rather than waiting for
 * stage 4 to overwrite it. A round that dies in stage 3 or 4 has still reached a
 * verdict, and a failed row that shows which one is far easier to explain than a
 * null.
 */
export async function setRoundVerdict(id, { verdictType, status }, exec = query) {
  const { rows } = await exec(
    `UPDATE rounds SET verdict_type = $2, status = $3 WHERE id = $1
     RETURNING id, verdict_type, status`,
    [id, verdictType, status],
  );

  return rows[0] ?? null;
}

export async function completeRound(
  { id, verdictType, finalAnswer, openQuestions, totalCost, durationMs },
  exec = query,
) {
  const { rows } = await exec(
    `
      UPDATE rounds
      SET verdict_type = $2,
          final_answer = $3,
          open_questions = $4,
          total_cost = $5,
          duration_ms = $6,
          status = 'complete'
      WHERE id = $1
      RETURNING ${COLUMNS}
    `,
    [id, verdictType, finalAnswer, openQuestions, totalCost, durationMs],
  );

  return rows[0] ?? null;
}

/**
 * Cost and duration are written on the way out even though the round produced no
 * answer: the calls that ran before it died were still billed, and a failed
 * round with total_cost 0 would understate what the debate actually spent.
 */
export async function failRound({ id, totalCost, durationMs }, exec = query) {
  const { rows } = await exec(
    `
      UPDATE rounds
      SET status = 'failed', total_cost = $2, duration_ms = $3
      WHERE id = $1
      RETURNING ${COLUMNS}
    `,
    [id, totalCost, durationMs],
  );

  return rows[0] ?? null;
}

/**
 * THE FREE TIER, AND IT IS A QUERY RATHER THAN A COUNTER.
 *
 * §3 gives an empty wallet two debates in the current UTC day. Nothing stores
 * that number: no `users.free_rounds_used`, no nightly reset, no cron. The
 * rounds themselves are the count, so there is nothing to reset and nothing
 * that can drift out of sync with what actually ran — a stored counter is
 * wrong the first time a row is deleted or an insert is rolled back, and wrong
 * silently.
 *
 * `date_trunc('day', now() AT TIME ZONE 'utc')` is a UTC midnight boundary
 * expressed as a naive timestamp, so it is compared against created_at
 * converted the same way. UTC and not the user's timezone because "two per day"
 * has to mean the same thing everywhere and must not give a traveller a third
 * debate by flying west.
 *
 * `idx_rounds_user_id_created_at` from migration 001 is the index for exactly
 * this, and its comment there says so.
 *
 * Every round counts, including one that failed. A failed round still made the
 * calls it made and we were still billed for them, so exempting it would let a
 * user spend without limit on rounds that break — and the count is the only
 * thing standing between an empty wallet and our OpenRouter bill.
 */
/**
 * What a round has actually cost this user lately, for the wallet's
 * "~ N more debates at your current council".
 *
 * Their own recent rounds rather than a quote over the catalogue, because the
 * question is about *their* council and their questions — a user debating two
 * cheap models gets a very different number from one running four, and both
 * are already recorded. Rounds that cost nothing are excluded: a council that
 * was refused before stage 1 says nothing about what the next one will cost.
 *
 * Returns null when they have never run one, which is the caller's cue to fall
 * back on the pre-flight estimate.
 */
export async function averageRoundCostForUser(userId, sampleSize = 20, exec = query) {
  const { rows } = await exec(
    `
      SELECT avg(total_cost)::numeric(14,8) AS average
      FROM (
        SELECT total_cost
        FROM rounds
        WHERE user_id = $1 AND total_cost > 0
        ORDER BY created_at DESC
        LIMIT $2
      ) recent
    `,
    [userId, sampleSize],
  );

  return rows[0].average === null ? null : Number(rows[0].average);
}

export async function countRoundsForUserToday(userId, exec = query) {
  const { rows } = await exec(
    `
      SELECT count(*)::int AS count
      FROM rounds
      WHERE user_id = $1
        AND (created_at AT TIME ZONE 'utc') >= date_trunc('day', now() AT TIME ZONE 'utc')
    `,
    [userId],
  );

  return rows[0].count;
}
