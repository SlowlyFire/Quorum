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
 * Services own the SQL; nothing outside src/services should call this.
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

export async function closePool() {
  await pool.end();
}
