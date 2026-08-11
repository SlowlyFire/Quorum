/**
 * presets and preset_models — a saved council line-up.
 *
 * The FIRST of the three council tables, and the one that applies to nothing
 * until it is loaded. The other two: `session_models` is a session's mutable
 * default, `round_models` the immutable per-round snapshot. Loading a preset
 * copies its rows into one of the others; nothing ever reads a preset to answer
 * a question about a round that has already run.
 *
 * That is why `preset_models.model_id` is ON DELETE RESTRICT like the rest: a
 * retired model still sits in old presets, and deleting the model row would take
 * them with it. The preset service refuses to load a council containing one, the
 * same way a session's does.
 *
 * Rows are returned as Postgres produces them (snake_case). Shaping for the
 * wire is the service layer's job.
 */
import { query } from '../db/pool.js';

const COLUMNS = `
  id,
  user_id,
  name,
  chairman_abstains,
  rebuttal_enabled,
  created_at
`;

export async function insertPreset(
  { userId, name, chairmanAbstains = true, rebuttalEnabled = true },
  exec = query,
) {
  const { rows } = await exec(
    `
      INSERT INTO presets (user_id, name, chairman_abstains, rebuttal_enabled)
      VALUES ($1, $2, $3, $4)
      RETURNING ${COLUMNS}
    `,
    [userId, name, chairmanAbstains, rebuttalEnabled],
  );

  return rows[0];
}

export async function findPresetById(id, exec = query) {
  const { rows } = await exec(`SELECT ${COLUMNS} FROM presets WHERE id = $1`, [id]);

  return rows[0] ?? null;
}

/** Oldest first, so the two seeded at registration stay at the top of the list
 *  and a user's own presets accumulate below them in the order they made them. */
export async function listPresetsByUser(userId, exec = query) {
  const { rows } = await exec(
    `SELECT ${COLUMNS} FROM presets WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );

  return rows;
}

/**
 * A partial update, COALESCEd per column exactly as updateSession is: a key the
 * caller omitted keeps its value. The line-up is not here — it lives in
 * preset_models and is replaced wholesale by the two functions below.
 */
export async function updatePreset(
  id,
  { name = null, chairmanAbstains = null, rebuttalEnabled = null },
  exec = query,
) {
  const { rows } = await exec(
    `
      UPDATE presets
      SET name = COALESCE($2, name),
          chairman_abstains = COALESCE($3, chairman_abstains),
          rebuttal_enabled = COALESCE($4, rebuttal_enabled)
      WHERE id = $1
      RETURNING ${COLUMNS}
    `,
    [id, name, chairmanAbstains, rebuttalEnabled],
  );

  return rows[0] ?? null;
}

export async function deletePreset(id, exec = query) {
  const { rowCount } = await exec(`DELETE FROM presets WHERE id = $1`, [id]);

  return rowCount > 0;
}

// ---------------------------------------------------------------------------
// preset_models
// ---------------------------------------------------------------------------

/**
 * The whole line-up in one statement, through unnest rather than a built-up
 * VALUES list — same reasoning as sessionModelModel and roundModelModel: the row
 * count varies per council, and assembling placeholders by string concatenation
 * is how a parameterised query stops being one.
 */
export async function insertPresetModels(presetId, entries, exec = query) {
  const modelIds = entries.map((entry) => entry.modelId);
  const chairmanFlags = entries.map((entry) => entry.isChairman === true);

  const { rows } = await exec(
    `
      INSERT INTO preset_models (preset_id, model_id, is_chairman)
      SELECT $1, model_id, is_chairman
      FROM unnest($2::uuid[], $3::boolean[]) AS t(model_id, is_chairman)
      RETURNING preset_id, model_id, is_chairman
    `,
    [presetId, modelIds, chairmanFlags],
  );

  return rows;
}

export async function deletePresetModels(presetId, exec = query) {
  const { rowCount } = await exec(`DELETE FROM preset_models WHERE preset_id = $1`, [presetId]);

  return rowCount;
}

/**
 * Every preset's line-up for one user in a single query — the list endpoint
 * renders a card per preset with its models named, and one query per card would
 * be a round trip to Supabase per card.
 *
 * Joined to `models` for the slug, display name and `is_active`, the same three
 * `listSessionModels` needs and for the same reasons: a preset saved before a
 * model was retired must still render, and must be refused when loaded.
 */
export async function listPresetModelsForUser(userId, exec = query) {
  const { rows } = await exec(
    `
      SELECT pm.preset_id,
             pm.model_id,
             pm.is_chairman,
             m.openrouter_slug,
             m.display_name,
             m.provider,
             m.input_per_1k,
             m.output_per_1k,
             m.is_active
      FROM preset_models pm
      JOIN presets p ON p.id = pm.preset_id
      JOIN models m  ON m.id = pm.model_id
      WHERE p.user_id = $1
      ORDER BY pm.preset_id, m.display_name
    `,
    [userId],
  );

  return rows;
}

export async function listPresetModels(presetId, exec = query) {
  const { rows } = await exec(
    `
      SELECT pm.preset_id,
             pm.model_id,
             pm.is_chairman,
             m.openrouter_slug,
             m.display_name,
             m.provider,
             m.input_per_1k,
             m.output_per_1k,
             m.is_active
      FROM preset_models pm
      JOIN models m ON m.id = pm.model_id
      WHERE pm.preset_id = $1
      ORDER BY m.display_name
    `,
    [presetId],
  );

  return rows;
}
