/**
 * §8's `GET /api/leaderboard?scope=mine|all&days=30`, and §4's scoring rules
 * applied to what `leaderboardModel` returns.
 *
 * The arithmetic is all in the query — read that file for the two traps it
 * exists to avoid. What is left here is the split §4 asks for and the shaping
 * every service in this directory does: one place where a row becomes wire
 * shape, and numerics off pg as numbers rather than strings.
 *
 * WHY THE SPLIT IS HERE AND NOT IN THE QUERY. "Fewer than five drafts" is a
 * presentation rule — the same rows, drawn in two places — and a query that
 * returned two result sets would have to be two queries. The threshold travels
 * to the client as `minDrafts` so the page's "needs 2 more drafts" is subtraction
 * against the number the server actually used, rather than a 5 typed into a
 * component.
 */
import { MIN_DRAFTS_TO_RANK, PODIUM_SIZE } from '../config/leaderboard.js';
import { aggregateLeaderboard } from '../models/leaderboardModel.js';

/** numeric off pg is a string; nulls stay null. */
function num(value) {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * The single place a leaderboard row becomes wire shape.
 *
 * `wins` and `merged` ARE DISJOINT, and that is a choice worth stating: `wins`
 * counts the rounds this model won outright and `merged` the rounds it shared,
 * so `score = wins + merged / 2` and a reader can check the win rate off the row
 * with the two columns mockup 07 already draws. Counting a merge in both would
 * make the row's own numbers fail to reconcile with its rate.
 *
 * `winRate` is computed here rather than read back from the query for the same
 * reason the cost estimate is multiplied in two places (decision 28): the
 * *inputs* are what must not be duplicated, and score and drafts both travel.
 */
export function toPublicStanding(row) {
  const drafts = Number(row.drafts);
  const score = Number(row.score);
  const rebuttals = Number(row.rebuttals);
  const conceded = Number(row.conceded);

  return {
    modelId: row.model_id,
    displayName: row.display_name,
    provider: row.provider,
    slug: row.openrouter_slug,

    drafts,
    /** Sole winner of stage 2 — §4's "chairman picks one draft", 1.0. */
    wins: Number(row.wins),
    /** One of several winners — §4's "chairman merges two drafts", 0.5 each. */
    merged: Number(row.merged),
    score,
    /** §4 ranks on this, never on raw wins. Null on zero drafts, which the
     *  query cannot return — a row exists only because a draft seat did. */
    winRate: drafts > 0 ? score / drafts : null,

    rebuttals,
    conceded,
    /**
     * Concessions over rebuttals MADE, not over rounds drafted. Stage 3 does not
     * always happen — it is skipped on a unanimous verdict and when a session
     * has rebuttals switched off — so the other denominator would report a model
     * that was never asked to rebut as one that never conceded. Null rather than
     * 0 when it has never rebutted, so the page can print "—" instead of
     * claiming a 0% concession rate it has no evidence for.
     */
    concessionRate: rebuttals > 0 ? conceded / rebuttals : null,

    /**
     * The mean cost and latency of this model's OWN draft call — not the round's
     * total. A round total would fold in the other models on the council and,
     * for a chairman that also drafts, its verdict and final calls too, which
     * makes the column incomparable between two rows. "What one draft from this
     * model costs" is the question the council picker is asking.
     *
     * Null when every draft it was seated for failed: avg() over no rows is
     * null, and 0 would read as free.
     */
    avgCost: num(row.avg_cost),
    avgLatencyMs: row.avg_latency === null ? null : Math.round(Number(row.avg_latency)),
  };
}

/**
 * @param {{ userId: string, scope: 'mine' | 'all', days: number }} options
 * @returns `{ scope, days, minDrafts, podiumSize, ranked, unranked }` —
 *   `ranked` already in rank order, `unranked` in draft order so the model
 *   closest to qualifying is first.
 */
export async function getLeaderboard({ userId, scope, days }) {
  const rows = await aggregateLeaderboard({
    // §4: "the same aggregate query with an optional user_id filter".
    userId: scope === 'mine' ? userId : null,
    days,
  });

  const standings = rows.map(toPublicStanding);

  const ranked = standings.filter((standing) => standing.drafts >= MIN_DRAFTS_TO_RANK);
  const unranked = standings
    .filter((standing) => standing.drafts < MIN_DRAFTS_TO_RANK)
    .sort((a, b) => b.drafts - a.drafts)
    .map((standing) => ({
      ...standing,
      /** Computed once, here, so the page never subtracts against its own 5. */
      draftsNeeded: MIN_DRAFTS_TO_RANK - standing.drafts,
    }));

  return {
    scope,
    days,
    minDrafts: MIN_DRAFTS_TO_RANK,
    podiumSize: PODIUM_SIZE,
    /** Rank is the array index plus one; it is not a column, because it is a
     *  property of this list rather than of the model. */
    ranked,
    unranked,
  };
}
