/**
 * Rate limiting for the credential endpoints only.
 *
 * Login is the one route where an attacker gets unlimited free guesses at
 * something secret, and register is the one where they get unlimited free
 * account creation. Nothing else in the API is worth throttling per-IP: every
 * other route already costs an authenticated session, and the debate routes
 * are governed by the wallet and the free-tier allowance instead.
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
