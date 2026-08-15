#!/usr/bin/env node
/**
 * Volume for the leaderboard: 30 real debates on the DEPLOYED API, so every
 * active model clears MIN_DRAFTS_TO_RANK comfortably and the podium has depth.
 *
 * WHY NOT UNDER THE RESEARCH ACCOUNT, WHICH IS WHERE THIS WAS FIRST AIMED.
 *
 * Two reasons, either of which is decisive:
 *
 *   1. IT WOULD SHOW NOTHING. `leaderboardModel` line 93 —
 *      `AND ($1::uuid IS NOT NULL OR u.role <> 'research')` — drops research
 *      rounds from `scope=all`, and `scope=all` is what the page opens on
 *      (`DEFAULT_SCOPE`). Thirty rounds under that account would move the
 *      board by exactly zero and be visible only under "My council", signed in
 *      as the research user.
 *   2. IT WOULD CORRUPT THE STUDY. `measure-self-preference.js` selects its
 *      sample as `WHERE r.user_id = $1 AND r.status = 'complete'` — every
 *      completed round the research account owns, with no marker separating
 *      study rounds from any other. The 48 rounds would be safe on disk and the
 *      published numbers are hardcoded in the client (decision 55), but the
 *      next re-analysis would silently mix 30 leaderboard rounds into a sample
 *      of 48 and report a different result.
 *
 * So this runs under its own ordinary account, `leaderboard-seed@quorum.local`,
 * role `user`. It appears in `scope=all`, it is one email to delete later, and
 * the research account is never opened.
 *
 *   npm run seed:leaderboard            # dry run: plan, seat balance, cost
 *   npm run seed:leaderboard -- --confirm
 */
import { randomUUID } from 'node:crypto';

import { closePool } from '../src/db/pool.js';
import { MIN_DRAFTS_TO_RANK } from '../src/config/leaderboard.js';
import { findUserByEmail } from '../src/models/userModel.js';
import { estimateRoundCost } from '../src/services/costEstimateService.js';
import { planCouncil } from '../src/services/debateService.js';
import { creditTopup } from '../src/services/walletService.js';

/** One apex since Session 24. CLIENT is sent as the Origin header, so it must be
 *  an origin CORS allows or every call fails. Both overridable. */
const API = (process.env.API ?? 'https://api.askthequorum.com').replace(/\/+$/, '');
const CLIENT = (process.env.CLIENT ?? 'https://app.askthequorum.com').replace(/\/+$/, '');
const ORIGIN = new URL(CLIENT).origin;

/**
 * The display name is the one field of this account a stranger could ever see —
 * it is what `users.display_name` would render as if a session of its were
 * shared, or if any future screen names a round's owner. "Leaderboard Seed"
 * reads as scaffolding left in a live product; "Quorum Benchmarks" reads as
 * what these rounds actually are, which is a standing benchmark run across the
 * seated models. The email stays machine-shaped on purpose: it is the handle
 * this script and any future clean-up match on.
 */
const ACCOUNT = {
  email: 'leaderboard-seed@quorum.local',
  password: 'leaderboard volume, not a study',
  displayName: 'Quorum Benchmarks',
};

/** Never opened by this script. Asserted, not assumed. */
const RESEARCH_EMAIL = 'research-self-preference@quorum.local';

const ROUNDS = Number(process.env.ROUNDS ?? 30);
const CONCURRENCY = 4;
const TOPUP = 5;

/**
 * CONTESTABLE ON PURPOSE, AND SHORT ON PURPOSE.
 *
 * The leaderboard's wins come from stage 2's `winner_labels` — the chairman's
 * blind pick between anonymised drafts. A question with one obviously correct
 * answer produces `unanimous`, which scores nobody, skips stage 3 and leaves
 * the board flat however many rounds are run. These are all questions where
 * competent models genuinely disagree, so the verdicts are `picked` and
 * `merged` and the podium separates.
 *
 * And short, because `PROMPT_LENGTH_SCALING` is not decoration: Session 13
 * measured a 141-character question costing 2.4x a 45-character one, through
 * every stage. These average about 80.
 */
