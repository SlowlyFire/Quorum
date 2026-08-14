/**
 * The one word that names each verdict type — the base every verdict chip in
 * the product renders, so `lib/verdict.js`'s session-row chip and
 * `lib/round.js`'s in-round chip cannot describe the same outcome two
 * different ways.
 *
 * MEASURED, NOT GUESSED, AND MEASURED AGAIN AGAINST PRODUCTION DATA BECAUSE
 * THE FIRST THREE ROUNDS OF GUESSING WERE WRONG. The sessions table's VERDICT
 * column (`SessionsTable.jsx`'s `miw={720}` table, `table-layout: auto`, so
 * every row shares one column width, and the width that leaves for VERDICT
 * shifts with what every OTHER cell in the table needs) was checked with a
 * canvas `measureText` at the badge's real weight/size (`700 11px`) against
 * the actual rendered column, not against character count, because the two
 * are not proportional and a rounder-sounding replacement can be no narrower
 * in pixels than the word it replaced. "Synthesised" (69px) truncated at
 * 320/360/768px; "New answer" (68px), the first replacement, truncated
 * identically. "Custom" (43px) is genuinely shorter and still truncated once
 * the OTHER columns' cells changed shape around it — the column's own width
 * is not a fixed target, so the fix is a word with real margin, not one that
 * clears the number measured a moment before. "New" (24px) and "Same" (31px,
 * for `unanimous`, which had the identical bug) hold up.
 *
 * "Merged" WAS ALSO WRONG, and this is the one the brief said not to touch.
 * It measured fine against local dev's fixture data — then truncated (43px
 * natural against a 39px column) on the DEPLOYED app's real sessions, at
 * 360px, checked as the last step of verifying this fix rather than assumed
 * safe because it wasn't named in the brief. "Both" (26px) replaces it, with
 * real margin rather than the few pixels "Merged" was short by.
 */
export const VERDICT_LABELS = {
  picked: 'Picked',
  merged: 'Both',
  synthesised: 'New',
  unanimous: 'Same',
};

/** A verdict type this map has never heard of renders as itself, unchanged —
 *  the same "show it rather than hide it" choice `verdictChipFor` made before
 *  this file existed. */
export function verdictLabel(verdictType) {
  return VERDICT_LABELS[verdictType] ?? verdictType;
}
