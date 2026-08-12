#!/usr/bin/env node
/**
 * Proof that stage 4 streams — and, more importantly, that streaming it changed
 * nothing else.
 *
 * The feature is a preview: bytes shown to the user before anything has been
 * parsed. Everything that decides money or history still comes from
 * `parseModelJson` over the complete buffer, so the checks that matter here are
 * the ones that would catch a preview quietly becoming the record:
 *
 *   * the streamed text and the parsed `final_answer` are compared character by
 *     character, not eyeballed;
 *   * the streamed call's `model_responses` row is read back out of Postgres and
 *     its tokens and cost asserted, because usage arrives in the LAST SSE
 *     message and a reader that took the first would debit every round zero;
 *   * a late subscriber's replayed deltas are reconstructed and compared to the
 *     live subscriber's, because the replay buffer is the half of SSE nobody
 *     watches;
 *   * the flag off produces a round with no delta frames at all.
 *
 * The server must already be running — `npm run dev` in another terminal — for
 * the HTTP half. The three direct-to-engine rounds do not need it.
 *
 * It WRITES to the database and leaves everything behind. Three real rounds and
 * one small extra call, about $0.03 a run.
 *
 *   npm run verify:streaming
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool } from '../src/db/pool.js';
import { FINAL_DELTA_FLUSH_CHARS, STREAM_FINAL_ANSWER } from '../src/config/llm.js';
import { listActiveModels } from '../src/models/llmModel.js';
import { findUserByEmail } from '../src/models/userModel.js';
import { insertSession } from '../src/models/sessionModel.js';
import { runRound } from '../src/services/debateService.js';
import { createFieldScanner } from '../src/services/jsonFieldStream.js';
import { callModelStreaming } from '../src/services/openrouterService.js';
import { creditTopup } from '../src/services/walletService.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const BASE = 'http://localhost:3000/api';

const USER = { email: 'streaming-verify@example.com', password: 'watch the answer arrive' };

const failures = [];
const spend = { calls: 0, cost: 0 };

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

function money(value) {
  return value === null || value === undefined ? 'unknown' : `$${Number(value).toFixed(8)}`;
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

/** The first data cell of a psql table, which is all several checks below want. */
function firstValue(output) {
  const lines = output.split('\n');
  const row = lines[2] ?? '';

  return row.split('|')[0]?.trim() ?? '';
}

function councilFrom(models, slugs) {
  return slugs.map((slug) => {
    const row = models.find((model) => model.openrouter_slug === slug);
    if (!row) throw new Error(`Seeded model ${slug} is missing — run npm run migrate.`);

    return {
      id: row.id,
      slug: row.openrouter_slug,
      displayName: row.display_name,
      supportsVision: row.supports_vision === true,
      supportsDocuments: row.supports_documents === true,
    };
  });
}

// ---------------------------------------------------------------------------
// 1. The scanner, with no models involved
// ---------------------------------------------------------------------------

/**
 * Every case below is run at seven chunk sizes, including one character at a
 * time, because a chunk boundary is the whole difficulty: `\uD83D` can arrive as
 * `\u`, `D8`, `3D` and a scanner that is right on whole strings can be wrong on
 * every real stream.
 */
const CHUNK_SIZES = [1, 2, 3, 5, 7, 13, 4096];

function splitInto(text, size) {
  const parts = [];

  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));

  return parts;
}

function scanAll(text, size) {
  const scanner = createFieldScanner('final_answer');
  let out = '';

  for (const chunk of splitInto(text, size)) out += scanner.push(chunk);

  return { out, complete: scanner.complete, lost: scanner.lost, chars: scanner.chars };
}

/** Runs one case at every chunk size and asserts they all agree. */
function scanCase(label, text, expect) {
  const results = CHUNK_SIZES.map((size) => ({ size, ...scanAll(text, size) }));
  const first = results[0];

  const stable = results.every(
    (result) =>
      result.out === first.out && result.complete === first.complete && result.lost === first.lost,
  );

  const matched = first.out === expect.out && first.complete === (expect.complete ?? false);

  check(
    label,
    stable && matched,
    stable
      ? `${JSON.stringify(truncate(first.out, 48))}${first.complete ? ' complete' : first.lost ? ' lost' : ' partial'}`
      : 'DIFFERS BY CHUNK SIZE',
  );

  return first;
}

