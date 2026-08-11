/**
 * Migration runner — `npm run migrate`.
 *
 * Applies every .sql file in ./migrations that is not already recorded in the
 * _migrations table, in filename order, each inside its own transaction. A file
 * that fails is rolled back whole and the process exits non-zero, so the
 * database is never left half-migrated.
 *
 * Running it twice applies nothing the second time.
 *
 * This is the one file outside src/models/ allowed to issue SQL. It executes
 * migration files rather than querying application tables; see CLAUDE.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '../config/env.js';
import { closePool, pool } from './pool.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Same defence-in-depth posture as the application tables: no policies, so
  // RLS denies everything to any role that does not bypass it.
  await client.query('ALTER TABLE _migrations ENABLE ROW LEVEL SECURITY');
}

async function readPendingFilenames(client) {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  const files = entries.filter((entry) => entry.endsWith('.sql')).sort();

  const { rows } = await client.query('SELECT filename FROM _migrations');
  const applied = new Set(rows.map((row) => row.filename));

  return files.filter((filename) => !applied.has(filename));
}

async function applyMigration(client, filename) {
  const sql = await fs.readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
  const startedAt = process.hrtime.bigint();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
  } catch (cause) {
    await client.query('ROLLBACK');
    throw new Error(`${filename} failed and was rolled back: ${cause.message}`, { cause });
  }

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  console.log(`[migrate] applied ${filename} (${durationMs.toFixed(0)}ms)`);
}

async function runMigrations() {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured. See server/.env.example.');
  }

  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const pending = await readPendingFilenames(client);

    if (pending.length === 0) {
      console.log('[migrate] nothing to apply — database is up to date');
      return;
    }

    console.log(`[migrate] ${pending.length} migration(s) pending`);

    for (const filename of pending) {
      await applyMigration(client, filename);
    }

    console.log('[migrate] done');
  } finally {
    client.release();
  }
}

try {
  await runMigrations();
  await closePool();
  process.exit(0);
} catch (error) {
  console.error(`[migrate] ${error.message}`);
  await closePool();
  process.exit(1);
}
