/**
 * The verdict vocabulary the sessions page uses, in one place.
 *
 * `lib/round.js` already has `verdictChip`, which renders the chairman's verdict
 * INSIDE a round — "PICKED B", "MERGED A + C", naming the anonymous labels. This
 * is the other reading: a session's outcome as a row in a list, where there are
 * no labels in scope and the chip has to fit a column. Mockup 03's chips are
 * "Merged", "Picked B", "Unanimous", "Synthesised" — title case, and the wording
 * on the filter buttons above them ("Picked one") is different again because a
 * filter names a category rather than a result.
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
const VERDICT_CHIPS = {
  picked: { label: 'Picked one', color: 'dark' },
  merged: { label: 'Merged', color: 'brass' },
  synthesised: { label: 'Synthesised', color: 'brass' },
  unanimous: { label: 'Unanimous', color: 'green' },
};

export function verdictChipFor(verdictType) {
  if (!verdictType) return null;

  return VERDICT_CHIPS[verdictType] ?? { label: verdictType, color: 'gray' };
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
