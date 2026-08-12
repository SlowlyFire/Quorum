#!/usr/bin/env node
/**
 * IS THE PRE-FLIGHT QUOTE STILL RIGHT?
 *
 *   npm run calibrate:estimate
 *
 * Reads every completed round we have ever run, rebuilds the council it used,
 * quotes it with the CURRENT estimator, and compares that quote to what the
 * round was actually billed. Costs nothing — it reads the database and calls
 * nobody.
 *
 * WHY THIS EXISTS. `STAGE_TOKEN_AVERAGES` is a constant measured from our own
 * traffic, and CLAUDE.md has warned since Session 9 that it drifts: "a new
 * model, a longer question or a template edit moves it". Session 13 found out
 * how much. The self-preference study asked sixteen open judgement calls, got
 * 400-word drafts back, and cost $0.90 against a $0.35 estimate — because the
 * averages were measured on short factual questions and nothing in the
 * estimator knew the difference.
 *
 * A warning in a comment is not a check. This is the check.
 *
 * The quote must lean HIGH. A quote under the bill is the error that surprises
 * a user, and §3's threshold is `max($0.05, estimate x 1.5)`, so an estimate
 * that is too low lets a round start that the wallet cannot cover — while one
 * that is too high pushes a funded user onto the free tier. Both directions are
 * real; under-quoting is the worse one.
 */
import { PROMPT_LENGTH_SCALING, STAGE_TOKEN_AVERAGES } from '../src/config/llm.js';
import { closePool, query } from '../src/db/pool.js';
import { estimateRoundCost, scaledStageTokens } from '../src/services/costEstimateService.js';

const BUCKETS = [
  { label: 'short   (<60 ch)', min: 0, max: 60 },
  { label: 'medium  (60-120)', min: 60, max: 120 },
  { label: 'long    (120-300)', min: 120, max: 300 },
  { label: 'v.long  (300+)', min: 300, max: Infinity },
];

function heading(text) {
  console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);
}

