import { Router } from 'express';

import { authRoutes } from './authRoutes.js';
import { healthRoutes } from './healthRoutes.js';
import { modelRoutes } from './modelRoutes.js';
import { roundRoutes } from './roundRoutes.js';
import { sessionRoutes } from './sessionRoutes.js';
import { walletRoutes } from './walletRoutes.js';

/**
 * The /api surface, all of it behind `express.json()` and `cookie-parser`.
 *
 * POST /api/webhooks/stripe is the one route that is NOT here despite its path.
 * It needs a raw body and authenticates by signature rather than by cookie, so
 * app.js mounts it ahead of the JSON parser. See webhookRoutes.js.
 */
const router = Router();

router.use('/auth', authRoutes);
router.use('/health', healthRoutes);
router.use('/models', modelRoutes);
router.use('/rounds', roundRoutes);
router.use('/sessions', sessionRoutes);
router.use('/wallet', walletRoutes);

export { router as apiRoutes };
