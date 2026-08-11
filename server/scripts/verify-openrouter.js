#!/usr/bin/env node
/**
 * Proof that the Session 4 LLM layer works: prompt loading, a real call, a real
 * parallel fan-out, real cost accounting, every mapped failure, and the JSON
 * parser.
 *
 * Read-only with respect to the database — it reads the `models` table for
 * prices and writes nothing anywhere. It does spend real money at OpenRouter:
 * six calls against the cheap seeded tier, well under a cent in total.
 *
 *   npm run verify:llm
 */
import { closePool } from '../src/db/pool.js';
import { listActiveModels } from '../src/models/llmModel.js';
import { parseModelJson } from '../src/services/jsonResponse.js';
import { callModel, fetchCatalogue } from '../src/services/openrouterService.js';
import { PROMPT_STAGES, getPrompt, renderStage } from '../src/services/promptService.js';

const QUESTION = 'What is the capital of France? Answer in one short sentence.';

const failures = [];

function heading(text) {
  console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);
}

function check(label, passed, note = '') {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`);
  if (!passed) failures.push(label);
}

function money(value) {
  return value === null || value === undefined ? 'unknown' : `$${value.toFixed(8)}`;
}

function describeError(error) {
  const parts = [
    `code=${error.code ?? '(none)'}`,
    `status=${error.status ?? '(none)'}`,
    error.providerStatus === undefined ? null : `providerStatus=${error.providerStatus}`,
    `message="${error.message}"`,
    error.providerMessage ? `provider="${String(error.providerMessage).slice(0, 120)}"` : null,
  ];

  return parts.filter(Boolean).join(' ');
}

/** 1 — templates load and split. */
function verifyTemplates() {
  heading('1. Prompt templates');

  console.log(`  stages loaded: ${PROMPT_STAGES.join(', ')}`);

  for (const stage of PROMPT_STAGES) {
    const { system, user } = getPrompt(stage);
    check(
      `${stage}: system ${system.length} chars, user ${user.length} chars`,
      system.length > 0 && user.length > 0,
    );
  }

  const draft = getPrompt('draft');

  check(
    'draft template dropped the "# Stage 1" title block and the --- rule',
    !draft.system.includes('# Stage 1') && !draft.system.startsWith('---'),
  );
  check('draft user section still carries {{QUESTION}}', draft.user.includes('{{QUESTION}}'));

  console.log('\n--- 01-draft.md, System section as loaded -------------------------------------');
  console.log(draft.system);
  console.log('--- end ----------------------------------------------------------------------');

  const rendered = renderStage('draft', { QUESTION });

  console.log('\n--- 01-draft.md, User section rendered ---------------------------------------');
  console.log(rendered.user);
  console.log('--- end ----------------------------------------------------------------------');

  check(
    'render substituted {{QUESTION}} and blanked the absent {{ATTACHMENTS}}',
    rendered.user.includes(QUESTION) && !rendered.user.includes('{{'),
  );

  return rendered;
}

/** 2 — one real call against the cheapest seeded model. */
async function verifySingleCall(models, prompt) {
  heading('2. Single call — cheapest seeded model');

  const cheapest = models[0];
  console.log(`  model: ${cheapest.display_name} (${cheapest.openrouter_slug})`);

  const result = await callModel({
    modelSlug: cheapest.openrouter_slug,
    system: prompt.system,
    user: prompt.user,
    maxTokens: 200,
  });

  console.log(`\n  content:          ${JSON.stringify(result.content)}`);
  console.log(`  promptTokens:     ${result.promptTokens}`);
  console.log(`  completionTokens: ${result.completionTokens}`);
  console.log(`  cost:             ${money(result.cost)}`);
  console.log(`  latencyMs:        ${result.latencyMs}`);
  console.log(`  finishReason:     ${result.finishReason}\n`);

  check('content is a non-empty string', typeof result.content === 'string' && result.content.length > 0);
  check('token counts are positive', result.promptTokens > 0 && result.completionTokens > 0);
  check('cost is a number', typeof result.cost === 'number');
  check('latencyMs is a number', typeof result.latencyMs === 'number' && result.latencyMs > 0);
  check('raw response body is attached', Boolean(result.raw?.id));

  return { model: cheapest, result, from: 'single call' };
}

/** 3 — four models at once, and proof the fan-out actually overlaps. */
async function verifyParallel(models, prompt) {
  heading('3. Parallel fan-out — all four seeded models');

  const startedAt = process.hrtime.bigint();

  const settled = await Promise.allSettled(
    models.map((model) =>
      callModel({
        modelSlug: model.openrouter_slug,
        system: prompt.system,
        user: prompt.user,
        maxTokens: 200,
      }),
    ),
  );

  const wallClockMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

  const columns = [
    ['model', 30],
    ['latency', 9],
    ['tokens', 10],
    ['cost', 13],
    ['content (first 80 chars)', 82],
  ];

  console.log(`\n  ${columns.map(([name, width]) => name.padEnd(width)).join('')}`);
  console.log(`  ${columns.map(([, width]) => '-'.repeat(width - 1).padEnd(width)).join('')}`);

  let sumLatency = 0;
  const results = [];

  settled.forEach((outcome, index) => {
    const slug = models[index].openrouter_slug;

    if (outcome.status === 'rejected') {
      console.log(`  ${slug.padEnd(30)}${'REJECTED'.padEnd(9)}${describeError(outcome.reason)}`);
      failures.push(`parallel call to ${slug}`);
      return;
    }

    const value = outcome.value;
    sumLatency += value.latencyMs;
    results.push({ model: models[index], result: value, from: 'fan-out' });

    const oneLine = value.content.replace(/\s+/g, ' ').trim().slice(0, 80);

    console.log(
      `  ${slug.padEnd(30)}` +
        `${`${value.latencyMs}ms`.padEnd(9)}` +
        `${`${value.promptTokens}/${value.completionTokens}`.padEnd(10)}` +
        `${money(value.cost).padEnd(13)}` +
        oneLine,
    );
  });

  console.log(`\n  wall clock (all four, parallel): ${wallClockMs}ms`);
  console.log(`  sum of individual latencies:     ${sumLatency}ms`);
  console.log(`  overlap saved:                   ${sumLatency - wallClockMs}ms`);

  check(
    'fan-out overlapped — wall clock is below the sum of latencies',
    wallClockMs < sumLatency,
    `${wallClockMs}ms vs ${sumLatency}ms`,
  );
  check('all four models answered', results.length === models.length);

  return results;
}

/** 4 — usage.cost came from OpenRouter, not from our fallback. */
function verifyUsageCost(all) {
  heading('4. Cost accounting — usage.cost present on every response');

  for (const { model, result, from } of all) {
    const reported = result.raw?.usage?.cost;
    const present = typeof reported === 'number';

    check(
      `${model.openrouter_slug} (${from}): usage.cost ${present ? `present (${reported})` : 'ABSENT — fell back to the models table'}`,
      present,
    );
  }
}

/** 5 — the billed figure against our own price table. */
function verifyCostMaths({ model, result }) {
  heading('5. Reported cost vs models-table maths');

  const inputPer1k = Number(model.input_per_1k);
  const outputPer1k = Number(model.output_per_1k);
  const computed =
    (result.promptTokens / 1000) * inputPer1k + (result.completionTokens / 1000) * outputPer1k;

  console.log(`  model:            ${model.openrouter_slug}`);
  console.log(`  upstream:         ${result.raw?.provider ?? 'not reported'}`);
  console.log(`  tokens:           ${result.promptTokens} in / ${result.completionTokens} out`);
  console.log(`  models table:     $${inputPer1k}/1k in, $${outputPer1k}/1k out`);
  console.log(`  computed cost:    ${money(computed)}`);
  console.log(`  OpenRouter cost:  ${money(result.cost)}`);
  console.log(`  difference:       ${money(Math.abs(computed - result.cost))}`);

  // Not an equality check, and it must not become one. OpenRouter routes a slug
  // to whichever upstream is available — the same call has come back served by
  // Parasail, Google and DeepInfra on consecutive runs, at three different
  // prices for the same token count. Our table holds one price per model, so it
  // is an estimate by construction and usage.cost is the figure we bill. Order
  // of magnitude is all that is being confirmed here.
  const ratio = computed === 0 ? 1 : result.cost / computed;
  check(
    'the two figures agree to within an order of magnitude',
    ratio > 0.1 && ratio < 10,
    `ratio ${ratio.toFixed(3)}`,
  );
}

/** 6 — every failure path maps to one of our codes, never a raw fetch error. */
async function verifyFailurePaths(models, prompt) {
  heading('6. Failure paths');

  console.log('\n  a) nonexistent model slug');
  try {
    await callModel({
      modelSlug: 'quorum/model-that-does-not-exist',
      system: prompt.system,
      user: prompt.user,
      maxTokens: 50,
    });
    check('nonexistent slug is rejected', false, 'the call unexpectedly succeeded');
  } catch (error) {
    console.log(`     ${describeError(error)}`);
    check(
      'nonexistent slug maps to OPENROUTER_BAD_REQUEST',
      error.code === 'OPENROUTER_BAD_REQUEST',
      `got ${error.code}`,
    );
  }

  console.log('\n  b) 1ms timeout against a real model');
  try {
    await callModel({
      modelSlug: models[0].openrouter_slug,
      system: prompt.system,
      user: prompt.user,
      maxTokens: 50,
      timeoutMs: 1,
    });
    check('the 1ms deadline aborts the call', false, 'the call unexpectedly succeeded');
  } catch (error) {
    console.log(`     ${describeError(error)}`);
    check(
      '1ms deadline maps to OPENROUTER_TIMEOUT',
      error.code === 'OPENROUTER_TIMEOUT',
      `got ${error.code}`,
    );
    check('the timeout is a 504, not a 500', error.status === 504);
  }
}

/**
 * 6, continued — the rest of the status map, and the retry policy.
 *
 * Offline: `fetch` is stubbed for this section so every branch can be reached
 * without provoking a real 402 or waiting for a real outage. Restored after.
 * Nothing is spent and no request leaves the machine.
 */
async function verifyStatusMap(models, prompt) {
  const realFetch = globalThis.fetch;
  let attempts = 0;

  const stub = (
    statuses,
    usage = { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
    choice = { message: { content: 'ok' }, finish_reason: 'stop' },
  ) => {
    const queue = [...statuses];
    return async () => {
      attempts += 1;
      // The last status repeats once the queue runs down, so [429] means "429
      // every time" rather than "429 then undefined" — which would have made
      // the retry land on the default mapping instead of the one under test.
      const status = queue.length > 1 ? queue.shift() : queue[0];
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () =>
          status === 200
            ? JSON.stringify({ id: 'stub', provider: 'Stubbed', choices: [choice], usage })
            : JSON.stringify({ error: { message: `stubbed ${status}` } }),
      };
    };
  };

  const call = () =>
    callModel({
      modelSlug: models[0].openrouter_slug,
      system: prompt.system,
      user: prompt.user,
      maxTokens: 10,
    });

  const cases = [
    { label: 'c) 500 then 200 — retried once, succeeds', statuses: [500, 200], expect: null, expectAttempts: 2 },
    { label: 'd) 503 twice — retried once, then gives up', statuses: [503], expect: 'OPENROUTER_UNAVAILABLE', expectAttempts: 2 },
    { label: 'e) 429 twice — retried once, then gives up', statuses: [429], expect: 'OPENROUTER_RATE_LIMIT', expectAttempts: 2 },
    { label: 'f) 401 — never retried', statuses: [401], expect: 'OPENROUTER_AUTH', expectAttempts: 1 },
    { label: 'g) 402 — never retried', statuses: [402], expect: 'OPENROUTER_INSUFFICIENT_CREDIT', expectAttempts: 1 },
    { label: 'h) 404 — never retried', statuses: [404], expect: 'OPENROUTER_BAD_REQUEST', expectAttempts: 1 },
  ];

  try {
    for (const { label, statuses, expect, expectAttempts } of cases) {
      attempts = 0;
      globalThis.fetch = stub(statuses);

      const startedAt = process.hrtime.bigint();
      let code = null;

      try {
        await call();
      } catch (error) {
        code = error.code;
      }

      const elapsedMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

      console.log(`\n  ${label}`);
      console.log(`     attempts=${attempts} elapsed=${elapsedMs}ms code=${code ?? 'none — call succeeded'}`);

      check(`${label.slice(0, 2)} code`, code === expect, `expected ${expect ?? 'success'}, got ${code}`);
      check(
        `${label.slice(0, 2)} attempts`,
        attempts === expectAttempts,
        `expected ${expectAttempts}, made ${attempts}`,
      );

      if (expectAttempts === 2) {
        check(`${label.slice(0, 2)} backed off ~2s before retrying`, elapsedMs >= 2000, `${elapsedMs}ms`);
      }
    }

    /**
     * The cost fallback. OpenRouter has returned usage.cost on every real call
     * in this run, so the only way to see this path is to serve a 200 without
     * it — which is exactly the shape of the outage the fallback exists for.
     */
    console.log('\n  i) 200 with no usage.cost — falls back to the models table');

    globalThis.fetch = stub([200], { prompt_tokens: 1000, completion_tokens: 1000 });

    const fallback = await call();
    const expected = Number(models[0].input_per_1k) + Number(models[0].output_per_1k);

    console.log(`     models table says ${money(expected)} for 1000 in / 1000 out; got ${money(fallback.cost)}`);
    check('i) cost was computed from the models table', fallback.cost === expected);

    console.log('\n  j) 200 with no usage.cost, for a slug not in the models table');

    const unknown = await callModel({
      modelSlug: 'quorum/not-in-our-catalogue',
      system: prompt.system,
      user: prompt.user,
      maxTokens: 10,
    });

    console.log(`     cost=${unknown.cost} (null is correct — nothing to price it against)`);
    check('j) cost is null rather than a guess', unknown.cost === null);

    /**
     * An upstream failure dressed as a 200. Found by the Session 5 debate runs:
     * gemini-2.5-flash answered 200 after 20s with finish_reason 'error', zero
     * tokens and no content. Returned as a success it would have counted toward
     * the engine's two-draft quorum.
     */
    console.log("\n  k) 200 with finish_reason 'error' and empty content");

    attempts = 0;
    globalThis.fetch = stub(
      [200],
      { prompt_tokens: 12, completion_tokens: 0, cost: 0.000004 },
      { message: { content: '' }, finish_reason: 'error' },
    );

    let emptyError = null;

    try {
      await call();
    } catch (error) {
      emptyError = error;
    }

    console.log(`     attempts=${attempts} code=${emptyError?.code} usage=${JSON.stringify(emptyError?.usage)}`);

    check('k) an errored finish reason is a failure, not a success', emptyError !== null);
    check('k) code is OPENROUTER_UNAVAILABLE', emptyError?.code === 'OPENROUTER_UNAVAILABLE');
    check('k) it was not retried', attempts === 1, `${attempts} attempts`);
    check(
      'k) what the failed call cost rides on the error, for the ledger',
      emptyError?.usage?.cost === 0.000004 && emptyError?.usage?.promptTokens === 12,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** 7 — the JSON parser against what models actually return. */
function verifyJsonParsing() {
  heading('7. parseModelJson');

  const cases = [
    ['clean JSON', '{"stance":"concede","argument":"Draft B is right about the dates."}', 'concede'],
    [
      'fenced JSON',
      '```json\n{"stance":"defend","argument":"The chairman misread the units."}\n```',
      'defend',
    ],
    [
      'prose before the JSON',
      'Certainly! Here is my response:\n\n{"stance":"revise","argument":"Partly right."}\n\nLet me know if you need more.',
      'revise',
    ],
  ];

  for (const [label, input, expected] of cases) {
    try {
      const parsed = parseModelJson(input);
      check(`${label} -> stance "${parsed.stance}"`, parsed.stance === expected);
    } catch (error) {
      check(label, false, describeError(error));
    }
  }

  try {
    parseModelJson('I am afraid I cannot answer that.');
    check('garbage is rejected', false, 'it parsed something');
  } catch (error) {
    console.log(`  garbage -> ${describeError(error)}`);
    check('garbage maps to MODEL_JSON_INVALID', error.code === 'MODEL_JSON_INVALID');
    check(
      'the raw content rides along for model_responses.error_text',
      error.rawContent === 'I am afraid I cannot answer that.',
    );
  }
}

/** 8 — the catalogue endpoint the price-refresh script will use. */
async function verifyCatalogue(models) {
  heading('8. fetchCatalogue');

  const catalogue = await fetchCatalogue();
  console.log(`  models returned: ${catalogue.length}`);

  check('the catalogue is a non-empty array', Array.isArray(catalogue) && catalogue.length > 0);

  const seeded = new Set(models.map((model) => model.openrouter_slug));
  const found = catalogue.filter((entry) => seeded.has(entry.id));

  for (const entry of found) {
    console.log(
      `  ${entry.id.padEnd(30)} prompt $${entry.pricing?.prompt}/tok  completion $${entry.pricing?.completion}/tok`,
    );
  }

  check(
    'all four seeded slugs are still live in the catalogue',
    found.length === models.length,
    `${found.length}/${models.length}`,
  );
}

async function main() {
  const prompt = verifyTemplates();

  // Cheapest first, so models[0] is the one the single call and the timeout use.
  const models = (await listActiveModels()).sort(
    (a, b) =>
      Number(a.input_per_1k) + Number(a.output_per_1k) -
      (Number(b.input_per_1k) + Number(b.output_per_1k)),
  );

  if (models.length === 0) throw new Error('No active models in the catalogue — run npm run migrate.');

  const single = await verifySingleCall(models, prompt);
  const fanned = await verifyParallel(models, prompt);

  verifyUsageCost([single, ...fanned]);
  verifyCostMaths(single);

  await verifyFailurePaths(models, prompt);
  await verifyStatusMap(models, prompt);
  verifyJsonParsing();
  await verifyCatalogue(models);

  const spent = [single, ...fanned].reduce((total, { result }) => total + (result.cost ?? 0), 0);

  heading(failures.length === 0 ? 'All checks passed' : `${failures.length} check(s) FAILED`);
  for (const failure of failures) console.log(`  - ${failure}`);
  console.log(`  total spent on this run: ${money(spent)}`);
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
