/**
 * §3's billing rule, as numbers, in one place.
 *
 * The same reasoning as config/llm.js: these are read by the service that
 * decides whether a round may start, by the service that summarises a wallet,
 * by the one that creates a Checkout session, and by the client — which is
 * given them over the wire rather than restating them. A second copy of "two
 * free debates" would drift the first time the number changed, and it would
 * drift silently, because both halves would still render.
 *
 * They also sit here rather than in entitlementService so that walletService
 * can read them without importing the service that imports it.
 */

/**
 * §3: a wallet that cannot cover a round gets this many debates per UTC day.
 * Counted as a query against `rounds`, never as a stored counter — see
 * countRoundsForUserToday.
 */
export const FREE_ROUNDS_PER_DAY = 2;

/**
 * §3's rule: `balance >= max($0.05, estimated_round_cost x 1.5)` bills the
 * wallet; anything less falls to the free allowance.
 *
 * The threshold is relative because a four-model council costs many times what
 * a two-model one does, so a flat floor is either too strict for the small
 * council or too loose for the large one. The multiple is headroom for the
 * estimate being an estimate — OpenRouter bills whichever upstream it routed to
 * (decision 16) — and the floor stops a very cheap council starting on a
 * balance too small to settle anything.
 */
export const MINIMUM_THRESHOLD = 0.05;
export const THRESHOLD_MULTIPLE = 1.5;

/** Mockup 04's three amounts, $15 preselected. Whole US dollars. */
export const TOPUP_AMOUNTS = Object.freeze([5, 15, 50]);

/** Mockup 04's bar chart is one week wide. */
export const SPEND_CHART_DAYS = 7;
