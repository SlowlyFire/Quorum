/**
 * session_models table — the council a session defaults to.
 *
 * The middle of three lifetimes, and the distinction matters on every read:
 *
 *   preset_models   a saved template, applying to nothing until it is loaded
 *   session_models  the session default — mutable, and picked up by every
 *                   round created AFTER it changes
 *   round_models    the immutable snapshot the engine writes per round
 *
 * Changing a session's council therefore rewrites this table and leaves every
 * existing round_models row untouched. That is the whole point of having two.
 */
import { query } from '../db/pool.js';

/**
 * The whole council in one statement, through unnest rather than a built-up
 * VALUES list — same reasoning as roundModelModel: the row count varies per
 * council, and assembling placeholders by string concatenation is how a
 * parameterised query stops being one.
 */
export async function insertSessionModels(sessionId, entries, exec = query) {
  const modelIds = entries.map((entry) => entry.modelId);
  const chairmanFlags = entries.map((entry) => entry.isChairman === true);

  const { rows } = await exec(
    `
      INSERT INTO session_models (session_id, model_id, is_chairman)
      SELECT $1, model_id, is_chairman
      FROM unnest($2::uuid[], $3::boolean[]) AS t(model_id, is_chairman)
      RETURNING session_id, model_id, is_chairman
    `,
    [sessionId, modelIds, chairmanFlags],
  );

  return rows;
}

/**
 * Joined to `models` because every caller needs the slug to call OpenRouter and
 * the display name to show a user, `is_active` to refuse a council whose member
 * has been retired since the session was created, and the two prices to quote
 * the round before it is allowed to start (Session 9's pre-flight check).
 *
 * Ordered by display_name for a stable list; the engine shuffles its drafters
 * itself, so no ordering here can leak into what a chairman sees.
 */
export async function listSessionModels(sessionId, exec = query) {
  const { rows } = await exec(
    `
      SELECT sm.session_id,
             sm.model_id,
             sm.is_chairman,
             m.openrouter_slug,
             m.display_name,
             m.provider,
             m.input_per_1k,
             m.output_per_1k,
             m.is_active
      FROM session_models sm
      JOIN models m ON m.id = sm.model_id
      WHERE sm.session_id = $1
      ORDER BY m.display_name
    `,
    [sessionId],
  );

  return rows;
}

/**
 * Replacing a council is this followed by insertSessionModels, and the two must
 * share a transaction executor: a failure between them would leave a session
 * with no council at all, which is a state no round can start from.
 */
export async function deleteSessionModels(sessionId, exec = query) {
  const { rowCount } = await exec(`DELETE FROM session_models WHERE session_id = $1`, [sessionId]);

  return rowCount;
}

/**
 * Every council in one query, for the session list — one round trip instead of
 * one per session. Callers group by session_id.
 */
export async function listSessionModelsForSessions(sessionIds, exec = query) {
  const { rows } = await exec(
    `
      SELECT sm.session_id,
             sm.model_id,
             sm.is_chairman,
             m.openrouter_slug,
             m.display_name,
             m.provider,
             m.is_active
      FROM session_models sm
      JOIN models m ON m.id = sm.model_id
      WHERE sm.session_id = ANY($1::uuid[])
      ORDER BY sm.session_id, m.display_name
    `,
    [sessionIds],
  );

  return rows;
}
