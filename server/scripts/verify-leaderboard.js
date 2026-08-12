#!/usr/bin/env node
/**
 * Proof that the leaderboard counts what §4 says it counts, and that an
 * attachment reaches the models that can read it and nobody else.
 *
 * The server must already be running — `npm run dev` in another terminal. Every
 * check drives it over fetch, so what is verified is the bytes we send.
 *
 *   npm run verify:leaderboard
 *
 * WRITES to the database and to Supabase Storage, and leaves everything behind.
 * It runs ONE real debate — the only way to prove that a vision model read the
 * image and a text-only one said it could not — at about $0.01. Everything else
 * is free: the leaderboard checks read rounds that already exist, and the
 * attachment refusals never reach a model.
 *
 * THE TWO TRAPS THIS SCRIPT EXISTS FOR, both of them silent when got wrong:
 *
 *   1. The score comes from stage 2's `winnerLabels`, never from
 *      `rounds.verdict_type`. Check 2 walks one model's rounds by hand and
 *      shows the arithmetic; check 3a shows what `verdict_type` would have said
 *      instead.
 *   2. The drafting denominator is `role IN ('drafter','both')`, never
 *      `role = 'drafter'`. Check 3 runs both and prints the difference on a
 *      real round where the chairman also drafted.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIN_DRAFTS_TO_RANK } from '../src/config/leaderboard.js';
import { closePool, query } from '../src/db/pool.js';
import { listActiveModels } from '../src/models/llmModel.js';
import {
  draftDenominatorComparison,
  explainLeaderboard,
} from '../src/models/leaderboardModel.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3000/api';

const PASSWORD = 'the leaderboard verification account';
const OWNER_EMAIL = `leaderboard-verify-${Date.now()}@example.com`;
const INTRUDER_EMAIL = `leaderboard-intruder-${Date.now()}@example.com`;

/**
 * The image the drafters are asked about. Mockup 07 itself: it has legible text,
 * three named models and three percentages, so "did the model actually see it"
 * has a checkable answer rather than a vibe.
 */
const IMAGE_PATH = path.resolve(currentDir, '../../docs/mockups/quorum-07-leaderboard.png');

/**
 * A phrase that exists nowhere except inside the generated PDF, so "did the
 * model read the document" is a string comparison rather than a judgement.
 */
const PDF_PASSPHRASE = 'BRASS LANTERN 4471';

const failures = [];

/**
 * A valid one-page PDF, built here rather than committed as a binary.
 *
 * A checked-in fixture would be an opaque blob in a repo where every other file
 * explains itself, and nobody could tell whether it had been tampered with. This
 * is 600 bytes of PDF that says what it is — and building it means computing the
 * xref offsets honestly, which is also what makes it parse in a real reader
 * rather than only in our own sniffer.
 */
function makeProbePdf() {
  const text =
    `BT /F1 16 Tf 24 150 Td (QUORUM ATTACHMENT PROBE) Tj ` +
    `0 -28 Td (The passphrase is: ${PDF_PASSPHRASE}) Tj ET`;

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 200]' +
      '/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${text.length}>>\nstream\n${text}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];

  for (const [index, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }

  const xrefAt = pdf.length;

  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function heading(text) {
  console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);
}

function check(label, passed, note = '') {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`);
  if (!passed) failures.push(label);
}

function table(rows, columns) {
  const widths = columns.map((column) =>
    Math.max(column.label.length, ...rows.map((row) => String(column.value(row)).length)),
  );

  const line = (cells) =>
    `  ${cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ')}`;

  console.log(line(columns.map((column) => column.label)));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(columns.map((column) => column.value(row))));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** One retry on ECONNRESET — Node's keep-alive against Node's 5s idle timeout,
 *  same helper and same reason as verify-wallet and verify-sharing. */
async function send(url, options = {}) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (attempt === 2 || error.cause?.code !== 'ECONNRESET') throw error;
    }
  }

  throw new Error('unreachable');
}

