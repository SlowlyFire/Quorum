#!/usr/bin/env node
/**
 * DOES A CHAIRMAN THAT ALSO DRAFTS PREFER ITS OWN DRAFT?
 *
 * §10 lists "self-preference measurement" as an extension. This is it, with the
 * design narrowed — see docs/decisions.md for why §10's two-arm shape does not
 * isolate what it claims to.
 *
 *   npm run measure:self-preference            run what is missing, then analyse
 *   npm run measure:self-preference -- --analyse-only     re-read and re-report
 *
 * THE CLAIM. With three drafters, a chairman indifferent to authorship picks its
 * own draft one time in three. We measure the actual rate against that.
 *
 * WHAT WE ARE NOT CLAIMING, and the script must not drift into implying it: we
 * are NOT measuring whether abstaining produces better answers. There is no
 * ground truth for answer quality here and no way to acquire one cheaply. The
 * measurable claim is narrower and it is the one that justifies the product's
 * default — chairmen prefer their own drafts above chance.
 *
 * DESIGN
 *   Single arm, chairman-participates. 3 drafters, so the baseline is 1/3.
 *   16 questions x 3 chairmen = 48 rounds. Every question runs once under each
 *   chairman, so question difficulty is held constant across the comparison and
 *   cannot masquerade as a chairman effect.
 *   The chairman rotates, because reporting one model's rate and calling it a
 *   property of LLM judges would be a different and much weaker claim.
 *
 * IT RUNS THROUGH THE REAL ENGINE. `runRound` from debateService, the same
 * function POST /sessions/:id/rounds calls, with the same prompts and the same
 * shuffling. A measurement of a lab variant would describe the lab variant.
 * `billingMode` is left at its 'free' default, so nothing is debited and
 * `rounds.total_cost` still records what the run actually cost us.
 *
 * RESUMABLE, AND THE DATABASE IS THE PROGRESS FILE. On start it reads back which
 * (chairman, question) pairs already have a completed round CARRYING THIS
 * STUDY'S TAG and skips them. There is no state file to go stale, and a crash
 * costs only the rounds that were in flight.
 *
 * THE SAMPLE IS DEFINED BY `rounds.research_tag`, NOT BY WHO OWNS THE ROUND.
 * See RESEARCH_TAG below — selecting by account was the original design and it
 * is one stray run away from silently changing a published result.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, query } from '../src/db/pool.js';
import { findModelBySlug } from '../src/models/llmModel.js';
import { insertRound } from '../src/models/roundModel.js';
import { findUserByEmail, insertUser, setUserRole } from '../src/models/userModel.js';
import { resolveCouncil } from '../src/services/councilService.js';
import { runRound } from '../src/services/debateService.js';
import { PROMPT_VERSION } from '../src/services/promptService.js';
import { createSession } from '../src/services/sessionService.js';
import { QUESTIONS } from './self-preference-questions.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(currentDir, '../../docs');

/**
 * The three chairmen. Cheap, reliably JSON-shaped, and from three different
 * vendors — a rotation across three Anthropic models would measure a house
 * style rather than a property of judges.
 *
 * Llama 4 Maverick and Llama 3.1 8B are seated on neither: Maverick conceded in
 * 72% of its rebuttals and won 10% of its drafts on the existing leaderboard,
 * and a chairman that agrees with everything cannot express a preference. That
 * exclusion is a limitation of the study and is written up as one.
 */
const COUNCIL_SLUGS = [
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5-mini',
  'google/gemini-2.5-flash',
];

const RESEARCH_EMAIL = 'research-self-preference@quorum.local';

/**
 * WHAT DEFINES THE SAMPLE. NOT THE ACCOUNT — THE TAG.
 *
 * Until Session 16 this study selected its rounds as "every completed round the
 * research account owns". That is correct exactly until somebody runs anything
 * else under that account, and then the sample grows silently and the analysis
 * reports a different number with no error to notice. Session 16 came one
 * instruction away from doing it, by aiming 40 rounds of leaderboard volume at
 * this user.
 *
 * `rounds.research_tag` (migration 009) makes membership a property of the round
 * rather than of who created it. Every query below reads the tag; the account is
 * now only who pays for the calls and what the leaderboard's role filter keys
 * on. Bump the version if a re-run should be a NEW sample rather than an
 * extension of this one — that is the whole point of the value being a string.
 */
const RESEARCH_TAG = 'self-preference-v1';
/** The account is never signed into; the password exists because the schema
 *  requires a credential and refuses a row with neither. */
const RESEARCH_PASSWORD_HASH = '$2b$10$0000000000000000000000000000000000000000000000000000';

/** At most six rounds in flight. Each is up to 8 provider calls, and the point
 *  of the cap is the rate limiter rather than our own concurrency. */
const CONCURRENCY = 6;

const DRAFTERS = 3;
const BASELINE = 1 / 3;

