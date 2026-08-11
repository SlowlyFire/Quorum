/**
 * Sampling defaults for the four debate stages, in one place.
 *
 * Deliberately not inside openrouterService: the transport should have no
 * opinion about how hot a chairman runs. Session 5's orchestrator looks a stage
 * name up here and passes the pair straight through to callModel.
 */

/**
 * Drafting wants variety — the entire premise of the product is that
 * independent answers differ, and a drafter sampled at 0 is a drafter that adds
 * nothing the others did not. Judging wants the opposite: a chairman that
 * returns a different verdict on the same drafts is measuring its own sampling
 * noise rather than the drafts, so both chairman stages run near-deterministic.
 * Rebuttals sit between the two — an argument needs some room to be phrased,
 * but a model deciding whether it was wrong should not be dicing for it.
 */
export const TEMPERATURE = Object.freeze({
  drafting: 0.7,
  chairman: 0.2,
  rebuttal: 0.5,
});

/**
 * Ceilings, not spend. We are billed for the tokens a model actually generates,
 * so a generous ceiling costs nothing and a truncation costs the whole call:
 * `finish_reason: 'length'` mid-JSON loses the entire response and is billed in
 * full. The asymmetry is total, so these are set high.
 *
 * Session 5 ran with draft 1200 / verdict 1500 / rebuttal 800 / final 1500 and
 * `openai/gpt-5-mini` hit the rebuttal ceiling four times across three runs,
 * each losing that drafter's stance for ~$0.0018. Two causes, both of which the
 * old numbers ignored:
 *
 *   * a reasoning model spends completion tokens on internal reasoning before
 *     it writes a character of visible output, so a ceiling sized for the
 *     visible answer is sized for a fraction of the call; and
 *   * `revised_answer` on a rebuttal can be a full replacement answer, not a
 *     footnote — 800 was sized for the `argument` field alone.
 *
 * `finishReason === 'length'` remains the signal that one of these is still too
 * low, which is why callModel returns it rather than discarding it.
 *
 * These are NOT a pre-flight cost estimate. Estimating a round at max_tokens
 * would roughly double every quote and push paying users onto the free tier —
 * see the note in CLAUDE.md for Session 9.
 */
export const MAX_TOKENS = Object.freeze({
  draft: 2000,
  verdict: 2500,
  rebuttal: 2000,
  final: 3000,
});

/**
 * WHAT A STAGE ACTUALLY USES, per call, measured from our own traffic. This is
 * the only input to a pre-flight cost estimate, and it replaces Session 6's
 * COMPLETION_ESTIMATE_RATIO — a fraction of MAX_TOKENS — which Session 8
 * measured quoting 2.4-2.7x high.
 *
 * WHY A FRACTION OF THE CEILING WAS THE WRONG SHAPE. MAX_TOKENS above is set
 * high on purpose: headroom is free and a truncation costs the whole call. So
 * the ceiling tracks the worst case a stage could need, and it moves for
 * reasons — a reasoning model's hidden tokens, a `revised_answer` that is a
 * whole replacement answer — that say nothing about what a typical call
 * generates. 0.4 x 2000 quoted a draft at 800 completion tokens; the drafts we
 * have actually run average 275. No fraction of that ceiling is right, because
 * the two numbers are not measuring the same thing.
 *
 * MEASURED 2026-08-12 against every `model_responses` row with a null
 * error_text — 84 drafts, 32 verdicts, 51 rebuttals, 32 finals, 199 calls in
 * all, from Sessions 5 to 8:
 *
 *   stage     avg prompt   avg completion
 *   draft            149              275
 *   verdict          827              285
 *   rebuttal        1055              293
 *   final           1176              247
 *
 * Prompts are rounded up to the nearest fifty and completions to the nearest
 * twenty-five: an estimate should lean high, since quoting under and then
 * debiting over is the direction that surprises a user.
 *
 * REFRESH THIS WHEN IT DRIFTS. It is an average over our own four models at one
 * council size and one prompt length, so a new model, a longer question, or a
 * template edit moves it. Re-run the query in the comment above and compare;
 * `scripts/verify-wallet.js` prints the estimate against a real round's actual
 * cost, which is the cheapest way to notice. A constant measured once and never
 * looked at again is the thing this replaced.
 */
export const STAGE_TOKEN_AVERAGES = Object.freeze({
  draft: Object.freeze({ prompt: 150, completion: 275 }),
  verdict: Object.freeze({ prompt: 850, completion: 300 }),
  rebuttal: Object.freeze({ prompt: 1100, completion: 300 }),
  final: Object.freeze({ prompt: 1200, completion: 250 }),
});

/**
 * Keyed by `model_responses.stage`, so a stage name is the only lookup key the
 * orchestrator needs to hold. Both chairman stages share one temperature and
 * differ only in their ceiling.
 */
export const STAGE_DEFAULTS = Object.freeze({
  draft: Object.freeze({ temperature: TEMPERATURE.drafting, maxTokens: MAX_TOKENS.draft }),
  verdict: Object.freeze({ temperature: TEMPERATURE.chairman, maxTokens: MAX_TOKENS.verdict }),
  rebuttal: Object.freeze({ temperature: TEMPERATURE.rebuttal, maxTokens: MAX_TOKENS.rebuttal }),
  final: Object.freeze({ temperature: TEMPERATURE.chairman, maxTokens: MAX_TOKENS.final }),
});
