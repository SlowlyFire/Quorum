import pg from 'pg';

import { env, isDevelopment } from '../config/env.js';

const { Pool } = pg;

/**
 * One pool for the whole process. Supabase terminates non-SSL connections, and
 * its pooler presents a certificate that does not chain to a root Node ships
 * with, so verification is disabled while the transport stays encrypted.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (error) => {
  console.error(`[db] idle client error: ${error.message}`);
});

/**
 * Every query goes through here so timings are visible in development.
 * Models own the SQL; nothing outside src/models should call this, with
 * src/db/migrate.js the one exception.
 */
export async function query(text, params) {
  const startedAt = process.hrtime.bigint();
  const result = await pool.query(text, params);

  if (isDevelopment) {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const sql = text.replace(/\s+/g, ' ').trim();
    console.log(`[db] ${durationMs.toFixed(1)}ms rows=${result.rowCount ?? 0} :: ${sql}`);
  }

  return result;
}

/**
 * Several writes, or none. The callback is handed an executor with the same
 * (text, params) shape as `query` above, so any model function can be run
 * inside the transaction simply by passing it as that function's last argument
 * — which is exactly why every model takes the executor last.
 *
 *   await withTransaction(async (exec) => {
 *     await deleteSessionModels(id, exec);
 *     await insertSessionModels(id, entries, exec);
 *   });
 *
 * BEGIN/COMMIT/ROLLBACK is the one SQL that lives outside src/models/. It is
 * transaction control rather than a statement against an application table, and
 * putting it in a model would mean picking a table it does not belong to.
 */
export async function withTransaction(run) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await run((text, params) => client.query(text, params));
    await client.query('COMMIT');

    return result;
  } catch (error) {
    // Best effort: if the rollback itself fails the connection is already lost,
    // and the original error is the one that explains what happened.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(`[db] rollback failed: ${rollbackError.message}`);
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
