/**
 * §8's Wallet block: balance, ledger, and the start of a top-up.
 *
 * Thin, as every controller here is. The one that does anything unusual is
 * `listTransactions`, and only because a CSV is a different content type rather
 * than a different resource — the rows and their shaping still come from
 * walletService, so the download and the table cannot disagree about a row.
 *
 * There is no `:id` anywhere in this file and so no ownership check: a wallet
 * belongs to the caller by definition, and `req.user.id` — loaded from the
 * database by requireAuth, never read off the JWT — is the only user id that
 * reaches a query.
 */
import * as walletService from '../services/walletService.js';
import { createCheckoutSession } from '../services/stripeService.js';

export async function getWallet(req, res, next) {
  try {
    res.json({ wallet: await walletService.getWalletSummary(req.user.id) });
  } catch (error) {
    next(error);
  }
}

export async function listTransactions(req, res, next) {
  try {
    const { format, limit, offset } = req.query;

    if (format === 'csv') {
      /**
       * The whole ledger the schema's ceiling allows, not the page the table
       * happens to be showing. An export that silently contains the first fifty
       * rows is worse than no export: it looks complete.
       */
      const { transactions } = await walletService.getTransactions(req.user.id, {
        limit: 200,
        offset: 0,
      });

      res.type('text/csv; charset=utf-8');
      // Without this the browser renders the CSV as text in a tab. The date is
      // in the name because a ledger export is a snapshot of a moving thing.
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="quorum-transactions-${new Date().toISOString().slice(0, 10)}.csv"`,
      );

      return res.send(walletService.transactionsToCsv(transactions));
    }

    res.json(await walletService.getTransactions(req.user.id, { limit, offset }));
  } catch (error) {
    next(error);
  }
}

/**
 * Creates the Checkout session and hands back its URL. Nothing is credited
 * here and nothing may be: the balance moves only when Stripe tells the server
 * the payment completed, over a signed webhook. A user who reaches the
 * success_url without paying — by editing the address bar, or by closing the
 * tab at the right moment — gets a page that says a top-up is on its way and a
 * balance that has not moved.
 */
export async function startCheckout(req, res, next) {
  try {
    const session = await createCheckoutSession({
      userId: req.user.id,
      email: req.user.email,
      amount: req.body.amount,
    });

    res.status(201).json({ checkout: session });
  } catch (error) {
    next(error);
  }
}
