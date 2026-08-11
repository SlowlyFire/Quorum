#!/usr/bin/env node
/**
 * Proof that the four-stage engine runs: five real rounds against real models,
 * one council rejected before it spends anything, and the whole of round 1 read
 * back off disk through psql rather than through our own model layer.
 *
 * This one DOES write to the database — a debate that is not persisted is not a
 * debate. It creates (or reuses) one verification user and one fresh session per
 * run, and leaves everything behind on purpose: step 7 is only meaningful if the
 * rows are still there afterwards.
 *
 *   npm run verify:debate
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hash } from 'bcryptjs';

import { closePool } from '../src/db/pool.js';
import { listActiveModels } from '../src/models/llmModel.js';
import { listResponsesByRound } from '../src/models/modelResponseModel.js';
import { findRoundById } from '../src/models/roundModel.js';
import { listRoundModels } from '../src/models/roundModelModel.js';
import { insertSession } from '../src/models/sessionModel.js';
import { findUserByEmail, insertUser } from '../src/models/userModel.js';
import { VERDICT_TYPE_MAP, runRound } from '../src/services/debateService.js';
import { PROMPT_VERSION } from '../src/services/promptService.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const VERIFY_EMAIL = 'debate-verify@example.com';

const failures = [];
const spend = { calls: 0, cost: 0 };

function heading(text) {
  console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);
}

function check(label, passed, note = '') {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`);
  if (!passed) failures.push(label);
}

function money(value) {
  return value === null || value === undefined ? 'unknown' : `$${Number(value).toFixed(8)}`;
}

function truncate(text, length) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > length ? `${oneLine.slice(0, length)}…` : oneLine;
}

/** Prints each event as it fires, which is the stream Session 6 turns into SSE. */
function makeStreamLogger() {
  const events = [];

  const onEvent = async (event, payload) => {
    events.push({ event, payload });

    const detail = {
      round_started: (p) => `chairman=${p.chairman} drafters=${p.drafterCount}`,
      stage_started: (p) => `stage=${p.stage}`,
      stage_skipped: (p) => `stage=${p.stage} reason="${p.reason}"`,
      response_ready: (p) =>
        `${p.stage} ${p.label ?? '(chairman)'} ${p.modelName} ${p.latencyMs}ms ${money(p.cost)} :: ${truncate(p.content, 60)}`,
      response_failed: (p) => `${p.stage} ${p.label ?? '(chairman)'} ${p.modelName} :: ${p.error}`,
      verdict: (p) => `${p.verdictType} winners=[${p.winnerLabels.join(', ')}]`,
      stance: (p) => `${p.label} ${p.modelName} -> ${p.stance}`,
      round_complete: (p) => `${p.verdictType} ${money(p.totalCost)} ${p.durationMs}ms`,
      round_failed: (p) => p.error,
    };

    const line = detail[event] ? detail[event](payload) : JSON.stringify(payload);
    console.log(`    -> ${event.padEnd(16)} ${line}`);
  };

  return { onEvent, events };
}

/**
 * Live providers flake. google/gemini-2.5-flash was observed three times in
 * these runs answering 200 after 3-20s with finish_reason 'error', zero tokens
 * and no content — which the engine correctly treats as a failed call.
 *
 * A step whose point is that a round COMPLETES must not be scored as a defect
 * because a second, unplanned model dropped out and took the two-draft quorum
 * with it. One retry, announced loudly, and the retry is counted in the spend.
 */
async function attemptRound(label, run) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt === 2) throw error;

      console.log(
        `\n  !! ${label} did not complete: ${error.code} — ${error.message}\n` +
          '     That is an unplanned provider dropout rather than the condition under test.\n' +
          '     Retrying once.\n',
      );
    }
  }
}

async function ensureUser() {
  const existing = await findUserByEmail(VERIFY_EMAIL);
  if (existing) return existing;

  return insertUser({
    email: VERIFY_EMAIL,
    passwordHash: await hash('debate verification only', 10),
    displayName: 'Debate Verification',
  });
}

function councilFrom(models, slugs) {
  return slugs.map((slug) => {
    const row = models.find((model) => model.openrouter_slug === slug);
    if (!row) throw new Error(`Seeded model ${slug} is missing — run npm run migrate.`);

    return { id: row.id, slug: row.openrouter_slug, displayName: row.display_name };
  });
}

