/**
 * §8 Leaderboard — listed under "Models & presets" there, and mounted as its own
 * router here because it is neither.
 *
 * Behind requireAuth for the same reason `GET /api/models` is: §4 lists it among
 * the signed-in user's use cases, `scope=mine` has no meaning without a user,
 * and `scope=all` aggregates every user's rounds — which is safe to show a
 * member and not something to leave open. There is no `:id`, so no ownership
 * check; the two scopes are the whole of the authorization, and the one that
 * reads a user's own data reads it from `req.user.id` rather than from anything
 * the caller sent.
 */
import { Router } from 'express';

import { getStandings } from '../controllers/leaderboardController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { leaderboardQuerySchema } from '../validation/leaderboardSchemas.js';

const router = Router();

router.get('/', requireAuth, validate({ query: leaderboardQuerySchema }), getStandings);

export { router as leaderboardRoutes };
