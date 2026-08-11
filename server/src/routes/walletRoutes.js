/**
 * §8 Wallet — balance, ledger, and starting a top-up.
 *
 * No `:id` on any of the three, and so no requireOwnership: a wallet is not
 * addressable, it is whoever is asking. `req.user.id` comes from the row
 * requireAuth loaded, which is the only user id that reaches a query here.
 *
 * The fourth endpoint in §8's wallet block, POST /api/webhooks/stripe, is NOT
 * in this file and not under /api/wallet. Its caller is Stripe rather than a
 * signed-in user, it authenticates by signature rather than by cookie, and it
 * needs a raw body — so it is mounted separately in app.js, ahead of the JSON
 * parser. See webhookRoutes.js.
 */
import { Router } from 'express';

import { getWallet, listTransactions, startCheckout } from '../controllers/walletController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { checkoutSchema, listTransactionsQuerySchema } from '../validation/walletSchemas.js';

const router = Router();

router.use(requireAuth);

router.get('/', getWallet);
router.get('/transactions', validate({ query: listTransactionsQuerySchema }), listTransactions);
router.post('/checkout', validate({ body: checkoutSchema }), startCheckout);

export { router as walletRoutes };
