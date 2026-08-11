/**
 * `npm run psql -- <psql args>` — an interactive session or a one-off query
 * against the configured database.
 *
 *   npm run psql -- -c '\dt'
 *   npm run psql -- -c 'SELECT count(*) FROM models'
 *
 * DATABASE_URL is decomposed into libpq's PG* variables and handed to the child
 * through its environment. It is deliberately never interpolated into a command
 * string: a connection URI on the command line lands in shell history and is
 * visible to anyone who can run `ps`.
 *
 * psql itself is a local development convenience, not a project dependency —
 * the server talks to Postgres through `pg`, so no deploy host needs it.
 */
import { spawnSync } from 'node:child_process';

import { env } from '../src/config/env.js';

// Homebrew keeps libpq keg-only, so psql is commonly installed but off PATH.
const CANDIDATE_BINARIES = [
  process.env.PSQL_BIN,
  'psql',
  '/opt/homebrew/opt/libpq/bin/psql',
  '/usr/local/opt/libpq/bin/psql',
].filter(Boolean);

function resolvePsql() {
  for (const candidate of CANDIDATE_BINARIES) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!probe.error) return candidate;
  }
  return null;
}

function connectionEnv(databaseUrl) {
  const url = new URL(databaseUrl);

  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
    // Matches the pool's ssl: { rejectUnauthorized: false } — encrypted
    // transport, no certificate verification.
    PGSSLMODE: url.searchParams.get('sslmode') ?? 'require',
  };
}

if (!env.DATABASE_URL) {
  console.error('[psql] DATABASE_URL is not configured. See server/.env.example.');
  process.exit(1);
}

const binary = resolvePsql();

if (!binary) {
  console.error('[psql] no psql binary found. Install it with `brew install libpq`,');
  console.error('[psql] or point PSQL_BIN at an existing one.');
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, ...connectionEnv(env.DATABASE_URL) },
});

process.exit(result.status ?? 1);