const QUESTIONS = [
  'Are code comments a sign of unclear code, or a necessary part of it?',
  'Should a small team use a monorepo or separate repositories?',
  'Is test-driven development worth it for exploratory work?',
  'Should database migrations ever be rolled back in production?',
  'Are microservices ever the right first architecture?',
  'Is 100% code coverage a useful target or a harmful one?',
  'Should a startup build authentication itself or buy it?',
  'Is pair programming worth the doubled headcount cost?',
  'Should REST or GraphQL be the default for a new public API?',
  'Are feature branches better than trunk-based development?',
  'Is it acceptable to ship code you do not fully understand?',
  'Should error messages ever be shown to end users verbatim?',
  'Is premature optimisation really the root of all evil?',
  'Should teams estimate work in hours, points, or not at all?',
  'Is a shared database between services always a mistake?',
  'Should you rewrite a legacy system or refactor it in place?',
  'Are ORMs a net win or a net loss on a long-lived project?',
  'Is technical debt a useful metaphor or a misleading one?',
  'Should code review block merging, or happen after it?',
  'Is serverless cheaper than containers at real scale?',
  'Should a team standardise on one language or let each service choose?',
  'Are integration tests more valuable than unit tests?',
  'Is documentation better in the repository or in a wiki?',
  'Should you optimise for developer speed or production reliability?',
  'Is squashing commits before merge good practice or lost history?',
  'Should a service degrade gracefully or fail loudly?',
  'Is caching a performance fix or a correctness risk?',
  'Should you log every request, or only the interesting ones?',
  'Is on-call sustainable for a team of five engineers?',
  'Should typing be gradual or enforced from the first commit?',
];

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function heading(text) {
  console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);
}

