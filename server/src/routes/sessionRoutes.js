/**
 * §8 Sessions & rounds, the owned half.
 *
 * requireOwnership's first real callers. Session 3 built it and verified it by
 * reading; these five routes and the two in roundRoutes are what exercise it.
 *
 * Middleware order on every :id route is requireAuth, then validate, then
 * requireOwnership — and the middle one is not cosmetic. The ownership loader
 * passes req.params.id straight into a query, so an id that is not a uuid would
 * reach Postgres and return as a 500 `invalid input syntax for type uuid`
 * instead of the 400 it plainly is.
 *
 * POST /:id/rounds lives here rather than in roundRoutes because ownership of
 * the round it creates is ownership of the session it belongs to, and mounting
 * it here is what keeps that one truth in one place.
 */
import { Router } from 'express';

import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  updateSession,
} from '../controllers/sessionController.js';
import { startRound } from '../controllers/roundController.js';
import { createRoundRateLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireOwnership } from '../middleware/requireOwnership.js';
import { validate } from '../middleware/validate.js';
import { loadSessionForOwnership } from '../services/sessionService.js';
import { createRoundSchema } from '../validation/roundSchemas.js';
import {
  createSessionSchema,
  listSessionsQuerySchema,
  sessionIdParamSchema,
  updateSessionSchema,
} from '../validation/sessionSchemas.js';

const router = Router();

/** Nothing below this line is reachable without a valid session cookie. */
router.use(requireAuth);

const owned = () => requireOwnership(loadSessionForOwnership);

router.post('/', validate({ body: createSessionSchema }), createSession);
router.get('/', validate({ query: listSessionsQuerySchema }), listSessions);

router.get('/:id', validate({ params: sessionIdParamSchema }), owned(), getSession);
router.patch(
  '/:id',
  validate({ params: sessionIdParamSchema, body: updateSessionSchema }),
  owned(),
  updateSession,
);
router.delete('/:id', validate({ params: sessionIdParamSchema }), owned(), deleteSession);

/**
 * TEMPORARY spend cap — 10 rounds per hour per user, until Session 9's wallet
 * replaces it. See createRoundRateLimiter for why it exists and why it is
 * keyed on the user rather than the IP.
 *
 * It is mounted LAST, after validate and after ownership, which is the reverse
 * of the auth routes. There the limiter guards a secret, so a malformed body
 * is still an attempt worth counting. Here it guards money, and neither a 400
 * nor a 403 spends any: counting them would let a user burn their own hour of
 * debates on typos.
 */
router.post(
  '/:id/rounds',
  validate({ params: sessionIdParamSchema, body: createRoundSchema }),
  owned(),
  createRoundRateLimiter(),
  startRound,
);

export { router as sessionRoutes };
