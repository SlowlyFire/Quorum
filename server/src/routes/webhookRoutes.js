/**
 * Inbound webhooks. One so far.
 *
 * Deliberately NOT part of the /api router in routes/index.js, even though the
 * path reads as though it should be. Everything in that router sits behind
 * `express.json()`, and this route must not: Stripe signs the exact bytes it
 * sent, so verification needs the raw body. app.js mounts this ahead of the
 * JSON parser and gives it `express.raw` instead — see the comment there.
 *
 * Nothing here is behind requireAuth. The caller is Stripe; the signature is
 * the credential.
 */
import { Router } from 'express';

import { handleStripeWebhook } from '../controllers/webhookController.js';

const router = Router();

router.post('/stripe', handleStripeWebhook);

export { router as webhookRoutes };
