/**
 * The published result of the self-preference study, as numbers the leaderboard
 * can draw.
 *
 * HARDCODED, AND THAT IS THE RIGHT CALL. This is a finished measurement with a
 * date on it, not live data: 48 rounds run on 2026-08-12, written up in
 * docs/self-preference-study.md with the raw rows in
 * docs/self-preference-data.csv. Serving it from an endpoint would mean a query
 * that recomputes a published figure on every page load and could silently
 * disagree with the document — the study is a citation, and a citation is a
 * constant. Same reasoning as the landing page's `RealDebate`.
 *
 * IF THE STUDY IS RE-RUN, THESE NUMBERS MUST BE REGENERATED FROM ITS OUTPUT.
 * `npm run measure:self-preference -- --analyse-only` prints every figure below.
 * A stale number here is worse than no section at all, because the document it
 * links to would contradict it.
 */

/** The chance baseline: three drafters, so an indifferent chairman picks its
 *  own draft one time in three. */
export const BASELINE = 1 / 3;

export const STUDY = Object.freeze({
  ranAt: '2026-08-12',
  rounds: 48,
  /** Only sole-winner rounds have a chance baseline of exactly 1/3. */
  decisiveRounds: 34,
  selfPicks: 15,
  rate: 15 / 34,
  ci: { low: 0.289, high: 0.605 },
  p: 0.204,

  /**
   * The headline is a NULL RESULT, and the component keys its wording off this
   * flag rather than off prose someone might forget to update. The interval
   * contains the baseline; we did not find self-preference.
   */
  significant: false,

  perChairman: [
    { model: 'GPT-5 Mini', n: 15, selfPicks: 15, rate: 1, winsUnderOthers: 14 / 19 },
    { model: 'Claude Haiku 4.5', n: 3, selfPicks: 0, rate: 0, winsUnderOthers: 5 / 31 },
    { model: 'Gemini 2.5 Flash', n: 16, selfPicks: 0, rate: 0, winsUnderOthers: 0 },
  ],

  /** The one finding that survived its controls, and it is post-hoc. */
  merges: { n: 14, includedSelf: 14, p: 0.026 },
});

export const STUDY_PATH =
  'https://github.com/SlowlyFire/Quorum/blob/main/docs/self-preference-study.md';
