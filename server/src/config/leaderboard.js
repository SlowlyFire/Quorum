/**
 * §4's leaderboard-scoring numbers, in one place — the same job `config/billing.js`
 * does for §3's. Nothing here is a sampling default or a price; these are the
 * rules of the ranking, and the page, the query and the empty state all have to
 * agree on them or the screen explains itself with a number the server did not
 * use.
 */

/**
 * §4: "A model needs at least 5 drafts in the period to be ranked, so a single
 * lucky win cannot top the podium." Below it a model is not dropped — it goes
 * to `unranked` with its counts, because a user with two days of history who
 * sees an empty page concludes the feature is broken rather than that they have
 * not debated enough yet.
 */
export const MIN_DRAFTS_TO_RANK = 5;

/** §8's `days=30`. */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * A year. The window is a `now() - interval` in a query with no LIMIT, so it is
 * the only thing bounding how much of `model_responses` one request reads.
 */
export const MAX_WINDOW_DAYS = 365;

/** Mockup 07 draws three blocks. Gold, silver, bronze. */
export const PODIUM_SIZE = 3;
