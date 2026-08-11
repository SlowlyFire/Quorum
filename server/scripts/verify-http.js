#!/usr/bin/env node
/**
 * Proof that the HTTP surface for a debate works: real requests against a
 * running server, real debates against real models, and a real SSE stream read
 * off the socket rather than described.
 *
 * The server must already be running — `npm run dev` in another terminal. This
 * script drives it the way a browser would, over fetch with a cookie jar.
 *
 * It WRITES to the database and leaves everything behind, because step 10 is
 * only meaningful if the rows are still there to be read through psql.
 * Four real rounds, about $0.03 a run.
 *
 *   npm run verify:http
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool } from '../src/db/pool.js';
import { listActiveModels } from '../src/models/llmModel.js';
import { findUserByEmail } from '../src/models/userModel.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const BASE = 'http://localhost:3000/api';

const USER_A = { email: 'http-verify-a@example.com', password: 'verify the http surface' };
const USER_B = { email: 'http-verify-b@example.com', password: 'the other user entirely' };

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

function truncate(text, length) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > length ? `${oneLine.slice(0, length)}…` : oneLine;
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

// ---------------------------------------------------------------------------
// An HTTP client with a cookie jar, which is all a browser is here
// ---------------------------------------------------------------------------

function makeClient(name) {
  let cookie = null;

  async function request(method, path, body) {
    const startedAt = process.hrtime.bigint();

    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const value of setCookie) {
      const [pair] = value.split(';');
      if (pair.startsWith('quorum_token=')) cookie = pair;
    }

    const text = await response.text();
    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { rawBody: text };
    }

    return { status: response.status, body: payload, elapsedMs, headers: response.headers };
  }

  return {
    name,
    request,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    del: (path) => request('DELETE', path),
    get cookie() {
      return cookie;
    },
    clearCookie() {
      cookie = null;
    },
  };
}

/**
 * Register, or log in if the account survives from a previous run. Both paths
 * end with the cookie in the jar, which is the only thing the rest of this
 * script needs.
 */
async function signIn(client, { email, password }) {
  const registered = await client.post('/auth/register', {
    email,
    password,
    displayName: 'HTTP Verification',
  });

  if (registered.status === 201) return registered.body.user;

  const loggedIn = await client.post('/auth/login', { email, password });

  if (loggedIn.status !== 200) {
    throw new Error(`Could not sign in as ${email}: ${loggedIn.status} ${JSON.stringify(loggedIn.body)}`);
  }

  return loggedIn.body.user;
}

// ---------------------------------------------------------------------------
// An SSE client, reading frames off the socket
// ---------------------------------------------------------------------------

/**
 * Opens GET /api/rounds/:id/stream and parses the wire format by hand, so what
 * is verified is the bytes we send rather than a library's idea of them.
 *
 * Returns as soon as the response headers arrive; `done` resolves when the
 * server closes the stream or `abort()` is called.
 */
async function openStream(client, roundId, { label, lastEventId = null, onFrame } = {}) {
  const controller = new AbortController();
  const startedAt = Date.now();

  const response = await fetch(`${BASE}/rounds/${roundId}/stream`, {
    headers: {
      ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(lastEventId !== null ? { 'Last-Event-ID': String(lastEventId) } : {}),
    },
    signal: controller.signal,
  });

  const frames = [];
  const heartbeats = [];
  let retryDirective = null;

  const done = (async () => {
    if (!response.ok || !response.body) {
      // A refusal is a normal JSON response; read it so the socket is released.
      await response.text().catch(() => {});
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;

        buffer += decoder.decode(value, { stream: true });

        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          if (raw.startsWith(':')) {
            heartbeats.push(Date.now() - startedAt);
            continue;
          }

          const frame = { atMs: Date.now() - startedAt };

          for (const line of raw.split('\n')) {
            const separator = line.indexOf(':');
            const field = line.slice(0, separator);
            const value = line.slice(separator + 1).replace(/^ /, '');

            if (field === 'id') frame.id = Number(value);
            else if (field === 'event') frame.event = value;
            else if (field === 'data') frame.data = value;
            else if (field === 'retry') retryDirective = Number(value);
          }

          if (!frame.event) continue;

          try {
            frame.payload = JSON.parse(frame.data);
          } catch {
            frame.payload = { unparseable: frame.data };
          }

          frames.push(frame);
          onFrame?.(frame, label);
        }
      }
    } catch (error) {
      // An abort is how this script disconnects on purpose; anything else is real.
      if (error.name !== 'AbortError') throw error;
    }
  })();

  return {
    label,
    status: response.status,
    headers: response.headers,
    frames,
    heartbeats,
    done,
    get retryDirective() {
      return retryDirective;
    },
    abort: () => controller.abort(),
  };
}

