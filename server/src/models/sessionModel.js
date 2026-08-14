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
 *
 * `latest_verdict_type` and `total_spend` are correlated subqueries for the same
 * reason `round_count` is: a join with GROUP BY would make LIMIT apply to the
 * joined rows rather than to sessions, and a five-round session would eat five
 * places on a page of twenty.
 */

/**
 * §8's "filter by verdict", and the definition is a choice rather than a lookup.
 *
 * A session has MANY rounds and each has its own verdict_type, so "sessions with
 * a merged verdict" has at least three readings — any round merged, all rounds
 * merged, the latest round merged. Only the last produces a stable list: `any`
 * puts a session in several filters at once, so the four chips stop partitioning
 * anything and their counts sum to more than the total; `all` makes a session
 * silently leave a filter the moment a follow-up question is asked, which is the
 * one action the sessions page most encourages. The latest round is also what
 * every other column on the row already shows — the verdict chip, the relative
 * time — so filtering on anything else would filter on a value not on screen.
 *
 * So: "sessions whose most recent debate ended this way".
 */
const LATEST_VERDICT_SQL = `
  (SELECT r.verdict_type
     FROM rounds r
    WHERE r.session_id = s.id
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 1)
`;

export async function listSessionsByUser(
  userId,
  { limit, offset, search = null, verdict = null },
  exec = query,
) {
  const { rows } = await exec(
    `
      SELECT ${COLUMNS},
             (SELECT count(*) FROM rounds r WHERE r.session_id = s.id) AS round_count,
             (SELECT coalesce(sum(r.total_cost), 0) FROM rounds r WHERE r.session_id = s.id) AS total_spend,
             ${LATEST_VERDICT_SQL} AS latest_verdict_type
      FROM sessions s
      WHERE s.user_id = $1
        AND ($4::text IS NULL OR s.title ILIKE '%' || $4 || '%')
        AND ($5::text IS NULL OR ${LATEST_VERDICT_SQL} = $5)
      ORDER BY s.updated_at DESC, s.id DESC
      LIMIT $2 OFFSET $3
    `,
    [userId, limit, offset, search, verdict],
  );

  return rows;
}

/** The total the page above is a window onto. Same filters, or the count lies. */
export async function countSessionsByUser(
  userId,
  { search = null, verdict = null } = {},
  exec = query,
) {
  const { rows } = await exec(
    `
      SELECT count(*)::int AS total
      FROM sessions s
      WHERE s.user_id = $1
        AND ($2::text IS NULL OR s.title ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR ${LATEST_VERDICT_SQL} = $3)
    `,
    [userId, search, verdict],
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
 * The public read, and the ONLY query in the product that finds a session by
 * something other than its owner's id.
 *
 * `share_token` is nullable and revoking sets it back to null, so a revoked
 * session simply stops matching — there is no "revoked" state to check for and
 * therefore no way to forget to check it. `= $1` on a null column is null, never
 * true, so a caller passing null cannot match every unshared session in the
 * table; the service refuses an empty token before it gets here as well.
 *
 * Migration 001's unique index on share_token is the lookup index for this, which
 * is why it was declared as an index rather than a column constraint.
 */
export async function findSessionByShareToken(shareToken, exec = query) {
  const { rows } = await exec(`SELECT ${COLUMNS} FROM sessions WHERE share_token = $1`, [
    shareToken,
  ]);

  return rows[0] ?? null;
}

/**
 * Sets or clears the token. `null` revokes.
 *
 * Not COALESCEd like updateSession's columns, because here null is a value the
 * caller means rather than "leave it alone" — revoking IS writing null, and a
 * COALESCE would make DELETE /share silently do nothing.
 */
export async function setSessionShareToken(id, shareToken, exec = query) {
  const { rows } = await exec(
    `
      UPDATE sessions
      SET share_token = $2, updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}
    `,
    [id, shareToken],
  );

  return rows[0] ?? null;
}

/**
 * Sets a title ONLY IF the session does not already have one — the auto-title
 * write, never the rename one (that is `updateSession`, and it always wins).
 *
 * `WHERE title IS NULL` makes this atomic in the database rather than a
 * read-then-write in JS: a user who renames a session in the few seconds
 * between a round starting and finishing must never have that rename
 * clobbered by a title generated from the question that was typed before it.
 * A read-then-write has a race window between the read and the write; this
 * has none, because Postgres evaluates the WHERE clause and performs the SET
 * as one atomic operation.
 */
export async function setTitleIfBlank(id, title, exec = query) {
  const { rows } = await exec(
    `
      UPDATE sessions
      SET title = $2, updated_at = now()
      WHERE id = $1 AND title IS NULL
      RETURNING ${COLUMNS}
    `,
    [id, title],
  );

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
