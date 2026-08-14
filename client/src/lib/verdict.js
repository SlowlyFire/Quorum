import { verdictLabel } from './verdictLabel.js';

/**
 * The verdict vocabulary the sessions page uses, in one place.
 *
 * `lib/round.js` already has `verdictChip`, which renders the chairman's verdict
 * INSIDE a round — "PICKED B", "MERGED A + C", naming the anonymous labels. This
 * is the other reading: a session's outcome as a row in a list, where there are
 * no labels in scope and the chip has to fit a column. Both read their WORD off
 * `lib/verdictLabel.js` — the shared map is what stops the two chips from
 * describing the same verdict differently — and this file adds only the colour
 * per type and, on the filter buttons, "Picked one" rather than "Picked", since
 * a filter names a category rather than a single row's result.
 *
 * The values are `rounds.verdict_type`'s own, so `key` is what goes on the wire
 * as `?verdict=` and the labels stay entirely on this side.
 */

/** Mockup 03's four filter buttons, in its order. */
export const VERDICT_FILTERS = [
  { key: 'all', label: 'All verdicts' },
  { key: 'merged', label: 'Merged' },
  { key: 'picked', label: 'Picked one' },
  { key: 'synthesised', label: 'Synthesised' },
];

/**
 * `unanimous` has no filter chip in the mockup and is a legal value of the
 * column — three of Session 6's four rounds ended that way once every drafter
 * had conceded. So it renders in the table and simply cannot be filtered for,
 * which is the mockup's design rather than an oversight; the server accepts it
 * as a filter value anyway so the two never disagree about what exists.
 */
const VERDICT_COLORS = {
  picked: 'dark',
  merged: 'brass',
  synthesised: 'brass',
  unanimous: 'green',
};

export function verdictChipFor(verdictType) {
  if (!verdictType) return null;

  return { label: verdictLabel(verdictType), color: VERDICT_COLORS[verdictType] ?? 'gray' };
}

/**
 * "2h ago", "Yesterday", "Aug 6" — the mockup's WHEN column.
 *
 * Deliberately not a library. Four branches and a date format is the whole
 * requirement, and the nearest dependency that does it is larger than every
 * component on this page put together.
 */
export function relativeTime(value) {
  if (!value) return '—';

  const then = new Date(value);
  const elapsedMs = Date.now() - then.getTime();

  if (!Number.isFinite(elapsedMs)) return '—';
  if (elapsedMs < 60_000) return 'Just now';

  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  // Calendar days rather than 24-hour blocks: something at 23:00 last night is
  // "Yesterday" at 09:00 this morning, which is how a person reads it.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const daysAgo = Math.floor((startOfToday.getTime() - then.getTime()) / 86_400_000) + 1;

  if (daysAgo <= 1) return 'Yesterday';

  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