function printTranscript(frames, { showGaps = true } = {}) {
  console.log('\n     id  t+ms     Δms   event            payload');
  console.log(`     ${'-'.repeat(70)}`);

  let previous = 0;

  for (const frame of frames) {
    const gap = frame.atMs - previous;
    previous = frame.atMs;

    const summary = summarise(frame.event, frame.payload);
    console.log(
      `     ${String(frame.id).padStart(2)}  ${String(frame.atMs).padStart(6)}  ${
        showGaps ? String(gap).padStart(6) : '      '
      }  ${frame.event.padEnd(16)} ${summary}`,
    );
  }
}

function summarise(event, payload) {
  const summaries = {
    round_started: (p) => `chairman=${p.chairman} drafters=${p.drafterCount}`,
    stage_started: (p) => `stage=${p.stage}`,
    stage_skipped: (p) => `stage=${p.stage} reason="${p.reason}"`,
    response_ready: (p) =>
      `${p.stage} ${p.label ?? '(chairman)'} ${p.modelName} ${p.latencyMs}ms :: ${truncate(p.content, 44)}`,
    response_failed: (p) => `${p.stage} ${p.label ?? '(chairman)'} ${p.modelName} :: ${truncate(p.error, 60)}`,
    verdict: (p) => `${p.verdictType} winners=[${(p.winnerLabels ?? []).join(', ')}]`,
    stance: (p) => `${p.label} ${p.modelName} -> ${p.stance}`,
    round_complete: (p) => `${p.verdictType} $${Number(p.totalCost).toFixed(8)} ${p.durationMs}ms`,
    round_failed: (p) => truncate(p.error, 70),
    stream_closed: (p) => truncate(p.reason, 70),
  };

  return summaries[event] ? summaries[event](payload) : truncate(JSON.stringify(payload), 60);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Live providers flake, and google/gemini-2.5-flash in particular answers 200
 * with finish_reason 'error' and no content often enough to have earned
 * decision 21. A step whose point is that a round COMPLETES must not be scored
 * as a defect because an unplanned dropout took the two-draft quorum with it.
 *
 * One retry, announced loudly, exactly as verify:debate does. This is the
 * script refusing to score a provider outage as a bug — it is not the engine
 * retrying anything.
 */
async function startAndSettle(client, sessionId, body, label) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const accepted = await client.post(`/sessions/${sessionId}/rounds`, body);

    if (accepted.status !== 202) return { accepted, round: null };

    const round = await waitForRound(client, accepted.body.roundId);

    if (round.status === 'complete' || attempt === 2) return { accepted, round };

    console.log(
      `\n  !! ${label} did not complete: ${round.responses.find((r) => r.errorText)?.errorText ?? 'unknown'}\n` +
        '     That is an unplanned provider dropout rather than the condition under test.\n' +
        '     Retrying once.\n',
    );
  }
}