function verifyScanner() {
  heading('1. The scanner — deterministic, no models, no cost');

  console.log(`  each case is fed at chunk sizes ${CHUNK_SIZES.join(', ')} and must agree\n`);

  const answer =
    'A short answer.\n\nWith a second paragraph, a "quoted" phrase, a backslash \\, ' +
    'a tab\there, an emoji 😀 and a **markdown** heading:\n\n## Done';

  const wholeObject = JSON.stringify({
    verdict_type: 'pick',
    changed_from_initial: false,
    final_answer: answer,
    open_questions: 'One thing the council could not settle.',
  });

  scanCase('the template\'s object, exactly as 04-final.md asks for it', wholeObject, {
    out: answer,
    complete: true,
  });

  scanCase('the same object inside a markdown fence the model added anyway', `\`\`\`json\n${wholeObject}\n\`\`\``, {
    out: answer,
    complete: true,
  });

  scanCase(
    'the same object with prose in front of it',
    `Here is the council's ruling.\n\n${wholeObject}`,
    { out: answer, complete: true },
  );

  scanCase(
    'final_answer last, after open_questions — key order is the model\'s choice',
    JSON.stringify({ verdict_type: 'merge', open_questions: null, final_answer: answer }),
    { out: answer, complete: true },
  );

  scanCase('an answer that is only escapes', JSON.stringify({ final_answer: '\n\t"\\é\u{1f600}' }), {
    out: '\n\t"\\é\u{1f600}',
    complete: true,
  });

  // --- and now the ways it is allowed to fail ---

  scanCase('the key never appears — emits nothing, and is not "lost" either', JSON.stringify({ verdict_type: 'pick' }), {
    out: '',
  });

  scanCase('final_answer is null rather than a string', '{"final_answer": null}', { out: '' });

  scanCase('final_answer is an object', '{"final_answer": {"text": "no"}}', { out: '' });

  scanCase('an escape JSON does not define', '{"final_answer": "ab\\qcd"}', { out: 'ab' });

  scanCase('a \\u that is not four hex digits', '{"final_answer": "ab\\uZZZZcd"}', { out: 'ab' });

  scanCase('a stream that stops mid-answer', '{"final_answer": "half an answ', {
    out: 'half an answ',
  });

  /**
   * The one case that would matter if it went wrong: an earlier field whose
   * value talks about the key. JSON escapes the quotes, so the needle
   * `"final_answer"` is not in those bytes at all.
   */
  const decoy = JSON.stringify({
    reasoning: 'I copied B\'s "final_answer" wholesale, then edited it.',
    final_answer: 'The real one.',
  });

  scanCase('an earlier string value that quotes the key back at us', decoy, {
    out: 'The real one.',
    complete: true,
  });

  // Whitespace is the model's to choose, and pretty-printed JSON is common.
  scanCase(
    'pretty-printed, with newlines between the key, the colon and the value',
    '{\n  "final_answer"\n  :\n  "spaced out"\n}',
    { out: 'spaced out', complete: true },
  );

  /**
   * The scanner reads; it never consumes. The complete text has to survive it
   * intact, because that text is what parseModelJson gets and what everything
   * downstream is decided from.
   */
  const scanner = createFieldScanner('final_answer');
  let rebuilt = '';

  for (const chunk of splitInto(wholeObject, 3)) {
    scanner.push(chunk);
    rebuilt += chunk;
  }

  const parsed = JSON.parse(rebuilt);

  check('the buffer is untouched — the complete text still parses', rebuilt === wholeObject);
  check(
    'and every other field survives: verdict_type, changed_from_initial, open_questions',
    parsed.verdict_type === 'pick' &&
      parsed.changed_from_initial === false &&
      parsed.open_questions === 'One thing the council could not settle.',
    `open_questions ${JSON.stringify(truncate(parsed.open_questions, 40))}`,
  );
}

// ---------------------------------------------------------------------------
// 2. One real streamed call, without a round around it
// ---------------------------------------------------------------------------

/**
 * The transport on its own, across every model that could chair a council.
 *
 * Two things are being established. The first is that a streamed call still
 * settles with tokens and a cost on it — usage arrives in the LAST SSE message
 * and a reader that took the first would bill every streamed round zero.
 *
 * The second is HOW COARSE THE CHUNKS ARE, which is not our decision and is not
 * uniform. It is the upstream provider's, and the table this prints is the whole
 * argument for `FINAL_DELTA_FLUSH_CHARS`: a provider that sends five characters
 * at a time would otherwise put one frame per token into a replay buffer that
 * every reconnecting client re-reads.
 *
 * The prompt asks for prose rather than JSON on purpose. That is exactly the
 * shape of "the chairman ignored the template", and the required answer is that
 * deltas flow, the call settles, and the preview scanner emits nothing at all.
 */
