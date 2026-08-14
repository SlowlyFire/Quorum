/**
 * A session's auto-title, from the question that started it.
 *
 * Truncation on a word boundary rather than a cheap LLM call: the question
 * itself is usually the best label a session could have, this is free and
 * instant where a call would add latency and cost to the one moment in the
 * round that already ends it, and it cannot fail the way a call can. Checked
 * against eight real questions pulled from `rounds.user_prompt` before this
 * was written rather than assumed — all eight read as a coherent label, not a
 * word cut in half:
 *
 *   "Should a small team use a monorepo or separate repositories?"
 *     -> "Should a small team use a monorepo or separate…"
 *   "A team is deciding whether to run their own Postgres or use a managed
 *   one. Give a clear recommendation and say what would change it."
 *     -> "A team is deciding whether to run their own…"
 *
 * ~50 characters, not exactly 50: cutting mid-word would read as broken in a
 * way cutting at the word before it does not, so the limit is a ceiling the
 * function backs off from rather than a fixed length.
 */
const MAX_LENGTH = 50;

/**
 * @param {string} prompt
 * @returns {string|null} a title, or null for an empty prompt (never happens
 *   in practice — the round schema requires a non-empty prompt — but this is
 *   the one function on this path with no request to have already checked).
 */
export function titleFromPrompt(prompt) {
  const trimmed = (prompt ?? '').trim().replace(/\s+/g, ' ');

  if (!trimmed) return null;
  if (trimmed.length <= MAX_LENGTH) return trimmed;

  const slice = trimmed.slice(0, MAX_LENGTH);
  const lastSpace = slice.lastIndexOf(' ');

  // A single word longer than the limit (a URL, an unbroken identifier) has
  // no boundary to back off to — hard-cut rather than return nothing.
  const cut = lastSpace > 15 ? slice.slice(0, lastSpace) : slice;

  return `${cut}…`;
}
