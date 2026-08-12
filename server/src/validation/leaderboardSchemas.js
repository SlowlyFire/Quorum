/**
 * Zod for §8's `GET /api/leaderboard?scope=mine|all&days=30`.
 *
 * A query string carries only strings, so `days` is coerced. Both parameters
 * have defaults, and the defaults are the URL with no query at all — a bare
 * GET /api/leaderboard is the page's first load.
 */
import { z } from 'zod';

import { DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS } from '../config/leaderboard.js';

/**
 * `all` is the default, matching the page: a new user's personal board is empty,
 * and an empty podium is the worst possible first impression of a feature whose
 * whole point is a comparison.
 */
export const leaderboardQuerySchema = z
  .object({
    scope: z
      .enum(['mine', 'all'])
      .default('all')
      .or(z.literal('').transform(() => 'all')),
    /**
     * Capped for the same reason pagination is: the window is the only thing
     * bounding how much of `model_responses` one request aggregates, and
     * `?days=100000` is a lever any signed-in user could pull.
     */
    days: z.coerce
      .number()
      .int()
      .min(1, 'must be at least 1')
      .max(MAX_WINDOW_DAYS, `must be at most ${MAX_WINDOW_DAYS}`)
      .default(DEFAULT_WINDOW_DAYS),
  })
  .strict('is not a recognised query parameter');