function account(result) {
  spend.calls += result.callCount;
  spend.cost += result.totalCost;
}

function printRound(result) {
  console.log('\n  label -> model mapping (server-side only, never sent to the chairman):');
  for (const entry of result.labels) {
    console.log(`    ${entry.label}  ${entry.displayName.padEnd(22)} ${entry.slug}`);
  }

  console.log('\n  drafts:');
  for (const draft of result.drafts) {
    console.log(
      `    ${draft.label}  ${draft.modelName.padEnd(22)} via ${String(draft.provider).padEnd(14)} ${truncate(draft.content, 100)}`,
    );
  }

  console.log('\n  verdict JSON:');
  console.log(`${JSON.stringify(result.verdict, null, 2).replace(/^/gm, '    ')}`);

  console.log('\n  stances:');
  if (result.rebuttalSkipReason) {
    console.log(`    (stage 3 skipped — ${result.rebuttalSkipReason})`);
  } else {
    for (const rebuttal of result.rebuttals) {
      console.log(
        `    ${rebuttal.label}  ${rebuttal.modelName.padEnd(22)} ${rebuttal.stance.toUpperCase().padEnd(8)} ${truncate(rebuttal.argument, 90)}`,
      );
    }
  }

  console.log('\n  final answer:');
  console.log(result.finalAnswer.replace(/^/gm, '    '));

  if (result.openQuestions) {
    console.log('\n  open questions:');
    console.log(result.openQuestions.replace(/^/gm, '    '));
  }

  console.log(`\n  verdict_type:  ${result.verdictType} (changed from initial: ${result.changedFromInitial})`);
  console.log(`  prompt_version: ${result.promptVersion}`);
  console.log(`  calls:          ${result.callCount}`);
  console.log(`  total cost:     ${money(result.totalCost)}`);
  console.log(`  duration:       ${result.durationMs}ms`);
}