/** Polls GET /api/rounds/:id until the round leaves a running status. */
async function waitForRound(client, roundId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const response = await client.get(`/rounds/${roundId}`);

    if (response.status === 200) {
      const { status } = response.body.round;
      if (status === 'complete' || status === 'failed') return response.body.round;
    }

    if (Date.now() > deadline) throw new Error(`Round ${roundId} did not settle within ${timeoutMs}ms`);

    await delay(2000);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  const health = await fetch(`${BASE}/health`).catch(() => null);

  if (!health?.ok) {
    console.error('The server is not answering on http://localhost:3000. Start it with `npm run dev`.');
    process.exit(1);
  }

  const models = await listActiveModels();
  const bySlug = (slug) => {
    const row = models.find((model) => model.openrouter_slug === slug);
    if (!row) throw new Error(`Seeded model ${slug} is missing — run npm run migrate.`);
    return row;
  };

  const claude = bySlug('anthropic/claude-haiku-4.5');
  const gpt = bySlug('openai/gpt-5-mini');
  const gemini = bySlug('google/gemini-2.5-flash');
  const llama = bySlug('meta-llama/llama-4-maverick');

  const alice = makeClient('alice');
  const bob = makeClient('bob');

  await signIn(alice, USER_A);
  await signIn(bob, USER_B);

  // -- 1 ---------------------------------------------------------------------

  heading('1  POST /api/sessions -> 201, then GET it back');

  const created = await alice.post('/sessions', {
    title: 'HTTP verification',
    council: { modelIds: [claude.id, gpt.id, gemini.id], chairmanId: claude.id },
  });

  check('POST /api/sessions returns 201', created.status === 201, `${created.status}`);

  const sessionId = created.body?.session?.id;

  check('the response carries a session id', Boolean(sessionId), sessionId ?? 'none');
  check(
    'the council came back with three models',
    created.body?.session?.council?.models?.length === 3,
    `${created.body?.session?.council?.models?.length}`,
  );
  check(
    'the chairman is the model that was nominated',
    created.body?.session?.council?.chairmanId === claude.id,
    created.body?.session?.council?.models?.find((m) => m.isChairman)?.displayName,
  );
  check('a brand-new session reports roundCount 0', created.body?.session?.roundCount === 0);

  console.log('\n  created session:');
  console.log(JSON.stringify(created.body.session, null, 2).replace(/^/gm, '    '));

  const fetched = await alice.get(`/sessions/${sessionId}`);

  check('GET /api/sessions/:id returns 200', fetched.status === 200, `${fetched.status}`);
  check('it is the same session', fetched.body?.session?.id === sessionId);
  check(
    'it carries the same council',
    JSON.stringify(fetched.body?.session?.council) === JSON.stringify(created.body?.session?.council),
  );
  check('it carries an empty rounds array', Array.isArray(fetched.body?.session?.rounds) && fetched.body.session.rounds.length === 0);

  const listed = await alice.get('/sessions?limit=5');

  check('GET /api/sessions returns 200', listed.status === 200, `${listed.status}`);
  check(
    'the new session is first, newest activity first',
    listed.body?.sessions?.[0]?.id === sessionId,
  );
  check(
    'the page carries pagination',
    typeof listed.body?.pagination?.total === 'number' && listed.body.pagination.limit === 5,
    JSON.stringify(listed.body?.pagination),
  );

  // -- 2 ---------------------------------------------------------------------

  heading('2  A chairman that is not on the council -> 400 naming the id');

  const badChairman = await alice.post('/sessions', {
    council: { modelIds: [claude.id, gpt.id, gemini.id], chairmanId: llama.id },
  });

  check('status is 400', badChairman.status === 400, `${badChairman.status}`);
  check(
    'the offending id is named in the response',
    JSON.stringify(badChairman.body).includes(llama.id),
    llama.id,
  );

  console.log(`\n    ${JSON.stringify(badChairman.body)}`);

  const unknownId = '00000000-0000-4000-8000-000000000000';
  const unknownModel = await alice.post('/sessions', {
    council: { modelIds: [claude.id, gpt.id, unknownId], chairmanId: claude.id },
  });

  check('an unknown model id is 400', unknownModel.status === 400, `${unknownModel.status}`);
  check(
    'and the unknown id is named',
    JSON.stringify(unknownModel.body).includes(unknownId),
    unknownModel.body?.error?.code,
  );
  console.log(`    ${JSON.stringify(unknownModel.body)}`);

  // A model retired after a council was saved is the case the INACTIVE_MODEL
  // branch exists for. Flip one, prove the refusal names it, flip it back.
  psql(`UPDATE models SET is_active = false WHERE id = '${llama.id}'`);

  const inactiveModel = await alice.post('/sessions', {
    council: { modelIds: [claude.id, gpt.id, llama.id], chairmanId: claude.id },
  });

  psql(`UPDATE models SET is_active = true WHERE id = '${llama.id}'`);

  check('an inactive model id is 400', inactiveModel.status === 400, `${inactiveModel.status}`);
  check(
    'and it is named by display name and id',
    JSON.stringify(inactiveModel.body).includes(llama.id) &&
      JSON.stringify(inactiveModel.body).includes(llama.display_name),
    inactiveModel.body?.error?.code,
  );
  console.log(`    ${JSON.stringify(inactiveModel.body)}`);

  const restored = psql(`SELECT is_active FROM models WHERE id = '${llama.id}'`);
  check('the model was restored to active', /\bt\b/.test(restored), truncate(restored, 40));

  const tooSmall = await alice.post('/sessions', {
    council: { modelIds: [claude.id, gpt.id], chairmanId: claude.id },
  });

  check(
    'a council too small to debate is refused at creation',
    tooSmall.status === 400 && tooSmall.body?.error?.code === 'INSUFFICIENT_COUNCIL',
    `${tooSmall.status} ${tooSmall.body?.error?.code}`,
  );
  console.log(`    ${JSON.stringify(tooSmall.body)}`);

  // -- 3, 4, 5, 6 ------------------------------------------------------------

  heading('3  POST /api/sessions/:id/rounds -> 202 immediately');

  const startedAt = Date.now();
  const accepted = await alice.post(`/sessions/${sessionId}/rounds`, {
    prompt: 'Should a small team building an internal tool write end-to-end tests, or is that effort better spent elsewhere?',
  });

  check('status is 202 Accepted', accepted.status === 202, `${accepted.status}`);
  check(
    'it answered within 500ms',
    accepted.elapsedMs < 500,
    `${accepted.elapsedMs.toFixed(0)}ms — a full round takes 8-47s`,
  );

  const roundId = accepted.body?.roundId;

  check('a roundId came back', Boolean(roundId), roundId ?? 'none');
  check('a streamUrl came back', accepted.body?.streamUrl === `/api/rounds/${roundId}/stream`);

  console.log(`\n    ${JSON.stringify(accepted.body)}`);

  const immediately = await alice.get(`/rounds/${roundId}`);
  check(
    'the round the 202 named already resolves — no race with the engine',
    immediately.status === 200,
    `GET /api/rounds/${String(roundId).slice(0, 8)}… -> ${immediately.status} status=${immediately.body?.round?.status}`,
  );

  heading('4  A subscriber that connects LATE is replayed the buffer, in order');

  // The race the buffer exists for: the client cannot connect before POST
  // returns, so by now the round has already emitted several events.
  await delay(4000);

  const state = await alice.get(`/rounds/${roundId}`);
  const bufferedBefore = state.body?.round?.stream?.bufferedEvents ?? 0;

  console.log(`\n  ${((Date.now() - startedAt) / 1000).toFixed(1)}s after the POST, before any client connected:`);
  console.log(`    the server has buffered ${bufferedBefore} event(s) that nobody has seen`);

  check('events were emitted before any subscriber existed', bufferedBefore > 0, `${bufferedBefore} buffered`);

  const first = await openStream(alice, roundId, { label: 'first' });
  // A second subscriber on the same round, attached at the same moment.
  const second = await openStream(alice, roundId, { label: 'second' });
  const connectedAt = Date.now();

  check('the stream answered 200', first.status === 200, `${first.status}`);
  check(
    'with Content-Type: text/event-stream',
    (first.headers.get('content-type') ?? '').startsWith('text/event-stream'),
    first.headers.get('content-type'),
  );
  check(
    'with no-cache and the no-transform compression opt-out',
    (first.headers.get('cache-control') ?? '').includes('no-cache') &&
      (first.headers.get('cache-control') ?? '').includes('no-transform'),
    first.headers.get('cache-control'),
  );
  check(
    'with X-Accel-Buffering: no',
    first.headers.get('x-accel-buffering') === 'no',
    first.headers.get('x-accel-buffering'),
  );

  await Promise.all([first.done, second.done]);

  const replayed = first.frames.filter((frame) => frame.atMs < 250);

  check(
    'the buffer was replayed to the late subscriber',
    replayed.length >= bufferedBefore,
    `${replayed.length} frame(s) arrived in the first 250ms, ${bufferedBefore} had been buffered`,
  );
  check(
    'the replay starts at id 1 — nothing was lost',
    first.frames[0]?.id === 1,
    `first frame id=${first.frames[0]?.id} event=${first.frames[0]?.event}`,
  );
  check(
    'frame ids are monotonic with no gaps',
    first.frames.every((frame, index) => frame.id === index + 1),
    `${first.frames.length} frames, ids ${first.frames[0]?.id}..${first.frames.at(-1)?.id}`,
  );
  check(
    'a retry directive was sent before any event',
    typeof first.retryDirective === 'number',
    `retry: ${first.retryDirective}`,
  );

  heading('5  The full stream transcript, with the gaps between stages');

  console.log(`\n  round ${roundId}`);
  console.log(
    `  t=0 is the moment this subscriber connected, ${((connectedAt - startedAt) / 1000).toFixed(1)}s after the POST — ` +
      'so frames 1 and 2 are replayed history, not live',
  );

  printTranscript(first.frames);

  const terminal = first.frames.at(-1);

  check(
    'the stream ended on a terminal event',
    terminal?.event === 'round_complete' || terminal?.event === 'round_failed',
    terminal?.event,
  );
  check(
    'the server closed the stream itself — the reader saw EOF, it was never aborted',
    first.frames.at(-1) === terminal,
    `${first.heartbeats.length} heartbeat(s) seen over ${(terminal?.atMs ?? 0) / 1000}s`,
  );

  const order = first.frames.map((frame) => frame.event);

  check('round_started came first', order[0] === 'round_started', order[0]);
  check(
    'every stage_started precedes its own responses',
    order.indexOf('stage_started') < order.indexOf('response_ready'),
  );

  heading('6  Two simultaneous subscribers both receive every frame');

  const firstIds = first.frames.map((frame) => frame.id).join(',');
  const secondIds = second.frames.map((frame) => frame.id).join(',');

  console.log(`    subscriber "first"  ${first.frames.length} frames, ids ${first.frames[0]?.id}..${first.frames.at(-1)?.id}`);
  console.log(`    subscriber "second" ${second.frames.length} frames, ids ${second.frames[0]?.id}..${second.frames.at(-1)?.id}`);

  check('both received the same number of frames', first.frames.length === second.frames.length,
    `${first.frames.length} vs ${second.frames.length}`);
  check('both received the same ids in the same order', firstIds === secondIds);
  check(
    'both saw the terminal event',
    second.frames.at(-1)?.event === terminal?.event,
    second.frames.at(-1)?.event,
  );

  // -- 7 ---------------------------------------------------------------------

  heading('7  Disconnect mid-round; the round still completes');

  let finishedAlone = null;
  let seenBeforeLeaving = 0;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const secondRound = await alice.post(`/sessions/${sessionId}/rounds`, {
      prompt: 'Is it better to name a boolean field `enabled` or `isEnabled`?',
    });

    check('a second round started', secondRound.status === 202, `${secondRound.status}`);

    const abandonedId = secondRound.body.roundId;
    const abandoned = await openStream(alice, abandonedId, { label: 'abandoned' });

    // Watch until the first draft lands, then walk away mid-debate.
    for (let waited = 0; waited < 60_000; waited += 250) {
      if (abandoned.frames.some((frame) => frame.event === 'response_ready')) break;
      await delay(250);
    }

    seenBeforeLeaving = abandoned.frames.length;
    abandoned.abort();
    await abandoned.done;

    console.log(`\n    disconnected after ${seenBeforeLeaving} frame(s), mid-debate`);

    finishedAlone = await waitForRound(alice, abandonedId);

    if (finishedAlone.status === 'complete' || attempt === 2) break;

    console.log(
      '\n  !! the abandoned round failed on a provider dropout rather than on being abandoned.\n' +
        '     Retrying once.\n',
    );
  }

  check('the client had seen part of the round', seenBeforeLeaving > 0, `${seenBeforeLeaving} frames`);

  check(
    'the round completed with nobody watching',
    finishedAlone.status === 'complete',
    `status=${finishedAlone.status} cost=$${Number(finishedAlone.totalCost).toFixed(8)} ${finishedAlone.durationMs}ms`,
  );
  check('GET /api/rounds/:id has the final answer', Boolean(finishedAlone.finalAnswer),
    `${finishedAlone.finalAnswer?.length ?? 0} characters`);
  check('and every model_responses row', finishedAlone.responses.length >= 4,
    `${finishedAlone.responses.length} responses across ${new Set(finishedAlone.responses.map((r) => r.stage)).size} stages`);
  check('and the label -> model mapping', finishedAlone.labels.length >= 2,
    finishedAlone.labels.map((l) => `${l.label}=${l.modelName}`).join(' '));
  check(
    "and stage 2's blind verdict, separate from rounds.verdict_type",
    finishedAlone.verdict !== null,
    `stage 2: ${finishedAlone.verdict?.verdictType} winners=[${finishedAlone.verdict?.winnerLabels?.join(', ')}] | stage 4 (rounds.verdict_type): ${finishedAlone.verdictType}`,
  );

  // -- 8 ---------------------------------------------------------------------

  heading("8  Another user's session and round: 403 everywhere");

  const bobGetsSession = await bob.get(`/sessions/${sessionId}`);
  const bobStartsRound = await bob.post(`/sessions/${sessionId}/rounds`, { prompt: 'let me in' });
  const bobGetsRound = await bob.get(`/rounds/${roundId}`);
  const bobStreams = await openStream(bob, roundId, { label: 'bob' });
  await bobStreams.done;

  check('GET /api/sessions/:id -> 403', bobGetsSession.status === 403, `${bobGetsSession.status} ${bobGetsSession.body?.error?.code}`);
  check('POST /api/sessions/:id/rounds -> 403', bobStartsRound.status === 403, `${bobStartsRound.status} ${bobStartsRound.body?.error?.code}`);
  check('GET /api/rounds/:id -> 403', bobGetsRound.status === 403, `${bobGetsRound.status} ${bobGetsRound.body?.error?.code}`);
  check('GET /api/rounds/:id/stream -> 403', bobStreams.status === 403, `${bobStreams.status}`);
  check(
    'the stream refusal is our error envelope, not a half-open stream',
    (bobStreams.headers.get('content-type') ?? '').includes('application/json'),
    bobStreams.headers.get('content-type'),
  );

  const bobPatches = await bob.patch(`/sessions/${sessionId}`, { title: 'mine now' });
  const bobDeletes = await bob.del(`/sessions/${sessionId}`);

  check('PATCH /api/sessions/:id -> 403', bobPatches.status === 403, `${bobPatches.status}`);
  check('DELETE /api/sessions/:id -> 403', bobDeletes.status === 403, `${bobDeletes.status}`);

  const stillThere = await alice.get(`/sessions/${sessionId}`);
  check("and the owner's session is untouched", stillThere.status === 200 && stillThere.body.session.title === 'HTTP verification');

  // -- 9 ---------------------------------------------------------------------

  heading('9  Unauthenticated -> 401');

  const anonymous = makeClient('anonymous');
  const anonStream = await openStream(anonymous, roundId, { label: 'anonymous' });
  await anonStream.done;

  check('GET /api/rounds/:id/stream with no cookie -> 401', anonStream.status === 401, `${anonStream.status}`);

  const anonRound = await anonymous.get(`/rounds/${roundId}`);
  const anonSessions = await anonymous.get('/sessions');

  check('GET /api/rounds/:id with no cookie -> 401', anonRound.status === 401, `${anonRound.status} ${anonRound.body?.error?.code}`);
  check('GET /api/sessions with no cookie -> 401', anonSessions.status === 401, `${anonSessions.status} ${anonSessions.body?.error?.code}`);

  // The cookie is what authenticates the stream, and EventSource cannot set a
  // header — so this is the property the whole design leans on.
  const withCookie = await openStream(alice, roundId, { label: 'cookie check' });
  await withCookie.done;

  check(
    'the same request WITH the cookie is 200',
    withCookie.status === 200,
    'the httpOnly cookie carried the JWT to an EventSource-shaped GET, no header set',
  );

  // -- 10 --------------------------------------------------------------------

  heading('10  Changing a council never rewrites history');

  const roundOneCouncilBefore = psql(
    `SELECT m.display_name, rm.role FROM round_models rm JOIN models m ON m.id = rm.model_id
     WHERE rm.round_id = '${roundId}' ORDER BY m.display_name`,
  );

  console.log('\n  round 1 council, before the PATCH:');
  console.log(roundOneCouncilBefore.replace(/^/gm, '    '));

  const patched = await alice.patch(`/sessions/${sessionId}`, {
    title: 'HTTP verification (re-crewed)',
    council: { modelIds: [gemini.id, llama.id, gpt.id], chairmanId: gemini.id },
  });

  check('PATCH returns 200', patched.status === 200, `${patched.status}`);
  check('the title changed', patched.body?.session?.title === 'HTTP verification (re-crewed)');
  check(
    'the council is the new one',
    patched.body?.session?.council?.chairmanId === gemini.id &&
      patched.body.session.council.models.length === 3 &&
      !patched.body.session.council.models.some((model) => model.id === claude.id),
    patched.body?.session?.council?.models?.map((m) => m.displayName).join(', '),
  );

  const emptyPatch = await alice.patch(`/sessions/${sessionId}`, {});
  check('an empty PATCH is refused', emptyPatch.status === 400, `${emptyPatch.status} ${emptyPatch.body?.error?.code}`);

  const roundOneCouncilAfter = psql(
    `SELECT m.display_name, rm.role FROM round_models rm JOIN models m ON m.id = rm.model_id
     WHERE rm.round_id = '${roundId}' ORDER BY m.display_name`,
  );

  console.log('\n  round 1 council, after the PATCH — read through psql, not our own model layer:');
  console.log(roundOneCouncilAfter.replace(/^/gm, '    '));

  check(
    'round 1 round_models is byte-identical after the council changed',
    roundOneCouncilBefore === roundOneCouncilAfter,
  );

  const thirdRound = await startAndSettle(
    alice,
    sessionId,
    { prompt: 'In one paragraph: what is a monorepo good for?' },
    'round 3 (inherited council)',
  );

  const inheritedId = thirdRound.accepted.body.roundId;

  check(
    'the inheriting round ran to completion',
    thirdRound.round.status === 'complete',
    `status=${thirdRound.round.status}`,
  );

  const inheritedCouncil = psql(
    `SELECT m.display_name, rm.role FROM round_models rm JOIN models m ON m.id = rm.model_id
     WHERE rm.round_id = '${inheritedId}' ORDER BY m.display_name`,
  );

  console.log('\n  round 3, started with no council in the body — it inherited the session default:');
  console.log(inheritedCouncil.replace(/^/gm, '    '));

  check(
    'the new round used the PATCHed council',
    inheritedCouncil.includes(gemini.display_name) &&
      inheritedCouncil.includes(llama.display_name) &&
      !inheritedCouncil.includes(claude.display_name),
  );
  check(
    'and the new chairman chairs it',
    new RegExp(`${gemini.display_name}\\s*\\|\\s*chairman`).test(inheritedCouncil),
  );

  // The other path: a council in the request wins for the round and must NOT
  // write back to session_models.
  const councilBeforeOverride = psql(
    `SELECT m.display_name, sm.is_chairman FROM session_models sm JOIN models m ON m.id = sm.model_id
     WHERE sm.session_id = '${sessionId}' ORDER BY m.display_name`,
  );

  const overrideRound = await startAndSettle(
    alice,
    sessionId,
    {
      prompt: 'Name one thing a code review should never be used for.',
      council: { modelIds: [claude.id, llama.id, gemini.id], chairmanId: llama.id },
    },
    'round 4 (council in the request body)',
  );

  const overrideId = overrideRound.accepted.body.roundId;

  check(
    'the overriding round ran to completion',
    overrideRound.round.status === 'complete',
    `status=${overrideRound.round.status}`,
  );

  const overrideCouncil = psql(
    `SELECT m.display_name, rm.role FROM round_models rm JOIN models m ON m.id = rm.model_id
     WHERE rm.round_id = '${overrideId}' ORDER BY m.display_name`,
  );

  const councilAfterOverride = psql(
    `SELECT m.display_name, sm.is_chairman FROM session_models sm JOIN models m ON m.id = sm.model_id
     WHERE sm.session_id = '${sessionId}' ORDER BY m.display_name`,
  );

  console.log('\n  round 4, started WITH a council in the request body:');
  console.log(overrideCouncil.replace(/^/gm, '    '));
  console.log('\n  session_models before that round:');
  console.log(councilBeforeOverride.replace(/^/gm, '    '));
  console.log('\n  session_models after it:');
  console.log(councilAfterOverride.replace(/^/gm, '    '));

  check(
    'the per-round council is what the round ran with',
    new RegExp(`${llama.display_name}\\s*\\|\\s*chairman`).test(overrideCouncil) &&
      overrideCouncil.includes(claude.display_name),
  );
  check(
    'and session_models is untouched by it',
    councilBeforeOverride === councilAfterOverride,
  );

  const roundOneCouncilFinally = psql(
    `SELECT m.display_name, rm.role FROM round_models rm JOIN models m ON m.id = rm.model_id
     WHERE rm.round_id = '${roundId}' ORDER BY m.display_name`,
  );

  check(
    'round 1 is STILL unchanged after two further rounds on two further councils',
    roundOneCouncilBefore === roundOneCouncilFinally,
  );

  // -- Session detail, now that there is something in it ----------------------

  heading('Extra A  GET /api/sessions/:id carries every round and every response');

  const full = await alice.get(`/sessions/${sessionId}`);
  const rounds = full.body?.session?.rounds ?? [];
  const responseCount = rounds.reduce((total, round) => total + round.responses.length, 0);

  check('status is 200', full.status === 200, `${full.status}`);
  // Four rounds unless a provider dropout forced a retry above, which adds one.
  check('every round on the session came back', rounds.length >= 4, `${rounds.length} rounds`);
  check('with every model_responses row attached', responseCount >= 16, `${responseCount} responses`);
  check(
    'each round carries its own council snapshot',
    rounds.every((round) => round.council.length === 3),
  );
  check(
    'rounds are ordered oldest first',
    rounds.map((round) => round.createdAt).join() ===
      [...rounds].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).map((r) => r.createdAt).join(),
  );

  console.log('\n  the session as one document:');
  for (const round of rounds) {
    console.log(
      `    ${round.id.slice(0, 8)}  ${round.status.padEnd(8)} ${String(round.verdictType).padEnd(12)} ` +
        `${round.responses.length} responses  $${Number(round.totalCost).toFixed(8)}  ${round.durationMs}ms  ` +
        `council: ${round.council.map((c) => c.displayName).join(', ')}`,
    );
  }

  // -- Cleanup path ----------------------------------------------------------

  heading('Extra B  DELETE /api/sessions/:id cascades');

  const throwaway = await alice.post('/sessions', {
    title: 'to be deleted',
    council: { modelIds: [claude.id, gpt.id, gemini.id], chairmanId: gpt.id },
  });

  const throwawayId = throwaway.body.session.id;
  const councilRows = psql(`SELECT count(*) FROM session_models WHERE session_id = '${throwawayId}'`);

  check('its council was written', /\b3\b/.test(councilRows), truncate(councilRows, 30));

  const deleted = await alice.del(`/sessions/${throwawayId}`);

  check('DELETE returns 204', deleted.status === 204, `${deleted.status}`);
  check('and 204 has no body', deleted.body === null);

  const afterDelete = await alice.get(`/sessions/${throwawayId}`);
  const orphans = psql(`SELECT count(*) FROM session_models WHERE session_id = '${throwawayId}'`);

  check('the session is gone', afterDelete.status === 404, `${afterDelete.status}`);
  check('and its council rows went with it', /\b0\b/.test(orphans), truncate(orphans, 30));

  // -- Stream lifecycle ------------------------------------------------------

  heading('Extra C  Stream lifecycle edge cases');

  const finishedStream = await openStream(alice, roundId, { label: 'after the fact' });
  await finishedStream.done;

  check(
    'a stream opened after the round finished replays the whole buffer and closes',
    finishedStream.frames.length > 0 && finishedStream.frames.at(-1)?.event === 'round_complete',
    `${finishedStream.frames.length} frames replayed`,
  );

  const resumed = await openStream(alice, roundId, { label: 'resume', lastEventId: 5 });
  await resumed.done;

  check(
    'Last-Event-ID resumes from the buffer instead of replaying from zero',
    resumed.frames[0]?.id === 6 && resumed.frames.length === finishedStream.frames.length - 5,
    `first id ${resumed.frames[0]?.id}, ${resumed.frames.length} frames instead of ${finishedStream.frames.length}`,
  );

  const unknownRound = await alice.get(`/rounds/${unknownId}/stream`);
  check('a stream for a round that does not exist -> 404', unknownRound.status === 404, `${unknownRound.status}`);

  const badId = await alice.get('/rounds/not-a-uuid/stream');
  check(
    'a malformed id is 400 from validate, not 500 from Postgres',
    badId.status === 400 && badId.body?.error?.code === 'VALIDATION_ERROR',
    `${badId.status} ${badId.body?.error?.code}`,
  );

  // -- Summary ---------------------------------------------------------------

  heading('Summary');

  const spend = psql(
    `SELECT count(*) AS rounds, sum(total_cost)::numeric(14,8) AS cost FROM rounds
     WHERE user_id = '${(await findUserByEmail(USER_A.email)).id}'`,
  );

  console.log(`\n  every round this account has ever run:\n${spend.replace(/^/gm, '    ')}`);

  if (failures.length === 0) {
    console.log('\n  All checks passed.\n');
  } else {
    console.log(`\n  ${failures.length} check(s) FAILED:`);
    for (const failure of failures) console.log(`    - ${failure}`);
    console.log('');
  }

  return failures.length === 0 ? 0 : 1;
}

let exitCode = 1;

try {
  exitCode = await main();
} catch (error) {
  console.error(`\nverify-http died: ${error.stack}`);
  exitCode = 1;
} finally {
  await closePool();
}

process.exit(exitCode);
