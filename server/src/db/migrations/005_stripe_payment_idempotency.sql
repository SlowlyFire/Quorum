-- Migration 005 — Stripe idempotency, Session 9.
--
-- credit_transactions.stripe_payment_id has existed since migration 001 and
-- nothing enforced anything about it, because nothing wrote it. The webhook
-- now does, and Stripe redelivers an event until it gets a 2xx — a retry that
-- credits a second time is money given away.
--
-- walletService.creditTopup already looks the id up under the user row's write
-- lock before it writes anything, which handles every retry that reaches the
-- same process. This index is the backstop for the one case a lock cannot
-- cover: two processes, no shared lock, both past the SELECT. There it turns a
-- double credit into a failed INSERT and a rolled-back transaction — Stripe
-- retries, the second attempt sees the committed row, and the balance is
-- right. A guarantee is worth having under a check that is merely correct.
--
-- PARTIAL, on IS NOT NULL. Every debit has a null here — it was not a payment —
-- and a plain UNIQUE index would treat those as distinct, which happens to be
-- true in Postgres but is true by accident rather than by intent. The WHERE
-- clause says what is actually meant: at most one row per real payment.

CREATE UNIQUE INDEX idx_credit_transactions_stripe_payment_id
  ON credit_transactions (stripe_payment_id)
  WHERE stripe_payment_id IS NOT NULL;
