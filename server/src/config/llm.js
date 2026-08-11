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
 * Ceilings, not targets. `01-draft.md` asks for under 400 words — roughly 600
 * tokens — so 1200 is headroom rather than an invitation. The chairman's two
 * stages carry a whole answer plus its reasoning inside a JSON envelope, so
 * they get more; a rebuttal is 2-3 sentences plus at most one revised answer,
 * so it gets less.
 *
 * `finishReason === 'length'` is the signal that one of these is set too low,
 * which is why callModel returns it rather than discarding it.
 */
export const MAX_TOKENS = Object.freeze({
  draft: 1200,
  verdict: 1500,
  rebuttal: 800,
  final: 1500,
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
