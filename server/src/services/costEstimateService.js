/**
 * What a round will probably cost, before it is run.
 *
 * §8 words POST /sessions/:id/rounds as "pre-flight cost check, then run stages
 * 1-4", and §3's rule is stated in terms of this number:
 *
 *   balance >= max($0.05, estimated_round_cost x 1.5)  ->  bill the wallet
 *
 * So this figure decides which side of the free tier a user falls on, which is
 * the reason Session 9 stopped estimating from MAX_TOKENS. See
 * STAGE_TOKEN_AVERAGES in config/llm.js for what replaced it and why.
 *
 * WHAT THIS IS NOT. It is not what the round will be billed. OpenRouter routes
 * a slug to whichever upstream provider is available and bills that upstream's
 * price (decision 16), and a completion length is not knowable in advance at
 * all. `usage.cost` off the response body is what walletService debits; this is
 * a quote, and every surface that renders it says `est.`
 *
 * The client computes the same figure from the same inputs, shipped to it by
 * GET /api/models — see modelCatalogueService. The arithmetic is duplicated
 * deliberately (a toggle must re-quote with no round trip); the *constants* are
 * not, which is what stops the two drifting.
 */
import { STAGE_TOKEN_AVERAGES } from '../config/llm.js';

/**
 * Which models run which stage, from a planCouncil result.
 *
 * Stage 3 is included whenever the session has rebuttals on, which makes this
 * the upper bound of what will actually happen: the other route into the skip —
 * a stage-2 verdict of `unanimous` — cannot be known before stage 2 has run.
 * Quoting the round without it would under-quote every round that does hold
 * rebuttals, which is most of them.
 */
export function stagesOfPlan(plan) {
  const chairman = plan.chairman ? [plan.chairman] : [];

  return [
    { stage: 'draft', models: plan.drafters },
    { stage: 'verdict', models: chairman },
    ...(plan.rebuttalEnabled ? [{ stage: 'rebuttal', models: plan.drafters }] : []),
    { stage: 'final', models: chairman },
  ];
}

/**
 * One call: the stage's measured prompt length at the model's input price, plus
 * its measured completion length at the model's output price.
 *
 * A member with no prices quotes zero rather than throwing. The prices come
 * from the same `models` row the council was resolved from, so a missing one
 * means a numeric column arrived as something Number() could not read — worth
 * a quote that is too low, never worth failing a round the user can afford.
 */
export function estimateCall(member, stage) {
  const tokens = STAGE_TOKEN_AVERAGES[stage];

  if (!tokens || !member) return 0;

  const inputPer1k = Number(member.inputPer1k ?? 0);
  const outputPer1k = Number(member.outputPer1k ?? 0);

  if (!Number.isFinite(inputPer1k) || !Number.isFinite(outputPer1k)) return 0;

  return (tokens.prompt / 1000) * inputPer1k + (tokens.completion / 1000) * outputPer1k;
}

/**
 * The whole round, priced per model rather than per average: a council of
 * Claude and Llama is not two of anything, and their output prices differ
 * sevenfold.
 *
 * Takes a planCouncil result, so the thing quoted and the thing run are the
 * same line-up by construction.
 */
export function estimateRoundCost(plan) {
  const total = stagesOfPlan(plan).reduce(
    (sum, entry) =>
      sum + entry.models.reduce((stageSum, member) => stageSum + estimateCall(member, entry.stage), 0),
    0,
  );

  // Eight decimal places is model_responses.cost's own precision; anything
  // beyond it is float noise that would render as a different number every time.
  return Number(total.toFixed(8));
}

/** The call count that estimate covers, for a response that explains itself. */
export function estimateCallCount(plan) {
  return stagesOfPlan(plan).reduce((total, entry) => total + entry.models.length, 0);
}
