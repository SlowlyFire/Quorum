/**
 * Rate limiting.
 *
 * Login is the one route where an attacker gets unlimited free guesses at
 * something secret, and register is the one where they get unlimited free
 * account creation. Both are throttled per-IP, because the caller has no
 * identity yet.
 *
 * Starting a round is throttled per-*user*, and for a different reason: money.
 * See createRoundRateLimiter below.
 */
import { rateLimit } from 'express-rate-limit';

import { httpError } from '../lib/httpError.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 10;

const ROUND_WINDOW_MS = 60 * 60 * 1000;
const ROUND_MAX_REQUESTS = 10;

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

/**
 * TEMPORARY — a spend stopgap, replaced by the wallet in Session 9.
 *
 * §8 words POST /sessions/:id/rounds as "pre-flight cost check, then run
 * stages 1-4", and that check does not exist yet: nothing is debited, no
 * credit_transactions row is written, and no free-tier count runs. Until it
 * does, the only thing between one signed-in user and unlimited OpenRouter
 * spend is the hard cap on OpenRouter's own dashboard. Ten rounds an hour is
 * roughly $0.15 at Session 6's observed cost per round — enough that no honest
 * user notices it, and small enough that a runaway client or a stolen cookie
 * cannot empty the account overnight.
 *
 * Keyed on req.user.id, NOT on the IP. The thing being rationed is a user's
 * spend, and it follows the account rather than the network it is used from:
 * an office behind one NAT must not share a budget, and one user on a phone
 * must not get a fresh budget by changing networks. That is also why this
 * limiter can only be mounted behind requireAuth.
 *
 * Session 9: delete this and the mount in sessionRoutes, and replace both with
 * the wallet debit and the free-tier count. A per-user cap is not a substitute
 * for either — it says nothing about what a round costs or what the user can
 * afford.
 */
export function createRoundRateLimiter() {
  return rateLimit({
    windowMs: ROUND_WINDOW_MS,
    limit: ROUND_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,

    // requireAuth has already loaded the row, so req.user is the source of
    // truth here exactly as it is everywhere else — never the JWT's claims.
    keyGenerator: (req) => req.user.id,

    handler: (req, res, next) => {
      next(
        httpError(
          429,
          'RATE_LIMITED',
          'Too many debates started. You can start 10 rounds per hour — please try again shortly.',
        ),
      );
    },
  });
}
