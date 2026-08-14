#!/usr/bin/env node
/**
 * Titles every existing session that has none, from its first round's
 * question — the backfill for sessions created before session auto-titling
 * existed.
 *
 * A ONE-OFF SCRIPT, NOT A MIGRATION, and the reason is `titleFromPrompt.js`.
 * Every migration in `src/db/migrations/` is plain DDL — a column, an index,
 * an enum value — and none computes a value from business logic. Reimplementing
 * word-boundary truncation in raw SQL would be a second copy of the exact
 * function the live feature uses, and a second copy is the one this backfill
 * and a future edit to the truncation rule can silently disagree about. This
 * script imports the same `titleFromPrompt` `debateService.js` calls on every
 * round completion, so there is exactly one place that decides what a title
 * looks like.
 *
 * Dry run by default, prints every session it would title and the title it
 * would give it; `--confirm` writes. Idempotent: `setTitleIfBlank`'s
 * `WHERE title IS NULL` means a second run touches nothing a first run (or a
 * user's own rename, or a round that completed normally) already set.
 *
 *   npm run backfill:session-titles
 *   npm run backfill:session-titles -- --confirm
 */
import { closePool, query } from '../src/db/pool.js';
import { setTitleIfBlank } from '../src/models/sessionModel.js';
import { titleFromPrompt } from '../src/lib/titleFromPrompt.js';

async function main() {
  const confirmed = process.argv.includes('--confirm');

  /**
   * One row per untitled session, paired with its EARLIEST round's prompt —
   * "the first round", matching the live feature exactly rather than
   * whichever round happens to be easiest to query. A session with zero
   * rounds has no prompt to derive a title from and is correctly absent here;
   * it gets titled the normal way the moment it has a first round.
   */
  const { rows } = await query(`
    SELECT s.id, s.title,
           (SELECT r.user_prompt
              FROM rounds r
             WHERE r.session_id = s.id
             ORDER BY r.created_at ASC, r.id ASC
             LIMIT 1) AS first_prompt
      FROM sessions s
     WHERE s.title IS NULL
     ORDER BY s.created_at ASC
  `);

  const candidates = rows
    .map((row) => ({ id: row.id, title: titleFromPrompt(row.first_prompt) }))
    .filter((row) => row.title);

  console.log(`\n  ${rows.length} untitled sessions, ${candidates.length} with a round to title from\n`);

  for (const { id, title } of candidates) {
    console.log(`  ${id}  ->  "${title}"`);
  }

  if (rows.length > candidates.length) {
    console.log(`\n  ${rows.length - candidates.length} untitled session(s) have no rounds yet — left alone.`);
  }

  if (!confirmed) {
    console.log('\n  DRY RUN — nothing was written.');
    console.log('  Re-run with --confirm to write.\n');
    return;
  }

  let written = 0;

  for (const { id, title } of candidates) {
    const updated = await setTitleIfBlank(id, title);
    // Not every row: a session renamed by its owner between the SELECT above
    // and this write is exactly the race setTitleIfBlank's WHERE clause
    // exists to lose gracefully rather than win.
    if (updated) written += 1;
  }

  console.log(`\n  wrote ${written} of ${candidates.length} titles ` +
    `(${candidates.length - written} were renamed or titled between the read and the write).\n`);
}

main()
  .catch((error) => {
    console.error('\nbackfill:session-titles could not finish:', error);
    process.exitCode = 1;
  })
  .finally(closePool);
