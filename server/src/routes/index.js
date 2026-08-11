import { Router } from 'express';

import { authRoutes } from './authRoutes.js';
import { healthRoutes } from './healthRoutes.js';
import { modelRoutes } from './modelRoutes.js';
import { presetRoutes } from './presetRoutes.js';
import { roundRoutes } from './roundRoutes.js';
import { sessionRoutes } from './sessionRoutes.js';
import { shareRoutes } from './shareRoutes.js';
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
router.use('/presets', presetRoutes);
router.use('/rounds', roundRoutes);
router.use('/sessions', sessionRoutes);
router.use('/wallet', walletRoutes);

/**
 * The only mount on this router with no authentication behind it. §8: "GET
 * /api/share/:token — Public. Read-only session, no auth." Its payload is built
 * by allow-list in shareService, which is the file to read before changing
 * anything it returns.
 */
router.use('/share', shareRoutes);

export { router as apiRoutes };
