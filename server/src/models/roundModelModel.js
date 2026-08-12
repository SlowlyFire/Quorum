/**
 * round_models table — the council, snapshotted per round.
 *
 * `role` is three-valued: 'drafter', 'chairman', or 'both'. The composite
 * primary key means a model appears at most once per round, so a chairman that
 * does not abstain has no second row available to say it drafted as well —
 * 'both' is what makes that line-up representable.
 *
 * Any query about drafting must use role IN ('drafter', 'both'); any query about
 * judging, role IN ('chairman', 'both'). A bare role = 'drafter' silently drops
 * every round in which the chairman also drafted, which is precisely the
 * population the leaderboard's win-rate denominator counts.
 *
 * The two reads below join the modality flags as well as the name and slug.
 * They are catalogue facts rather than round facts — a model that gained vision
 * last week gained it for old rounds too — but they travel with the council
 * because that is what lets a reader of a persisted round work out which member
 * could not see the attachment, without the catalogue and without a column
 * recording it per round.
 */
import { query } from '../db/pool.js';

/**
 * The whole council in one statement. Two parallel arrays through unnest rather
 * than a built-up VALUES list: the row count varies per round, and building
 * placeholders by string concatenation is how a parameterised query stops being
 * one.
 */
export async function insertRoundModels(roundId, entries, exec = query) {
  const modelIds = entries.map((entry) => entry.modelId);
  const roles = entries.map((entry) => entry.role);

  const { rows } = await exec(
    `
      INSERT INTO round_models (round_id, model_id, role)
      SELECT $1, model_id, role
      FROM unnest($2::uuid[], $3::text[]) AS t(model_id, role)
      RETURNING round_id, model_id, role
    `,
    [roundId, modelIds, roles],
  );

  return rows;
}

export async function listRoundModels(roundId, exec = query) {
  const { rows } = await exec(
    `
      SELECT rm.round_id, rm.model_id, rm.role, m.display_name, m.openrouter_slug,
             m.supports_vision, m.supports_documents
      FROM round_models rm
      JOIN models m ON m.id = rm.model_id
      WHERE rm.round_id = $1
      ORDER BY m.display_name
    `,
    [roundId],
  );

  return rows;
}

/**
 * Every round's council across a whole session, for GET /api/sessions/:id —
 * one query rather than one per round. Callers group by round_id.
 */
export async function listRoundModelsBySession(sessionId, exec = query) {
  const { rows } = await exec(
    `
      SELECT rm.round_id, rm.model_id, rm.role, m.display_name, m.openrouter_slug,
             m.supports_vision, m.supports_documents
      FROM round_models rm
      JOIN rounds r ON r.id = rm.round_id
      JOIN models m ON m.id = rm.model_id
      WHERE r.session_id = $1
      ORDER BY rm.round_id, m.display_name
    `,
    [sessionId],
  );

  return rows;
}