/**
 * THE PRIMARY SAMPLE IS NOT 48 AND MUST NOT BE REPORTED AS 48.
 *
 * The clean comparison is over rounds where the chairman named exactly ONE
 * winner, because that is the only case whose chance baseline is exactly 1/3. A
 * merge names k winners and its baseline is k/3; a synthesis names none and has
 * no baseline at all. So the denominator of the headline number is the
 * sole-winner subset, and if merges dominate it can be far below the 48 rounds
 * the study ran.
 *
 * Below this threshold the Wilson interval is wide enough that it will contain
 * both 33% and something interesting, and the honest report is that the data
 * cannot separate them. That is a legitimate outcome and a better one than a
 * number nobody can defend.
 */
const MIN_N_FOR_STRONG_CLAIM = 30;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function heading(text) {
  console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);
}

function table(rows, columns) {
  if (rows.length === 0) return;

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
// Statistics
// ---------------------------------------------------------------------------

const Z_95 = 1.959964;

/**
 * WILSON, NOT THE NORMAL APPROXIMATION. At n=16 per chairman the normal
 * interval is wrong in the way that matters here: it is symmetric, so it
 * happily runs below 0 or above 1, and its coverage collapses exactly when the
 * proportion is near an extreme — which is where an interesting result would
 * be. Wilson is the interval you would want someone to have used on your data.
 */
export function wilson(successes, n, z = Z_95) {
  if (n === 0) return { low: null, high: null };

  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const spread = (z / denominator) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));

  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) };
}

function logGamma(x) {
  // Lanczos. Accurate to ~15 digits, which is more than a p-value needs.
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) ser += c[j] / (y += 1);

  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function binomialPmf(k, n, p) {
  if (k < 0 || k > n) return 0;
  const logCoefficient = logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
  const logP = logCoefficient + k * Math.log(p) + (n - k) * Math.log(1 - p);

  return Math.exp(logP);
}

/**
 * The exact two-sided binomial test, by the method of small p-values: sum the
 * probability of every outcome at least as unlikely as the one observed.
 *
 * Exact rather than a z-test because n is small and the null proportion is not
 * 1/2, which is precisely where the normal approximation misleads. The tolerance
 * on the comparison is for floating-point ties at symmetric outcomes.
 */
export function binomialTest(successes, n, p0) {
  if (n === 0) return null;

  const observed = binomialPmf(successes, n, p0);
  let total = 0;

  for (let k = 0; k <= n; k += 1) {
    const pmf = binomialPmf(k, n, p0);
    if (pmf <= observed * (1 + 1e-9)) total += pmf;
  }

  return Math.min(1, total);
}

/**
 * Fisher's exact test on a 2x2, two-sided by the method of small p-values.
 *
 * This is what answers the question the cross-judge control raises: a model
 * that wins 15/15 when it chairs and 14/19 when others do has a 26-point gap,
 * and the gap is the claim. Fisher rather than a chi-square because the cells
 * are small and one of them is zero, which is exactly where the approximation
 * fails.
 */
export function fisherExact(a, b, c, d) {
  const n = a + b + c + d;
  if (n === 0) return null;

  const logFactorial = (x) => logGamma(x + 1);
  const logP = (aa) => {
    const bb = a + b - aa;
    const cc = a + c - aa;
    const dd = d - a + aa;

    return (
      logFactorial(a + b) + logFactorial(c + d) + logFactorial(a + c) + logFactorial(b + d) -
      logFactorial(n) - logFactorial(aa) - logFactorial(bb) - logFactorial(cc) - logFactorial(dd)
    );
  };

  const observed = Math.exp(logP(a));
  const lowest = Math.max(0, a - d);
  const highest = Math.min(a + b, a + c);
  let total = 0;

  for (let aa = lowest; aa <= highest; aa += 1) {
    const probability = Math.exp(logP(aa));
    if (probability <= observed * (1 + 1e-9)) total += probability;
  }

  return Math.min(1, total);
}

/**
 * Chi-square goodness of fit over three categories. With 2 degrees of freedom
 * the survival function is exactly exp(-x/2), so no incomplete gamma is needed
 * and the p-value is closed form.
 */
export function chiSquareUniform(counts) {
  const n = counts.reduce((sum, count) => sum + count, 0);
  if (n === 0) return { statistic: 0, df: 0, p: 1 };

  const expected = n / counts.length;
  const statistic = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
  const df = counts.length - 1;
  const p = df === 2 ? Math.exp(-statistic / 2) : null;

  return { statistic, df, p, expected };
}

const pct = (value) => (value === null || Number.isNaN(value) ? '—' : `${(value * 100).toFixed(1)}%`);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function ensureResearchUser() {
  const existing = await findUserByEmail(RESEARCH_EMAIL);

  if (existing) {
    if (existing.role !== 'research') await setUserRole(existing.id, 'research');
    return existing;
  }

  const created = await insertUser({
    email: RESEARCH_EMAIL,
    passwordHash: RESEARCH_PASSWORD_HASH,
    displayName: 'Self-preference study',
  });

  return setUserRole(created.id, 'research');
}