function makeClient() {
  let cookie = null;

  async function request(method, path, body, { raw = null } = {}) {
    const response = await send(`${BASE}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(raw ? { body: raw } : {}),
    });

    for (const value of response.headers.getSetCookie?.() ?? []) {
      const [pair] = value.split(';');
      if (pair.startsWith('quorum_token=')) cookie = pair;
    }

    const text = await response.text();
    const isJson = response.headers.get('content-type')?.includes('application/json');

    return { status: response.status, body: isJson && text ? JSON.parse(text) : null, text };
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    del: (path) => request('DELETE', path),
    /** multipart, built by hand so the declared type is ours to control — which
     *  is the whole point of the sniffing checks. */
    upload: (path, { bytes, filename, contentType }) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: contentType }), filename);
      return request('POST', path, null, { raw: form });
    },
  };
}

async function anonymousGet(path) {
  const response = await send(`${BASE}${path}`);
  const text = await response.text();
  const isJson = response.headers.get('content-type')?.includes('application/json');

  return { status: response.status, body: isJson && text ? JSON.parse(text) : null, text };
}

async function register(client, email) {
  const registered = await client.post('/auth/register', {
    email,
    password: PASSWORD,
    displayName: 'Leaderboard Verification',
  });

  if (registered.status !== 201) {
    await client.post('/auth/login', { email, password: PASSWORD });
  }
}

// ===========================================================================
// 1 — the query, its plan and its timing
// ===========================================================================

async function verifyQueryPlan() {
  heading('1. THE QUERY: one statement with CTEs, its EXPLAIN, and its timing');

  const started = process.hrtime.bigint();
  const plan = await explainLeaderboard({ userId: null, days: 30 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  console.log(
    plan
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  );

  const executionMs = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? NaN);
  const planningMs = Number(/Planning Time: ([\d.]+) ms/.exec(plan)?.[1] ?? NaN);

  console.log(
    `\n  planning ${planningMs.toFixed(2)} ms · execution ${executionMs.toFixed(2)} ms · ` +
      `round trip ${elapsedMs.toFixed(0)} ms (Supabase is remote; most of that is the wire)`,
  );

  check('EXPLAIN ANALYZE returned a plan', plan.length > 0);
  check('execution time is under 250 ms', executionMs < 250, `${executionMs.toFixed(2)} ms`);
  check(
    'the plan aggregates in ONE statement — no per-model loop',
    (plan.match(/Execution Time/g) ?? []).length === 1,
  );
}

// ===========================================================================
// 2 — one model's numbers, checked by hand against the rows
// ===========================================================================

/**
 * The arithmetic, done twice: once by the query and once here from the raw
 * rows, for whichever model has the most drafts. If §4's scoring table has been
 * implemented wrongly, these two disagree.
 */
async function verifyByHand(client) {
  heading('2. HAND-VERIFYING ONE MODEL against its rows in the database');

  const { body } = await client.get('/leaderboard?scope=all&days=30');
  const board = body.leaderboard;
  const subject = board.ranked[0];

  if (!subject) {
    check('there is a ranked model to verify', false, 'the board is empty');
    return board;
  }

  console.log(`  Subject: ${subject.displayName}\n`);

  /**
   * Every round in the window in which this model was SEATED TO DRAFT, with the
   * label it drafted under and the winner_labels of that round's stage-2
   * verdict. Deliberately spelled out rather than reusing the model file's SQL:
   * a check that runs the code under test proves nothing.
   */
  const { rows } = await query(
    `
      SELECT r.id AS round_id,
             rm.role,
             (
               SELECT mr.anon_label
               FROM model_responses mr
               WHERE mr.round_id = r.id AND mr.model_id = $1
                 AND mr.stage = 'draft' AND mr.error_text IS NULL
               ORDER BY mr.created_at DESC LIMIT 1
             ) AS my_label,
             (
               SELECT mr.content
               FROM model_responses mr
               WHERE mr.round_id = r.id AND mr.stage = 'verdict' AND mr.error_text IS NULL
               ORDER BY mr.created_at DESC LIMIT 1
             ) AS verdict_json,
             r.verdict_type AS stage4_verdict_type
      FROM rounds r
      JOIN round_models rm ON rm.round_id = r.id AND rm.model_id = $1
      WHERE r.status = 'complete'
        AND r.created_at >= now() - make_interval(days => 30)
        AND rm.role IN ('drafter', 'both')
      ORDER BY r.created_at
    `,
    [subject.modelId],
  );

  let wins = 0;
  let merged = 0;
  const printable = [];

  for (const row of rows) {
    const winnerLabels = row.verdict_json ? (JSON.parse(row.verdict_json).winnerLabels ?? []) : [];
    const won = row.my_label !== null && winnerLabels.includes(row.my_label);
    const sole = won && winnerLabels.length === 1;

    if (sole) wins += 1;
    else if (won) merged += 1;

    printable.push({
      round: row.round_id.slice(0, 8),
      role: row.role,
      label: row.my_label ?? '(draft failed)',
      winners: winnerLabels.join('+') || '(none)',
      scores: sole ? '1.0' : won ? '0.5' : '0',
      stage4: row.stage4_verdict_type ?? '—',
    });
  }

  table(printable, [
    { label: 'ROUND', value: (row) => row.round },
    { label: 'ROLE', value: (row) => row.role },
    { label: 'ITS LABEL', value: (row) => row.label },
    { label: 'STAGE-2 WINNERS', value: (row) => row.winners },
    { label: 'SCORES', value: (row) => row.scores },
    { label: 'STAGE-4 verdict_type', value: (row) => row.stage4 },
  ]);

  const score = wins + merged * 0.5;
  const winRate = score / rows.length;

  console.log(
    `\n  by hand:  drafts ${rows.length} · wins ${wins} · merged ${merged} · ` +
      `score ${wins} + ${merged}×0.5 = ${score} · win rate ${score}/${rows.length} = ${(winRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  the API:  drafts ${subject.drafts} · wins ${subject.wins} · merged ${subject.merged} · ` +
      `score ${subject.score} · win rate ${(subject.winRate * 100).toFixed(1)}%`,
  );

  check('drafts match', rows.length === subject.drafts, `${rows.length} vs ${subject.drafts}`);
  check('wins match', wins === subject.wins, `${wins} vs ${subject.wins}`);
  check('merged match', merged === subject.merged, `${merged} vs ${subject.merged}`);
  check('score matches', Math.abs(score - subject.score) < 1e-9, `${score} vs ${subject.score}`);
  check(
    'win rate matches score / drafts',
    Math.abs(winRate - subject.winRate) < 1e-9,
    `${winRate.toFixed(6)} vs ${subject.winRate.toFixed(6)}`,
  );

  /**
   * TRAP 1, made visible. Stage 4 answers `unanimous` once every drafter has
   * conceded, which names no winner at all — so a leaderboard scored from
   * `rounds.verdict_type` would record those rounds as draws and erase a real
   * stage-2 win.
   */
  const unanimousAtStage4 = printable.filter((row) => row.stage4 === 'unanimous');
  const wonButUnanimous = unanimousAtStage4.filter((row) => row.scores !== '0');

  console.log(
    `\n  TRAP 1: ${unanimousAtStage4.length} of ${printable.length} rounds ended stage 4 ` +
      `"unanimous"; ${wonButUnanimous.length} of those are rounds this model SCORED in at stage 2.`,
  );
  check(
    'stage 4 and stage 2 genuinely disagree in this data, so the trap is not hypothetical',
    unanimousAtStage4.length > 0,
    `${unanimousAtStage4.length} unanimous rounds`,
  );

  return board;
}

// ===========================================================================
// 3 — trap 2, both denominators side by side
// ===========================================================================

async function verifyDenominatorTrap() {
  heading("3. TRAP 2: role IN ('drafter','both') against a bare role = 'drafter'");

  const rows = await draftDenominatorComparison({ userId: null, days: 30 });

  table(rows, [
    { label: 'MODEL', value: (row) => row.display_name },
    { label: "IN ('drafter','both')", value: (row) => row.drafts_correct },
    { label: "= 'drafter'", value: (row) => row.drafts_bare_equality },
    { label: "ROLE 'both'", value: (row) => row.also_chairman },
    {
      label: 'UNDERCOUNT',
      value: (row) =>
        row.drafts_correct === row.drafts_bare_equality
          ? '—'
          : `${row.drafts_correct - row.drafts_bare_equality} rounds lost`,
    },
  ]);

  const affected = rows.filter((row) => row.also_chairman > 0);

  check(
    'at least one model drafted while chairing, so the trap is live in this data',
    affected.length > 0,
    `${affected.length} model(s)`,
  );

  for (const row of affected) {
    const lost = row.drafts_correct - row.drafts_bare_equality;

    check(
      `${row.display_name}: the bare equality loses exactly its 'both' rounds`,
      lost === row.also_chairman && lost > 0,
      `${row.drafts_bare_equality} instead of ${row.drafts_correct}`,
    );

    /**
     * The point is not that the count is smaller — it is that the WIN RATE moves
     * without anything saying so. A model that drafted while chairing is scored
     * against a denominator missing exactly those rounds.
     */
    const { rows: scored } = await query(
      `
        SELECT count(*)::int AS drafts
        FROM round_models rm
        JOIN rounds r ON r.id = rm.round_id
        WHERE r.status = 'complete'
          AND r.created_at >= now() - make_interval(days => 30)
          AND rm.model_id = (SELECT id FROM models WHERE display_name = $1)
          AND rm.role = 'drafter'
      `,
      [row.display_name],
    );

    console.log(
      `        a leaderboard using the bare equality would divide by ${scored[0].drafts} ` +
        `instead of ${row.drafts_correct} — a silently inflated win rate.`,
    );
  }
}

// ===========================================================================
// 4 — the five-draft minimum
// ===========================================================================

function verifyUnranked(board) {
  heading(`4. A model under ${MIN_DRAFTS_TO_RANK} drafts is UNRANKED, not dropped`);

  table([...board.ranked, ...board.unranked], [
    { label: 'MODEL', value: (row) => row.displayName },
    { label: 'DRAFTS', value: (row) => row.drafts },
    { label: 'WHERE', value: (row) => (row.draftsNeeded === undefined ? 'ranked' : 'unranked') },
    { label: 'NEEDS', value: (row) => row.draftsNeeded ?? '—' },
  ]);

  check('the threshold travels with the response', board.minDrafts === MIN_DRAFTS_TO_RANK);
  check(
    'every ranked model has at least the minimum',
    board.ranked.every((row) => row.drafts >= MIN_DRAFTS_TO_RANK),
  );
  check(
    'every unranked model is genuinely under it',
    board.unranked.every((row) => row.drafts < MIN_DRAFTS_TO_RANK),
  );
  check(
    'there IS an unranked model, so this is checking something',
    board.unranked.length > 0,
    `${board.unranked.length}`,
  );
  check(
    'draftsNeeded is the gap, computed by the server',
    board.unranked.every((row) => row.draftsNeeded === MIN_DRAFTS_TO_RANK - row.drafts),
  );
  check(
    'no unranked model appears on the podium',
    board.ranked
      .slice(0, board.podiumSize)
      .every((row) => !board.unranked.some((other) => other.modelId === row.modelId)),
  );
  check(
    'ranked is ordered by win rate, descending',
    board.ranked.every((row, index) => index === 0 || board.ranked[index - 1].winRate >= row.winRate),
  );
}

// ===========================================================================
// 11 — scope=mine against scope=all
// ===========================================================================

async function verifyScope(client, ownerEmail) {
  heading('11. scope=mine and scope=all return different numbers');

  const all = (await client.get('/leaderboard?scope=all&days=30')).body.leaderboard;
  const mine = (await client.get('/leaderboard?scope=mine&days=30')).body.leaderboard;

  const total = (board) => board.ranked.concat(board.unranked).reduce((sum, row) => sum + row.drafts, 0);

  console.log(`  scope=all   ${all.ranked.length} ranked, ${all.unranked.length} unranked, ${total(all)} drafts in total`);
  console.log(`  scope=mine  ${mine.ranked.length} ranked, ${mine.unranked.length} unranked, ${total(mine)} drafts in total  (${ownerEmail})`);

  check('scope=all sees drafts', total(all) > 0, `${total(all)}`);
  check(
    'scope=mine sees fewer than scope=all — this account has one round, the database has dozens',
    total(mine) < total(all),
    `${total(mine)} < ${total(all)}`,
  );
  check('the response echoes the scope it applied', all.scope === 'all' && mine.scope === 'mine');
  check('the response echoes the window', all.days === 30 && mine.days === 30);

  /** The default matters: an empty personal board is a bad first impression. */
  const bare = (await client.get('/leaderboard')).body.leaderboard;
  check('a bare GET defaults to scope=all', bare.scope === 'all', bare.scope);
  check('a bare GET defaults to 30 days', bare.days === 30, String(bare.days));

  const rejected = await client.get('/leaderboard?scope=everyone');
  check('an unknown scope is a 400', rejected.status === 400, String(rejected.status));

  const tooLong = await client.get('/leaderboard?days=100000');
  check('an unbounded window is a 400', tooLong.status === 400, String(tooLong.status));

  const anonymous = await anonymousGet('/leaderboard');
  check('the leaderboard needs a session', anonymous.status === 401, String(anonymous.status));
}

// ===========================================================================
// 5 — uploads: what is accepted and what is not
// ===========================================================================

async function verifyUploadRules(client) {
  heading('5. UPLOADS: the bytes decide, not the name and not the header');

  const png = readFileSync(IMAGE_PATH);

  const honest = await client.upload('/attachments', {
    bytes: png,
    filename: 'board.png',
    contentType: 'image/png',
  });

  check('a real PNG is 201', honest.status === 201, String(honest.status));
  check('the stored type is image/png', honest.body?.attachment.mimeType === 'image/png');
  check('it is classified as an image', honest.body?.attachment.kind === 'image');
  check('a signed URL comes back', Boolean(honest.body?.attachment.signedUrl));
  check(
    'the signed URL is not a public object path',
    honest.body?.attachment.signedUrl?.includes('/object/sign/') === true,
  );
  check(
    'the storage path is NOT on the wire',
    !JSON.stringify(honest.body).includes('storagePath') &&
      !JSON.stringify(honest.body).includes('storage_path'),
  );

  /** THE MAGIC-BYTE CHECK. PDF bytes, a .png name, and an image/png header. */
  const liar = Buffer.from('%PDF-1.7\n% not a png at all\n');
  const lying = await client.upload('/attachments', {
    bytes: liar,
    filename: 'definitely-a-picture.png',
    contentType: 'image/png',
  });

  check(
    'PDF bytes with a .png name and an image/png header are REFUSED',
    lying.status === 415,
    `${lying.status} ${lying.body?.error?.code ?? ''}`,
  );
  check('the refusal names the mismatch', lying.body?.error?.code === 'FILE_TYPE_MISMATCH');
  check(
    'the message says renaming will not help',
    /contents are application\/pdf/.test(lying.body?.error?.message ?? ''),
  );

  /** A type that is on no list at all, honestly declared. */
  const text = await client.upload('/attachments', {
    bytes: Buffer.from('just some words'),
    filename: 'notes.txt',
    contentType: 'text/plain',
  });

  check(
    'an unsupported type is 415 UNSUPPORTED_FILE_TYPE',
    text.status === 415 && text.body?.error?.code === 'UNSUPPORTED_FILE_TYPE',
    `${text.status} ${text.body?.error?.code ?? ''}`,
  );

  /** 9 MB — multer aborts the stream and the error becomes our 413. */
  const oversize = Buffer.alloc(9 * 1024 * 1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversize);

  const large = await client.upload('/attachments', {
    bytes: oversize,
    filename: 'huge.png',
    contentType: 'image/png',
  });

  check(
    'a 9 MB file is 413 in OUR envelope',
    large.status === 413 && large.body?.error?.code === 'FILE_TOO_LARGE',
    `${large.status} ${large.body?.error?.code ?? ''}`,
  );
  check(
    'the 413 body is the standard envelope',
    typeof large.body?.error?.message === 'string' && typeof large.body?.error?.code === 'string',
  );

  const anonymous = await send(`${BASE}/attachments`, { method: 'POST' });
  check('an anonymous upload is 401', anonymous.status === 401, String(anonymous.status));

  return honest.body.attachment;
}

// ===========================================================================
// 7 — a PDF, and the model that cannot read one
// ===========================================================================

/**
 * The PDF path is NOT the image path with a different media type. OpenRouter
 * carries a document as a `file` content part, and the set of models accepting
 * one is smaller than the set accepting an image — measured against the live
 * catalogue, Llama 4 Maverick takes images and refuses documents. So there are
 * two modality columns, and this is the check that the second one is real.
 */
async function verifyPdfRound(client, models) {
  heading('7. A REAL DEBATE with a PDF, on a council containing an images-only model');

  const chairman = models.find((model) => model.supports_documents);
  const readers = models
    .filter((model) => model.supports_documents && model.id !== chairman.id)
    .slice(0, 2);
  /** Vision but no documents — the case a single `supportsVision` flag misses. */
  const imagesOnly = models.find((model) => model.supports_vision && !model.supports_documents);

  console.log('  Measured against the live OpenRouter catalogue (architecture.input_modalities):');
  table(models.filter((model) => model.is_active), [
    { label: 'MODEL', value: (model) => model.display_name },
    { label: 'IMAGES', value: (model) => (model.supports_vision ? 'yes' : 'no') },
    { label: 'DOCUMENTS', value: (model) => (model.supports_documents ? 'yes' : 'no') },
  ]);

  if (!imagesOnly) {
    check('the catalogue has an images-only model to seat', false, 'none found');
    return;
  }

  const council = {
    modelIds: [chairman.id, ...readers.map((model) => model.id), imagesOnly.id],
    chairmanId: chairman.id,
  };

  const session = await client.post('/sessions', { title: 'PDF verification', council });
  const pdf = makeProbePdf();

  const uploaded = await client.upload('/attachments', {
    bytes: pdf,
    filename: 'probe.pdf',
    contentType: 'application/pdf',
  });

  check('a PDF uploads', uploaded.status === 201, String(uploaded.status));
  check('it is classified as a document', uploaded.body?.attachment.kind === 'document');
  check('and stored as application/pdf', uploaded.body?.attachment.mimeType === 'application/pdf');

  const started = await client.post(`/sessions/${session.body.session.id}/rounds`, {
    prompt:
      'A PDF is attached. Quote the passphrase written inside it, exactly. ' +
      'If you cannot read the document, say so in one line and do not guess.',
    attachmentIds: [uploaded.body.attachment.id],
  });

  check('the round starts', started.status === 202, String(started.status));
  if (started.status !== 202) return;

  const round = await waitForRound(client, started.body.roundId);
  check('the round completed', round.status === 'complete', round.status);

  const drafts = round.responses.filter((response) => response.stage === 'draft');

  for (const draft of drafts) {
    console.log(`\n  --- ${draft.modelName} (Draft ${draft.label}) ---`);
    console.log(
      (draft.content ?? draft.errorText ?? '')
        .split('\n')
        .slice(0, 5)
        .map((line) => `  ${line}`)
        .join('\n'),
    );
  }

  console.log('');

  const quoted = (draft) => draft?.content?.includes(PDF_PASSPHRASE) === true;
  const blindDraft = drafts.find((draft) => draft.modelName === imagesOnly.display_name);
  const readerDrafts = drafts.filter((draft) => draft.modelName !== imagesOnly.display_name);

  check(
    'a document-capable drafter quoted the passphrase from inside the PDF',
    readerDrafts.some(quoted),
    readerDrafts.map((draft) => `${draft.modelName}:${quoted(draft)}`).join(' '),
  );
  check(
    `${imagesOnly.display_name} takes images but not documents, so it was NOT sent the PDF`,
    !quoted(blindDraft),
  );
  check(
    'and it drafted anyway rather than failing the round',
    Boolean(blindDraft?.content) && !blindDraft?.errorText,
  );
}

// ===========================================================================
// 8 — somebody else's attachment
// ===========================================================================

async function verifyAttachmentOwnership(intruder, attachment, sessionId) {
  heading("8. ANOTHER USER'S attachment id");

  const deleted = await intruder.del(`/attachments/${attachment.id}`);
  check(
    'DELETE on it is 403',
    deleted.status === 403,
    `${deleted.status} ${deleted.body?.error?.code ?? ''}`,
  );

  const used = await intruder.post(`/sessions/${sessionId}/rounds`, {
    prompt: 'Whose file is this?',
    attachmentIds: [attachment.id],
  });

  /**
   * 403 whichever way it is refused. The intruder does not own the session
   * either, and that check fires first — which is the correct order and worth
   * asserting rather than working around: ownership of the resource in the path
   * is settled before anything in the body is read.
   */
  check(
    "using it on somebody else's session is 403",
    used.status === 403,
    `${used.status} ${used.body?.error?.code ?? ''}`,
  );

  const own = await intruder.post('/sessions', {
    title: 'Intruder session',
    council: await minimalCouncil(),
  });

  const onOwnSession = await intruder.post(`/sessions/${own.body.session.id}/rounds`, {
    prompt: 'Whose file is this?',
    attachmentIds: [attachment.id],
  });

  check(
    "using it on the intruder's OWN session is still 403",
    onOwnSession.status === 403,
    `${onOwnSession.status} ${onOwnSession.body?.error?.code ?? ''}`,
  );
  check(
    'the code does not distinguish "not yours" from "does not exist"',
    onOwnSession.body?.error?.code === 'ATTACHMENT_NOT_AVAILABLE',
  );

  const invented = await intruder.post(`/sessions/${own.body.session.id}/rounds`, {
    prompt: 'And this one?',
    attachmentIds: ['00000000-0000-4000-8000-000000000000'],
  });

  check(
    'an id that never existed gets the identical refusal',
    invented.status === 403 && invented.body?.error?.code === onOwnSession.body?.error?.code,
    `${invented.status} ${invented.body?.error?.code ?? ''}`,
  );
}

/** Three models, because the chairman abstains by default and two drafters is
 *  the engine's floor — a two-model council is INSUFFICIENT_COUNCIL. */
async function minimalCouncil() {
  const [chairman, ...drafters] = await listActiveModels();

  return {
    modelIds: [chairman.id, drafters[0].id, drafters[1].id],
    chairmanId: chairman.id,
  };
}

// ===========================================================================
// 6 — the real round: vision models read it, a text-only one says it cannot
// ===========================================================================

async function verifyAttachedRound(client, models) {
  heading('6. A REAL DEBATE with a PNG attached, on a council containing a text-only model');

  const chairman = models.find((model) => model.supports_vision);
  const vision = models.filter((model) => model.supports_vision && model.id !== chairman.id).slice(0, 2);
  const textOnly = models.find((model) => !model.supports_vision);

  if (!textOnly) {
    check('the catalogue has a text-only model to seat', false, 'none found');
    return null;
  }

  const council = {
    modelIds: [chairman.id, ...vision.map((model) => model.id), textOnly.id],
    chairmanId: chairman.id,
  };

  console.log(
    `  chairman: ${chairman.display_name} (abstains)\n` +
      `  drafters: ${[...vision, textOnly]
        .map((model) => `${model.display_name} [vision=${model.supports_vision}]`)
        .join(', ')}\n`,
  );

  const session = await client.post('/sessions', { title: 'Attachment verification', council });
  const sessionId = session.body.session.id;

  const png = readFileSync(IMAGE_PATH);
  const uploaded = await client.upload('/attachments', {
    bytes: png,
    filename: 'board.png',
    contentType: 'image/png',
  });

  const attachmentId = uploaded.body.attachment.id;

  const started = await client.post(`/sessions/${sessionId}/rounds`, {
    prompt:
      'What does this attached image show? Name the top three models on the podium and their win rates. ' +
      'If you cannot see it, say so in one line.',
    attachmentIds: [attachmentId],
  });

  check('the round starts — a text-only council member is NOT a 400', started.status === 202, String(started.status));
  check('the 202 echoes the attachment it claimed', started.body?.attachmentIds?.[0] === attachmentId);

  if (started.status !== 202) return null;

  const roundId = started.body.roundId;
  const round = await waitForRound(client, roundId);

  check('the round completed', round.status === 'complete', round.status);
  check('the round carries its attachment', round.attachments?.length === 1);
  check(
    'the persisted attachment has a freshly signed URL',
    round.attachments?.[0]?.signedUrl?.includes('/object/sign/') === true,
  );

  const drafts = round.responses.filter((response) => response.stage === 'draft');

  for (const draft of drafts) {
    console.log(`\n  --- ${draft.modelName} (Draft ${draft.label}) ---`);
    console.log(
      (draft.content ?? draft.errorText ?? '')
        .split('\n')
        .slice(0, 8)
        .map((line) => `  ${line}`)
        .join('\n'),
    );
  }

  console.log('');

  const blindDraft = drafts.find((draft) => draft.modelName === textOnly.display_name);
  const sightedDrafts = drafts.filter((draft) => draft.modelName !== textOnly.display_name);

  /**
   * "Claude Sonnet 4.5" and "68%" are printed on mockup 07 and appear nowhere in
   * the prompt, so a draft containing either read the image. Two independent
   * markers, because one could in principle be guessed.
   */
  const sawIt = (text) => /claude sonnet 4\.5/i.test(text ?? '') || /68\s*%/.test(text ?? '');
  const saidBlind = (text) => /(could not|cannot|can't|unable to) (see|view|read|access)/i.test(text ?? '');

  check(
    'every vision drafter described the image',
    sightedDrafts.length > 0 && sightedDrafts.every((draft) => sawIt(draft.content)),
    sightedDrafts.map((draft) => `${draft.modelName}:${sawIt(draft.content)}`).join(' '),
  );
  check(
    'the text-only drafter still produced a draft',
    Boolean(blindDraft?.content) && !blindDraft?.errorText,
  );
  check(
    'the text-only drafter said it could not see the image',
    saidBlind(blindDraft?.content),
  );
  check(
    'and did NOT invent its contents',
    !sawIt(blindDraft?.content),
  );

  /** The client derives the "could not see it" marker from these two fields. */
  const councilOnRound = round.council;
  const textOnlyMember = councilOnRound.find((member) => member.displayName === textOnly.display_name);

  check(
    'the round council carries supportsVision, so a reload can mark it',
    textOnlyMember?.supportsVision === false,
    JSON.stringify(textOnlyMember),
  );
  check(
    'and carries it as true for the models that could see',
    councilOnRound
      .filter((member) => vision.some((model) => model.display_name === member.displayName))
      .every((member) => member.supportsVision === true),
  );

  return { sessionId, roundId, attachmentId, round };
}

async function waitForRound(client, roundId) {
  const deadline = Date.now() + 180_000;

  while (Date.now() < deadline) {
    const { body } = await client.get(`/rounds/${roundId}`);

    if (body?.round?.status === 'complete' || body?.round?.status === 'failed') return body.round;

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`round ${roundId} did not settle within 180s`);
}

// ===========================================================================
// 9 — the shared view's signed URLs
// ===========================================================================

async function verifySharedAttachment(client, sessionId) {
  heading('9. A SHARED session with an attachment: signed, short-lived, and no path');

  const shared = await client.post(`/sessions/${sessionId}/share`);
  const token = shared.body?.shareToken;

  check('the session shares', shared.status === 200 && Boolean(token));

  const { status, body } = await anonymousGet(`/share/${token}`);
  const round = body?.session?.rounds?.[0];
  const attachment = round?.attachments?.[0];

  check('the public read is 200 without a cookie', status === 200, String(status));
  check('the shared round carries its attachment', Boolean(attachment));
  check('with a signed URL', attachment?.signedUrl?.includes('/object/sign/') === true);

  /** The credential must actually work, or the page shows a broken image. */
  const fetched = await fetch(attachment.signedUrl);
  check('the signed URL fetches the bytes', fetched.ok, String(fetched.status));
  check(
    'and the bytes are a PNG',
    Buffer.from(await fetched.arrayBuffer()).subarray(0, 4).toString('hex') === '89504e47',
  );

  /** The expiry is IN the token, so it can be read rather than waited out. */
  const jwt = new URL(attachment.signedUrl).searchParams.get('token');
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  const lifetimeSeconds = claims.exp - claims.iat;

  console.log(`\n  signed URL lifetime: ${lifetimeSeconds}s (issued ${new Date(claims.iat * 1000).toISOString()})`);

  check('the shared URL expires', Number.isFinite(claims.exp));
  check(
    'it lives 5 minutes — shorter than the owner\'s 10',
    lifetimeSeconds === 300,
    `${lifetimeSeconds}s`,
  );

  /** A token cannot outlive its expiry: forge the clock by asking for a stale
   *  one. Supabase signs `exp` into the JWT, so tampering invalidates it. */
  const tampered = attachment.signedUrl.replace(/token=.+$/, 'token=not-a-real-token');
  const refused = await fetch(tampered);

  check('a tampered signature is refused', !refused.ok, String(refused.status));

  /** Everything the allow-list withholds, checked structurally. */
  const flat = JSON.stringify(body);

  check('no storagePath anywhere in the shared payload', !/storage_?[Pp]ath/.test(flat));
  check('no cost field anywhere', !/"(cost|totalCost|total_cost|avgCost)"/.test(flat));
  check('no email anywhere', !/@example\.com/.test(flat));
  check('no share token echoed back', !flat.includes(`"shareToken"`));

  /**
   * THE ONE THING THAT DOES CROSS, asserted rather than discovered. A signed URL
   * contains the object's path, and the path is `userId/uuid.ext` — so the
   * owner's uuid is inside the URL. It is not an identity and it grants nothing,
   * but it makes two shared links from one owner linkable, and shareService's
   * header says so. Naming it here means a change to the path layout will show
   * up as this check flipping rather than as nobody noticing.
   */
  const ownerId = /attachments\/([0-9a-f-]{36})\//.exec(attachment.signedUrl)?.[1] ?? null;

  check(
    'KNOWN AND ACCEPTED: the signed URL contains the owner uuid, because the object path does',
    ownerId !== null,
    ownerId ?? 'no uuid in the path — the layout changed, update shareService and this check',
  );
  check(
    'that uuid appears ONLY inside the signed URL, never as a field',
    !new RegExp(`"[^"]*[Ii]d"\\s*:\\s*"${ownerId}"`).test(flat),
  );

  return token;
}

// ===========================================================================
// 10 — deleting an attachment
// ===========================================================================

async function verifyDelete(client) {
  heading('10. DELETE removes the object as well as the row');

  const uploaded = await client.upload('/attachments', {
    bytes: readFileSync(IMAGE_PATH),
    filename: 'to-delete.png',
    contentType: 'image/png',
  });

  const { id, signedUrl } = uploaded.body.attachment;

  const before = await fetch(signedUrl);
  check('the object is there before the delete', before.ok, String(before.status));

  const deleted = await client.del(`/attachments/${id}`);
  check('DELETE is 204', deleted.status === 204, String(deleted.status));

  const { rows } = await query('SELECT id FROM attachments WHERE id = $1', [id]);
  check('the row is gone', rows.length === 0);

  const after = await fetch(signedUrl);
  check(
    'the object is gone too — the signed URL now 404s',
    !after.ok,
    `${after.status}`,
  );

  const again = await client.del(`/attachments/${id}`);
  check('deleting it twice is a 404, not a 500', again.status === 404, String(again.status));
}

// ===========================================================================

async function main() {
  const owner = makeClient();
  const intruder = makeClient();

  await register(owner, OWNER_EMAIL);
  await register(intruder, INTRUDER_EMAIL);

  const models = await listActiveModels();

  await verifyQueryPlan();
  const board = await verifyByHand(owner);
  await verifyDenominatorTrap();
  verifyUnranked(board);

  const staged = await verifyUploadRules(owner);
  const debate = await verifyAttachedRound(owner, models);
  await verifyPdfRound(owner, models);

  if (debate) {
    await verifyAttachmentOwnership(intruder, staged, debate.sessionId);
    const token = await verifySharedAttachment(owner, debate.sessionId);

    heading('A shared debate with an image, left live for the browser check');
    console.log(`  http://localhost:5173/s/${token}`);
  }

  await verifyDelete(owner);
  await verifyScope(owner, OWNER_EMAIL);

  heading(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`);
  for (const failure of failures) console.log(`  - ${failure}`);

  process.exitCode = failures.length === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error('\nverify-leaderboard aborted:', error);
  process.exitCode = 1;
} finally {
  await closePool();
}
