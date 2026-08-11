#!/usr/bin/env node
/**
 * Proof that presets, sharing and the sessions list work — and, above all, that
 * the one public route in the product leaks nothing.
 *
 * The server must already be running — `npm run dev` in another terminal. Every
 * check drives it over fetch, so what is verified is the bytes we send.
 *
 * It costs NOTHING to run: not a single OpenRouter call. Every check needs
 * sessions and rounds rather than debates, so the rounds are inserted directly
 * with psql. That is a deliberate departure from verify-debate and verify-http,
 * which spend real money because what they check IS the model traffic; nothing
 * here is.
 *
 *   npm run verify:sharing
 *
 * WRITES to the database and leaves everything behind.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool } from '../src/db/pool.js';
import { listActiveModels } from '../src/models/llmModel.js';
import { findUserByEmail } from '../src/models/userModel.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const BASE = 'http://localhost:3000/api';

/** Registered fresh on every run, so check 1 sees a genuinely new account. */
const OWNER = { password: 'the owner of these sessions' };
/** A second account, for the 403s. */
const INTRUDER = { email: 'share-verify-intruder@example.com', password: 'not my sessions at all' };

const failures = [];

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

function psql(sql) {
  const result = spawnSync(process.execPath, [path.join(currentDir, 'psql.js'), '-c', sql], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

function firstValue(output) {
  return output.split('\n')[2]?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * One retry on ECONNRESET, and it is about this script rather than the server.
 * Node's fetch keeps sockets alive and Node's HTTP server hangs up an idle one
 * after five seconds, so a check that spends longer than that shelling out to
 * psql between requests hands the next request a socket the server has already
 * closed. Nothing else is retried — a real failure must fail. Same helper, same
 * reason, as verify-wallet.
 */
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

  async function request(method, path, body) {
    const response = await send(`${BASE}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
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
    patch: (path, body) => request('PATCH', path, body),
    del: (path) => request('DELETE', path),
  };
}

/** No cookie jar at all — the logged-out reader. */
async function anonymousGet(path) {
  const response = await send(`${BASE}${path}`);
  const text = await response.text();
  const isJson = response.headers.get('content-type')?.includes('application/json');

  return { status: response.status, body: isJson && text ? JSON.parse(text) : null, text };
}

// ---------------------------------------------------------------------------
// 1 — a new account is seeded with two presets
// ---------------------------------------------------------------------------

async function verifySeedPresets(client, email) {
  heading('1. A NEW account is registered with two presets already in it');

  const registered = await client.post('/auth/register', {
    email,
    password: OWNER.password,
    displayName: 'Share Verification',
  });

  check('registration succeeded', registered.status === 201, String(registered.status));

  const { status, body } = await client.get('/presets');
  const presets = body?.presets ?? [];

  console.log(
    presets
      .map(
        (preset) =>
          `  ${preset.name.padEnd(16)} ${preset.council.models
            .map((model) => `${model.displayName}${model.isChairman ? ' (chair)' : ''}`)
            .join(', ')}  abstains=${preset.chairmanAbstains}`,
      )
      .join('\n'),
  );

  check('GET /api/presets is 200', status === 200);
  check('two presets exist', presets.length === 2, `${presets.length}`);
  check('one is "Full council"', presets.some((preset) => preset.name === 'Full council'));
  check('one is "Cheap draft"', presets.some((preset) => preset.name === 'Cheap draft'));

  const full = presets.find((preset) => preset.name === 'Full council');
  const cheap = presets.find((preset) => preset.name === 'Cheap draft');
  const models = await listActiveModels();

  check(
    'Full council holds every active model',
    full?.council.models.length === models.length,
    `${full?.council.models.length} of ${models.length}`,
  );
  check('Full council has the chairman abstaining', full?.chairmanAbstains === true);
  check('Cheap draft holds two models', cheap?.council.models.length === 2);
  check(
    'Cheap draft has the chairman DRAFTING — two models abstaining cannot debate',
    cheap?.chairmanAbstains === false,
  );

  const cheapest = [...models].sort((a, b) => Number(a.output_per_1k) - Number(b.output_per_1k))[0];

  check(
    'the cheapest model chairs both',
    full?.council.chairmanId === cheapest.id && cheap?.council.chairmanId === cheapest.id,
  );
  check(
    'the ids are real catalogue ids, not hard-coded',
    full?.council.models.every((model) => models.some((row) => row.id === model.id)),
  );

  return presets;
}

// ---------------------------------------------------------------------------
// 2 and 3 — preset CRUD, the 409, and duplicate
// ---------------------------------------------------------------------------

async function verifyPresetCrud(client, models) {
  heading('2 & 3. Preset CRUD, a duplicate name, and the council rules at save time');

  const council = {
    modelIds: models.slice(0, 3).map((model) => model.id),
    chairmanId: models[0].id,
  };

  const created = await client.post('/presets', {
    name: 'Fact-check trio',
    council,
    chairmanAbstains: true,
    rebuttalEnabled: true,
  });

  check('POST /api/presets is 201', created.status === 201, String(created.status));
  check('it echoes the council back in a session-shaped block', Boolean(created.body?.preset?.council?.chairmanId));

  const presetId = created.body.preset.id;

  const duplicate = await client.post('/presets', { name: 'Fact-check trio', council });

  console.log(`  duplicate name: ${duplicate.status} ${duplicate.body?.error?.code}`);
  console.log(`  message: ${duplicate.body?.error?.message}`);

  check('a duplicate name is 409', duplicate.status === 409, String(duplicate.status));
  check('with CONFLICT', duplicate.body?.error?.code === 'CONFLICT');
  check('and a readable message naming the preset', duplicate.body?.error?.message?.includes('Fact-check trio'));

  const cased = await client.post('/presets', { name: 'FACT-CHECK TRIO', council });
  check('and the check is case-insensitive', cased.status === 409, String(cased.status));

  const renamed = await client.patch(`/presets/${presetId}`, { name: 'Fact-check pair' });
  check('PATCH renames', renamed.status === 200 && renamed.body.preset.name === 'Fact-check pair');

  const recrewed = await client.patch(`/presets/${presetId}`, {
    council: { modelIds: models.slice(0, 4).map((model) => model.id), chairmanId: models[1].id },
  });

  check('PATCH replaces the line-up', recrewed.status === 200);
  check('the new line-up is four models', recrewed.body?.preset?.council?.models?.length === 4);
  check('with the new chairman', recrewed.body?.preset?.council?.chairmanId === models[1].id);

  // Duplicate, which is a read the client already has plus a POST it already has.
  const source = recrewed.body.preset;
  const duplicated = await client.post('/presets', {
    name: `${source.name} copy`,
    council: {
      modelIds: source.council.models.map((model) => model.id),
      chairmanId: source.council.chairmanId,
    },
    chairmanAbstains: source.chairmanAbstains,
    rebuttalEnabled: source.rebuttalEnabled,
  });

  check('"Duplicate" is a create from the row already on screen', duplicated.status === 201);
  check(
    'and it copies the line-up exactly',
    duplicated.body.preset.council.models.length === source.council.models.length &&
      duplicated.body.preset.council.chairmanId === source.council.chairmanId,
  );

  // A council that could never debate is refused at SAVE time, not at round time.
  const impossible = await client.post('/presets', {
    name: 'Two abstaining',
    council: { modelIds: models.slice(0, 2).map((model) => model.id), chairmanId: models[0].id },
    chairmanAbstains: true,
  });

  console.log(`\n  2 models, chairman abstaining: ${impossible.status} ${impossible.body?.error?.code}`);
  check(
    'a preset that could never hold a debate is refused when saved',
    impossible.status === 400 && impossible.body?.error?.code === 'INSUFFICIENT_COUNCIL',
    impossible.body?.error?.code,
  );

  const removed = await client.del(`/presets/${duplicated.body.preset.id}`);
  check('DELETE is 204', removed.status === 204, String(removed.status));

  const after = await client.get('/presets');
  check(
    'and it is gone from the list',
    !after.body.presets.some((preset) => preset.id === duplicated.body.preset.id),
  );

  return presetId;
}

// ---------------------------------------------------------------------------
// 4 — another user's preset
// ---------------------------------------------------------------------------

async function verifyPresetOwnership(intruder, presetId, models) {
  heading("4. Another user's preset — PATCH and DELETE");

  const patched = await intruder.patch(`/presets/${presetId}`, { name: 'Mine now' });
  const removed = await intruder.del(`/presets/${presetId}`);
  const badId = await intruder.patch('/presets/not-a-uuid', { name: 'x' });

  console.log(`  PATCH: ${patched.status} ${patched.body?.error?.code}`);
  console.log(`  DELETE: ${removed.status} ${removed.body?.error?.code}`);
  console.log(`  PATCH with a non-uuid: ${badId.status} ${badId.body?.error?.code}`);

  check('PATCH is 403', patched.status === 403, String(patched.status));
  check('DELETE is 403', removed.status === 403, String(removed.status));
  check('and neither is a 404 — the row exists, it is simply not theirs', patched.body?.error?.code === 'FORBIDDEN');
  check(
    'a non-uuid id is a 400 from Zod, not a 500 from Postgres',
    badId.status === 400,
    String(badId.status),
  );

  const stillThere = firstValue(psql(`SELECT name FROM presets WHERE id = '${presetId}'`));
  check('the preset is untouched', stillThere === 'Fact-check pair', stillThere);
}

// ---------------------------------------------------------------------------
// 5–8 — sharing, and the thing that must not leak
// ---------------------------------------------------------------------------

/**
 * THE STRUCTURAL LEAK ASSERTION.
 *
 * Walks the whole response — every object, every array, to any depth — and
 * collects any key whose NAME suggests an identity or a price, plus any string
 * VALUE that looks like an email address. Asserted structurally rather than by
 * reading the JSON, because reading it proves the payload of the day and this
 * has to keep being true after somebody adds a field upstream.
 *
 * The value scan matters as much as the key scan: an owner's email could arrive
 * under a key called anything at all, and `user_id` under a key called `id`.
 */
const FORBIDDEN_KEY = /(^|_|\b)(user_?id|owner|email|cost|spend|balance|credit|price|prompt_?tokens|completion_?tokens|total_?cost|share_?token)($|_|\b)/i;
const EMAIL_VALUE = /[\w.+-]+@[\w-]+\.[\w.-]+/;

function findLeaks(node, trail = '$', found = []) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => findLeaks(item, `${trail}[${index}]`, found));
    return found;
  }

  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const at = `${trail}.${key}`;

      if (FORBIDDEN_KEY.test(key)) found.push({ at, reason: `key "${key}"`, value });

      findLeaks(value, at, found);
    }

    return found;
  }

  if (typeof node === 'string' && EMAIL_VALUE.test(node)) {
    found.push({ at: trail, reason: 'looks like an email address', value: node });
  }

  return found;
}

async function verifySharing(client, session, ownerEmail, ownerId) {
  heading('5–8. Sharing: the link, the public read, revoking, and a token that never existed');

  const shared = await client.post(`/sessions/${session.id}/share`);

  console.log(`  POST /share: ${shared.status}`);
  console.log(`  token: ${shared.body?.shareToken}`);
  console.log(`  url:   ${shared.body?.url}`);

  check('POST /share is 200', shared.status === 200, String(shared.status));
  check('it returns a token', typeof shared.body?.shareToken === 'string');
  check(
    'the token is 32 base64url characters — 24 bytes of CSPRNG',
    /^[A-Za-z0-9_-]{32}$/.test(shared.body?.shareToken ?? ''),
    `${shared.body?.shareToken?.length} chars`,
  );
  check('and a url pointing at /s/:token', shared.body?.url?.endsWith(`/s/${shared.body.shareToken}`));

  const again = await client.post(`/sessions/${session.id}/share`);
  check(
    'calling it twice is IDEMPOTENT — a link already sent must not break',
    again.body?.shareToken === shared.body.shareToken,
  );
  check('and it says it did not create one', again.body?.created === false);

  // -- 5: the logged-out read ---------------------------------------------

  const token = shared.body.shareToken;
  const anonymous = await anonymousGet(`/share/${token}`);
  const payload = anonymous.body?.session;

  check('GET /api/share/:token with NO cookie is 200', anonymous.status === 200, String(anonymous.status));
  check('it returns the session', Boolean(payload));
  check('with its title', payload?.title === session.title, payload?.title);
  check('its council', payload?.council?.models?.length > 0);
  check('and its rounds', payload?.rounds?.length > 0, `${payload?.rounds?.length} round(s)`);
  check(
    'each round carries its responses',
    payload?.rounds?.[0]?.responses?.length > 0,
    `${payload?.rounds?.[0]?.responses?.length} response(s)`,
  );
  check('and the label -> model map, so a reader sees who said what', payload?.rounds?.[0]?.labels?.length > 0);

  // -- 6: the leak assertion ----------------------------------------------

  heading('6. The public payload, asserted structurally to leak nothing');

  const raw = anonymous.text;
  const leaks = findLeaks(anonymous.body);

  console.log(`  payload: ${raw.length} bytes, ${payload?.rounds?.length ?? 0} rounds`);
  console.log(`  keys walked to any depth; ${leaks.length} suspicious`);

  if (leaks.length > 0) {
    for (const leak of leaks.slice(0, 10)) {
      console.log(`    LEAK ${leak.at} — ${leak.reason} = ${JSON.stringify(leak.value)?.slice(0, 80)}`);
    }
  }

  check('no key at any depth is a user id, an email, or a cost', leaks.length === 0, `${leaks.length} found`);

  // The three specific values, checked against the raw bytes as well — a
  // structural walk cannot catch a value spliced into a string.
  check("the owner's email does not appear anywhere in the bytes", !raw.includes(ownerEmail));
  check("the owner's user id does not appear anywhere in the bytes", !raw.includes(ownerId));
  check('the literal "cost" does not appear as a key', !/"[a-z_]*cost[a-z_]*"\s*:/i.test(raw));
  check('nor "totalCost"', !raw.includes('totalCost'));
  check('nor token counts', !raw.includes('promptTokens') && !raw.includes('completionTokens'));
  check('nor the share token itself, which is already in the URL', !raw.includes(token));

  // And prove the same fields ARE there on the owner's route, so the absence
  // above is the allow-list working rather than the data being missing.
  const owned = await client.get(`/sessions/${session.id}`);

  check(
    'the OWNER’s route does carry totalCost — the absence above is deliberate',
    owned.body?.session?.rounds?.[0]?.totalCost !== undefined,
  );

  // -- 7 and 8: revoked, and never-existed --------------------------------

  heading('7 & 8. A revoked token and a token that never existed');

  const revoked = await client.del(`/sessions/${session.id}/share`);
  check('DELETE /share is 204', revoked.status === 204, String(revoked.status));

  const afterRevoke = await anonymousGet(`/share/${token}`);
  const neverExisted = await anonymousGet('/share/ZmFrZS10b2tlbi10aGF0LW5ldmVyLXdhcw');

  console.log(`  revoked token:       ${afterRevoke.status} ${afterRevoke.body?.error?.code}`);
  console.log(`  token never issued:  ${neverExisted.status} ${neverExisted.body?.error?.code}`);
  console.log(`  revoked message:     ${afterRevoke.body?.error?.message}`);

  check('a revoked token is 404', afterRevoke.status === 404, String(afterRevoke.status));
  check('NOT 403 — a 403 would confirm the token was once real', afterRevoke.status !== 403);
  check('a token that never existed is 404 too', neverExisted.status === 404);
  check(
    'and the two responses are byte-identical, so neither confirms anything',
    afterRevoke.text === neverExisted.text,
  );

  const dbToken = firstValue(psql(`SELECT coalesce(share_token, 'NULL') FROM sessions WHERE id = '${session.id}'`));
  check('revoking wrote NULL rather than a tombstone', dbToken === 'NULL', dbToken);

  // Re-sharing mints a NEW token: the old link stays dead.
  const reshared = await client.post(`/sessions/${session.id}/share`);
  check('re-sharing mints a new token', reshared.body?.shareToken !== token);
  check('and the old link is still 404', (await anonymousGet(`/share/${token}`)).status === 404);

  // The owner-side half is guarded like everything else.
  const anonShare = await send(`${BASE}/sessions/${session.id}/share`, { method: 'POST' });
  check('POST /share without a cookie is 401', anonShare.status === 401, String(anonShare.status));

  return reshared.body.shareToken;
}

// ---------------------------------------------------------------------------
// 9 — search and the verdict filters
// ---------------------------------------------------------------------------

async function verifySearchAndFilters(client, sessions) {
  heading('9. Search, and each verdict filter');

  const all = await client.get('/sessions?limit=50');
  console.log(`  no filter: ${all.body.pagination.total} session(s)`);

  check('the unfiltered list holds every session', all.body.pagination.total >= sessions.length);

  const searched = await client.get('/sessions?limit=50&search=deadlock');
  const titles = searched.body.sessions.map((session) => session.title);

  console.log(`  ?search=deadlock -> ${titles.join(' | ')}`);

  check('search matches on the title', searched.body.sessions.length === 1, `${searched.body.sessions.length}`);
  check('and it is the right one', titles[0]?.toLowerCase().includes('deadlock'));
  check('the total matches the filter, not the table', searched.body.pagination.total === 1);

  const caseInsensitive = await client.get('/sessions?limit=50&search=DEADLOCK');
  check('search is case-insensitive (ILIKE)', caseInsensitive.body.sessions.length === 1);

  const empty = await client.get('/sessions?limit=50&search=');
  check('?search= is "no filter", not "titles that are empty"', empty.body.pagination.total === all.body.pagination.total);

  /**
   * `merged` is 2 and the rest are 1, and the 2 is the point rather than an
   * accident: the "Two rounds" fixture went picked then merged, so it joins the
   * single-round merged session here — and is absent from `picked` below, which
   * is what proves the filter reads the latest round rather than any of them.
   */
  for (const [verdict, expected] of Object.entries({
    merged: 2,
    picked: 1,
    synthesised: 1,
    unanimous: 1,
  })) {
    const filtered = await client.get(`/sessions?limit=50&verdict=${verdict}`);
    const rows = filtered.body.sessions;

    console.log(
      `  ?verdict=${verdict.padEnd(12)} -> ${rows.length}: ${rows.map((row) => row.title).join(', ')}`,
    );

    check(`?verdict=${verdict} returns ${expected}`, rows.length === expected, `${rows.length}`);
    check(
      `and every row's latest verdict IS ${verdict}`,
      rows.every((row) => row.latestVerdictType === verdict),
    );
  }

  /**
   * The filter is on the LATEST round, and this is the check that proves it
   * rather than asserting it: the multi-round session's first round was
   * `picked` and its second `merged`, so it must appear under merged and NOT
   * under picked. A filter reading "any round" would return it for both.
   */
  const multi = sessions.find((session) => session.title.includes('Two rounds'));
  const underMerged = await client.get('/sessions?limit=50&verdict=merged');
  const underPicked = await client.get('/sessions?limit=50&verdict=picked');

  check(
    'a session whose rounds went picked then merged appears under merged',
    underMerged.body.sessions.some((row) => row.id === multi.id),
  );
  check(
    'and NOT under picked — the filter is the latest round, not any round',
    !underPicked.body.sessions.some((row) => row.id === multi.id),
  );

  const both = await client.get('/sessions?limit=50&search=Two&verdict=merged');
  check('search and verdict compose', both.body.sessions.length === 1);

  const bad = await client.get('/sessions?limit=50&verdict=nonsense');
  check('an unknown verdict value is a 400', bad.status === 400, String(bad.status));

  const allChip = await client.get('/sessions?limit=50&verdict=all');
  check("the All chip's value is accepted as 'no filter'", allChip.body?.pagination?.total === all.body.pagination.total);
}

// ---------------------------------------------------------------------------
// 10 — the cascade, and what must survive it
// ---------------------------------------------------------------------------

async function verifyCascade(client, session, userId) {
  heading('10. Deleting a session — what goes, and what must NOT');

  const roundIds = psql(`SELECT id FROM rounds WHERE session_id = '${session.id}'`)
    .split('\n')
    .slice(2)
    .map((line) => line.trim())
    .filter((line) => line.length === 36);

  const roundId = roundIds[0];

  // A ledger row against one of this session's rounds, so the cascade has
  // something financial to threaten.
  psql(`
    INSERT INTO credit_transactions (user_id, round_id, type, amount, balance_after)
    VALUES ('${userId}', '${roundId}', 'debit', -0.005, 9.995)
  `);

  const before = {
    rounds: firstValue(psql(`SELECT count(*) FROM rounds WHERE session_id = '${session.id}'`)),
    responses: firstValue(
      psql(`SELECT count(*) FROM model_responses WHERE round_id IN (SELECT id FROM rounds WHERE session_id = '${session.id}')`),
    ),
    roundModels: firstValue(
      psql(`SELECT count(*) FROM round_models WHERE round_id IN (SELECT id FROM rounds WHERE session_id = '${session.id}')`),
    ),
    ledger: firstValue(psql(`SELECT count(*) FROM credit_transactions WHERE round_id = '${roundId}'`)),
  };

  console.log(`  before: ${JSON.stringify(before)}`);

  const removed = await client.del(`/sessions/${session.id}`);
  check('DELETE /api/sessions/:id is 204', removed.status === 204, String(removed.status));

  const after = {
    session: firstValue(psql(`SELECT count(*) FROM sessions WHERE id = '${session.id}'`)),
    rounds: firstValue(psql(`SELECT count(*) FROM rounds WHERE id = '${roundId}'`)),
    responses: firstValue(psql(`SELECT count(*) FROM model_responses WHERE round_id = '${roundId}'`)),
    roundModels: firstValue(psql(`SELECT count(*) FROM round_models WHERE round_id = '${roundId}'`)),
    sessionModels: firstValue(psql(`SELECT count(*) FROM session_models WHERE session_id = '${session.id}'`)),
  };

  console.log(`  after:  ${JSON.stringify(after)}`);

  check('the session is gone', after.session === '0');
  check('its rounds cascaded', after.rounds === '0');
  check('its model_responses cascaded', after.responses === '0');
  check('its round_models cascaded', after.roundModels === '0');
  check('its session_models cascaded', after.sessionModels === '0');

  const ledger = psql(`
    SELECT type, amount, coalesce(round_id::text, 'NULL') AS round_id
    FROM credit_transactions
    WHERE user_id = '${userId}' AND amount = -0.005
  `);

  console.log(`\n${ledger}\n`);

  const surviving = firstValue(
    psql(`SELECT count(*) FROM credit_transactions WHERE user_id = '${userId}' AND amount = -0.005`),
  );
  const roundRef = psql(`
    SELECT coalesce(round_id::text, 'NULL') AS round_id
    FROM credit_transactions WHERE user_id = '${userId}' AND amount = -0.005
  `);

  check(
    'THE LEDGER ROW SURVIVED — financial history outlives the conversation',
    surviving === '1',
    `${surviving} row(s)`,
  );
  check(
    'and its round_id was SET NULL rather than cascaded',
    firstValue(roundRef) === 'NULL',
    firstValue(roundRef),
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Sessions and rounds inserted directly, because nothing in this file checks a
 * debate — it checks lists, filters, links and cascades, and paying OpenRouter
 * $0.05 a run for rows that could be INSERTed is spending money to slow a test
 * down. The columns written are exactly the ones the engine writes.
 */
function seedFixtures(userId, models) {
  const chairman = models[0].id;
  const drafters = models.slice(1, 3);

  const sessions = [
    { title: 'Is RAG better than fine-tuning?', verdicts: ['merged'] },
    { title: 'Debug this SQL deadlock', verdicts: ['picked'] },
    { title: 'Explain CAP theorem simply', verdicts: ['unanimous'] },
    { title: 'Two rounds, picked then merged', verdicts: ['picked', 'merged'] },
    { title: 'Best pricing model for SaaS', verdicts: ['synthesised'] },
  ];

  const created = [];

  for (const spec of sessions) {
    const sessionId = firstValue(
      psql(`
        INSERT INTO sessions (user_id, title, chairman_abstains, rebuttal_enabled)
        VALUES ('${userId}', ${quote(spec.title)}, true, true)
        RETURNING id
      `),
    );

    psql(`
      INSERT INTO session_models (session_id, model_id, is_chairman)
      VALUES ('${sessionId}', '${chairman}', true)
        ${drafters.map((model) => `, ('${sessionId}', '${model.id}', false)`).join('')}
    `);

    for (const [index, verdict] of spec.verdicts.entries()) {
      const roundId = firstValue(
        psql(`
          INSERT INTO rounds (
            session_id, user_id, user_prompt, chairman_model_id, chairman_abstains,
            verdict_type, final_answer, status, total_cost, duration_ms, prompt_version, created_at
          )
          VALUES (
            '${sessionId}', '${userId}', ${quote(`${spec.title} — round ${index + 1}`)},
            '${chairman}', true, '${verdict}',
            ${quote(`The council settled on this after arguing. Round ${index + 1}.`)},
            'complete', 0.0071, 9400, 'v1', now() - interval '${spec.verdicts.length - index} minute'
          )
          RETURNING id
        `),
      );

      psql(`
        INSERT INTO round_models (round_id, model_id, role)
        VALUES ('${roundId}', '${chairman}', 'chairman')
          ${drafters.map((model) => `, ('${roundId}', '${model.id}', 'drafter')`).join('')}
      `);

      for (const [seat, model] of drafters.entries()) {
        psql(`
          INSERT INTO model_responses (
            round_id, model_id, stage, anon_label, content,
            prompt_tokens, completion_tokens, cost, latency_ms, provider
          )
          VALUES (
            '${roundId}', '${model.id}', 'draft', '${String.fromCharCode(65 + seat)}',
            ${quote(`Draft ${String.fromCharCode(65 + seat)}: an argued answer.`)},
            149, 275, 0.0012, 4100, 'Fixture'
          )
        `);
      }

      psql(`
        INSERT INTO model_responses (
          round_id, model_id, stage, content, prompt_tokens, completion_tokens, cost, latency_ms
        )
        VALUES (
          '${roundId}', '${chairman}', 'verdict',
          ${quote(JSON.stringify({ verdictType: verdict, winnerLabels: ['A'], reasoning: 'A was clearer.', answer: 'The merged answer.' }))},
          827, 285, 0.0019, 5200
        )
      `);
    }

    created.push({ id: sessionId, title: spec.title });
  }

  return created;
}

/** Single quotes doubled — these strings are ours, but a title with an
 *  apostrophe would still end the literal. */
function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

// ---------------------------------------------------------------------------

async function main() {
  const health = await send('http://localhost:3000/api/health').catch(() => null);

  if (!health?.ok) {
    console.error('The server is not running. Start it with `npm run dev` in another terminal.');
    process.exitCode = 1;
    return;
  }

  const models = await listActiveModels();
  if (models.length < 4) throw new Error(`Need 4 active models, found ${models.length}`);

  /**
   * A fresh email per run, because check 1 is specifically about what a NEW
   * account is given and re-registering an existing one would skip it. The
   * timestamp comes from the clock rather than a counter so two runs on the
   * same day do not collide.
   */
  const ownerEmail = `share-verify-${Date.now()}@example.com`;

  const owner = makeClient();
  const intruder = makeClient();

  await verifySeedPresets(owner, ownerEmail);

  // The intruder may already exist from a previous run.
  const registered = await intruder.post('/auth/register', {
    email: INTRUDER.email,
    password: INTRUDER.password,
    displayName: 'The Other User',
  });
  if (registered.status !== 201) {
    await intruder.post('/auth/login', { email: INTRUDER.email, password: INTRUDER.password });
  }

  const ownerRow = await findUserByEmail(ownerEmail);
  console.log(`\n  owner:    ${ownerRow.id} (${ownerEmail})`);

  const presetId = await verifyPresetCrud(owner, models);
  await verifyPresetOwnership(intruder, presetId, models);

  const sessions = seedFixtures(ownerRow.id, models);
  console.log(`\n  seeded ${sessions.length} sessions with 6 rounds between them`);

  const shareable = sessions.find((session) => session.title.includes('RAG'));
  const token = await verifySharing(owner, shareable, ownerEmail, ownerRow.id);

  await verifySearchAndFilters(owner, sessions);
  await verifyCascade(owner, sessions.find((session) => session.title.includes('CAP')), ownerRow.id);

  heading('A shared link, left live for the browser check');
  console.log(`  http://localhost:5173/s/${token}`);
  console.log('  Open it in a logged-out window (incognito) — check 5 in the session brief.');

  heading(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`);
  for (const failure of failures) console.log(`  - ${failure}`);

  process.exitCode = failures.length === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error('\nverify-sharing aborted:', error);
  process.exitCode = 1;
} finally {
  await closePool();
}