function money(value) {
  return `$${Number(value ?? 0).toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// The rotation
// ---------------------------------------------------------------------------

/**
 * Deterministic, and balanced by construction rather than by luck.
 *
 * Each round seats four of the five models: one chairman (which abstains, so it
 * does NOT draft) and three drafters. The chairman advances every round, and
 * which of the remaining four sits out advances every five — so over 30 rounds
 * every model chairs six times and draws the same number of drafting seats.
 *
 * Random councils would average out eventually but not at n=30, and a model
 * that landed under MIN_DRAFTS_TO_RANK would leave the board exactly as thin as
 * it is now, after spending the money.
 */
function planCouncils(models, rounds) {
  const n = models.length;
  const plan = [];

  for (let i = 0; i < rounds; i += 1) {
    const chairIndex = i % n;
    const others = Array.from({ length: n - 1 }, (_, k) => models[(chairIndex + 1 + k) % n]);
    const sitOut = Math.floor(i / n) % others.length;

    plan.push({
      question: QUESTIONS[i % QUESTIONS.length],
      chairman: models[chairIndex],
      drafters: others.filter((_, k) => k !== sitOut),
    });
  }

  return plan;
}

function seatCounts(plan) {
  const counts = new Map();

  const bump = (model, key) => {
    const row = counts.get(model.id) ?? { name: model.displayName, drafts: 0, chairs: 0 };
    row[key] += 1;
    counts.set(model.id, row);
  };

  for (const round of plan) {
    bump(round.chairman, 'chairs');
    for (const drafter of round.drafters) bump(drafter, 'drafts');
  }

  return [...counts.values()].sort((a, b) => b.drafts - a.drafts);
}

/**
 * THE SERVER'S OWN ESTIMATOR, NOT A REIMPLEMENTATION OF IT.
 *
 * The first version of this function multiplied `STAGE_TOKEN_AVERAGES` by the
 * catalogue prices by hand and quoted 40 rounds at $0.2705. They cost $0.4851 —
 * 1.79x — because it omitted `PROMPT_LENGTH_SCALING` (decision 56). These
 * questions average about 80 characters against the 45-character reference the
 * averages were measured at, and Session 13's whole finding is that the extra
 * length is paid for at every stage: longer prompts in, longer drafts out, and
 * stages 2-4 then pay to read those drafts back.
 *
 * CLAUDE.md's rule is that duplicating the arithmetic is fine and duplicating a
 * constant is not. This managed to do neither and still be wrong — it
 * duplicated the arithmetic and silently dropped a term. `estimateRoundCost` is
 * the function `POST /rounds` quotes from, so using it means the plan is priced
 * exactly as the gate would price it.
 */
function estimatePlan(plan) {
  return plan.reduce((total, round) => {
    const council = planCouncil({
      models: [round.chairman, ...round.drafters].map((model) => ({ ...model, id: model.id, slug: model.slug })),
      chairmanId: round.chairman.id,
      chairmanAbstains: true,
      rebuttalEnabled: true,
    });

    return total + estimateRoundCost(council, round.question);
  }, 0);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function makeClient() {
  let cookie = null;

  async function request(method, path, body) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Origin: ORIGIN,
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
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
  };
}

async function signIn(client) {
  const registered = await client.post('/api/auth/register', ACCOUNT);

  if (registered.status === 201) return registered.body.user;

  const loggedIn = await client.post('/api/auth/login', {
    email: ACCOUNT.email,
    password: ACCOUNT.password,
  });

  if (loggedIn.status !== 200) {
    throw new Error(`Could not sign in: ${loggedIn.status} ${JSON.stringify(loggedIn.body)}`);
  }

  return loggedIn.body.user;
}

/** Polls until the round leaves `drafting`/`verdict`/`rebuttal`/`final`. */
async function awaitRound(client, roundId) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const detail = await client.get(`/api/rounds/${roundId}`);
    const status = detail.body?.round?.status;

    if (status === 'complete' || status === 'failed') {
      return { status, cost: Number(detail.body.round.totalCost ?? 0) };
    }
  }

  return { status: 'timeout', cost: 0 };
}

/** Four at a time, as asked — and four is also polite to the providers. */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// The board, before and after
// ---------------------------------------------------------------------------

async function showBoard(client, label) {
  const response = await client.get('/api/leaderboard?scope=all&days=30');
  const board = response.body?.leaderboard;

  heading(label);

  if (!board) {
    console.log(`  could not read the leaderboard: ${response.status}`);
    return null;
  }

  console.log(`  scope=${board.scope} days=${board.days} minDrafts=${board.minDrafts}\n`);
  console.log('    #  model                drafts  wins  merged  score  winRate');
  console.log(`    ${'-'.repeat(62)}`);

  for (const [index, row] of board.ranked.entries()) {
    console.log(
      `    ${String(index + 1).padStart(2)}  ${row.displayName.padEnd(20)} ` +
        `${String(row.drafts).padStart(6)}  ${String(row.wins).padStart(4)}  ` +
        `${String(row.merged).padStart(6)}  ${String(row.score).padStart(5)}  ` +
        `${row.winRate === null ? '   —' : `${(row.winRate * 100).toFixed(0)}%`}`,
    );
  }

  const unranked = board.unranked ?? [];

  console.log(
    `\n  unranked (<${board.minDrafts} drafts): ` +
      (unranked.map((row) => `${row.displayName} (${row.drafts})`).join(', ') || 'none'),
  );

  return board;
}

// ---------------------------------------------------------------------------

async function main() {
  const confirmed = process.argv.includes('--confirm');

  console.log('Quorum — leaderboard volume\n');
  console.log(`  API:     ${API}`);
  console.log(`  account: ${ACCOUNT.email} (role user — NOT the research account)`);
  console.log(`  rounds:  ${ROUNDS}, ${CONCURRENCY} concurrent`);

  const client = makeClient();
  const user = await signIn(client);

  /**
   * The study's account is never signed into, never posted to, and never
   * updated by this script. Asserting it here means a future edit that
   * accidentally pointed at it fails loudly rather than quietly adding rounds
   * to a published sample.
   */
  if (user.email === RESEARCH_EMAIL || user.role === 'research') {
    throw new Error(`Refusing to run: signed in as ${user.email} (role ${user.role})`);
  }

  const research = await findUserByEmail(RESEARCH_EMAIL);
  const studyRoundsBefore = research ? await countRounds(research.id) : 0;

  console.log(`  signed in as ${user.email} (role ${user.role}, id ${user.id})`);
  console.log(`  study account untouched: ${research?.email ?? 'absent'} holds ${studyRoundsBefore} rounds`);

  const catalogue = await client.get('/api/models');
  const models = catalogue.body?.models ?? [];

  if (models.length < 4) throw new Error(`Need at least 4 active models, catalogue has ${models.length}`);

  const plan = planCouncils(models, ROUNDS);
  const seats = seatCounts(plan);
  const estimate = estimatePlan(plan);

  heading('The plan');

  console.log('  model                 drafting seats  chairman turns   ranks?');
  console.log(`  ${'-'.repeat(64)}`);

  for (const row of seats) {
    console.log(
      `  ${row.name.padEnd(22)}${String(row.drafts).padStart(10)}${String(row.chairs).padStart(16)}` +
        `   ${row.drafts >= MIN_DRAFTS_TO_RANK ? `yes (needs ${MIN_DRAFTS_TO_RANK})` : 'NO'}`,
    );
  }

  const thinnest = seats[seats.length - 1];

  console.log(`\n  every model clears the ${MIN_DRAFTS_TO_RANK}-draft minimum: ` +
    `${thinnest.drafts >= MIN_DRAFTS_TO_RANK ? `yes — the thinnest is ${thinnest.name} at ${thinnest.drafts}` : 'NO'}`);
  console.log(`  ${ROUNDS} rounds x 8 calls = ${ROUNDS * 8} calls`);
  console.log(`  estimated cost: ${money(estimate)}  (the engine's own per-stage averages, priced per council)`);

  if (!confirmed) {
    console.log('\n  DRY RUN — nothing was spent and no round was started.');
    console.log('  Re-run with --confirm to execute.\n');
    return;
  }

  // -- fund it, so the rounds are not refused by the free-tier gate ---------

  const balance = Number((await client.get('/api/wallet')).body?.wallet?.balance ?? 0);

  if (balance < estimate * 1.5) {
    await creditTopup({
      userId: user.id,
      amount: TOPUP,
      stripePaymentId: `seed_leaderboard_${randomUUID()}`,
    });
    console.log(`\n  topped the seed account up by $${TOPUP} (free tier is 2 rounds a day)`);
  }

  const before = await showBoard(client, 'Leaderboard BEFORE');

  // -- run ------------------------------------------------------------------

  heading(`Running ${ROUNDS} rounds, ${CONCURRENCY} at a time`);

  const startedAt = Date.now();
  let done = 0;

  const outcomes = await runPool(plan, CONCURRENCY, async (round, index) => {
    const session = await client.post('/api/sessions', {
      title: `Leaderboard volume ${index + 1}`,
      council: {
        modelIds: [round.chairman.id, ...round.drafters.map((model) => model.id)],
        chairmanId: round.chairman.id,
      },
    });

    if (session.status !== 201) {
      console.log(`  ${String(index + 1).padStart(2)}. session failed: ${session.status}`);
      return { status: 'session_failed', cost: 0 };
    }

    const started = await client.post(`/api/sessions/${session.body.session.id}/rounds`, {
      prompt: round.question,
    });

    if (started.status !== 202) {
      console.log(`  ${String(index + 1).padStart(2)}. round refused: ${started.status} ${started.body?.error?.code ?? ''}`);
      return { status: 'refused', cost: 0 };
    }

    const outcome = await awaitRound(client, started.body.roundId);

    done += 1;
    console.log(
      `  ${String(done).padStart(2)}/${ROUNDS}  ${outcome.status.padEnd(8)} ${money(outcome.cost).padStart(9)}  ` +
        `${round.chairman.displayName} chairs  ·  ${round.question.slice(0, 46)}`,
    );

    return outcome;
  });

  const spent = outcomes.reduce((total, outcome) => total + (outcome?.cost ?? 0), 0);
  const completed = outcomes.filter((outcome) => outcome?.status === 'complete').length;

  console.log(`\n  ${completed}/${ROUNDS} completed in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  console.log(`  spent ${money(spent)} against an estimate of ${money(estimate)}`);

  const after = await showBoard(client, 'Leaderboard AFTER');

  // -- the study is untouched ----------------------------------------------

  heading('The self-preference study');

  const studyRoundsAfter = research ? await countRounds(research.id) : 0;

  console.log(`  ${RESEARCH_EMAIL}`);
  console.log(`    rounds before: ${studyRoundsBefore}`);
  console.log(`    rounds after:  ${studyRoundsAfter}`);
  console.log(
    `    ${studyRoundsBefore === studyRoundsAfter ? 'UNCHANGED — the study sample is intact' : 'CHANGED — INVESTIGATE'}`,
  );

  if (before && after) {
    console.log(
      `\n  ranked models: ${before.ranked.length} -> ${after.ranked.length}, ` +
        `total drafts ${before.ranked.reduce((t, r) => t + r.drafts, 0)} -> ` +
        `${after.ranked.reduce((t, r) => t + r.drafts, 0)}`,
    );
  }

  console.log('');
}

async function countRounds(userId) {
  const { query } = await import('../src/db/pool.js');
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM rounds WHERE user_id = $1', [userId]);

  return rows[0].n;
}

main()
  .catch((error) => {
    console.error('\nseed:leaderboard could not finish:', error);
    process.exitCode = 1;
  })
  .finally(closePool);
