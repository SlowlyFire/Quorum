/**
 * sessions table — one conversation, holding many rounds.
 *
 * Rows are returned as Postgres produces them (snake_case). Shaping for the
 * wire is the service layer's job.
 */
import { query } from '../db/pool.js';

const COLUMNS = `
  id,
  user_id,
  title,
  chairman_abstains,
  rebuttal_enabled,
  share_token,
  created_at,
  updated_at
`;

export async function insertSession(
  { userId, title = null, chairmanAbstains = true, rebuttalEnabled = true },
  exec = query,
) {
  const { rows } = await exec(
    `
      INSERT INTO sessions (user_id, title, chairman_abstains, rebuttal_enabled)
      VALUES ($1, $2, $3, $4)
      RETURNING ${COLUMNS}
    `,
    [userId, title, chairmanAbstains, rebuttalEnabled],
  );

  return rows[0];
}

export async function findSessionById(id, exec = query) {
  const { rows } = await exec(`SELECT ${COLUMNS} FROM sessions WHERE id = $1`, [id]);

  return rows[0] ?? null;
}

/**
 * `sessions.updated_at` has existed since migration 001 with nothing maintaining
 * it — Session 2 flagged that whichever service first mutated a session would
 * have to set it. Starting a round is that mutation: it is what "last activity"
 * on a conversation means, and the session list in §8 is ordered by it.
 */
export async function touchSession(id, exec = query) {
  const { rows } = await exec(
    `UPDATE sessions SET updated_at = now() WHERE id = $1 RETURNING id, updated_at`,
    [id],
  );

  return rows[0] ?? null;
}