/** 1 & 2 — a full 3-model round with the chairman abstaining. */
async function verifyFullRound(user, models) {
  heading('1. Full 3-model round, chairman abstaining');

  const council = {
    models: councilFrom(models, [
      'meta-llama/llama-4-maverick',
      'openai/gpt-5-mini',
      'google/gemini-2.5-flash',
    ]),
    chairmanAbstains: true,
    rebuttalEnabled: true,
  };
  council.chairmanId = council.models[2].id;

  const session = await insertSession({ userId: user.id, title: 'Verification — full round' });

  console.log(`  session ${session.id}`);
  console.log(`  chairman: ${council.models[2].displayName} (abstaining)`);

  const { result, events } = await attemptRound('round 1', async () => {
    const logger = makeStreamLogger();

    console.log('\n  event stream, in order:');

    const round = await runRound({
      sessionId: session.id,
      userId: user.id,
      prompt: 'Is it ever correct to use a database transaction for a single INSERT? Answer briefly.',
      council,
      onEvent: logger.onEvent,
    });

    return { result: round, events: logger.events };
  });

  account(result);
  printRound(result);

  const order = events.map((entry) => entry.event);

  const stagesAnnounced = events
    .filter((entry) => entry.event === 'stage_started')
    .map((entry) => entry.payload.stage);

  check('round_started came first', order[0] === 'round_started');
  check('round_complete came last', order.at(-1) === 'round_complete');
  check(
    'all four stages were announced, in order',
    JSON.stringify(stagesAnnounced) === JSON.stringify(['draft', 'verdict', 'rebuttal', 'final']),
    stagesAnnounced.join(' -> '),
  );
  check('two drafts were produced', result.drafts.length === 2);
  check('the round is complete', result.status === 'complete');
  check(
    'verdict_type is one of §7\'s four values',
    Object.values(VERDICT_TYPE_MAP).includes(result.verdictType),
    result.verdictType,
  );
  check('prompt_version was stamped', result.promptVersion === PROMPT_VERSION);
  check('total cost is positive', result.totalCost > 0);

  // -- 2. anonymity ------------------------------------------------------------

  heading('2. Anonymity — the EXACT {{DRAFTS}} string sent to the chairman');

  console.log(`\n${result.draftsBlock.replace(/^/gm, '  | ')}\n`);

  const haystack = result.draftsBlock.toLowerCase();
  const leaked = [];

  for (const entry of result.labels) {
    // Both the display name and the slug, plus the vendor half of the slug —
    // "anthropic" alone would be a leak even without "claude-haiku-4.5".
    const needles = [
      entry.displayName.toLowerCase(),
      entry.slug.toLowerCase(),
      entry.slug.split('/')[0].toLowerCase(),
    ];

    for (const needle of needles) {
      if (haystack.includes(needle)) leaked.push(`${entry.label}: "${needle}"`);
    }
  }

  console.log(`  searched for ${result.labels.length * 3} identifying strings (display name, slug, vendor)`);
  check('no model name, slug or vendor appears in the block', leaked.length === 0, leaked.join('; '));
  check(
    'the block contains only "### Response <label>" headings',
    result.draftsBlock.match(/^### .*$/gm).every((line) => /^### Response [A-Z]+$/.test(line)),
  );

  return result;
}

/** 3 — the chairman drafts as well as judges. */
async function verifyChairmanDrafting(user, models) {
  heading('3. 4-model round, chairman ALSO drafting (role = both)');

  const council = {
    models: councilFrom(models, [
      'meta-llama/llama-4-maverick',
      'openai/gpt-5-mini',
      'google/gemini-2.5-flash',
      'anthropic/claude-haiku-4.5',
    ]),
    chairmanAbstains: false,
    rebuttalEnabled: true,
  };
  council.chairmanId = council.models[3].id;

  const session = await insertSession({ userId: user.id, title: 'Verification — chairman drafts' });

  console.log(`  chairman: ${council.models[3].displayName} (drafting too)`);

  const result = await attemptRound('round 3', async () => {
    const logger = makeStreamLogger();

    console.log('\n  event stream, in order:');

    return runRound({
      sessionId: session.id,
      userId: user.id,
      prompt: 'In one paragraph: why is UDP still used when TCP guarantees delivery?',
      council,
      onEvent: logger.onEvent,
    });
  });

  account(result);

  const roles = await listRoundModels(result.roundId);
  const chairmanRow = roles.find((row) => row.model_id === council.chairmanId);

  console.log('\n  round_models:');
  for (const row of roles) {
    console.log(`    ${row.display_name.padEnd(22)} role=${row.role}`);
  }

  console.log(`\n  verdict: ${result.verdictType}, winners [${result.verdict.winnerLabels.join(', ')}]`);
  console.log(`  final answer: ${truncate(result.finalAnswer, 200)}`);

  check("the chairman's role is 'both'", chairmanRow?.role === 'both', chairmanRow?.role);
  check('the other three are drafters', roles.filter((row) => row.role === 'drafter').length === 3);
  check('four models drafted', result.drafts.length === 4);
  check(
    'the chairman is among the drafters',
    result.drafts.some((draft) => draft.modelId === council.chairmanId),
  );
  check('the round is complete', result.status === 'complete');

  return result;
}

/** 4 — a question with one right answer, to try to provoke 'unanimous'. */
async function verifyUnanimity(user, models) {
  heading("4. Agreement — 'What is 17 times 4?'");

  const council = {
    models: councilFrom(models, [
      'meta-llama/llama-4-maverick',
      'openai/gpt-5-mini',
      'google/gemini-2.5-flash',
    ]),
    chairmanAbstains: true,
    rebuttalEnabled: true,
  };
  council.chairmanId = council.models[2].id;

  const session = await insertSession({ userId: user.id, title: 'Verification — unanimity' });

  const { result, events } = await attemptRound('round 4', async () => {
    const logger = makeStreamLogger();

    console.log('\n  event stream, in order:');

    const round = await runRound({
      sessionId: session.id,
      userId: user.id,
      prompt: 'What is 17 times 4?',
      council,
      onEvent: logger.onEvent,
    });

    return { result: round, events: logger.events };
  });

  account(result);

  const skipped = events.find((entry) => entry.event === 'stage_skipped');

  console.log(`\n  verdict_type:      ${result.verdictType}`);
  console.log(`  stage 3 skipped:   ${result.rebuttalSkipReason ?? 'no — rebuttals ran'}`);
  console.log(`  rebuttal calls:    ${result.rebuttals.length}`);
  console.log(`  calls in total:    ${result.callCount}`);
  console.log(`  final answer:      ${truncate(result.finalAnswer, 160)}`);

  if (result.verdictType === 'unanimous') {
    check('unanimous verdict skipped stage 3', result.rebuttalSkipReason !== null);
    check('a stage_skipped event was emitted', Boolean(skipped));
    check('the skip saved two calls (4 rather than 6)', result.callCount === 4, `${result.callCount} calls`);
  } else {
    console.log(
      `\n  NOTE: the chairman returned "${result.verdictType}" rather than "unanimous", so the skip\n` +
        '  path was not exercised by this round. The skip is proven by the rebuttalEnabled=false\n' +
        '  round below, which takes the same branch.',
    );
    check('stage 3 ran, as a non-unanimous verdict requires', result.rebuttalSkipReason === null);
  }

  return result;
}

/** 4b — the other route into the same skip branch, so it is always proven. */
async function verifyRebuttalsDisabled(user, models) {
  heading('4b. rebuttalEnabled = false — the same skip branch, deterministically');

  const council = {
    models: councilFrom(models, [
      'meta-llama/llama-4-maverick',
      'openai/gpt-5-mini',
      'google/gemini-2.5-flash',
    ]),
    chairmanAbstains: true,
    rebuttalEnabled: false,
  };
  council.chairmanId = council.models[2].id;

  const session = await insertSession({ userId: user.id, title: 'Verification — no rebuttals' });

  const { result, events } = await attemptRound('round 4b', async () => {
    const logger = makeStreamLogger();

    console.log('\n  event stream, in order:');

    const round = await runRound({
      sessionId: session.id,
      userId: user.id,
      prompt: 'Name one advantage of a monorepo, in one sentence.',
      council,
      onEvent: logger.onEvent,
    });

    return { result: round, events: logger.events };
  });

  account(result);

  console.log('\n  the {{REBUTTALS}} block the chairman received in stage 4:');
  console.log(`  | ${result.rebuttalsBlock}`);

  check('stage 3 was skipped', result.rebuttalSkipReason === 'rebuttals are disabled for this session');
  check('a stage_skipped event fired', events.some((entry) => entry.event === 'stage_skipped'));
  check('no rebuttal calls were made', result.rebuttals.length === 0);
  check('the round still completed', result.status === 'complete');
  check(
    '{{REBUTTALS}} was not an empty string',
    result.rebuttalsBlock.length > 0 && result.rebuttalsBlock.includes('No rebuttal stage'),
  );

  return result;
}

/** 5 — one drafter cannot answer; the round must survive it. */
async function verifyDrafterFailure(user, models) {
  heading('5. A drafter that fails — the round continues without it');

  const council = {
    models: councilFrom(models, [
      'meta-llama/llama-4-maverick',
      'openai/gpt-5-mini',
      'google/gemini-2.5-flash',
      'anthropic/claude-haiku-4.5',
    ]),
    chairmanAbstains: true,
    rebuttalEnabled: true,
  };
  council.chairmanId = council.models[3].id;

  // A real models row — round_models has an FK to it — carrying a slug that
  // OpenRouter will refuse. This is the shape of a model retired upstream while
  // still active in our catalogue.
  const saboteur = council.models[1];
  const realSlug = saboteur.slug;
  saboteur.slug = 'openai/gpt-5-mini-does-not-exist';

  const session = await insertSession({ userId: user.id, title: 'Verification — drafter failure' });

  console.log(`  ${saboteur.displayName} will be called as "${saboteur.slug}" (real slug: ${realSlug})`);

  const { result, events } = await attemptRound('round 5', async () => {
    const logger = makeStreamLogger();

    console.log('\n  event stream, in order:');

    const round = await runRound({
      sessionId: session.id,
      userId: user.id,
      prompt: 'What does the SQL keyword HAVING do that WHERE cannot?',
      council,
      onEvent: logger.onEvent,
    });

    return { result: round, events: logger.events };
  });

  account(result);

  const failedEvent = events.find((entry) => entry.event === 'response_failed');
  const stored = await runPsql(
    `SELECT stage, anon_label, coalesce(provider,'-') AS provider, coalesce(left(error_text,60),'-') AS error
       FROM model_responses WHERE round_id = '${result.roundId}' AND stage = 'draft' ORDER BY anon_label`,
  );

  console.log('\n  draft rows on disk:');
  console.log(stored.replace(/^/gm, '  '));

  check('the failure was reported as an event', Boolean(failedEvent));
  check('two of three drafts succeeded', result.drafts.length === 2, `${result.drafts.length} drafts`);
  check('the round completed anyway', result.status === 'complete');
  check(
    'the failure is persisted with its error text',
    stored.includes('OPENROUTER_BAD_REQUEST'),
  );
  check(
    'the failed drafter got no rebuttal call',
    result.rebuttals.every((rebuttal) => rebuttal.modelId !== saboteur.id),
  );

  return result;
}

/** 6 — a council too small to debate, rejected before it spends anything. */
async function verifyInsufficientCouncil(user, models) {
  heading('6. INSUFFICIENT_COUNCIL — 2 models with the chairman abstaining');

  const council = {
    models: councilFrom(models, ['meta-llama/llama-4-maverick', 'google/gemini-2.5-flash']),
    chairmanAbstains: true,
    rebuttalEnabled: true,
  };
  council.chairmanId = council.models[1].id;

  const session = await insertSession({ userId: user.id, title: 'Verification — tiny council' });

  const before = await runPsql(`SELECT count(*) AS rounds FROM rounds WHERE session_id = '${session.id}'`);

  try {
    await runRound({
      sessionId: session.id,
      userId: user.id,
      prompt: 'This should never be sent to a model.',
      council,
      onEvent: async (event) => console.log(`    -> ${event}`),
    });
    check('a 2-model abstaining council is rejected', false, 'the round ran');
  } catch (error) {
    console.log(`  code:    ${error.code}`);
    console.log(`  status:  ${error.status}`);
    console.log(`  message: ${error.message}`);

    check('code is INSUFFICIENT_COUNCIL', error.code === 'INSUFFICIENT_COUNCIL');
    check('status is 400 — the caller can fix this', error.status === 400);
    check('the message names both minimums', error.message.includes('3 models') && error.message.includes('2 when it drafts'));
  }

  const after = await runPsql(`SELECT count(*) AS rounds FROM rounds WHERE session_id = '${session.id}'`);

  console.log(`\n  rounds for that session before: ${firstValue(before)}`);
  console.log(`  rounds for that session after:  ${firstValue(after)}`);
  check('no round row was created — nothing was spent', firstValue(after) === '0');
}

/** 5b — one draft is not a debate. */
async function verifyInsufficientDrafts(user, models) {
  heading('5b. INSUFFICIENT_DRAFTS — two of three drafters fail');

  const council = {
    models: councilFrom(models, [
      'meta-llama/llama-4-maverick',
      'openai/gpt-5-mini',
      'google/gemini-2.5-flash',
      'anthropic/claude-haiku-4.5',
    ]),
    chairmanAbstains: true,
    rebuttalEnabled: true,
  };
  council.chairmanId = council.models[3].id;
  council.models[1].slug = 'openai/gpt-5-mini-does-not-exist';
  council.models[2].slug = 'google/gemini-2.5-flash-does-not-exist';

  const session = await insertSession({ userId: user.id, title: 'Verification — insufficient drafts' });
  const { onEvent, events } = makeStreamLogger();

  console.log('  two of the three drafters carry slugs OpenRouter will refuse');
  console.log('\n  event stream, in order:');

  let thrown = null;

  try {
    await runRound({
      sessionId: session.id,
      userId: user.id,
      prompt: 'This round is expected to fail.',
      council,
      onEvent,
    });
  } catch (error) {
    thrown = error;
  }

  check('the round threw rather than faking a debate', Boolean(thrown));
  check('code is INSUFFICIENT_DRAFTS', thrown?.code === 'INSUFFICIENT_DRAFTS', thrown?.code);
  check('a round_failed event was emitted', events.some((entry) => entry.event === 'round_failed'));
  check('the chairman was never called', !events.some((entry) => entry.payload?.stage === 'verdict'));

  const roundId = events.find((entry) => entry.event === 'round_started')?.payload.roundId;
  const row = await findRoundById(roundId);
  const rows = await listResponsesByRound(roundId);

  spend.calls += rows.length;
  spend.cost += rows.reduce((total, r) => total + Number(r.cost ?? 0), 0);

  console.log(
    await runPsql(
      `SELECT status, total_cost, duration_ms, verdict_type, final_answer
         FROM rounds WHERE id = '${roundId}'`,
    ),
  );

  check("the round row is 'failed', not left mid-status", row.status === 'failed', row.status);
  check('all three draft calls were persisted', rows.length === 3, `${rows.length} rows`);
  check(
    'the one call that succeeded is still billed to the round',
    Number(row.total_cost) > 0,
    `total_cost ${row.total_cost}`,
  );
  check('duration_ms was recorded on the failed round', Number(row.duration_ms) > 0);
  check('no final answer was invented', row.final_answer === null);
}

/** 7 — the whole round read back through psql, not through our own models. */
async function verifyOnDisk(result) {
  heading('7. The round on disk (psql)');

  console.log(`  round ${result.roundId}\n`);

  const responses = await runPsql(
    `SELECT stage, anon_label, provider, stance, cost
       FROM model_responses WHERE round_id = '${result.roundId}' ORDER BY created_at`,
  );
  console.log(responses.replace(/^/gm, '  '));

  const round = await runPsql(
    `SELECT status, verdict_type, prompt_version, total_cost, duration_ms,
            length(final_answer) AS answer_chars, coalesce(open_questions,'(none)') AS open_questions
       FROM rounds WHERE id = '${result.roundId}'`,
  );
  console.log(round.replace(/^/gm, '  '));

  const roles = await runPsql(
    `SELECT m.display_name, rm.role
       FROM round_models rm JOIN models m ON m.id = rm.model_id
       WHERE rm.round_id = '${result.roundId}' ORDER BY rm.role, m.display_name`,
  );
  console.log(roles.replace(/^/gm, '  '));

  // Read independently of the engine's own return value.
  const row = await findRoundById(result.roundId);
  const rows = await listResponsesByRound(result.roundId);

  check('status is complete on disk', row.status === 'complete');
  check('verdict_type on disk matches the returned one', row.verdict_type === result.verdictType);
  check('prompt_version on disk is v1', row.prompt_version === 'v1');
  check('duration_ms was written', Number(row.duration_ms) > 0);
  check(
    'total_cost on disk matches the returned total',
    Math.abs(Number(row.total_cost) - result.totalCost) < 1e-8,
    `${row.total_cost} vs ${result.totalCost}`,
  );
  check(
    'one row per call, all four stages present',
    new Set(rows.map((r) => r.stage)).size === 4 && rows.length === result.callCount,
    `${rows.length} rows, ${result.callCount} calls`,
  );
  check(
    'every successful call recorded which upstream served it',
    rows.filter((r) => !r.error_text).every((r) => Boolean(r.provider)),
  );
  check(
    'anon_label is set on drafts and rebuttals, null on chairman stages',
    rows.every((r) =>
      ['draft', 'rebuttal'].includes(r.stage) ? Boolean(r.anon_label) : r.anon_label === null,
    ),
  );
  check(
    'stance is set only on rebuttal rows',
    rows.every((r) => (r.stance === null ? true : r.stage === 'rebuttal')),
  );
}

/**
 * psql through scripts/psql.js, which passes the connection through the child's
 * environment rather than the command line. Using a different client than the
 * engine is the point: it proves the rows are on disk, not in our head.
 */
async function runPsql(sql) {
  const result = spawnSync(process.execPath, [path.join(currentDir, 'psql.js'), '-c', sql], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

/** The single value out of a psql result — line 1 is the header, 2 the rule. */
function firstValue(stdout) {
  return stdout.split('\n')[2]?.trim() ?? '';
}

async function main() {
  const models = await listActiveModels();
  const user = await ensureUser();

  console.log(`\nverification user ${user.email} (${user.id})`);
  console.log(`prompt version    ${PROMPT_VERSION}`);
  console.log(`seeded models     ${models.length}`);

  const fullRound = await verifyFullRound(user, models);
  await verifyChairmanDrafting(user, models);
  await verifyUnanimity(user, models);
  await verifyRebuttalsDisabled(user, models);
  await verifyDrafterFailure(user, models);
  await verifyInsufficientDrafts(user, models);
  await verifyInsufficientCouncil(user, models);
  await verifyOnDisk(fullRound);

  heading(failures.length === 0 ? 'All checks passed' : `${failures.length} check(s) FAILED`);
  for (const failure of failures) console.log(`  - ${failure}`);

  console.log(`\n  OpenRouter calls made: ${spend.calls}`);
  console.log(`  total spend:           ${money(spend.cost)}`);
  console.log(`\n  round 1 for later inspection: ${fullRound.roundId}`);
}

try {
  await main();
} catch (error) {
  console.error('\n[verify] aborted:', error);
  failures.push('the script threw');
} finally {
  await closePool();
}

process.exit(failures.length === 0 ? 0 : 1);
