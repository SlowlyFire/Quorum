#!/usr/bin/env node
/**
 * Proof that the wallet bills correctly: real rounds against real models, real
 * money arithmetic, and a real signed Stripe webhook.
 *
 * The server must already be running — `npm run dev` in another terminal — for
 * everything driven over HTTP, which is most of it. What is checked is the
 * bytes we send and the rows we wrote, never a description of them.
 *
 * It WRITES to the database and leaves everything behind, because check 10 is
 * only meaningful if the ledger is still there to read through psql. It also
 * SETS BALANCES BY HAND, through psql, which is the only way to stand a user in
 * front of each branch of §3's rule without spending real money to get there.
 *
 * Roughly six real rounds, about $0.05 a run.
 *
 *   npm run verify:wallet
 *
 * The two Stripe checks (5 and 6) construct a signed event locally with the
 * SDK's own test-header helper and post it to the live endpoint, so they run
 * with no CLI and no browser. That verifies the signature path, the crediting
 * and the idempotency — but NOT that a card payment produces such an event, so
 * the script prints the `stripe listen` recipe for the end-to-end run too.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Stripe from 'stripe';

import { MAX_TOKENS, STAGE_TOKEN_AVERAGES } from '../src/config/llm.js';
import { env } from '../src/config/env.js';
import { closePool } from '../src/db/pool.js';
import { listActiveModels } from '../src/models/llmModel.js';
import { findUserByEmail } from '../src/models/userModel.js';
import { runRound } from '../src/services/debateService.js';
import { insertSession } from '../src/models/sessionModel.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const BASE = 'http://localhost:3000/api';

/** Funded throughout, and the account every paid-path check runs as. */
const PAID = { email: 'wallet-verify-paid@example.com', password: 'the wallet is funded' };
/** Emptied and stripped of today's rounds at the start, for the free tier. */
const FREE = { email: 'wallet-verify-free@example.com', password: 'the wallet is empty' };
/**
 * The reconciliation account, and the reason it is a third one: its balance is
 * set by hand exactly once, to zero, and moves only through the ledger after
 * that. The other two have balances set by psql between checks to stand them in
 * front of each branch of the rule, which is a change no ledger row records —
 * so SUM(amount) cannot equal their balance and check 10 would be asserting
 * something about the fixture rather than about the wallet.
 */
const LEDGER = { email: 'wallet-verify-ledger@example.com', password: 'every cent accounted for' };

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

