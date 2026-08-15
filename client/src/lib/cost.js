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
import { canSee } from './attachments.js';
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
export function estimateCall(model, stage, estimate, promptText = '', attachments = []) {
  const tokens = scaledStageTokens(stage, estimate, promptText);

  if (!model || !tokens) return 0;

  /**
   * An attached image is input tokens on a DRAFTER's stage-1 call and on nothing
   * else — attachments reach stage 1 only, and a drafter that cannot see the
   * file is sent a sentence instead of the bytes. `canSee` is the same rule the
   * "could not see this" marker uses, so the quote and the marker cannot
   * disagree about who is actually being charged.
   */
  const imageTokens =
    stage === 'draft' && estimate?.imageInputTokens
      ? attachments.filter((attachment) => canSee(model, attachment)).length *
        estimate.imageInputTokens
      : 0;

  return (
    ((tokens.prompt + imageTokens) / 1000) * model.inputPer1k +
    (tokens.completion / 1000) * model.outputPer1k
  );
}

/**
 * The stage averages, adjusted for how long the question is. The server's
 * `costEstimateService.scaledStageTokens` is the same function over the same
 * constants — which arrive in `estimate.lengthScaling` rather than being written
 * down here, so the two cannot drift.
 *
 * WHY THE QUESTION CHANGES THE QUOTE. Session 13 ran sixteen open judgement
 * calls and they cost 2.6x the quote, because the stage averages were measured
 * on short factual questions. Two effects, treated differently: the question is
 * interpolated into every stage's prompt once, so its tokens are ADDED and never
 * saturate; and models write longer answers to richer questions, which stages
 * 2-4 then pay to read back, so verbosity MULTIPLIES and is capped.
 *
 * With no scaling block on the wire — an older server — it returns the unscaled
 * averages, which is exactly the previous behaviour.
 */
export function scaledStageTokens(stage, estimate, promptText = '') {
  const base = estimate?.stageTokens?.[stage];

  if (!base) return null;

  const scaling = estimate?.lengthScaling;

  if (!scaling) return base;

  const chars = typeof promptText === 'string' ? promptText.length : 0;
  const extraChars = Math.max(0, chars - scaling.referenceChars);
  const extraTokens = Math.ceil(extraChars / scaling.charsPerToken);
  const verbosity = Math.min(scaling.maxVerbosity, 1 + extraTokens * scaling.verbosityPerToken);

  return {
    prompt: Math.round(base.prompt * verbosity + extraTokens),
    completion: Math.round(base.completion * verbosity),
  };
}

/**
 * The whole round, priced per model rather than per average: a council of Claude
 * and Llama is not two of anything, and their output prices differ sevenfold.
 *
 * Takes the same argument object as roundPlan, so the panel that shows the call
 * breakdown and the figure under it cannot disagree about who is drafting.
 */
export function estimateRound(
  { selected, chairmanId, chairmanAbstains, rebuttalEnabled, promptText = '', attachments = [] },
  estimate,
) {
  const plan = roundPlan({ selected, chairmanId, chairmanAbstains, rebuttalEnabled });

  const total = plan.stages.reduce(
    (sum, entry) =>
      sum +
      entry.models.reduce(
        (stageSum, model) =>
          stageSum + estimateCall(model, entry.stage, estimate, promptText, attachments),
        0,
      ),
    0,
  );

  return { total, callCount: plan.callCount, plan };
}

/**
 * §3's gate, evaluated in the browser so a council toggle re-answers "will this
 * round be billed?" without a round trip — the same reason the quote itself is
 * computed here. The two constants arrive in `estimate.threshold` from
 * GET /api/models; they are never written down on this side, because the
 * threshold is what decides who pays and a drifted copy would decide it wrongly
 * while still rendering a plausible number.
 *
 * MIRRORS `entitlementService.thresholdFor` AND MUST KEEP MIRRORING IT. If the
 * server's expression changes, this one has to change with it — the constants
 * travel, the arithmetic is duplicated on purpose (decisions 28, 31 and 56).
 *
 * Returns null when the catalogue has not supplied the constants, which is the
 * honest answer for an older server: a caller shows nothing rather than guessing
 * a tier. Do not default the constants here — that is the copy this avoids.
 */
export function billingModeFor({ balance, roundEstimate, estimate }) {
  const minimum = estimate?.threshold?.minimum;
  const multiple = estimate?.threshold?.multiple;

  if (!Number.isFinite(minimum) || !Number.isFinite(multiple)) return null;

  const threshold = Math.max(minimum, Number(roundEstimate ?? 0) * multiple);
  const funds = Number(balance ?? 0);

  return { mode: funds >= threshold ? 'paid' : 'free', threshold, balance: funds };
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