const STREAMING_PROBE = [
  'google/gemini-2.5-flash',
  'openai/gpt-5-mini',
  'anthropic/claude-haiku-4.5',
];

async function verifyStreamedCall(models) {
  heading('2. Streamed calls — usage in the LAST message, and how the chunks arrive');

  console.log('  model                         chunks   chars  median   p90   first    total  provider');
  console.log(`  ${'-'.repeat(88)}`);

  const measured = [];

  for (const slug of STREAMING_PROBE) {
    const model = models.find((row) => row.openrouter_slug === slug);

    if (!model) continue;

    const scanner = createFieldScanner('final_answer');
    const sizes = [];

    let firstDeltaMs = null;
    let preview = '';

    const startedAt = Date.now();

    let result;

    try {
      result = await callModelStreaming({
        modelSlug: slug,
        system: 'You are a helpful assistant.',
        user: 'In about 120 words, say why a small team should start with a monolith. Prose only, no JSON.',
        temperature: 0.2,
        /**
         * Generous, because GPT-5 Mini is a reasoning model and spends
         * completion tokens before it writes a visible character. At 400 it
         * burned the whole budget thinking and returned `finish_reason: length`
         * with empty content — which settleCall correctly refused, on the
         * streamed path exactly as on the non-streamed one. That is the guard
         * working; it is not a probe worth repeating.
         */
        maxTokens: 900,
        onDelta: (text) => {
          sizes.push(text.length);
          firstDeltaMs ??= Date.now() - startedAt;
          preview += scanner.push(text);
        },
      });
    } catch (error) {
      /**
       * One provider having a bad minute must not cost the other sixty checks.
       * Gemini did exactly this on one run — a mid-stream `error` chunk, which
       * is the streamed twin of the 200-with-`finish_reason: error` that
       * callModel has guarded against since Session 4 — so the provider's own
       * words are printed rather than only our mapped message.
       */
      console.log(
        `  ${model.display_name.padEnd(28)} FAILED — ${error.code}: ${error.message}` +
          `${error.providerMessage ? ` — ${truncate(error.providerMessage, 100)}` : ''}`,
      );
      continue;
    }

    spend.calls += 1;
    spend.cost += Number(result.cost ?? 0);

    const sorted = [...sizes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;

    console.log(
      `  ${model.display_name.padEnd(28)} ${String(sizes.length).padStart(6)}  ` +
        `${String(result.content.length).padStart(6)}  ${String(median).padStart(6)}  ` +
        `${String(p90).padStart(4)}  ${String(firstDeltaMs).padStart(5)}ms  ` +
        `${String(result.latencyMs).padStart(6)}ms  ${result.raw?.provider ?? '?'}`,
    );

    measured.push({ slug, name: model.display_name, sizes, median, result, firstDeltaMs, preview, scanner });
  }

  console.log('');

  check(
    'at least two models answered, so the comparison below means something',
    measured.length >= 2,
    `${measured.length} of ${STREAMING_PROBE.length}`,
  );
  check('every model streamed in more than one chunk', measured.every((row) => row.sizes.length > 1));
  check(
    'and every first delta beat its own completed call',
    measured.every((row) => row.firstDeltaMs !== null && row.firstDeltaMs < row.result.latencyMs),
  );
  check(
    'prompt and completion tokens came back on all of them',
    measured.every((row) => row.result.promptTokens > 0 && row.result.completionTokens > 0),
  );
  check(
    'so did a real cost — usage was read from the LAST chunk, not lost with the first',
    measured.every((row) => Number(row.result.cost) > 0),
    measured.map((row) => money(row.result.cost)).join(', '),
  );
  check(
    'the provider rode along, as it does on a non-streamed call',
    measured.every((row) => Boolean(row.result.raw?.provider)),
    measured.map((row) => row.result.raw.provider).join(', '),
  );
  check(
    'raw is shaped like a completion body, so settleCall cannot tell the paths apart',
    measured.every((row) => typeof row.result.raw?.choices?.[0]?.message?.content === 'string'),
  );
  check(
    'a scanner pointed at JSON that never came emits nothing at all',
    measured.every((row) => row.preview === '' && !row.scanner.complete),
  );

  /**
   * The point of the table, and the only part of it that is OURS to assert.
   *
   * How coarse a provider's chunks are is the provider's decision and it varies
   * by an order of magnitude across the seated models — Gemini has sent whole
   * paragraphs, GPT-5 Mini sends about six characters. That spread is printed,
   * not asserted: a run that loses a model to a provider hiccup should not fail
   * a check about somebody else's chunking.
   *
   * What IS ours is that the threshold bounds the frame count when a provider
   * streams finer than it. That is the thing the replay buffer depends on.
   */
  const finest = measured.reduce((a, b) => (a.median <= b.median ? a : b));
  const coarsest = measured.reduce((a, b) => (a.median >= b.median ? a : b));

  console.log(
    `\n  granularity is the PROVIDER's choice, not ours: ` +
      `${finest.name} sends ~${finest.median} chars a chunk, ` +
      `${coarsest.name} ~${coarsest.median}.`,
  );

  const uncoalesced = finest.sizes.length;
  const coalesced = Math.ceil(finest.result.content.length / FINAL_DELTA_FLUSH_CHARS);

  console.log(
    `  at the finest, ${uncoalesced} chunks become ~${coalesced} frames — which is what keeps a ` +
      'long answer inside the replay buffer.',
  );

  check(
    'coalescing bounds the frame count against the finest-grained provider',
    finest.median >= FINAL_DELTA_FLUSH_CHARS || coalesced < uncoalesced,
    `${uncoalesced} chunks → ~${coalesced} frames at a ${FINAL_DELTA_FLUSH_CHARS}-char threshold`,
  );
}

// ---------------------------------------------------------------------------
// An HTTP client with a cookie jar, and an SSE reader
// ---------------------------------------------------------------------------

function makeClient() {
  let cookie = null;

  async function request(method, path, body) {
    const response = await fetch(`${BASE}${path}`, {
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
    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { rawBody: text };
    }

    return { status: response.status, body: payload };
  }

  return {
    request,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    get cookie() {
      return cookie;
    },
  };
}

/**
 * The wire format parsed by hand, so what is checked is the bytes we send. Frame
 * ids and arrival times are kept for both the ordering checks and the "how early
 * did the first word appear" figure, which is the whole reason the feature
 * exists.
 */
async function openStream(client, roundId, { label, onFrame } = {}) {
  const controller = new AbortController();
  const startedAt = Date.now();

  const response = await fetch(`${BASE}/rounds/${roundId}/stream`, {
    headers: { ...(client.cookie ? { Cookie: client.cookie } : {}) },
    signal: controller.signal,
  });

  const frames = [];

  const done = (async () => {
    if (!response.ok || !response.body) {
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

          if (raw.startsWith(':')) continue;

          const frame = { atMs: Date.now() - startedAt };

          for (const line of raw.split('\n')) {
            const separator = line.indexOf(':');
            const field = line.slice(0, separator);
            const value = line.slice(separator + 1).replace(/^ /, '');

            if (field === 'id') frame.id = Number(value);
            else if (field === 'event') frame.event = value;
            else if (field === 'data') frame.data = value;
          }

          if (!frame.event) continue;

          try {
            frame.payload = JSON.parse(frame.data);
          } catch {
            frame.payload = { unparseable: frame.data };
          }

          frames.push(frame);
          onFrame?.(frame);
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  })();

  return { label, status: response.status, frames, done, abort: () => controller.abort() };
}

/** Every final_delta's text, in frame-id order, joined. */
function reconstruct(frames) {
  return frames
    .filter((frame) => frame.event === 'final_delta')
    .sort((a, b) => a.id - b.id)
    .map((frame) => frame.payload.text ?? '')
    .join('');
}

// ---------------------------------------------------------------------------
// 3-5. A real round over HTTP, watched by three subscribers
// ---------------------------------------------------------------------------

async function verifyLiveRound(client, user) {
  heading('3. A real round over HTTP, with the flag on');

  /**
   * Three models, named rather than left to whatever preset the account has, so
   * the cost of this script is predictable and Gemini chairs — the model that
   * has streamed most reliably for us.
   */
  const models = await listActiveModels();
  const council = councilFrom(models, [
    'meta-llama/llama-4-maverick',
    'openai/gpt-5-mini',
    'google/gemini-2.5-flash',
  ]);

  const session = await client.post('/sessions', {
    title: 'Streaming verification',
    council: { modelIds: council.map((model) => model.id), chairmanId: council[2].id },
  });

  if (session.status !== 201) {
    throw new Error(`Could not create a session: ${session.status} ${JSON.stringify(session.body)}`);
  }

  const sessionId = session.body.session.id;

  console.log(`  session ${sessionId}, chairman ${council[2].displayName}`);

  const started = await client.post(`/sessions/${sessionId}/rounds`, {
    prompt:
      'A small team is choosing between a monolith and microservices for a product with ' +
      'no users yet. Give a clear recommendation and say what would change it.',
  });

  if (started.status !== 202) {
    throw new Error(`POST /rounds answered ${started.status}: ${JSON.stringify(started.body)}`);
  }

  const roundId = started.body.roundId;

  check('the round was accepted as a paid one', started.body.billing?.mode === 'paid', started.body.billing?.mode);

  /**
   * Subscriber A watches from the start. B connects the instant A sees the FIRST
   * delta, which is the interesting moment: the replay buffer and the live
   * fan-out are both in play and a frame lost between them would be invisible to
   * A. C connects after the round is over and gets the buffer alone.
   */
  let lateSubscriber = null;
  let firstDeltaAt = null;
  let roundCompleteAt = null;

  const primary = await openStream(client, roundId, {
    label: 'A',
    onFrame: (frame) => {
      if (frame.event === 'final_delta' && firstDeltaAt === null) {
        firstDeltaAt = frame.atMs;
        lateSubscriber = openStream(client, roundId, { label: 'B' });
      }

      if (frame.event === 'round_complete') roundCompleteAt = frame.atMs;
    },
  });

  check('the stream opened', primary.status === 200, String(primary.status));

  await primary.done;

  const late = lateSubscriber ? await lateSubscriber : null;
  if (late) await late.done;

  const afterwards = await openStream(client, roundId, { label: 'C' });
  await afterwards.done;

  const detail = await client.get(`/rounds/${roundId}`);
  const round = detail.body.round;

  spend.calls += round.responses.length;
  spend.cost += Number(round.totalCost ?? 0);

  // -- the frames themselves ------------------------------------------------

  const deltas = primary.frames.filter((frame) => frame.event === 'final_delta');
  const dones = primary.frames.filter((frame) => frame.event === 'final_done');
  const bytes = deltas.reduce((total, frame) => total + Buffer.byteLength(frame.data, 'utf8'), 0);
  const streamed = reconstruct(primary.frames);

  console.log(`\n  round ${roundId} — ${round.status} in ${round.durationMs}ms`);
  console.log(`  final_delta frames: ${deltas.length}`);
  console.log(`  final_delta bytes:  ${bytes} on the wire, ${streamed.length} characters of answer`);
  console.log(`  first word at:      +${firstDeltaAt}ms`);
  console.log(`  round_complete at:  +${roundCompleteAt}ms`);
  console.log(`  head start:         ${roundCompleteAt - firstDeltaAt}ms of answer before the round settled`);

  /**
   * The TAIL of each snapshot, not the head. Every snapshot starts with the same
   * words — that is what "assembling" means — so printing the first ninety
   * characters four times demonstrates nothing. The growing edge is the part
   * that shows the answer being written.
   */
  console.log('\n  the answer assembling, as the client saw it — the growing edge of each snapshot:');
  for (const fraction of [0.15, 0.4, 0.7, 1]) {
    const upTo = Math.max(1, Math.round(deltas.length * fraction));
    const soFar = reconstruct(deltas.slice(0, upTo));
    const edge = truncate(soFar.slice(-76), 76);

    console.log(
      `    +${String(deltas[upTo - 1].atMs).padStart(6)}ms  ${String(upTo).padStart(3)} frames  ` +
        `${String(soFar.length).padStart(5)} chars  …${edge}`,
    );
  }

  check('the final answer streamed at all', deltas.length > 0, `${deltas.length} frames`);
  check(
    'no frame is smaller than the flush threshold, except the last',
    deltas
      .slice(0, -1)
      .every((frame) => (frame.payload.text ?? '').length >= FINAL_DELTA_FLUSH_CHARS),
    `${(streamed.length / deltas.length).toFixed(1)} chars a frame on average, threshold ${FINAL_DELTA_FLUSH_CHARS}`,
  );
  check(
    'and the whole answer fits the replay buffer with room to spare',
    primary.frames.length < 2500 / 2,
    `${primary.frames.length} frames against a 2500 cap`,
  );
  check('final_done was emitted exactly once', dones.length === 1, `${dones.length}`);
  check('final_done says the scanner closed the string cleanly', dones[0]?.payload?.complete === true);

  const lastDelta = deltas[deltas.length - 1];
  const complete = primary.frames.find((frame) => frame.event === 'round_complete');
  const finalResponse = primary.frames.find(
    (frame) => frame.event === 'response_ready' && frame.payload.stage === 'final',
  );

  const ordered =
    Boolean(lastDelta && dones[0] && finalResponse && complete) &&
    lastDelta.id < dones[0].id &&
    dones[0].id < finalResponse.id &&
    finalResponse.id < complete.id;

  check(
    'the frame order is deltas, then final_done, then the parsed answer, then round_complete',
    ordered,
    `${lastDelta?.id} < ${dones[0]?.id} < ${finalResponse?.id} < ${complete?.id}`,
  );

  check(
    'every delta id is strictly increasing',
    deltas.every((frame, index) => index === 0 || frame.id > deltas[index - 1].id),
  );

  // -- the assertion the whole feature rests on -----------------------------

  check(
    'THE STREAMED TEXT IS THE PARSED final_answer, character for character',
    streamed === round.finalAnswer,
    streamed === round.finalAnswer
      ? `${streamed.length} chars`
      : `streamed ${streamed.length} vs parsed ${round.finalAnswer?.length}`,
  );

  check(
    'and round_complete carried that same answer',
    complete.payload.finalAnswer === round.finalAnswer,
  );

  // -- the parse was not disturbed -----------------------------------------

  const persisted = round.responses.filter((row) => row.stage === 'final' && !row.errorText);
  const stageFour = persisted[persisted.length - 1];
  const stored = JSON.parse(stageFour.content);

  check('stage 4 persisted the canonical validated JSON, as it always has', Object.keys(stored).sort().join(',') === 'changedFromInitial,finalAnswer,openQuestions,verdictType', Object.keys(stored).join(', '));
  check('verdict_type survived the scan', typeof stored.verdictType === 'string', stored.verdictType);
  check('changed_from_initial survived the scan', typeof stored.changedFromInitial === 'boolean', String(stored.changedFromInitial));
  check(
    'open_questions survived the scan',
    Object.hasOwn(stored, 'openQuestions'),
    stored.openQuestions ? truncate(stored.openQuestions, 60) : 'null this round',
  );
  check('the round exposes it on the wire too', round.openQuestions === stored.openQuestions);

  // -- the money -----------------------------------------------------------

  heading('4. The streamed call was billed like any other');

  const row = psql(
    `SELECT prompt_tokens, completion_tokens, cost, provider, latency_ms
       FROM model_responses
      WHERE round_id = '${roundId}' AND stage = 'final' AND error_text IS NULL
      ORDER BY created_at DESC LIMIT 1`,
  );

  console.log(`\n${row}\n`);

  const [promptTokens, completionTokens, cost, provider] = (row.split('\n')[2] ?? '')
    .split('|')
    .map((cell) => cell.trim());

  check('the streamed row has prompt tokens', Number(promptTokens) > 0, promptTokens);
  check('the streamed row has completion tokens', Number(completionTokens) > 0, completionTokens);
  check('the streamed row has a real cost', Number(cost) > 0, money(cost));
  check('the streamed row names its provider', provider.length > 0, provider);

  const summed = Number(
    firstValue(psql(`SELECT COALESCE(SUM(cost), 0) FROM model_responses WHERE round_id = '${roundId}'`)),
  );
  const totalCost = Number(firstValue(psql(`SELECT total_cost FROM rounds WHERE id = '${roundId}'`)));

  check(
    'rounds.total_cost is the sum of its calls, streamed one included',
    Math.abs(summed - totalCost) < 1e-8,
    `${money(summed)} vs ${money(totalCost)}`,
  );

  const debit = Number(
    firstValue(psql(`SELECT amount FROM credit_transactions WHERE round_id = '${roundId}'`)),
  );

  check(
    'the wallet was debited exactly that, negative',
    Math.abs(debit + totalCost) < 1e-8,
    `${money(debit)} against ${money(totalCost)}`,
  );

  const ledger = Number(
    firstValue(psql(`SELECT COALESCE(SUM(amount), 0) FROM credit_transactions WHERE user_id = '${user.id}'`)),
  );
  const balance = Number(firstValue(psql(`SELECT credit_balance FROM users WHERE id = '${user.id}'`)));
  const rows = Number(
    firstValue(psql(`SELECT COUNT(*) FROM credit_transactions WHERE user_id = '${user.id}'`)),
  );

  /**
   * THE TOLERANCE SCALES WITH THE NUMBER OF LEDGER ROWS, and that is not a fudge
   * — it is the schema's arithmetic.
   *
   * `credit_transactions.amount` is numeric(14,8); `users.credit_balance` is
   * numeric(12,6). `adjustCreditBalance` does its addition in the database, so
   * each write rounds the running balance to six places and can lose up to
   * 5e-7. The ledger keeps all eight. So the gap is bounded by rows x 5e-7 and
   * grows every round — Session 9's flat 1e-6 holds only because verify:wallet
   * resets its account, and this one is topped up and spent on every run.
   *
   * A tolerance that did not grow would pass for a while and then start failing
   * for a reason that has nothing to do with the code under test.
   */
  const tolerance = Math.max(1e-6, rows * 5e-7);

  check(
    'and SUM(amount) still equals credit_balance, within the columns’ rounding',
    Math.abs(ledger - balance) < tolerance,
    `${money(ledger)} vs ${money(balance)} — ${rows} rows allow ${tolerance.toExponential(1)}`,
  );

  // -- the replay ----------------------------------------------------------

  heading('5. A late subscriber is replayed the deltas, in order');

  const lateDeltas = late ? late.frames.filter((frame) => frame.event === 'final_delta') : [];
  const lateText = late ? reconstruct(late.frames) : '';
  const afterText = reconstruct(afterwards.frames);
  const afterDeltas = afterwards.frames.filter((frame) => frame.event === 'final_delta');

  console.log(`  A watched from the start:        ${deltas.length} deltas`);
  console.log(`  B joined at the first delta:     ${lateDeltas.length} deltas (${late?.frames.length} frames in all)`);
  console.log(`  C joined after round_complete:   ${afterDeltas.length} deltas (${afterwards.frames.length} frames in all)`);

  check('B was connected at all', Boolean(late) && late.status === 200);
  check(
    'B reconstructs the identical answer — nothing was lost between replay and live',
    lateText === streamed,
    lateText === streamed ? `${lateText.length} chars` : `${lateText.length} vs ${streamed.length}`,
  );
  check(
    'B received every delta frame, not merely enough of them',
    lateDeltas.length === deltas.length,
    `${lateDeltas.length} vs ${deltas.length}`,
  );
  check(
    'B saw them in ascending id order',
    lateDeltas.every((frame, index) => index === 0 || frame.id > lateDeltas[index - 1].id),
  );
  check(
    'C, connecting after the round ended, replays the whole answer from the buffer',
    afterText === streamed,
    afterText === streamed ? `${afterText.length} chars` : `${afterText.length} vs ${streamed.length}`,
  );
  check(
    'the buffer held every frame without truncating',
    afterwards.frames.length === primary.frames.length,
    `${afterwards.frames.length} vs ${primary.frames.length}`,
  );

  return { sessionId, roundId, council };
}

// ---------------------------------------------------------------------------
// 6. The flag off
// ---------------------------------------------------------------------------

async function verifyFlagOff(user, council) {
  heading('6. STREAM_FINAL_ANSWER off — the round runs exactly as it did');

  const session = await insertSession({ userId: user.id, title: 'Streaming verification — flag off' });
  const events = [];

  const result = await runRound({
    sessionId: session.id,
    userId: user.id,
    prompt: 'In two sentences: when is a feature flag worth the branch it creates?',
    council: { models: council, chairmanId: council[2].id, chairmanAbstains: true, rebuttalEnabled: true },
    streamFinalAnswer: false,
    onEvent: (event, payload) => {
      events.push({ event, payload });
    },
  });

  spend.calls += result.callCount;
  spend.cost += result.totalCost;

  const names = events.map((entry) => entry.event);

  console.log(`  round ${result.roundId} — ${result.status} in ${result.durationMs}ms, ${money(result.totalCost)}`);
  console.log(`  events: ${names.join(' → ')}`);
  console.log(`  answer: ${truncate(result.finalAnswer, 100)}`);

  check('the round completed', result.status === 'complete');
  check('not one final_delta was emitted', !names.includes('final_delta'));
  check('and no final_done either', !names.includes('final_done'));
  check('no preview object was produced', result.finalPreview === null);
  check('the final answer is still there, whole', (result.finalAnswer ?? '').length > 0, `${result.finalAnswer.length} chars`);

  const finalReady = events.find(
    (entry) => entry.event === 'response_ready' && entry.payload.stage === 'final',
  );

  check(
    'response_ready still carries the whole parsed object, as Session 6 sent it',
    JSON.parse(finalReady.payload.content).finalAnswer === result.finalAnswer,
  );

  check('the flag itself is on by default', STREAM_FINAL_ANSWER === true);
}

// ---------------------------------------------------------------------------
// 7. A preview that explodes
// ---------------------------------------------------------------------------

/**
 * The guarantee that matters most and is the easiest to lose: a debate is paid
 * for, and nothing about drawing it on a screen may be able to take it down.
 * Here the delta handler throws on every single frame.
 */
async function verifyPreviewCannotFailARound(user, council) {
  heading('7. A delta handler that throws on every frame');

  const session = await insertSession({ userId: user.id, title: 'Streaming verification — hostile sink' });

  let thrown = 0;
  const events = [];

  const result = await runRound({
    sessionId: session.id,
    userId: user.id,
    prompt: 'In two sentences: what is the point of an integration test?',
    council: { models: council, chairmanId: council[2].id, chairmanAbstains: true, rebuttalEnabled: true },
    onEvent: (event, payload) => {
      events.push({ event, payload });

      if (event === 'final_delta') {
        thrown += 1;
        throw new Error('the subscriber exploded');
      }
    },
  });

  spend.calls += result.callCount;
  spend.cost += result.totalCost;

  console.log(`  round ${result.roundId} — ${result.status}, ${thrown} deltas thrown on`);
  console.log(`  answer: ${truncate(result.finalAnswer, 100)}`);

  check('the delta handler really did throw', thrown > 0, `${thrown} times`);
  check('the round completed anyway', result.status === 'complete');
  check('with its final answer intact', (result.finalAnswer ?? '').length > 0, `${result.finalAnswer.length} chars`);
  check('and it was still billed', result.totalCost > 0, money(result.totalCost));
  check(
    'the preview it produced still matched the parsed answer',
    result.finalPreview?.text === result.finalAnswer,
    `${result.finalPreview?.chars} chars, ${result.finalPreview?.frames} frames`,
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function signIn(client) {
  const registered = await client.post('/auth/register', {
    email: USER.email,
    password: USER.password,
    displayName: 'Streaming Verification',
  });

  if (registered.status !== 201) {
    const loggedIn = await client.post('/auth/login', { email: USER.email, password: USER.password });

    if (loggedIn.status !== 200) {
      throw new Error(`Could not sign in: ${loggedIn.status} ${JSON.stringify(loggedIn.body)}`);
    }
  }

  return findUserByEmail(USER.email);
}

async function main() {
  console.log('Quorum — streaming the final answer\n');
  console.log(`  STREAM_FINAL_ANSWER=${STREAM_FINAL_ANSWER}, FINAL_DELTA_FLUSH_CHARS=${FINAL_DELTA_FLUSH_CHARS}`);

  const health = await fetch(`${BASE}/health`).catch(() => null);

  if (!health?.ok) {
    console.error('\n  The server is not running. Start it with `npm run dev` and try again.\n');
    process.exitCode = 1;
    return;
  }

  verifyScanner();

  const models = await listActiveModels();

  await verifyStreamedCall(models);

  const client = makeClient();
  const user = await signIn(client);

  /**
   * Funded on purpose, and through creditTopup rather than an UPDATE, so the
   * ledger invariant SUM(amount) = credit_balance survives this script and the
   * debit check below asserts something about the wallet rather than about the
   * fixture. The id is per-run, because a topup is idempotent on it.
   */
  await creditTopup({
    userId: user.id,
    amount: 5,
    stripePaymentId: `pi_stream_verify_${randomUUID()}`,
  });

  const { council } = await verifyLiveRound(client, user);

  await verifyFlagOff(user, council);
  await verifyPreviewCannotFailARound(user, council);

  heading('Result');

  console.log(`  ${spend.calls} calls, about ${money(spend.cost)} spent.\n`);

  if (failures.length === 0) {
    console.log('  All checks passed.\n');
    return;
  }

  console.log(`  ${failures.length} FAILED:`);
  for (const failure of failures) console.log(`    - ${failure}`);
  console.log('');

  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('\nverify:streaming could not finish:', error);
    process.exitCode = 1;
  })
  .finally(closePool);