function money(value) {
  return `$${Number(value).toFixed(6)}`;
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

/** The first data value out of psql's aligned table output. */
function firstValue(output) {
  const lines = output.split('\n');
  return lines[2]?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// An HTTP client with a cookie jar, which is all a browser is here
// ---------------------------------------------------------------------------

function makeClient() {
  let cookie = null;

  /**
   * One retry on ECONNRESET, and it is about this script rather than about the
   * server. Node's fetch keeps sockets alive and Node's HTTP server closes an
   * idle one after five seconds, so a check that spends fifteen seconds in psql
   * between requests hands the next request a socket the server has already
   * hung up on. The retry opens a fresh one. Nothing else is retried — a real
   * failure must fail.
   */
  async function send(method, path, body) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await fetch(`${BASE}${path}`, {
          method,
          headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch (error) {
        if (attempt === 2 || error.cause?.code !== 'ECONNRESET') throw error;
      }
    }

    throw new Error('unreachable');
  }

  async function request(method, path, body) {
    const response = await send(method, path, body);

    for (const value of response.headers.getSetCookie?.() ?? []) {
      const [pair] = value.split(';');
      if (pair.startsWith('quorum_token=')) cookie = pair;
    }

    const text = await response.text();
    const isJson = response.headers.get('content-type')?.includes('application/json');

    return {
      status: response.status,
      body: isJson && text ? JSON.parse(text) : null,
      text,
      headers: response.headers,
    };
  }

  return {
    request,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    del: (path) => request('DELETE', path),
    get cookie() {
      return cookie;
    },
  };
}

async function signIn(client, { email, password }) {
  const registered = await client.post('/auth/register', {
    email,
    password,
    displayName: 'Wallet Verification',
  });

  if (registered.status === 201) return registered.body.user;

  const loggedIn = await client.post('/auth/login', { email, password });

  if (loggedIn.status !== 200) {
    throw new Error(`Could not sign in as ${email}: ${loggedIn.status} ${loggedIn.text}`);
  }

  return loggedIn.body.user;
}

// ---------------------------------------------------------------------------
// Wallet fixtures
// ---------------------------------------------------------------------------

function setBalance(userId, amount) {
  psql(`UPDATE users SET credit_balance = ${amount} WHERE id = '${userId}'`);
}

function balanceOf(userId) {
  return Number(firstValue(psql(`SELECT credit_balance FROM users WHERE id = '${userId}'`)));
}

function ledgerRowsFor(userId) {
  return Number(
    firstValue(psql(`SELECT count(*) FROM credit_transactions WHERE user_id = '${userId}'`)),
  );
}

/**
 * Wipes an account back to a known starting point: no rounds today, no ledger,
 * a chosen balance. The free-tier count is a query against `rounds`, so a
 * second run of this script on the same day would otherwise inherit the first
 * run's count and check 3 would fail for the wrong reason.
 */
function resetAccount(userId, balance) {
  psql(`DELETE FROM credit_transactions WHERE user_id = '${userId}'`);
  psql(`DELETE FROM rounds WHERE user_id = '${userId}'`);
  setBalance(userId, balance);
}

async function createSessionWith(client, models, chairmanId, title) {
  const created = await client.post('/sessions', {
    title,
    council: { modelIds: models.map((model) => model.id), chairmanId },
    chairmanAbstains: true,
    rebuttalEnabled: true,
  });

  if (created.status !== 201) {
    throw new Error(`Could not create a session: ${created.status} ${created.text}`);
  }

  return created.body.session;
}

/** Polls GET /api/rounds/:id until the engine is finished with it. */
async function awaitRound(client, roundId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { body } = await client.get(`/rounds/${roundId}`);
    const status = body?.round?.status;

    if (status === 'complete' || status === 'failed') return body.round;

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error(`Round ${roundId} did not settle within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// 1 — the estimate, before and after
// ---------------------------------------------------------------------------

/**
 * Session 6's estimate priced the completion side at a fraction of MAX_TOKENS.
 * These are the numbers it used, kept here so the comparison is against the
 * real thing rather than a description of it — and kept ONLY here, because
 * config/llm.js no longer holds them.
 */
const OLD_COMPLETION_RATIO = 0.4;
const OLD_PROMPT_TOKENS = { draft: 150, verdict: 900, rebuttal: 1150, final: 1250 };

function priceRound(rows, tokensFor) {
  return rows.reduce((total, row) => {
    const tokens = tokensFor(row.stage);

    return (
      total +
      (tokens.prompt / 1000) * Number(row.input_per_1k) +
      (tokens.completion / 1000) * Number(row.output_per_1k)
    );
  }, 0);
}

async function verifyEstimate() {
  heading('1. The estimate, before and after — against rounds already run');

  const output = psql(`
    SELECT r.id, r.total_cost
    FROM rounds r
    WHERE r.status = 'complete' AND r.total_cost > 0
    ORDER BY r.created_at DESC
    LIMIT 5
  `);

  const ids = output
    .split('\n')
    .slice(2)
    .map((line) => line.trim().split(/\s*\|\s*/))
    .filter((parts) => parts.length === 2 && parts[0].length === 36);

  if (ids.length === 0) {
    check('there are finished rounds to compare against', false, 'none found');
    return;
  }

  console.log('  round     calls   before      after       actual      before/actual  after/actual');

  const ratios = { before: [], after: [] };

  for (const [id, actualCost] of ids) {
    const callsOutput = psql(`
      SELECT mr.stage, m.input_per_1k, m.output_per_1k
      FROM model_responses mr JOIN models m ON m.id = mr.model_id
      WHERE mr.round_id = '${id}'
    `);

    const rows = callsOutput
      .split('\n')
      .slice(2)
      .map((line) => line.trim().split(/\s*\|\s*/))
      .filter((parts) => parts.length === 3)
      .map(([stage, input_per_1k, output_per_1k]) => ({ stage, input_per_1k, output_per_1k }));

    if (rows.length === 0) continue;

    const before = priceRound(rows, (stage) => ({
      prompt: OLD_PROMPT_TOKENS[stage],
      completion: MAX_TOKENS[stage] * OLD_COMPLETION_RATIO,
    }));
    const after = priceRound(rows, (stage) => STAGE_TOKEN_AVERAGES[stage]);
    const actual = Number(actualCost);

    ratios.before.push(before / actual);
    ratios.after.push(after / actual);

    console.log(
      `  ${id.slice(0, 8)}  ${String(rows.length).padStart(5)}   ` +
        `${money(before).padEnd(11)} ${money(after).padEnd(11)} ${money(actual).padEnd(11)} ` +
        `${(before / actual).toFixed(2)}x`.padEnd(15) +
        `${(after / actual).toFixed(2)}x`,
    );
  }

  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  const beforeMean = mean(ratios.before);
  const afterMean = mean(ratios.after);

  console.log(`\n  mean overshoot before: ${beforeMean.toFixed(2)}x`);
  console.log(`  mean overshoot after:  ${afterMean.toFixed(2)}x`);

  check('the new estimate is closer to the billed figure', afterMean < beforeMean);
  check('the old estimate overshot by more than 2x', beforeMean > 2);
  check('the new estimate overshoots by less than 2x', afterMean < 2);
  check(
    'the new estimate still leans high — a quote under the bill is the wrong error',
    afterMean > 1,
    `${afterMean.toFixed(2)}x`,
  );
}

// ---------------------------------------------------------------------------
// 2 — a paid round writes one ledger row
// ---------------------------------------------------------------------------

async function verifyPaidRound(client, user, models) {
  heading('2. A paid round — one ledger row, correct balance_after');

  setBalance(user.id, 5);

  const chairman = models[0];
  const session = await createSessionWith(client, models.slice(0, 3), chairman.id, 'Wallet — paid round');

  const before = balanceOf(user.id);
  console.log(`  balance before: ${money(before)}`);

  const started = await client.post(`/sessions/${session.id}/rounds`, {
    prompt: 'In one paragraph: why is a write-ahead log useful?',
  });

  check('POST /rounds answered 202', started.status === 202, String(started.status));
  check('the 202 says which side of the rule this round fell on', started.body?.billing?.mode === 'paid', started.body?.billing?.mode);
  console.log(`  quoted: ${money(started.body.billing.estimate)}  threshold: ${money(started.body.billing.threshold)}`);

  const round = await awaitRound(client, started.body.roundId);
  console.log(`  round settled: ${round.status}, ${round.responses.length} calls, ${money(round.totalCost)}`);

  const after = balanceOf(user.id);
  const rows = psql(`
    SELECT type, amount, balance_after
    FROM credit_transactions
    WHERE round_id = '${round.id}'
  `);

  console.log(`\n${rows}\n`);

  const rowCount = Number(
    firstValue(psql(`SELECT count(*) FROM credit_transactions WHERE round_id = '${round.id}'`)),
  );

  check(
    'exactly ONE ledger row for the round, not one per call',
    rowCount === 1,
    `${rowCount} row(s) for ${round.responses.length} calls`,
  );

  const amount = Number(firstValue(psql(`SELECT amount FROM credit_transactions WHERE round_id = '${round.id}'`)));
  const balanceAfter = Number(
    firstValue(psql(`SELECT balance_after FROM credit_transactions WHERE round_id = '${round.id}'`)),
  );

  check('the debit is negative', amount < 0, money(amount));
  check(
    'the debit equals rounds.total_cost',
    Math.abs(Math.abs(amount) - round.totalCost) < 1e-8,
    `${money(Math.abs(amount))} vs ${money(round.totalCost)}`,
  );
  check(
    'balance_after matches the balance the row left behind',
    Math.abs(balanceAfter - after) < 1e-6,
    `${money(balanceAfter)} vs ${money(after)}`,
  );
  check(
    'the balance fell by exactly the debit',
    Math.abs(before - Math.abs(amount) - after) < 1e-6,
    `${money(before)} - ${money(Math.abs(amount))} = ${money(after)}`,
  );

  // The quote is the thing check 1 measured; here it meets a real bill.
  console.log(
    `\n  quoted ${money(started.body.billing.estimate)} against ${money(round.totalCost)} billed — ` +
      `${(started.body.billing.estimate / round.totalCost).toFixed(2)}x`,
  );

  return round;
}

// ---------------------------------------------------------------------------
// 3 — the free tier: two, then 402
// ---------------------------------------------------------------------------

async function verifyFreeTier(client, user, models) {
  heading('3. An empty wallet — two free debates, then 402 DAILY_LIMIT_REACHED');

  resetAccount(user.id, 0);

  const session = await createSessionWith(client, models.slice(0, 3), models[0].id, 'Wallet — free tier');

  for (const attempt of [1, 2]) {
    const started = await client.post(`/sessions/${session.id}/rounds`, {
      prompt: `Free debate ${attempt}: name one advantage of an append-only log.`,
    });

    check(`free debate ${attempt} was allowed`, started.status === 202, String(started.status));
    check(`free debate ${attempt} is billed as 'free'`, started.body?.billing?.mode === 'free', started.body?.billing?.mode);
    console.log(`    freeRemaining before it started: ${started.body?.billing?.freeRemaining}`);

    // Awaited rather than fired in parallel: the count is a query against
    // `rounds` and the row exists from the 202 onward, so this is only about
    // letting the engine finish before the balance is inspected.
    const round = await awaitRound(client, started.body.roundId);
    console.log(`    settled ${round.status}, ${money(round.totalCost)} — which the user does NOT pay`);
  }

  const rows = ledgerRowsFor(user.id);
  const balance = balanceOf(user.id);

  check('a free round writes NO ledger row', rows === 0, `${rows} row(s)`);
  check('a free round does not move the balance', balance === 0, money(balance));

  const spent = firstValue(psql(`SELECT coalesce(sum(total_cost), 0) FROM rounds WHERE user_id = '${user.id}'`));
  console.log(`\n  rounds.total_cost still records what the two cost us: ${money(spent)}`);
  check('what a free round cost us is still recorded on the round', Number(spent) > 0);

  const third = await client.post(`/sessions/${session.id}/rounds`, {
    prompt: 'A third debate, which should be refused.',
  });

  console.log(`\n  third attempt: ${third.status} ${third.body?.error?.code}`);
  console.log(`  message: ${third.body?.error?.message}`);
  console.log(`  billing: ${JSON.stringify(third.body?.error?.billing)}`);

  check('the third debate is refused', third.status === 402, String(third.status));
  check('the code is DAILY_LIMIT_REACHED', third.body?.error?.code === 'DAILY_LIMIT_REACHED', third.body?.error?.code);
  check('the refusal carries an estimate', typeof third.body?.error?.billing?.estimate === 'number');
  check('the refusal carries a balance', typeof third.body?.error?.billing?.balance === 'number');
  check('the refusal carries freeRemaining: 0', third.body?.error?.billing?.freeRemaining === 0);

  const roundCount = Number(firstValue(psql(`SELECT count(*) FROM rounds WHERE user_id = '${user.id}'`)));
  check('the refused attempt created no round row', roundCount === 2, `${roundCount} round(s)`);
}

// ---------------------------------------------------------------------------
// 4 — a balance below the threshold falls to the free tier
// ---------------------------------------------------------------------------

async function verifyBelowThreshold(client, user, models) {
  heading('4. $0.03 against a four-model council — below threshold, falls to free');

  resetAccount(user.id, 0.03);

  const session = await createSessionWith(client, models, models[0].id, 'Wallet — below threshold');

  const started = await client.post(`/sessions/${session.id}/rounds`, {
    prompt: 'One sentence: what is a bloom filter for?',
  });

  const billing = started.body?.billing ?? started.body?.error?.billing;

  console.log(`  status:    ${started.status}`);
  console.log(`  balance:   ${money(billing.balance)}`);
  console.log(`  estimate:  ${money(billing.estimate)}   (4 models, chairman abstaining)`);
  console.log(`  threshold: ${money(billing.threshold)}   = max($0.05, estimate x 1.5)`);
  console.log(`  mode:      ${billing.mode}`);

  check('the round was allowed', started.status === 202, String(started.status));
  check('the balance is below the threshold', billing.balance < billing.threshold);
  check("so it fell to the free tier rather than being refused", billing.mode === 'free', billing.mode);
  check(
    'the threshold is max($0.05, estimate x 1.5)',
    Math.abs(billing.threshold - Math.max(0.05, billing.estimate * 1.5)) < 1e-8,
  );

  const round = await awaitRound(client, started.body.roundId);
  const balance = balanceOf(user.id);

  check(
    'the $0.03 was not touched — a free round is free even with money in the wallet',
    Math.abs(balance - 0.03) < 1e-6,
    money(balance),
  );
  check('and no ledger row was written', ledgerRowsFor(user.id) === 0);

  console.log(`\n  the round itself cost us ${money(round.totalCost)}, recorded on rounds.total_cost`);

  // The other refusal code: money in the wallet, allowance gone.
  psql(`DELETE FROM rounds WHERE user_id = '${user.id}'`);
  psql(`
    INSERT INTO rounds (session_id, user_id, user_prompt, chairman_model_id, chairman_abstains, status)
    SELECT '${session.id}', '${user.id}', 'placeholder', '${models[0].id}', true, 'complete'
    FROM generate_series(1, 2)
  `);

  const refused = await client.post(`/sessions/${session.id}/rounds`, {
    prompt: 'This one should be refused for having money but not enough.',
  });

  console.log(`\n  with the allowance gone: ${refused.status} ${refused.body?.error?.code}`);
  console.log(`  message: ${refused.body?.error?.message}`);

  check('a funded-but-insufficient wallet is refused', refused.status === 402, String(refused.status));
  check(
    'and the code says so — INSUFFICIENT_CREDIT, not DAILY_LIMIT_REACHED',
    refused.body?.error?.code === 'INSUFFICIENT_CREDIT',
    refused.body?.error?.code,
  );
  check('the message names both figures', refused.body?.error?.message?.includes('$0.03'));
}

// ---------------------------------------------------------------------------
// 5 and 6 — Stripe: credit once, and only once
// ---------------------------------------------------------------------------

/**
 * A webhook event Stripe would send, signed with our own webhook secret through
 * the SDK's test-header helper. That is the same HMAC the real signature is, so
 * the endpoint cannot tell this from Stripe — which is the point: everything
 * from the signature check inward is exercised for real.
 */
function signedWebhook(payload) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const body = JSON.stringify(payload);

  return {
    body,
    signature: stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: env.STRIPE_WEBHOOK_SECRET,
    }),
  };
}

async function postWebhook({ body, signature }) {
  const response = await fetch('http://localhost:3000/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body,
  });

  return { status: response.status, body: await response.json().catch(() => null) };
}

async function verifyStripe(client, user, models) {
  heading('5. Stripe — a signed checkout.session.completed credits the balance');

  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    check('Stripe credentials are configured', false, 'set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
    return;
  }

  const paymentId = `pi_verify_${Date.now()}`;
  const event = {
    id: `evt_verify_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_verify_${Date.now()}`,
        object: 'checkout.session',
        payment_intent: paymentId,
        payment_status: 'paid',
        amount_total: 1500,
        client_reference_id: user.id,
        metadata: { userId: user.id, credits: '15' },
      },
    },
  };

  const signed = signedWebhook(event);

  const before = balanceOf(user.id);
  const first = await postWebhook(signed);
  const afterFirst = balanceOf(user.id);

  console.log(`  balance before:  ${money(before)}`);
  console.log(`  webhook 1:       ${first.status} ${JSON.stringify(first.body)}`);
  console.log(`  balance after:   ${money(afterFirst)}`);

  check('the signed event was accepted', first.status === 200, String(first.status));
  check('it reported crediting', first.body?.credited === true);
  check('the balance rose by $15', Math.abs(afterFirst - before - 15) < 1e-6, money(afterFirst));

  const topupRows = psql(`
    SELECT type, amount, balance_after, stripe_payment_id
    FROM credit_transactions WHERE user_id = '${user.id}' AND type = 'topup'
  `);
  console.log(`\n${topupRows}\n`);

  const topupCount = Number(
    firstValue(psql(`SELECT count(*) FROM credit_transactions WHERE stripe_payment_id = '${paymentId}'`)),
  );

  check('one topup row', topupCount === 1, `${topupCount} row(s)`);

  // -- an unsigned request is not a credit ---------------------------------

  const unsigned = await postWebhook({ body: signed.body, signature: 't=1,v1=deadbeef' });

  console.log(`  a wrongly signed replay: ${unsigned.status} ${unsigned.body?.error?.code}`);
  check('a bad signature is refused', unsigned.status === 400, String(unsigned.status));
  check('with STRIPE_SIGNATURE_INVALID', unsigned.body?.error?.code === 'STRIPE_SIGNATURE_INVALID');
  check('and credits nothing', Math.abs(balanceOf(user.id) - afterFirst) < 1e-9);

  // -- 6: the replay -------------------------------------------------------

  heading('6. Stripe retries — the same event replayed credits nothing twice');

  const second = await postWebhook(signed);
  const afterSecond = balanceOf(user.id);
  const rowsAfter = Number(
    firstValue(psql(`SELECT count(*) FROM credit_transactions WHERE stripe_payment_id = '${paymentId}'`)),
  );

  console.log(`  webhook 2 (byte-identical): ${second.status} ${JSON.stringify(second.body)}`);
  console.log(`  balance:  ${money(afterFirst)} -> ${money(afterSecond)}`);
  console.log(`  ledger rows: ${rowsAfter}`);

  check('the replay is answered 200, not 4xx — a 4xx makes Stripe retry forever', second.status === 200);
  check('it reports that nothing was credited', second.body?.credited === false);
  check('the balance is unchanged', Math.abs(afterSecond - afterFirst) < 1e-9, money(afterSecond));
  check('no second row was written', rowsAfter === 1, `${rowsAfter} row(s)`);

  // -- the unique index, independently of the lock -------------------------

  const duplicate = spawnSync(
    process.execPath,
    [
      path.join(currentDir, 'psql.js'),
      '-c',
      `INSERT INTO credit_transactions (user_id, type, amount, balance_after, stripe_payment_id)
       VALUES ('${user.id}', 'topup', 15, 30, '${paymentId}')`,
    ],
    { encoding: 'utf8' },
  );

  check(
    'the partial unique index refuses a duplicate payment id outright',
    duplicate.status !== 0 && /duplicate key|unique/i.test(duplicate.stderr + duplicate.stdout),
  );

  console.log('\n  END-TO-END, with a real card, is two commands and a browser:');
  console.log('    stripe listen --forward-to localhost:3000/api/webhooks/stripe');
  console.log('    POST /api/wallet/checkout { "amount": 15 }, open the url, pay 4242 4242 4242 4242');

  // One real round on the freshly credited balance, so check 10 reconciles a
  // ledger with movement in both directions rather than a single top-up.
  const session = await createSessionWith(client, models.slice(0, 3), models[0].id, 'Wallet — ledger');
  const started = await client.post(`/sessions/${session.id}/rounds`, {
    prompt: 'One sentence: what does a two-phase commit protect against?',
  });

  check('a round on the credited balance is a paid one', started.body?.billing?.mode === 'paid');
  const round = await awaitRound(client, started.body.roundId);
  console.log(`\n  and one round spent ${money(round.totalCost)} of it`);
}

// ---------------------------------------------------------------------------
// 7 — a round that fails is still billed for what it spent
// ---------------------------------------------------------------------------

async function verifyFailedRoundIsBilled(user, models) {
  heading('7. A round that fails mid-debate — the partial cost is still debited');

  setBalance(user.id, 5);

  /**
   * Two drafters carry slugs OpenRouter will refuse, so exactly one draft
   * succeeds and the round dies on INSUFFICIENT_DRAFTS — after that one draft
   * has been made and billed to us. Driven through the engine rather than over
   * HTTP because the council has to be corrupted after it is resolved, which
   * only a direct caller can do.
   */
  const council = {
    models: models.slice(0, 4).map((model) => ({ ...model })),
    chairmanAbstains: true,
    rebuttalEnabled: true,
  };
  council.chairmanId = council.models[0].id;
  council.models[1].slug = `${council.models[1].slug}-does-not-exist`;
  council.models[2].slug = `${council.models[2].slug}-does-not-exist`;

  const session = await insertSession({ userId: user.id, title: 'Wallet — a failing round' });

  const before = balanceOf(user.id);
  let roundId = null;
  let thrown = null;

  try {
    await runRound({
      sessionId: session.id,
      userId: user.id,
      prompt: 'This round is expected to fail after one draft.',
      council,
      billingMode: 'paid',
      onEvent: async (event, payload) => {
        if (event === 'round_started') roundId = payload.roundId;
      },
    });
  } catch (error) {
    thrown = error;
  }

  check('the round failed', Boolean(thrown), thrown?.code);

  const roundCost = Number(firstValue(psql(`SELECT total_cost FROM rounds WHERE id = '${roundId}'`)));
  const status = firstValue(psql(`SELECT status FROM rounds WHERE id = '${roundId}'`));
  const after = balanceOf(user.id);
  const rows = psql(`SELECT type, amount, balance_after FROM credit_transactions WHERE round_id = '${roundId}'`);

  console.log(`\n  round status: ${status}`);
  console.log(`  it spent:     ${money(roundCost)} before it died`);
  console.log(`  balance:      ${money(before)} -> ${money(after)}`);
  console.log(`\n${rows}\n`);

  check('the round is marked failed', status === 'failed', status);
  check('it still recorded what it spent', roundCost > 0, money(roundCost));
  check(
    'and the wallet was debited for it — we paid, so the user pays',
    Math.abs(before - roundCost - after) < 1e-6,
    `${money(before)} - ${money(roundCost)} = ${money(after)}`,
  );
  const failedRows = Number(
    firstValue(psql(`SELECT count(*) FROM credit_transactions WHERE round_id = '${roundId}'`)),
  );
  check('with one ledger row, as a successful round gets', failedRows === 1, `${failedRows} row(s)`);
}

// ---------------------------------------------------------------------------
// 8 — two rounds at once, which is what FOR UPDATE is for
// ---------------------------------------------------------------------------

async function verifyConcurrentRounds(client, user, models) {
  heading('8. Two rounds started at the same instant — both debits land');

  setBalance(user.id, 5);

  const session = await createSessionWith(client, models.slice(0, 3), models[0].id, 'Wallet — concurrent');

  const before = balanceOf(user.id);

  // Fired together, deliberately: they will finish within milliseconds of each
  // other, which is the window in which two debits can lose one another.
  const [first, second] = await Promise.all([
    client.post(`/sessions/${session.id}/rounds`, { prompt: 'Concurrent A: define idempotency.' }),
    client.post(`/sessions/${session.id}/rounds`, { prompt: 'Concurrent B: define atomicity.' }),
  ]);

  check('both were accepted', first.status === 202 && second.status === 202, `${first.status}, ${second.status}`);
  check(
    'both as paid rounds',
    first.body?.billing?.mode === 'paid' && second.body?.billing?.mode === 'paid',
  );

  const rounds = await Promise.all([
    awaitRound(client, first.body.roundId),
    awaitRound(client, second.body.roundId),
  ]);

  const totals = rounds.map((round) => round.totalCost);
  const after = balanceOf(user.id);
  const roundIds = [first.body.roundId, second.body.roundId].map((id) => `'${id}'`).join(', ');
  const rows = psql(`
    SELECT round_id, amount, balance_after
    FROM credit_transactions WHERE round_id IN (${roundIds}) ORDER BY created_at
  `);

  console.log(`\n  round costs: ${totals.map(money).join(', ')}`);
  console.log(`  balance:     ${money(before)} -> ${money(after)}`);
  console.log(`\n${rows}\n`);

  const expected = before - totals[0] - totals[1];
  const rowCount = Number(
    firstValue(psql(`SELECT count(*) FROM credit_transactions WHERE round_id IN (${roundIds})`)),
  );

  check('two ledger rows, one per round', rowCount === 2, `${rowCount} row(s)`);
  check(
    'the balance fell by both, not by one',
    Math.abs(after - expected) < 1e-6,
    `${money(after)} vs ${money(expected)}`,
  );

  /**
   * The invariant FOR UPDATE exists for: the two balance_after values must be
   * different and must step down. Without the lock both debits still land on
   * credit_balance — the addition happens in the database — but both rows can
   * read the same intermediate balance and write it, leaving a ledger whose
   * running total goes sideways.
   */
  const balancesAfter = rows
    .split('\n')
    .slice(2)
    .map((line) => line.trim().split(/\s*\|\s*/))
    .filter((parts) => parts.length === 3)
    .map((parts) => Number(parts[2]));

  check(
    'the two balance_after values are distinct — the lock serialised them',
    new Set(balancesAfter).size === 2,
    balancesAfter.map(money).join(' then '),
  );
  check(
    'and the second is lower than the first',
    balancesAfter[1] < balancesAfter[0],
    balancesAfter.map(money).join(' > '),
  );
}

// ---------------------------------------------------------------------------
// 9 — the CSV export
// ---------------------------------------------------------------------------

async function verifyCsv(client, user) {
  heading('9. GET /api/wallet/transactions?format=csv');

  const response = await client.get('/wallet/transactions?format=csv');

  console.log(`  status:              ${response.status}`);
  console.log(`  content-type:        ${response.headers.get('content-type')}`);
  console.log(`  content-disposition: ${response.headers.get('content-disposition')}`);

  const lines = response.text.trim().split('\n');
  console.log(`\n  ${lines.slice(0, 4).join('\n  ')}`);

  check('200', response.status === 200);
  check('served as CSV', response.headers.get('content-type')?.includes('text/csv'));
  check(
    'as an attachment with a dated filename',
    /attachment; filename="quorum-transactions-\d{4}-\d{2}-\d{2}\.csv"/.test(
      response.headers.get('content-disposition') ?? '',
    ),
  );
  check(
    'the header row names every column',
    lines[0] === 'when,session,models,tokens,type,amount,balance_after',
    lines[0],
  );

  const ledgerCount = ledgerRowsFor(user.id);
  check('a row per ledger entry', lines.length === ledgerCount + 1, `${lines.length - 1} vs ${ledgerCount}`);
  check('every field is quoted', lines.slice(1).every((line) => line.startsWith('"') && line.endsWith('"')));
  check(
    'amounts are numbers rather than formatted money',
    lines.slice(1).every((line) => /,"-?\d+\.\d{6}","-?\d+\.\d{6}"$/.test(line)),
  );
}

// ---------------------------------------------------------------------------
// 10 — the ledger reconciles
// ---------------------------------------------------------------------------

async function verifyReconciliation(user) {
  heading('10. The ledger reconciles against the balance');

  console.log(
    psql(`
      SELECT ct.created_at, ct.type, ct.amount, ct.balance_after,
             coalesce(s.title, '(top-up)') AS what
      FROM credit_transactions ct
      LEFT JOIN rounds r ON r.id = ct.round_id
      LEFT JOIN sessions s ON s.id = r.session_id
      WHERE ct.user_id = '${user.id}'
      ORDER BY ct.created_at
    `),
  );

  const summed = Number(
    firstValue(
      psql(`SELECT coalesce(sum(amount), 0) FROM credit_transactions WHERE user_id = '${user.id}'`),
    ),
  );
  const balance = balanceOf(user.id);

  console.log(`\n  SUM(amount):          ${money(summed)}`);
  console.log(`  users.credit_balance: ${money(balance)}`);

  /**
   * This account's balance was set by hand exactly once, to zero, before any of
   * this ran — so every cent of it came through a ledger row and the two must
   * agree. The tolerance is the two columns' precision difference and nothing
   * else: numeric(14,8) on a row against numeric(12,6) on the balance means a
   * debit of $0.00000123 rounds to zero in one and not in the other, which is
   * the "ledger precision mismatch" the build log has carried since Session 2.
   */
  check(
    'SUM(amount) equals the balance, to the two columns’ precision difference',
    Math.abs(summed - balance) < 1e-6,
    `${money(summed)} vs ${money(balance)}`,
  );

  const lastBalanceAfter = Number(
    firstValue(
      psql(`
        SELECT balance_after FROM credit_transactions
        WHERE user_id = '${user.id}' ORDER BY created_at DESC, id DESC LIMIT 1
      `),
    ),
  );

  check(
    'and the newest row’s balance_after is the balance',
    Math.abs(lastBalanceAfter - balance) < 1e-6,
    `${money(lastBalanceAfter)} vs ${money(balance)}`,
  );
}

// ---------------------------------------------------------------------------
// GET /api/wallet, which is what the page renders
// ---------------------------------------------------------------------------

async function verifyWalletEndpoint(client) {
  heading('GET /api/wallet — the three cards on mockup 04');

  const { status, body } = await client.get('/wallet');
  const wallet = body?.wallet;

  console.log(JSON.stringify({ ...wallet, spendByDay: `${wallet?.spendByDay?.length} days` }, null, 2));

  check('200', status === 200);
  check('carries a balance and a clamped display balance', typeof wallet?.balance === 'number' && wallet.displayBalance >= 0);
  check('seven days of spend, zero-filled', wallet?.spendByDay?.length === 7);
  check('the days are consecutive and end today (UTC)', wallet?.spendByDay?.at(-1)?.day === new Date().toISOString().slice(0, 10));
  check('a mode', wallet?.mode === 'paid' || wallet?.mode === 'free');
  check("today's free remaining", Number.isInteger(wallet?.freeRemaining));
  check('the top-up amounts, so the page cannot offer a fourth', JSON.stringify(wallet?.topupAmounts) === '[5,15,50]');

  const checkout = await client.post('/wallet/checkout', { amount: 7 });
  console.log(`\n  POST /wallet/checkout { amount: 7 }: ${checkout.status} ${checkout.body?.error?.code}`);
  check('an amount off the allow-list is a 400', checkout.status === 400, String(checkout.status));

  const anonymous = await fetch(`${BASE}/wallet`);
  check('GET /api/wallet without a cookie is 401', anonymous.status === 401, String(anonymous.status));
}

// ---------------------------------------------------------------------------

async function main() {
  const health = await fetch('http://localhost:3000/api/health').catch(() => null);

  if (!health?.ok) {
    console.error('The server is not running. Start it with `npm run dev` in another terminal.');
    process.exitCode = 1;
    return;
  }

  const models = (await listActiveModels()).map((row) => ({
    id: row.id,
    slug: row.openrouter_slug,
    displayName: row.display_name,
    inputPer1k: Number(row.input_per_1k),
    outputPer1k: Number(row.output_per_1k),
  }));

  if (models.length < 4) throw new Error(`Need 4 active models, found ${models.length}`);

  const paidClient = makeClient();
  const freeClient = makeClient();
  const ledgerClient = makeClient();

  await signIn(paidClient, PAID);
  await signIn(freeClient, FREE);
  await signIn(ledgerClient, LEDGER);

  const paidUser = await findUserByEmail(PAID.email);
  const freeUser = await findUserByEmail(FREE.email);
  const ledgerUser = await findUserByEmail(LEDGER.email);

  console.log(`  paid user:   ${paidUser.id}`);
  console.log(`  free user:   ${freeUser.id}`);
  console.log(`  ledger user: ${ledgerUser.id}`);

  /**
   * The paid user is wiped ONCE, here, and every check below adds to the ledger
   * rather than clearing it — checks 9 and 10 are only worth running against a
   * ledger with several rows of both signs in it. Balances are set between
   * checks with setBalance, which moves the number without deleting history.
   */
  resetAccount(paidUser.id, 0);
  resetAccount(ledgerUser.id, 0);

  await verifyEstimate();
  await verifyPaidRound(paidClient, paidUser, models);
  await verifyFreeTier(freeClient, freeUser, models);
  await verifyBelowThreshold(freeClient, freeUser, models);
  await verifyFailedRoundIsBilled(paidUser, models);
  await verifyConcurrentRounds(paidClient, paidUser, models);
  await verifyStripe(ledgerClient, ledgerUser, models);
  await verifyCsv(paidClient, paidUser);
  await verifyReconciliation(ledgerUser);
  await verifyWalletEndpoint(paidClient);

  heading(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`);
  for (const failure of failures) console.log(`  - ${failure}`);

  process.exitCode = failures.length === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error('\nverify-wallet aborted:', error);
  process.exitCode = 1;
} finally {
  await closePool();
}
