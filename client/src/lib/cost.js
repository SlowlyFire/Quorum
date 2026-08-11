/**
 * What the next round will probably cost, and how to write a price down.
 *
 * THE ESTIMATE IS AN ESTIMATE, AND THE LABEL SAYS SO.
 *
 * Two things make it impossible to promise a figure. OpenRouter routes a slug to
 * whichever upstream provider is available and bills that upstream's price, so
 * the same model at the same token count costs different amounts on different
 * calls (decision 16) — the `models` table price is our own estimate of a moving
 * number. And the completion length is not knowable in advance at all.
 *
 * So every figure this file produces is prefixed `est.` or `~` where it is
 * rendered, and what the wallet will debit is `usage.cost` from the response
 * body, which arrives after the fact.
 *
 * `estimate` — `{ stageTokens, maxTokens }` — comes from GET /api/models rather
 * than being written down here, because those token counts live in the server's
 * config/llm.js and a second copy would drift the first time they are
 * re-measured. See modelCatalogueService.js and costEstimateService.js: the
 * server runs this same arithmetic to decide whether a round may start at all,
 * and the two agree because they read the same constants, not because anyone
 * remembered to update both.
 */
import { roundPlan } from './council.js';

/**
 * One call: what a stage of this kind has actually sent up, at the model's
 * input price, plus what it has actually generated, at its output price.
 *
 * Note what this does NOT do: quote a fraction of `maxTokens` as the
 * completion, which is what Session 6 did and Session 8 measured running
 * 2.4-2.7x high. The ceilings are set high because headroom is free and a
 * truncation costs the whole call, so they track the worst case a stage could
 * need rather than what one typically uses — no fraction of them is right.
 * `stageTokens` is measured from our own model_responses instead (decision 31).
 */
export function estimateCall(model, stage, estimate) {
  const tokens = estimate?.stageTokens?.[stage];

  if (!model || !tokens) return 0;

  return (tokens.prompt / 1000) * model.inputPer1k + (tokens.completion / 1000) * model.outputPer1k;
}

/**
 * The whole round, priced per model rather than per average: a council of Claude
 * and Llama is not two of anything, and their output prices differ sevenfold.
 *
 * Takes the same argument object as roundPlan, so the panel that shows the call
 * breakdown and the figure under it cannot disagree about who is drafting.
 */
export function estimateRound({ selected, chairmanId, chairmanAbstains, rebuttalEnabled }, estimate) {
  const plan = roundPlan({ selected, chairmanId, chairmanAbstains, rebuttalEnabled });

  const total = plan.stages.reduce(
    (sum, entry) =>
      sum + entry.models.reduce((stageSum, model) => stageSum + estimateCall(model, entry.stage, estimate), 0),
    0,
  );

  return { total, callCount: plan.callCount, plan };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Money, at the precision the number deserves. A round costs cents and a single
 * call costs a fraction of one, so a fixed two decimal places would render most
 * of this product as "$0.00" — which reads as free rather than as small.
 */
export function formatCost(value, { precise = false } = {}) {
  const amount = Number(value ?? 0);

  if (!Number.isFinite(amount)) return '$0.00';
  if (amount === 0) return '$0.00';
  if (precise || amount < 0.01) return `$${amount.toFixed(4)}`;

  return `$${amount.toFixed(amount < 1 ? 3 : 2)}`;
}

/** "8.2s" in the mockup's round footer; minutes once a round runs long. */
export function formatDuration(ms) {
  const value = Number(ms ?? 0);

  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;

  const minutes = Math.floor(value / 60_000);

  return `${minutes}m ${Math.round((value % 60_000) / 1000)}s`;
}

/** "4,180 tokens". */
export function formatTokens(count) {
  return Number(count ?? 0).toLocaleString('en-US');
}
