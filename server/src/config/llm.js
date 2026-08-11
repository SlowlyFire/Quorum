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
 * What a pre-flight cost check should assume a stage will actually generate,
 * as a fraction of its ceiling above. A placeholder with a deliberate expiry:
 * Session 9 has hundreds of `model_responses` rows to derive real per-stage
 * averages from, and a number measured from our own traffic beats a constant.
 */
export const COMPLETION_ESTIMATE_RATIO = 0.4;

/**
 * What a pre-flight estimate should assume a stage will send *up*, per call, in
 * prompt tokens.
 *
 * Unlike the completion side there is no ceiling to take a fraction of — a
 * prompt is as long as it is — so these are averages measured from our own
 * `model_responses` rows on 2026-08-11 (66 drafts, 26 verdicts, 36 rebuttals,
 * 26 finals): draft 147, verdict 862, rebuttal 1142, final 1211. Rounded up to
 * the nearest fifty, because the four stages after the first carry the question
 * plus every draft, and a longer question moves all of them together.
 *
 * They are the smaller half of the quote in any case — at Session 6's prices a
 * draft's prompt is under a tenth of its completion — so the estimate's accuracy
 * lives almost entirely in COMPLETION_ESTIMATE_RATIO above. Session 9 replaces
 * both with per-stage averages read from the table at request time.
 */
export const PROMPT_ESTIMATE_TOKENS = Object.freeze({
  draft: 150,
  verdict: 900,
  rebuttal: 1150,
  final: 1250,
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
