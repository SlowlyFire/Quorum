/**
 * The connectivity probe behind GET /api/health/db.
 *
 * It owns no table, but it exists so that the rule holds without exception:
 * SQL lives in src/models/, and healthService is a service like any other.
 */
import { query } from '../db/pool.js';

export async function selectNow(exec = query) {
  const { rows } = await exec('SELECT now()');

  return rows[0].now;
}