function table(rows, columns) {
  if (rows.length === 0) return;
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.value(r)).length)));
  const line = (cells) => `  ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ')}`;

  console.log(line(columns.map((c) => c.label)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) console.log(line(columns.map((c) => c.value(row))));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Every completed round that cost something, with the council it actually ran —
 * `round_models`, the immutable per-round snapshot, so a session whose line-up
 * changed later is still quoted against the models that debated.
 */
async function loadRounds() {
  const { rows } = await query(`
    SELECT r.id,
           r.user_prompt,
           r.chairman_abstains,
           r.total_cost,
           (SELECT count(*) FROM model_responses mr
              WHERE mr.round_id = r.id AND mr.stage = 'rebuttal') > 0 AS had_rebuttals,
           json_agg(json_build_object(
             'id', m.id, 'slug', m.openrouter_slug, 'displayName', m.display_name,
             'inputPer1k', m.input_per_1k, 'outputPer1k', m.output_per_1k, 'role', rm.role
           )) AS council
    FROM rounds r
    JOIN round_models rm ON rm.round_id = r.id
    JOIN models m ON m.id = rm.model_id
    WHERE r.status = 'complete' AND r.total_cost > 0
    GROUP BY r.id
    ORDER BY r.created_at
  `);

  return rows.map((row) => {
    const council = row.council.map((member) => ({
      ...member,
      inputPer1k: Number(member.inputPer1k),
      outputPer1k: Number(member.outputPer1k),
    }));

    return {
      id: row.id,
      prompt: row.user_prompt,
      actual: Number(row.total_cost),
      plan: {
        chairman: council.find((member) => member.role !== 'drafter') ?? council[0],
        drafters: council.filter((member) => member.role === 'drafter' || member.role === 'both'),
        /**
         * Whether stage 3 ran, read back from the responses rather than assumed.
         * The estimator always includes rebuttals because it cannot know that a
         * verdict will come back unanimous — so on a round that skipped them the
         * quote is high BY DESIGN, and folding that in here would make the
         * estimator look worse than it is at the job it actually has.
         */
        rebuttalEnabled: row.had_rebuttals,
      },
    };
  });
}

function summarise(rounds, label) {
  heading(label);

  const bucketed = BUCKETS.map((bucket) => {
    const mine = rounds.filter(
      (round) => round.prompt.length >= bucket.min && round.prompt.length < bucket.max,
    );
    const ratios = mine.map((round) => round.estimate / round.actual);
    const under = mine.filter((round) => round.estimate < round.actual).length;

    return {
      bucket: bucket.label,
      rounds: mine.length,
      avgActual: mine.length ? mine.reduce((s, r) => s + r.actual, 0) / mine.length : 0,
      avgEstimate: mine.length ? mine.reduce((s, r) => s + r.estimate, 0) / mine.length : 0,
      medianRatio: median(ratios),
      worstUnder: ratios.length ? Math.min(...ratios) : null,
      under,
    };
  }).filter((row) => row.rounds > 0);

  table(bucketed, [
    { label: 'QUESTION LENGTH', value: (r) => r.bucket },
    { label: 'ROUNDS', value: (r) => r.rounds },
    { label: 'AVG ACTUAL', value: (r) => `$${r.avgActual.toFixed(5)}` },
    { label: 'AVG QUOTE', value: (r) => `$${r.avgEstimate.toFixed(5)}` },
    { label: 'MEDIAN QUOTE/ACTUAL', value: (r) => r.medianRatio.toFixed(2) },
    { label: 'WORST', value: (r) => r.worstUnder.toFixed(2) },
    { label: 'UNDER-QUOTED', value: (r) => `${r.under}/${r.rounds}` },
  ]);

  const allRatios = rounds.map((round) => round.estimate / round.actual);
  const under = rounds.filter((round) => round.estimate < round.actual).length;

  console.log(
    `\n  overall: median ${median(allRatios).toFixed(2)}x · ` +
      `worst ${Math.min(...allRatios).toFixed(2)}x · ` +
      `under-quoted ${under}/${rounds.length} (${((under / rounds.length) * 100).toFixed(0)}%)`,
  );

  return { median: median(allRatios), worst: Math.min(...allRatios), under, n: rounds.length };
}

const rounds = await loadRounds();

heading('WHAT A STAGE COSTS AT DIFFERENT QUESTION LENGTHS');
console.log('  Measured from model_responses, every call with a null error_text.\n');

const { rows: observed } = await query(`
  SELECT mr.stage,
         CASE WHEN length(r.user_prompt) < 60 THEN 'short'
              WHEN length(r.user_prompt) < 120 THEN 'medium'
              ELSE 'long' END AS bucket,
         count(*)::int AS calls,
         round(avg(mr.prompt_tokens))::int AS prompt_tokens,
         round(avg(mr.completion_tokens))::int AS completion_tokens
  FROM model_responses mr
  JOIN rounds r ON r.id = mr.round_id
  WHERE mr.error_text IS NULL AND mr.prompt_tokens IS NOT NULL
  GROUP BY 1, 2
  ORDER BY 1, 2
`);

table(observed, [
  { label: 'STAGE', value: (r) => r.stage },
  { label: 'QUESTION', value: (r) => r.bucket },
  { label: 'CALLS', value: (r) => r.calls },
  { label: 'PROMPT', value: (r) => r.prompt_tokens },
  { label: 'COMPLETION', value: (r) => r.completion_tokens },
  {
    label: 'WHAT THE ESTIMATOR ASSUMES (unscaled)',
    value: (r) =>
      `${STAGE_TOKEN_AVERAGES[r.stage].prompt} / ${STAGE_TOKEN_AVERAGES[r.stage].completion}`,
  },
]);

/** The scaling, printed as a curve so the constants are legible as behaviour. */
heading('THE LENGTH FACTOR');
console.log(
  `  reference ${PROMPT_LENGTH_SCALING.referenceChars} chars · ` +
    `+${PROMPT_LENGTH_SCALING.verbosityPerToken} per token over it · ` +
    `capped at ${PROMPT_LENGTH_SCALING.maxVerbosity}x\n`,
);

table(
  // A string of the right LENGTH — scaledStageTokens measures characters, and
  // handing it a number silently scales nothing.
  [40, 60, 90, 120, 150, 200, 400, 1000, 8000].map((chars) => ({
    chars,
    ...scaledStageTokens('draft', 'x'.repeat(chars)),
    verdict: scaledStageTokens('verdict', 'x'.repeat(chars)),
  })),
  [
    { label: 'QUESTION CHARS', value: (r) => r.chars },
    { label: 'DRAFT PROMPT', value: (r) => r.prompt },
    { label: 'DRAFT COMPLETION', value: (r) => r.completion },
    { label: 'VERDICT PROMPT', value: (r) => r.verdict.prompt },
    { label: 'VERDICT COMPLETION', value: (r) => r.verdict.completion },
  ],
);

for (const round of rounds) {
  round.estimate = estimateRoundCost(round.plan, round.prompt);
  round.unscaled = estimateRoundCost(round.plan, '');
}

const scaled = summarise(rounds, 'WITH LENGTH SCALING (what ships)');

const before = rounds.map((round) => ({ ...round, estimate: round.unscaled }));
const plain = summarise(before, 'WITHOUT IT (the Session 9 behaviour, for comparison)');

/**
 * ROUTING, WHICH NO TOKEN MODEL CAN FIX.
 *
 * Decision 16 says OpenRouter routes a slug to whichever upstream is available
 * and bills THAT upstream's price, so the catalogue price is an estimate of a
 * moving number. Measured over every call we have made, that is true of exactly
 * one seated model — and it is true by a factor of two:
 *
 *   Gemini 2.5 Flash   billed / catalogue-predicted   1.03
 *   Claude Haiku 4.5                                  0.99
 *   GPT-5 Mini                                        1.00
 *   Llama 4 Maverick                                  2.12
 *   Llama 3.1 8B                                      0.43
 *
 * OpenRouter's own listed price for `meta-llama/llama-4-maverick` is exactly
 * what we have seeded ($0.0002 / $0.000696 per 1k), so this is not a stale
 * catalogue — it is the listed price being the cheapest route's price while the
 * round was billed at a dearer one. Session 6 saw the same slug served by
 * DeepInfra and DigitalOcean within a single round.
 *
 * Splitting on it separates "the token model is wrong" from "the price is a
 * moving target", which are different problems with different fixes.
 */
const withMaverick = rounds.filter((round) =>
  [round.plan.chairman, ...round.plan.drafters].some((m) => m?.displayName === 'Llama 4 Maverick'),
);
const withoutMaverick = rounds.filter((round) => !withMaverick.includes(round));

if (withMaverick.length && withoutMaverick.length) {
  summarise(withoutMaverick, 'WITH SCALING, EXCLUDING COUNCILS THAT SEATED LLAMA 4 MAVERICK');
  summarise(withMaverick, 'WITH SCALING, ONLY COUNCILS THAT SEATED LLAMA 4 MAVERICK');
}

heading('VERDICT');
console.log(
  `  under-quoted rounds: ${plain.under}/${plain.n} before → ${scaled.under}/${scaled.n} after`,
);
console.log(`  worst case:          ${plain.worst.toFixed(2)}x before → ${scaled.worst.toFixed(2)}x after`);
console.log(`  median overshoot:    ${plain.median.toFixed(2)}x before → ${scaled.median.toFixed(2)}x after`);

await closePool();
