/**
 * The leaderboard's vocabulary and formatting, in one place — the same job
 * `lib/verdict.js` does for the sessions page.
 *
 * No arithmetic lives here. Every number on the page (`score`, `winRate`,
 * `concessionRate`, `draftsNeeded`) is computed by the server from the query's
 * own output, because the ranking rules are §4's and a second implementation on
 * this side would be a second set of rules. What this file does is turn those
 * numbers into the strings mockup 07 draws.
 */

/** Mockup 07's two buttons. `key` is what goes on the wire as `?scope=`. */
export const SCOPE_TABS = [
  { key: 'mine', label: 'My council' },
  { key: 'all', label: 'All time' },
];

/**
 * "All time" is the default, and that is a deliberate departure from the
 * mockup, which draws "My council" selected. A signed-in user opening this page
 * for the first time has no completed rounds, so the mockup's default renders an
 * empty podium and reads as a broken feature — the one impression a comparison
 * screen cannot afford to make. The toggle is one click away and the other view
 * always has something in it.
 */
export const DEFAULT_SCOPE = 'all';

/** Gold, silver, bronze — the three rules across the tops of the blocks. */
export const PODIUM_COLORS = ['#B8860B', '#9AA7B2', '#A96A3C'];

/**
 * Podium seating: second, first, third. First is the tallest and in the middle,
 * which is what makes the shape read as a podium rather than as a bar chart.
 */
export const PODIUM_ORDER = [1, 0, 2];

/** Block heights, in the same order as the ranks they belong to. */
export const PODIUM_HEIGHTS = [200, 145, 110];

export function formatPercent(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';

  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * SIGNIFICANT FIGURES, NOT DECIMAL PLACES, and the difference is the whole
 * column.
 *
 * A draft from our cheapest model costs $0.00051 and from the dearest $0.00095.
 * `toFixed(2)` prints both as $0.00 and claims the models are free; `toFixed(4)`
 * prints $0.0005 and $0.0010, which is legible but rounds two models that differ
 * by a factor of two into looking almost the same. Two significant figures keeps
 * the comparison the column exists to make, at whatever magnitude the prices
 * happen to be — which matters because they are not ours and they move.
 *
 * Above a cent, fixed decimals read better than significant figures ($0.0125,
 * not $0.013), so the threshold switches.
 */
export function formatAvgCost(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';

  return value < 0.01 ? `$${Number(value.toPrecision(2))}` : `$${value.toFixed(4)}`;
}

export function formatLatency(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';

  return `${(ms / 1000).toFixed(1)}s`;
}

/** "needs 2 more drafts" — the line under an unranked model. */
export function needsMoreDrafts(count) {
  return `needs ${count} more draft${count === 1 ? '' : 's'}`;
}
