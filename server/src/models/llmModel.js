/**
 * models table — the OpenRouter model catalogue.
 *
 * Named llmModel rather than modelModel; the table is `models` but a file
 * called modelModel.js in a models/ directory reads as a typo.
 *
 * Rows are returned as Postgres produces them (snake_case). Shaping for the
 * wire is the service layer's job.
 */
import { query } from '../db/pool.js';

const COLUMNS = `
  id,
  provider,
  openrouter_slug,
  display_name,
  input_per_1k,
  output_per_1k,
  supports_vision,
  is_active
`;

/**
 * Every model function takes the query executor last, defaulting to the pool
 * helper. Passing a transaction client's query instead is what lets a debate
 * round debit the wallet and write its responses atomically.
 */

export async function listActiveModels(exec = query) {
  const { rows } = await exec(`
    SELECT ${COLUMNS}
    FROM models
    WHERE is_active = true
    ORDER BY provider, display_name
  `);

  return rows;
}

export async function findModelById(id, exec = query) {
  const { rows } = await exec(
    `SELECT ${COLUMNS} FROM models WHERE id = $1`,
    [id],
  );

  return rows[0] ?? null;
}

export async function findModelBySlug(openrouterSlug, exec = query) {
  const { rows } = await exec(
    `SELECT ${COLUMNS} FROM models WHERE openrouter_slug = $1`,
    [openrouterSlug],
  );

  return rows[0] ?? null;
}

/**
 * Resolves a whole council in one round trip. The caller compares the returned
 * length against the requested one to detect an id that is unknown or retired.
 */
export async function findActiveModelsByIds(ids, exec = query) {
  const { rows } = await exec(
    `
      SELECT ${COLUMNS}
      FROM models
      WHERE id = ANY($1::uuid[])
        AND is_active = true
      ORDER BY provider, display_name
    `,
    [ids],
  );

  return rows;
}
