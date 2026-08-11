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
  created_at
`;

export async function insertRound(
  { sessionId, userId, userPrompt, chairmanModelId, chairmanAbstains, promptVersion },
  exec = query,
) {
  const { rows } = await exec(
    `
      INSERT INTO rounds (
        session_id, user_id, user_prompt, chairman_model_id, chairman_abstains, prompt_version
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING ${COLUMNS}
    `,
    [sessionId, userId, userPrompt, chairmanModelId, chairmanAbstains, promptVersion],
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
