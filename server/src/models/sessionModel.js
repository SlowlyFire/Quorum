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
 * One page of a user's sessions, newest activity first.
 *
 * Ordered by updated_at rather than created_at: touchSession moves it on every
 * round, so this is "most recently debated in", which is what a conversation
 * list means. `id` breaks the tie so the order is total — two sessions created
 * in the same millisecond must not swap places between pages.
 *
 * round_count comes from a correlated subquery rather than a join with GROUP BY
 * so that LIMIT applies to sessions, not to the joined rows.
 *
 * `search` is §8's "List (search…)": an untrimmed empty string is treated as
 * absent, so `?search=` lists everything rather than nothing.
 */
export async function listSessionsByUser(userId, { limit, offset, search = null }, exec = query) {
  const { rows } = await exec(
    `
      SELECT ${COLUMNS},
             (SELECT count(*) FROM rounds r WHERE r.session_id = s.id) AS round_count
      FROM sessions s
      WHERE s.user_id = $1
        AND ($4::text IS NULL OR s.title ILIKE '%' || $4 || '%')
      ORDER BY s.updated_at DESC, s.id DESC
      LIMIT $2 OFFSET $3
    `,
    [userId, limit, offset, search],
  );

  return rows;
}

/** The total the page above is a window onto. Same filter, or the count lies. */
export async function countSessionsByUser(userId, { search = null } = {}, exec = query) {
  const { rows } = await exec(
    `
      SELECT count(*)::int AS total
      FROM sessions s
      WHERE s.user_id = $1
        AND ($2::text IS NULL OR s.title ILIKE '%' || $2 || '%')
    `,
    [userId, search],
  );

  return rows[0].total;
}

/**
 * A partial update. Every field is COALESCEd against its own column, so a key
 * the caller omitted keeps its current value rather than being nulled — the
 * service passes null for "not supplied", which is why `title` cannot be
 * cleared back to null through here. Nothing in §8 asks to clear a title.
 *
 * updated_at moves too: renaming a session is activity on it.
 */
export async function updateSession(
  id,
  { title = null, chairmanAbstains = null, rebuttalEnabled = null },
  exec = query,
) {
  const { rows } = await exec(
    `
      UPDATE sessions
      SET title = COALESCE($2, title),
          chairman_abstains = COALESCE($3, chairman_abstains),
          rebuttal_enabled = COALESCE($4, rebuttal_enabled),
          updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}
    `,
    [id, title, chairmanAbstains, rebuttalEnabled],
  );

  return rows[0] ?? null;
}

/**
 * Cascades to rounds, round_models, model_responses, attachments and
 * session_models. credit_transactions.round_id is ON DELETE SET NULL, so the
 * ledger survives — deleting a conversation must never destroy the record of
 * what it was billed.
 */
export async function deleteSession(id, exec = query) {
  const { rowCount } = await exec(`DELETE FROM sessions WHERE id = $1`, [id]);

  return rowCount > 0;
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
