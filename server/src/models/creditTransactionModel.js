/**
 * credit_transactions table — the wallet's ledger.
 *
 * ONE ROW PER ROUND, NEVER ONE PER CALL. A round makes up to 2N OpenRouter
 * calls and `model_responses` already holds every one of them with its own
 * cost, tokens, provider and latency. This table answers a different question —
 * how the balance got to where it is — and a financial ledger with eight rows
 * per debate cannot be read, cannot be exported usefully, and would make
 * `balance_after` meaningless on seven of the eight (decision 33).
 *
 * SIGN CONVENTION: `amount` is signed. A debit is negative, a top-up positive,
 * so SUM(amount) over a user's rows equals their balance and the CSV export
 * reads the way the mockup renders it (-$0.008, +$15.00). Nothing here enforces
 * that; walletService is the only writer and it is the one that gets it right.
 *
 * Rows are returned as Postgres produces them (snake_case). Shaping for the
 * wire is the service layer's job.
 */
import { query } from '../db/pool.js';

const COLUMNS = `
  id,
  user_id,
  round_id,
  type,
  amount,
  balance_after,
  stripe_payment_id,
  created_at
`;

/**
 * Every function takes the query executor last, defaulting to the pool helper.
 * A debit and its balance update must be one transaction — a crash between them
 * leaves a ledger that does not reconcile — so walletService passes a
 * transaction client's query here and to adjustCreditBalance alike.
 */

export async function insertCreditTransaction(
  { userId, roundId = null, type, amount, balanceAfter, stripePaymentId = null },
  exec = query,
) {
  const { rows } = await exec(
    `
      INSERT INTO credit_transactions (user_id, round_id, type, amount, balance_after, stripe_payment_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING ${COLUMNS}
    `,
    [userId, roundId, type, amount, balanceAfter, stripePaymentId],
  );

  return rows[0];
}

/**
 * The Stripe idempotency check. Stripe retries a webhook until it gets a 2xx,
 * and a retry that credits a second time is the classic way an integration
 * gives money away — so the payment intent id is looked up before anything is
 * written, inside the same transaction that holds the user row locked.
 *
 * Migration 005's partial unique index on this column is the backstop for the
 * case this SELECT cannot cover: two processes, no shared lock. Both are kept,
 * because one is a clear answer and the other is a guarantee.
 */
export async function findCreditTransactionByStripePaymentId(stripePaymentId, exec = query) {
  const { rows } = await exec(
    `SELECT ${COLUMNS} FROM credit_transactions WHERE stripe_payment_id = $1`,
    [stripePaymentId],
  );

  return rows[0] ?? null;
}

/**
 * The mockup's transaction table, which shows a session title, a model column
 * and a token count against each debit — none of which live in this table.
 *
 * They are joined rather than denormalised because they are already recorded
 * exactly once elsewhere and a ledger row that carried its own copy of a
 * session title would be wrong the moment the session was renamed. The LATERAL
 * aggregates model_responses for the round the debit paid for; it is null for a
 * top-up, which has no round, and the wire renders that as the mockup's em dash.
 */
export async function listCreditTransactionsByUser(userId, { limit = 50, offset = 0 } = {}, exec = query) {
  const { rows } = await exec(
    `
      SELECT ct.id,
             ct.user_id,
             ct.round_id,
             ct.type,
             ct.amount,
             ct.balance_after,
             ct.stripe_payment_id,
             ct.created_at,
             r.session_id,
             s.title           AS session_title,
             calls.total_tokens,
             calls.model_count
      FROM credit_transactions ct
      LEFT JOIN rounds r   ON r.id = ct.round_id
      LEFT JOIN sessions s ON s.id = r.session_id
      LEFT JOIN LATERAL (
        SELECT sum(coalesce(mr.prompt_tokens, 0) + coalesce(mr.completion_tokens, 0)) AS total_tokens,
               count(DISTINCT mr.model_id)                                            AS model_count
        FROM model_responses mr
        WHERE mr.round_id = ct.round_id
      ) calls ON true
      WHERE ct.user_id = $1
      ORDER BY ct.created_at DESC, ct.id DESC
      LIMIT $2 OFFSET $3
    `,
    [userId, limit, offset],
  );

  return rows;
}

export async function countCreditTransactionsByUser(userId, exec = query) {
  const { rows } = await exec(
    `SELECT count(*)::int AS count FROM credit_transactions WHERE user_id = $1`,
    [userId],
  );

  return rows[0].count;
}

/**
 * Spend per UTC day for the mockup's bar chart, zero-filled.
 *
 * generate_series produces the days rather than the client, because a day on
 * which nothing was spent has no rows to return and a chart with six bars where
 * seven were asked for is a chart that has silently relabelled its axis. The
 * LEFT JOIN is what turns "no rows" into "0".
 *
 * Debits are stored negative, so the chart's height is -sum(amount): a spend of
 * $0.008 reads as 0.008 on an axis that starts at zero.
 */
export async function sumDebitsByDay(userId, days, exec = query) {
  const { rows } = await exec(
    `
      SELECT day::date                                   AS day,
             coalesce(-sum(ct.amount), 0)::numeric(14,8) AS spend
      FROM generate_series(
             (now() AT TIME ZONE 'utc')::date - ($2::int - 1),
             (now() AT TIME ZONE 'utc')::date,
             interval '1 day'
           ) AS day
      LEFT JOIN credit_transactions ct
        ON ct.user_id = $1
       AND ct.amount < 0
       AND (ct.created_at AT TIME ZONE 'utc')::date = day::date
      GROUP BY day
      ORDER BY day
    `,
    [userId, days],
  );

  return rows;
}

/** The most recent top-up, for the mockup's "of $15.00 topped up on Aug 6". */
export async function findLatestTopup(userId, exec = query) {
  const { rows } = await exec(
    `
      SELECT ${COLUMNS}
      FROM credit_transactions
      WHERE user_id = $1 AND type = 'topup'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [userId],
  );

  return rows[0] ?? null;
}

/**
 * The reconciliation check: the ledger's own sum, which must equal
 * users.credit_balance. Nothing in the request path calls this — it is what
 * verify:wallet and a future admin panel assert against.
 */
export async function sumCreditTransactions(userId, exec = query) {
  const { rows } = await exec(
    `SELECT coalesce(sum(amount), 0)::numeric(14,8) AS total FROM credit_transactions WHERE user_id = $1`,
    [userId],
  );

  return rows[0].total;
}