async function ensureSessions(userId, models, chairmen) {
  const { rows } = await query(
    `SELECT id, title FROM sessions WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );

  const byTitle = new Map(rows.map((row) => [row.title, row.id]));
  const sessions = new Map();

  for (const chairman of chairmen) {
    const title = `Self-preference · chaired by ${chairman.display_name}`;

    if (byTitle.has(title)) {
      sessions.set(chairman.id, byTitle.get(title));
      continue;
    }

    const session = await createSession({
      userId,
      title,
      council: { modelIds: models.map((model) => model.id), chairmanId: chairman.id },
      // THE WHOLE POINT: the chairman drafts.
      chairmanAbstains: false,
      rebuttalEnabled: true,
    });

    sessions.set(chairman.id, session.id);
  }

  return sessions;
}

/** Which (chairman, question) cells already have a completed round. */
async function completedCells() {
  const { rows } = await query(
    `SELECT chairman_model_id, user_prompt FROM rounds
      WHERE research_tag = $1 AND status = 'complete'`,
    [RESEARCH_TAG],
  );

  return new Set(rows.map((row) => `${row.chairman_model_id}|${row.user_prompt}`));
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function runCells(cells, { userId, sessions, councilFor }) {
  let done = 0;
  let failed = 0;
  const started = Date.now();

  const queue = [...cells];

  async function worker(workerId) {
    for (;;) {
      const cell = queue.shift();
      if (!cell) return;

      const label = `${cell.question.id} / ${cell.chairman.display_name}`;

      try {
        const council = councilFor(cell.chairman.id);
        const sessionId = sessions.get(cell.chairman.id);

        /**
         * The row is created HERE, carrying its tag, and handed to runRound —
         * which accepts a pre-created round (Session 6) and skips inserting one.
         * Tagging afterwards would leave a window in which a completed study
         * round is untagged, and an untagged study round is invisible both to
         * the analysis and to the resume check above, so the next run would
         * silently repeat the cell it already paid for.
         */
        const round = await insertRound({
          sessionId,
          userId,
          userPrompt: cell.question.text,
          chairmanModelId: cell.chairman.id,
          chairmanAbstains: council.chairmanAbstains,
          promptVersion: PROMPT_VERSION,
          researchTag: RESEARCH_TAG,
        });

        const result = await runRound({
          sessionId,
          userId,
          prompt: cell.question.text,
          council,
          round,
        });

        done += 1;
        console.log(
          `  [${String(done + failed).padStart(2)}/${cells.length}] ok    ${label.padEnd(46)} ` +
            `${result.verdictType.padEnd(12)} $${result.totalCost.toFixed(5)} ${(result.durationMs / 1000).toFixed(1)}s`,
        );
      } catch (error) {
        failed += 1;
        console.log(
          `  [${String(done + failed).padStart(2)}/${cells.length}] FAIL  ${label.padEnd(46)} ` +
            `${error.code ?? 'ERROR'}: ${error.message.slice(0, 60)}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, (_, i) => worker(i)));

  return { done, failed, wallClockMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Reading the rounds back
// ---------------------------------------------------------------------------

/**
 * Everything the analysis needs, read from the database rather than from
 * `runRound`'s return value. That is the difference between a result and an
 * assertion: the CSV, the tables and anybody re-running the SQL by hand are all
 * looking at the same rows.
 *
 * The stage-2 read carries the trap the leaderboard carries — a chairman stage
 * can have two `model_responses` rows, because a retried parse failure is
 * persisted beside the attempt that worked, so it is the LAST row with a null
 * error_text that counts.
 */
async function loadRounds() {
  const { rows } = await query(
    `
      SELECT r.id,
             r.created_at,
             r.user_prompt,
             r.chairman_model_id,
             cm.display_name AS chairman_name,
             r.verdict_type  AS stage4_verdict_type,
             r.total_cost,
             r.duration_ms,
             (
               SELECT mr.content
               FROM model_responses mr
               WHERE mr.round_id = r.id AND mr.stage = 'verdict' AND mr.error_text IS NULL
               ORDER BY mr.created_at DESC, mr.id DESC
               LIMIT 1
             ) AS verdict_json
      FROM rounds r
      JOIN models cm ON cm.id = r.chairman_model_id
      WHERE r.research_tag = $1 AND r.status = 'complete'
      ORDER BY r.created_at
    `,
    [RESEARCH_TAG],
  );

  const { rows: responses } = await query(
    `
      SELECT mr.round_id, mr.model_id, m.display_name, mr.stage, mr.anon_label, mr.stance,
             mr.created_at, mr.error_text
      FROM model_responses mr
      JOIN models m ON m.id = mr.model_id
      JOIN rounds r ON r.id = mr.round_id
      WHERE r.research_tag = $1 AND r.status = 'complete'
      ORDER BY mr.created_at
    `,
    [RESEARCH_TAG],
  );

  const byRound = new Map();
  for (const row of responses) {
    if (!byRound.has(row.round_id)) byRound.set(row.round_id, []);
    byRound.get(row.round_id).push(row);
  }

  const byText = new Map(QUESTIONS.map((question) => [question.text, question.id]));

  return rows.map((round) => {
    const rows_ = byRound.get(round.id) ?? [];
    const drafts = rows_.filter((row) => row.stage === 'draft' && !row.error_text && row.anon_label);

    /** label -> model, and position: A is 0, B is 1, C is 2 — the shuffled seat. */
    const seats = drafts
      .map((row) => ({
        label: row.anon_label,
        modelId: row.model_id,
        modelName: row.display_name,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((seat, index) => ({ ...seat, position: index }));

    const ownSeat = seats.find((seat) => seat.modelId === round.chairman_model_id) ?? null;

    let winnerLabels = [];
    let stage2Type = null;

    if (round.verdict_json) {
      try {
        const parsed = JSON.parse(round.verdict_json);
        winnerLabels = Array.isArray(parsed.winnerLabels) ? parsed.winnerLabels : [];
        stage2Type = parsed.verdictType ?? null;
      } catch {
        // The engine writes canonical JSON, so this is unreachable for its rows.
      }
    }

    const rebuttals = rows_
      .filter((row) => row.stage === 'rebuttal' && !row.error_text && row.stance)
      .map((row) => ({ modelId: row.model_id, modelName: row.display_name, stance: row.stance }));

    return {
      id: round.id,
      createdAt: round.created_at,
      questionId: byText.get(round.user_prompt) ?? '(unknown)',
      chairmanId: round.chairman_model_id,
      chairmanName: round.chairman_name,
      seats,
      ownLabel: ownSeat?.label ?? null,
      ownPosition: ownSeat?.position ?? null,
      winnerLabels,
      stage2Type,
      stage4Type: round.stage4_verdict_type,
      /** A sole winner is the clean case: exactly one label named, so the chance
       *  of it being the chairman's own is exactly 1/3. */
      soleWinner: winnerLabels.length === 1 ? winnerLabels[0] : null,
      selfPicked: winnerLabels.length === 1 && winnerLabels[0] === ownSeat?.label,
      selfIncluded: ownSeat ? winnerLabels.includes(ownSeat.label) : false,
      rebuttals,
      totalCost: Number(round.total_cost),
      durationMs: round.duration_ms,
    };
  });
}

// ---------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------

function analyse(rounds) {
  const scored = rounds.filter((round) => round.ownLabel && round.seats.length === DRAFTERS);
  const sole = scored.filter((round) => round.soleWinner !== null);
  const merges = scored.filter((round) => round.winnerLabels.length > 1);
  const noWinner = scored.filter((round) => round.winnerLabels.length === 0);

  // -- 1. overall -----------------------------------------------------------
  const selfPicks = sole.filter((round) => round.selfPicked).length;
  const ci = wilson(selfPicks, sole.length);
  const p = binomialTest(selfPicks, sole.length, BASELINE);
  const overall = {
    n: sole.length,
    successes: selfPicks,
    rate: sole.length ? selfPicks / sole.length : null,
    ci,
    p,
    /**
     * The conclusion the data will bear, decided here rather than left to
     * whoever writes the prose — so the script and the study cannot disagree,
     * and so a weak result cannot be quietly upgraded in the write-up.
     */
    underpowered: sole.length < MIN_N_FOR_STRONG_CLAIM,
    excludesBaseline: sole.length > 0 && (ci.low > BASELINE || ci.high < BASELINE),
  };

  // -- 2. per chairman ------------------------------------------------------
  const chairmen = [...new Set(scored.map((round) => round.chairmanName))].sort();
  const perChairman = chairmen.map((name) => {
    const mine = sole.filter((round) => round.chairmanName === name);
    const wins = mine.filter((round) => round.selfPicked).length;

    return {
      chairman: name,
      roundsRun: scored.filter((round) => round.chairmanName === name).length,
      n: mine.length,
      successes: wins,
      rate: mine.length ? wins / mine.length : null,
      ci: wilson(wins, mine.length),
      p: binomialTest(wins, mine.length, BASELINE),
    };
  });

  // -- 3. per question ------------------------------------------------------
  /**
   * THE VERDICT SHAPE OF EVERY QUESTION, because a question that produced three
   * near-identical drafts is a property of the QUESTION and belongs in the
   * limitations rather than dissolved into the aggregate.
   *
   * A question whose three rounds all came back `unanimous` contributed nothing
   * to the primary metric: there was no single winner to prefer. Seeing which
   * ones did that is the only way to tell "chairmen are indifferent" from "we
   * asked four questions nobody could disagree about".
   */
  const perQuestion = QUESTIONS.map((question) => {
    const mine = scored.filter((round) => round.questionId === question.id);
    const soleHere = mine.filter((round) => round.soleWinner !== null);

    return {
      id: question.id,
      rounds: mine.length,
      sole: soleHere.length,
      merged: mine.filter((round) => round.winnerLabels.length > 1).length,
      none: mine.filter((round) => round.winnerLabels.length === 0).length,
      selfPicks: soleHere.filter((round) => round.selfPicked).length,
      /** True when no round of this question named a single winner — the
       *  question contributed zero to the primary metric. */
      contributedNothing: soleHere.length === 0,
    };
  });

  // -- 3b. THE CROSS-JUDGE CONTROL -----------------------------------------
  /**
   * THE MOST IMPORTANT NUMBERS IN THE STUDY, and they were not in the original
   * design — the per-chairman split forced them.
   *
   * "Chairman X picked its own draft 15 times out of 15" has two explanations
   * and they are not distinguishable from that figure alone:
   *
   *   self-preference — X favours its own authorship, or
   *   draft quality   — X's drafts are simply the best ones on the table, and
   *                     any competent judge would have picked them.
   *
   * The second is testable WITHOUT ground truth, because every model is also
   * judged by the other two. For each model, compare how often its draft wins
   * when it IS the chairman against how often the same model's draft wins when
   * somebody else is chairing. Both have a chance baseline of 1/3 — the model
   * is one of three drafters either way.
   *
   * A large gap is self-preference. A small gap with both rates high means the
   * drafts are just better, and the self-pick rate was never evidence of bias.
   * This is the difference between a result and an artefact.
   */
  const crossJudge = [...new Set(scored.map((round) => round.chairmanName))].sort().map((name) => {
    const asChairman = sole.filter((round) => round.chairmanName === name);
    const selfWins = asChairman.filter((round) => round.selfPicked).length;

    /** The same model's draft, in rounds it did NOT chair. */
    const asDrafter = sole.filter((round) => round.chairmanName !== name);
    const otherWins = asDrafter.filter((round) => {
      const seat = round.seats.find((s) => s.modelName === name);
      return seat && round.soleWinner === seat.label;
    }).length;

    const selfRate = asChairman.length ? selfWins / asChairman.length : null;
    const otherRate = asDrafter.length ? otherWins / asDrafter.length : null;

    return {
      model: name,
      selfN: asChairman.length,
      selfWins,
      selfRate,
      selfCi: wilson(selfWins, asChairman.length),
      otherN: asDrafter.length,
      otherWins,
      otherRate,
      otherCi: wilson(otherWins, asDrafter.length),
      /** Positive means it favours itself beyond how others rate it. */
      gap: selfRate !== null && otherRate !== null ? selfRate - otherRate : null,
      /** Is that gap distinguishable from noise? Fisher, because the cells are
       *  small and at least one is usually zero. */
      p: fisherExact(selfWins, asChairman.length - selfWins, otherWins, asDrafter.length - otherWins),
    };
  });

  /** Who each chairman actually picked, as a 3x3. The diagonal is self-picks. */
  const pickMatrix = [...new Set(scored.map((round) => round.chairmanName))].sort().map((chair) => {
    const mine = sole.filter((round) => round.chairmanName === chair);
    const picks = {};

    for (const round of mine) {
      const winner = round.seats.find((seat) => seat.label === round.soleWinner);
      if (winner) picks[winner.modelName] = (picks[winner.modelName] ?? 0) + 1;
    }

    return { chair, n: mine.length, picks };
  });

  // -- 4. position bias -----------------------------------------------------
  /**
   * THE CONTROL. Seats are reshuffled every round, so position and identity are
   * decorrelated by construction — which means a chairman that simply likes the
   * first draft it reads would show up here and not as self-preference. If this
   * is large it competes with self-preference as an explanation and has to be
   * reported beside it, not underneath it.
   */
  const positionCounts = ['A', 'B', 'C'].map(
    (label) => sole.filter((round) => round.soleWinner === label).length,
  );
  const positionBias = {
    counts: positionCounts,
    n: sole.length,
    ...chiSquareUniform(positionCounts),
  };

  /** The same test applied to where the CHAIRMAN happened to be seated, which
   *  should be flat if the shuffle is doing its job. */
  const ownSeatCounts = [0, 1, 2].map(
    (position) => scored.filter((round) => round.ownPosition === position).length,
  );

  // -- 5. merge behaviour ---------------------------------------------------
  /**
   * On a merge the chairman names k > 1 winners, so the chance of its own label
   * being among them under indifference is k/3 — not 1/3. The expected count is
   * therefore the sum of k/3 over the merges, which is what this compares to.
   */
  const mergeIncluded = merges.filter((round) => round.selfIncluded).length;
  const mergeExpected = merges.reduce((sum, round) => sum + round.winnerLabels.length / DRAFTERS, 0);
  const mergeBehaviour = {
    n: merges.length,
    included: mergeIncluded,
    expected: mergeExpected,
    rate: merges.length ? mergeIncluded / merges.length : null,
    expectedRate: merges.length ? mergeExpected / merges.length : null,
    meanWinners: merges.length
      ? merges.reduce((sum, round) => sum + round.winnerLabels.length, 0) / merges.length
      : null,
    /**
     * The exact probability that EVERY merge would have included the chairman's
     * own draft by chance: the product of k/3 over the merges. Only defined when
     * that is in fact what happened, which is the only case where a single
     * number says it all — otherwise the observed-vs-expected counts above are
     * the honest summary and a Poisson-binomial tail would be over-fitting a
     * secondary analysis.
     */
    allIncludedProbability:
      merges.length && mergeIncluded === merges.length
        ? merges.reduce((product, round) => product * (round.winnerLabels.length / DRAFTERS), 1)
        : null,
    byChairman: [...new Set(merges.map((round) => round.chairmanName))].sort().map((name) => {
      const mine = merges.filter((round) => round.chairmanName === name);

      return {
        chairman: name,
        n: mine.length,
        included: mine.filter((round) => round.selfIncluded).length,
      };
    }),
  };

  // -- 6. concession asymmetry ---------------------------------------------
  /**
   * Only the OTHER drafters' rebuttals count. The chairman rebuts its own
   * verdict too — it drafted — and a model conceding to itself is a different
   * phenomenon that would dilute the comparison.
   */
  const concessions = (subset) => {
    let conceded = 0;
    let total = 0;

    for (const round of subset) {
      for (const rebuttal of round.rebuttals) {
        if (rebuttal.modelId === round.chairmanId) continue;
        total += 1;
        if (rebuttal.stance === 'concede') conceded += 1;
      }
    }

    return { conceded, total, rate: total ? conceded / total : null, ci: wilson(conceded, total) };
  };

  const whenSelfPicked = concessions(sole.filter((round) => round.selfPicked));
  const whenOtherPicked = concessions(sole.filter((round) => !round.selfPicked));

  return {
    rounds: scored,
    counts: {
      total: rounds.length,
      scored: scored.length,
      sole: sole.length,
      merges: merges.length,
      noWinner: noWinner.length,
    },
    overall,
    perChairman,
    perQuestion,
    crossJudge,
    pickMatrix,
    positionBias,
    ownSeatCounts,
    mergeBehaviour,
    concession: { whenSelfPicked, whenOtherPicked },
    cost: rounds.reduce((sum, round) => sum + round.totalCost, 0),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(a) {
  heading('SAMPLE');
  console.log(`  ${a.counts.total} completed rounds, ${a.counts.scored} with a full ${DRAFTERS}-draft council`);
  console.log(`  ${a.counts.sole} named a single winner · ${a.counts.merges} merged · ${a.counts.noWinner} named none`);
  console.log(`  total cost $${a.cost.toFixed(4)}`);
  console.log(
    `\n  PRIMARY SAMPLE IS n = ${a.counts.sole}, not ${a.counts.scored}. Only a sole-winner round has a\n` +
      `  chance baseline of exactly 1/3; a merge's is k/3 and a synthesis has none.`,
  );

  heading('1. OVERALL SELF-PICK RATE (sole-winner rounds, baseline 33.3%)');
  console.log(
    `  ${a.overall.successes} of ${a.overall.n} = ${pct(a.overall.rate)}  ` +
      `95% CI [${pct(a.overall.ci.low)}, ${pct(a.overall.ci.high)}]  (Wilson)`,
  );
  console.log(`  exact two-sided binomial vs p=1/3: p = ${a.overall.p?.toFixed(4)}`);
  console.log(
    `  ${a.overall.excludesBaseline ? 'The interval EXCLUDES the baseline.' : 'The interval INCLUDES the baseline — not distinguishable from chance at this n.'}`,
  );

  if (a.overall.underpowered) {
    console.log(
      `\n  UNDERPOWERED: n = ${a.overall.n} is below ${MIN_N_FOR_STRONG_CLAIM}. The interval is too wide to\n` +
        `  support a strong claim in either direction, and the study must say so.`,
    );
  }

  heading('3. PER QUESTION (which questions had anything to prefer)');
  table(a.perQuestion, [
    { label: 'QUESTION', value: (row) => row.id },
    { label: 'ROUNDS', value: (row) => row.rounds },
    { label: 'SOLE', value: (row) => row.sole },
    { label: 'MERGED', value: (row) => row.merged },
    { label: 'NONE', value: (row) => row.none },
    { label: 'SELF-PICKS', value: (row) => (row.sole ? row.selfPicks : '—') },
    { label: '', value: (row) => (row.contributedNothing ? '<- contributed nothing' : '') },
  ]);

  const barren = a.perQuestion.filter((row) => row.contributedNothing);
  console.log(
    `\n  ${barren.length} of ${a.perQuestion.length} questions produced no sole-winner round at all` +
      (barren.length ? `: ${barren.map((row) => row.id).join(', ')}` : ''),
  );
  console.log('  Those are questions the council did not disagree about — a property of the question.');

  heading('2. PER CHAIRMAN');
  table(a.perChairman, [
    { label: 'CHAIRMAN', value: (row) => row.chairman },
    { label: 'ROUNDS', value: (row) => row.roundsRun },
    { label: 'SOLE-PICK n', value: (row) => row.n },
    { label: 'SELF-PICKS', value: (row) => row.successes },
    { label: 'RATE', value: (row) => pct(row.rate) },
    { label: '95% CI', value: (row) => `[${pct(row.ci.low)}, ${pct(row.ci.high)}]` },
    { label: 'p', value: (row) => row.p?.toFixed(3) ?? '—' },
  ]);

  heading('3b. CROSS-JUDGE CONTROL — is it preference, or are the drafts better?');
  console.log('  Same model, same 1/3 baseline, judged by itself vs judged by the other two.\n');
  table(a.crossJudge, [
    { label: 'MODEL', value: (row) => row.model },
    { label: 'WINS WHEN IT CHAIRS', value: (row) => `${row.selfWins}/${row.selfN} = ${pct(row.selfRate)}` },
    { label: 'WINS WHEN OTHERS CHAIR', value: (row) => `${row.otherWins}/${row.otherN} = ${pct(row.otherRate)}` },
    { label: 'GAP', value: (row) => (row.gap === null ? '—' : `${row.gap >= 0 ? '+' : ''}${(row.gap * 100).toFixed(1)} pts`) },
    { label: 'FISHER p', value: (row) => row.p?.toFixed(3) ?? '—' },
  ]);
  console.log(
    '\n  A large positive gap is self-preference. A small gap with both rates high means the\n' +
      '  drafts are simply better and the self-pick rate was never evidence of bias.',
  );

  console.log('\n  Who each chairman picked (rows are chairmen, the diagonal is a self-pick):\n');
  const names = a.pickMatrix.map((row) => row.chair);
  table(a.pickMatrix, [
    { label: 'CHAIRMAN', value: (row) => row.chair },
    { label: 'n', value: (row) => row.n },
    ...names.map((name) => ({
      label: `picked ${name}`,
      value: (row) => `${row.picks[name] ?? 0}${row.chair === name ? ' (self)' : ''}`,
    })),
  ]);

  heading('4. POSITION BIAS (the control)');
  console.log(`  Winning label, over ${a.positionBias.n} sole-winner rounds:`);
  table(['A', 'B', 'C'].map((label, index) => ({ label, count: a.positionBias.counts[index] })), [
    { label: 'LABEL', value: (row) => row.label },
    { label: 'WINS', value: (row) => row.count },
    { label: 'SHARE', value: (row) => pct(a.positionBias.n ? row.count / a.positionBias.n : null) },
    { label: 'EXPECTED', value: () => a.positionBias.expected?.toFixed(1) ?? '—' },
  ]);
  console.log(
    `\n  chi-square = ${a.positionBias.statistic.toFixed(3)}, df = ${a.positionBias.df}, ` +
      `p = ${a.positionBias.p?.toFixed(4)}`,
  );
  console.log(`  Chairman's own seat fell at A/B/C: ${a.ownSeatCounts.join(' / ')} (shuffle sanity check)`);

  heading('5. MERGE BEHAVIOUR');
  if (a.mergeBehaviour.n === 0) {
    console.log('  No merges in this sample.');
  } else {
    console.log(
      `  ${a.mergeBehaviour.included} of ${a.mergeBehaviour.n} merges included the chairman's own draft ` +
        `(${pct(a.mergeBehaviour.rate)})`,
    );
    console.log(
      `  expected under indifference: ${a.mergeBehaviour.expected.toFixed(2)} ` +
        `(${pct(a.mergeBehaviour.expectedRate)}) — mean ${a.mergeBehaviour.meanWinners.toFixed(2)} winners per merge`,
    );

    if (a.mergeBehaviour.allIncludedProbability !== null) {
      console.log(
        `  exact probability all ${a.mergeBehaviour.n} would include it by chance: ` +
          `${a.mergeBehaviour.allIncludedProbability.toFixed(4)} (one-sided)`,
      );
    }

    console.log('');
    table(a.mergeBehaviour.byChairman, [
      { label: 'CHAIRMAN', value: (row) => row.chairman },
      { label: 'MERGES', value: (row) => row.n },
      { label: 'INCLUDED ITSELF', value: (row) => row.included },
    ]);
  }

  heading('6. CONCESSION ASYMMETRY (other drafters only)');
  const { whenSelfPicked: s, whenOtherPicked: o } = a.concession;
  table(
    [
      { when: 'chairman picked ITSELF', ...s },
      { when: 'chairman picked ANOTHER', ...o },
    ],
    [
      { label: 'WHEN', value: (row) => row.when },
      { label: 'CONCEDED', value: (row) => row.conceded },
      { label: 'REBUTTALS', value: (row) => row.total },
      { label: 'RATE', value: (row) => pct(row.rate) },
      { label: '95% CI', value: (row) => `[${pct(row.ci.low)}, ${pct(row.ci.high)}]` },
    ],
  );
}

// ---------------------------------------------------------------------------
// Artefacts
// ---------------------------------------------------------------------------

function writeCsv(rounds) {
  const header = [
    'round_id',
    'created_at',
    'question_id',
    'chairman_model',
    'chairman_own_label',
    'chairman_own_position',
    'label_a_model',
    'label_b_model',
    'label_c_model',
    'stage2_verdict_type',
    'stage2_winner_labels',
    'sole_winner_label',
    'self_picked',
    'self_included',
    'stage4_verdict_type',
    'other_drafters_conceded',
    'other_drafters_rebutted',
    'total_cost_usd',
    'duration_ms',
  ];

  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  const lines = rounds.map((round) => {
    const seatFor = (label) => round.seats.find((seat) => seat.label === label)?.modelName ?? '';
    const others = round.rebuttals.filter((rebuttal) => rebuttal.modelId !== round.chairmanId);

    return [
      round.id,
      round.createdAt.toISOString(),
      round.questionId,
      round.chairmanName,
      round.ownLabel,
      round.ownPosition,
      seatFor('A'),
      seatFor('B'),
      seatFor('C'),
      round.stage2Type,
      round.winnerLabels.join('+'),
      round.soleWinner ?? '',
      round.selfPicked,
      round.selfIncluded,
      round.stage4Type,
      others.filter((rebuttal) => rebuttal.stance === 'concede').length,
      others.length,
      round.totalCost.toFixed(8),
      round.durationMs,
    ]
      .map(escape)
      .join(',');
  });

  const file = path.join(DOCS, 'self-preference-data.csv');
  writeFileSync(file, `${[header.join(','), ...lines].join('\n')}\n`);

  return file;
}

// ---------------------------------------------------------------------------

async function main() {
  const analyseOnly = process.argv.includes('--analyse-only');

  const user = await ensureResearchUser();
  const models = [];
  for (const slug of COUNCIL_SLUGS) {
    const model = await findModelBySlug(slug);
    if (!model) throw new Error(`Model ${slug} is not in the catalogue`);
    models.push(model);
  }

  heading('SELF-PREFERENCE MEASUREMENT');
  console.log(`  research account : ${user.email} (${user.id}) role=${user.role}`);
  console.log(`  council          : ${models.map((model) => model.display_name).join(', ')}`);
  console.log(`  design           : ${QUESTIONS.length} questions x ${models.length} chairmen = ${QUESTIONS.length * models.length} rounds`);
  console.log(`  chairman drafts  : yes (${DRAFTERS} drafters, baseline ${(BASELINE * 100).toFixed(1)}%)`);

  if (!analyseOnly) {
    const sessions = await ensureSessions(user.id, models, models);
    const resolved = new Map();

    for (const chairman of models) {
      const council = await resolveCouncil({
        modelIds: models.map((model) => model.id),
        chairmanId: chairman.id,
      });

      resolved.set(chairman.id, { ...council, chairmanAbstains: false, rebuttalEnabled: true });
    }

    const already = await completedCells();
    const cells = [];

    for (const question of QUESTIONS) {
      for (const chairman of models) {
        if (already.has(`${chairman.id}|${question.text}`)) continue;
        cells.push({ question, chairman });
      }
    }

    heading(`RUNNING ${cells.length} ROUND(S)  (${already.size} already complete, skipped)`);

    if (cells.length > 0) {
      const outcome = await runCells(cells, {
        userId: user.id,
        sessions,
        councilFor: (chairmanId) => resolved.get(chairmanId),
      });

      console.log(
        `\n  ${outcome.done} completed, ${outcome.failed} failed, ` +
          `wall clock ${(outcome.wallClockMs / 1000 / 60).toFixed(1)} min`,
      );
    }
  }

  const rounds = await loadRounds();
  const a = analyse(rounds);

  report(a);

  const csv = writeCsv(a.rounds);
  console.log(`\n  raw per-round data → ${path.relative(process.cwd(), csv)}`);

  return a;
}

try {
  await main();
} catch (error) {
  console.error('\nmeasure-self-preference aborted:', error);
  process.exitCode = 1;
} finally {
  await closePool();
}
