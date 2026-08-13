/**
 * GET /api/share/:token — §8's one public route.
 *
 * NOTHING HERE IS BEHIND requireAuth, AND THAT IS THE POINT. It is mounted in
 * its own file rather than alongside the owned session routes so that the
 * absence of `router.use(requireAuth)` is visible as a decision instead of as an
 * omission: in sessionRoutes and presetRoutes that line is the first thing in
 * the file, and a reader who knows the codebase would assume it here too.
 *
 * The two owner-side halves of sharing — POST and DELETE
 * /api/sessions/:id/share — live in sessionRoutes with the session they belong
 * to, behind both guards.
 *
 * The token is not validated by Zod. It is an opaque string we generated, its
 * only shape is base64url, and a token of the wrong shape is a token that does
 * not exist — which is the same 404 as one that never did. A schema would turn
 * that into a 400 and tell a caller their guess was malformed rather than wrong.
 */
import { Router } from 'express';

import { getSharedSession } from '../controllers/shareController.js';
import { createShareRateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { shareTokenParamSchema } from '../validation/shareSchemas.js';

const router = Router();

router.get(
  '/:token',
  createShareRateLimiter(),
  validate({ params: shareTokenParamSchema }),
  getSharedSession,
);

export { router as shareRoutes };
