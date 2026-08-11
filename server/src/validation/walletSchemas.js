/**
 * §8's four wallet endpoints, validated at the edge.
 *
 * The amount rule is the important one and it is deliberately an enum rather
 * than a range: the value decides both what Stripe charges and what we credit,
 * so "a positive number under 500" would let a client name $0.01 and be
 * credited $0.01 — harmless — or, one refactor later, name $0.01 and be
 * credited the $50 the button said. An allow-list cannot drift into either.
 * stripeService re-checks the same list before it names a price, because it is
 * the function that actually names one.
 */
import { z } from 'zod';

import { TOPUP_AMOUNTS } from '../config/billing.js';

export const checkoutSchema = z.object({
  amount: z
    .number({ error: 'must be one of the offered top-up amounts' })
    .refine((value) => TOPUP_AMOUNTS.includes(value), {
      error: `must be one of $${TOPUP_AMOUNTS.join(', $')}`,
    }),
});

/**
 * `format=csv` is a query parameter rather than a separate path because it is
 * the same resource in a different representation, and because the export has
 * to be reachable as a plain link — an anchor the browser downloads, with the
 * session cookie attached, and no fetch-then-blob dance.
 *
 * A CSV of 50 rows is not an export, so the limit's ceiling is higher here than
 * the 50 §8 caps a page at; `format=csv` ignores it entirely and takes the
 * maximum, since a spreadsheet that silently holds the first page of a ledger
 * is worse than no spreadsheet.
 */
export const listTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  format: z.enum(['json', 'csv']).default('json'),
});
