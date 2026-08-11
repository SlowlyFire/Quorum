/**
 * §8 Rounds — reading one, and watching one.
 *
 * Ownership is checked against the round itself here rather than its session,
 * which rounds.user_id makes a single row lookup with no join (decision 5).
 *
 * The stream is guarded exactly like the read. A debate is a user's question and
 * the models' answers to it, and "watch" is a read: an unauthenticated GET on
 * this path is a 401 and another user's round is a 403, with no separate rule
 * for the streaming case. Creating one is POST /api/sessions/:id/rounds, which
 * lives with the session it belongs to.
 */
import { Router } from 'express';

import { getRound, streamRound } from '../controllers/roundController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireOwnership } from '../middleware/requireOwnership.js';
import { validate } from '../middleware/validate.js';
import { loadRoundForOwnership } from '../services/roundService.js';
import { roundIdParamSchema, streamQuerySchema } from '../validation/roundSchemas.js';

const router = Router();

router.use(requireAuth);

const owned = () => requireOwnership(loadRoundForOwnership);

router.get('/:id', validate({ params: roundIdParamSchema }), owned(), getRound);

router.get(
  '/:id/stream',
  validate({ params: roundIdParamSchema, query: streamQuerySchema }),
  owned(),
  streamRound,
);

export { router as roundRoutes };
