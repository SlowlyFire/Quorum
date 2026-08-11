/**
 * Rate limiting.
 *
 * Login is the one route where an attacker gets unlimited free guesses at
 * something secret, and register is the one where they get unlimited free
 * account creation. Both are throttled per-IP, because the caller has no
 * identity yet.
 *
 * SESSION 9 DELETED createRoundRateLimiter FROM THIS FILE. It capped a user at
 * ten rounds an hour as a stopgap while POST /sessions/:id/rounds had no cost
 * check at all (decision 27), and §8's actual check now exists:
 * entitlementService decides whether a round may start from the user's balance
 * and the free-tier count, and walletService debits what it cost. Do not bring
 * a per-user round cap back alongside them — it says nothing about what a round
 * costs or what the user can afford, and it caps a funded user identically to
 * an empty one, which is the thing the wallet is for.
 */
import { rateLimit } from 'express-rate-limit';

import { httpError } from '../lib/httpError.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 10;

/**
 * A factory, so /login and /register get an instance each rather than sharing
 * one budget — ten failed sign-in attempts should not also block the person
 * from creating an account.
 *
 * The default store is in-memory and therefore per-process: it resets on
 * restart and does not add up across instances. Fine for one dyno; a shared
 * store is the fix if this is ever scaled out.
 */
export function createAuthRateLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,

    // The library's default writes its own plain-text 429. Hand it to
    // errorHandler instead so a throttled client parses the same
    // { error: { message, code } } envelope as every other failure.
    handler: (req, res, next) => {
      next(
        httpError(429, 'RATE_LIMITED', 'Too many attempts. Please try again in a few minutes.'),
      );
    },
  });
}
