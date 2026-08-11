/**
 * The wallet: what a user has, what they spent, and the ledger that explains
 * the difference.
 *
 * TWO TABLES, TWO JOBS. `users.credit_balance` is the balance, and it is the
 * only thing any check reads — recomputing it from the ledger on every round
 * start would be a growing aggregate on the hot path. `credit_transactions` is
 * the history, and `balance_after` on each row is what makes it auditable:
 * SUM(amount) must equal the balance, and the last row's `balance_after` must
 * too. Neither invariant survives a write that touches one table and not the
 * other, so every write here is inside withTransaction with the user row locked
 * FOR UPDATE. `scripts/verify-wallet.js` asserts both.
 *
 * WHAT IS DEBITED IS WHAT WE PAID, NOT WHAT WE QUOTED. `usage.cost` off each
 * OpenRouter response body is the real figure (decision 16); the pre-flight
 * estimate in costEstimateService decides only whether a round may start. So a
 * balance may end a round marginally negative when the round overshot its
 * estimate, and §3 explicitly allows that rather than building a
 * reserve-and-refund system for fractions of a cent — the next round is simply
 * blocked. Display clamps at zero; the stored number does not.
 */
import {
  FREE_ROUNDS_PER_DAY,
  MINIMUM_THRESHOLD,
  SPEND_CHART_DAYS,
  THRESHOLD_MULTIPLE,
  TOPUP_AMOUNTS,
} from '../config/billing.js';
import { withTransaction } from '../db/pool.js';
import {
  countCreditTransactionsByUser,
  findCreditTransactionByStripePaymentId,
  findLatestTopup,
  insertCreditTransaction,
  listCreditTransactionsByUser,
  sumCreditTransactions,
  sumDebitsByDay,
} from '../models/creditTransactionModel.js';
import { listActiveModels } from '../models/llmModel.js';
import {
  averageRoundCostForUser,
  countRoundsForUserToday,
} from '../models/roundModel.js';
import { adjustCreditBalance, findUserById, lockUserForUpdate } from '../models/userModel.js';
import { estimateRoundCost } from './costEstimateService.js';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** numeric arrives from pg as a string; everything above this line gets a number. */
function money(value) {
  return value === null || value === undefined ? null : Number(value);
}

export async function getBalance(userId) {
  const user = await findUserById(userId);

  return user ? Number(user.credit_balance) : 0;
}

/**
 * A balance may be marginally negative by design (see the header). Every
 * surface that *displays* one shows zero instead, because "-$0.0004" invites a
 * question about a debt that does not exist — the user owes nothing, they
 * simply cannot start another paid round. The real figure stays in the column
 * and in the ledger, where an audit needs it.
 */
export function displayBalance(balance) {
  return Math.max(0, Number(balance ?? 0));
}

/**
 * A pg `date` arrives as a JS Date at LOCAL midnight, and that is the trap.
 * `toISOString()` on it converts to UTC first, so on any machine east of
 * Greenwich a date of 2026-08-11 renders as "2026-08-10" — the chart silently
 * labels every bar a day early and its last column is yesterday. Reading the
 * local components back out is what keeps the day pg computed.
 *
 * The date pg computed is already a UTC one: sumDebitsByDay truncates
 * `now() AT TIME ZONE 'utc'`, because §3's day is a UTC day everywhere.
 */
function isoDay(value) {
  if (!(value instanceof Date)) return String(value).slice(0, 10);

  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');

  return `${value.getFullYear()}-${month}-${day}`;
}

export async function getSpendByDay(userId, days = SPEND_CHART_DAYS) {
  const rows = await sumDebitsByDay(userId, days);

  return rows.map((row) => ({ day: isoDay(row.day), spend: Number(row.spend) }));
}

/**
 * The wire shape of a ledger row, and the single place one becomes one — as
 * `toPublicUser` and `toPublicSession` are for theirs. The CSV export renders
 * the same object, so the table and the download cannot disagree about what a
 * row says.
 */
export function toPublicTransaction(row) {
  return {
    id: row.id,
    type: row.type,
    amount: money(row.amount),
    balanceAfter: money(row.balance_after),
    roundId: row.round_id,
    sessionId: row.session_id ?? null,
    sessionTitle: row.session_title ?? null,
    /**
     * Null for a top-up, which has no round — the mockup's em dash. The
     * LATERAL over an absent round returns 0 for the count rather than null
     * (count() of nothing is 0, not null), so the round is what decides here
     * and not the aggregate: "0 models" and "not a debate" are different
     * claims, and only one of them is true of a top-up.
     */
    tokens: row.round_id && row.total_tokens !== null ? Number(row.total_tokens) : null,
    modelCount: row.round_id && row.model_count ? Number(row.model_count) : null,
    createdAt: row.created_at,
  };
}

export async function getTransactions(userId, { limit = 50, offset = 0 } = {}) {
  const [rows, total] = await Promise.all([
    listCreditTransactionsByUser(userId, { limit, offset }),
    countCreditTransactionsByUser(userId),
  ]);

  return {
    transactions: rows.map(toPublicTransaction),
    pagination: { limit, offset, total },
  };
}

/** The ledger's own sum, for reconciliation. Not on any request path. */
export async function getLedgerTotal(userId) {
  return Number(await sumCreditTransactions(userId));
}

export async function getLatestTopup(userId) {
  const row = await findLatestTopup(userId);

  return row ? { amount: money(row.amount), createdAt: row.created_at } : null;
}

/**
 * What a round costs this user, for mockup 04's "~ 310 more debates at your
 * current council" and the "~400 debates" beside each top-up amount.
 *
 * Their own recent average first, because the question is about their council
 * and their questions — a user debating two cheap models gets a very different
 * number from one running four, and both are already recorded. A user who has
 * never run a round has nothing to average, so the fallback is a pre-flight
 * quote over the whole active catalogue with the cheapest model chairing, which
 * is exactly the council /new opens with.
 *
 * `source` travels with the figure so the page can label it honestly rather
 * than presenting a projection as a measurement.
 */
export async function getPerRoundCost(userId) {
  const measured = await averageRoundCostForUser(userId);

  if (measured && measured > 0) return { cost: measured, source: 'measured' };

  const models = (await listActiveModels()).map((row) => ({
    id: row.id,
    slug: row.openrouter_slug,
    displayName: row.display_name,
    inputPer1k: Number(row.input_per_1k),
    outputPer1k: Number(row.output_per_1k),
  }));

  if (models.length < 3) return { cost: 0, source: 'unknown' };

  const chairman = [...models].sort((a, b) => a.outputPer1k - b.outputPer1k)[0];

  return {
    cost: estimateRoundCost({
      chairman,
      drafters: models.filter((model) => model.id !== chairman.id),
      rebuttalEnabled: true,
    }),
    source: 'estimated',
  };
}

/**
 * Everything mockup 04's three top cards need, in one call.
 *
 * `mode` here answers "which side of §3's rule is this user on *right now*",
 * which is not quite the question canStartRound answers: that one is about a
 * specific council, and this one has none — the wallet page is not starting a
 * round. So the threshold used is the one for a typical round of theirs, and
 * the page says "2 debates per day" or shows a balance accordingly. The
 * authoritative decision is still made per round, at POST time.
 */
export async function getWalletSummary(userId) {
  const [balance, spendByDay, perRound, latestTopup, usedToday] = await Promise.all([
    getBalance(userId),
    getSpendByDay(userId),
    getPerRoundCost(userId),
    getLatestTopup(userId),
    countRoundsForUserToday(userId),
  ]);

  const threshold = Math.max(MINIMUM_THRESHOLD, perRound.cost * THRESHOLD_MULTIPLE);
  const mode = balance >= threshold ? 'paid' : 'free';

  return {
    balance,
    /** What every surface renders. See displayBalance for why they differ. */
    displayBalance: displayBalance(balance),
    mode,
    threshold,
    perRoundCost: perRound.cost,
    perRoundSource: perRound.source,
    /** Whole debates the balance covers, which is the figure under the bar. */
    roundsRemaining: perRound.cost > 0 ? Math.floor(displayBalance(balance) / perRound.cost) : null,
    freeRoundsPerDay: FREE_ROUNDS_PER_DAY,
    freeRemaining: Math.max(0, FREE_ROUNDS_PER_DAY - usedToday),
    spendByDay,
    spendTotal: Number(spendByDay.reduce((total, day) => total + day.spend, 0).toFixed(8)),
    latestTopup,
    /** The allow-list, so the page's three buttons are the server's three. */
    topupAmounts: TOPUP_AMOUNTS,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const CSV_COLUMNS = ['when', 'session', 'models', 'tokens', 'type', 'amount', 'balance_after'];

/**
 * One CSV field. Quoted always, and inner quotes doubled — RFC 4180's rule.
 *
 * Quoting everything rather than only the fields that need it is what makes a
 * session title safe without a per-field decision: a title is a user's own
 * question, so it may hold a comma, a newline, or a quotation mark.
 */
function csvField(value) {
  if (value === null || value === undefined) return '""';

  return `"${String(value).replaceAll('"', '""')}"`;
}

/**
 * The same, for a field whose content came from a user.
 *
 * A cell beginning `=`, `+`, `-` or `@` is a formula to Excel, Sheets and
 * Numbers — a downloaded ledger with `=HYPERLINK(...)` in the session column
 * executes when it is opened. The leading apostrophe is the standard defence.
 *
 * DELIBERATELY NOT APPLIED TO THE WHOLE ROW, which is the version that looks
 * safer and is worse: every debit amount begins with a minus, so guarding
 * numbers turns each one into the text `'-0.007757` and the spreadsheet the
 * export exists for can no longer add up its own column. Only the two fields a
 * user can write go through here.
 */
function csvUserField(value) {
  if (value === null || value === undefined) return '""';

  const text = String(value);

  return csvField(/^[=+\-@]/.test(text) ? `'${text}` : text);
}

/**
 * The mockup's "Export CSV". The same rows the table renders, through the same
 * `toPublicTransaction`, so the download and the screen cannot disagree.
 *
 * Amounts are written at six decimal places — `users.credit_balance`'s own
 * precision — rather than formatted as money, because the destination is a
 * spreadsheet and "$0.008" is a string there while 0.008000 is a number.
 */
export function transactionsToCsv(transactions) {
  const lines = [CSV_COLUMNS.join(',')];

  for (const row of transactions) {
    lines.push(
      [
        csvField(new Date(row.createdAt).toISOString()),
        csvUserField(row.sessionTitle ?? ''),
        csvField(row.modelCount ?? ''),
        csvField(row.tokens ?? ''),
        csvField(row.type),
        csvField(Number(row.amount).toFixed(6)),
        csvField(Number(row.balanceAfter).toFixed(6)),
      ].join(','),
    );
  }

  // Trailing newline: a file without one is a file some tools read as truncated.
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Bills a finished round. Called by the engine after the last stage, on the
 * success path AND on the failure path — see the note on failures below.
 *
 * `responses` is every row the round persisted, failures included. Summing them
 * here rather than taking the total the engine already computed is deliberate:
 * the ledger states what it charged for, and the array it charged from is the
 * same array `rounds.total_cost` was derived from, so the two agree by
 * construction rather than by both being maintained.
 *
 * WE BILL FAILURES. A provider that returns a 200 with an error finish reason,
 * or a chairman whose JSON will not parse, has still been paid for — callModel
 * attaches whatever the provider reported and debateService writes it onto the
 * error row. Not billing those would mean absorbing the cost of every round
 * that half-worked, and a user could make that the normal case.
 *
 * ONE ROW, NOT ONE PER CALL. See creditTransactionModel's header.
 *
 * Returns null when there is nothing to bill — a round refused before its first
 * call, or one whose every response came back with a null cost. A ledger row of
 * zero explains nothing and would put a meaningless entry in the user's export.
 */
export async function debitForRound(userId, roundId, responses = []) {
  const amount = Number(
    responses
      .reduce((total, response) => total + Number(response?.cost ?? 0), 0)
      // model_responses.cost is numeric(14,8); matching it here keeps the
      // ledger's arithmetic exactly the column's and not float's.
      .toFixed(8),
  );

  if (!Number.isFinite(amount) || amount <= 0) return null;

  return withTransaction(async (exec) => {
    // First, and before anything is read that will be written: this is what
    // makes two rounds settling at the same instant produce two correct
    // balance_after values instead of two identical ones.
    await lockUserForUpdate(userId, exec);

    const balanceAfter = await adjustCreditBalance(userId, -amount, exec);

    return insertCreditTransaction(
      {
        userId,
        roundId,
        type: 'debit',
        // Negative, so SUM(amount) is the balance and the export reads the way
        // the mockup renders it.
        amount: -amount,
        balanceAfter,
      },
      exec,
    );
  });
}

/**
 * Credits a completed Stripe payment. The webhook's only write.
 *
 * IDEMPOTENT, BECAUSE STRIPE RETRIES. Stripe redelivers an event until it gets
 * a 2xx, and a network blip between our commit and our response is enough to
 * earn a second delivery — so "insert a topup and add the credits" run twice is
 * money given away. The payment intent id is the key: it is looked up under the
 * same user-row lock the credit is applied under, so a redelivery that arrives
 * while the first is still committing waits for it and then sees its row.
 *
 * Migration 005's partial unique index on stripe_payment_id is the backstop for
 * the one case the lock cannot cover — two processes, no shared lock — where it
 * turns a double credit into a failed insert and a rolled-back transaction.
 *
 * Returns `{ credited: false }` for a replay, which the controller answers 200
 * to. A 4xx would make Stripe retry the thing it has already succeeded at.
 */
export async function creditTopup({ userId, amount, stripePaymentId }) {
  const credited = Number(amount);

  if (!Number.isFinite(credited) || credited <= 0) {
    throw new Error(`Refusing to credit a non-positive amount: ${amount}`);
  }

  return withTransaction(async (exec) => {
    await lockUserForUpdate(userId, exec);

    const existing = await findCreditTransactionByStripePaymentId(stripePaymentId, exec);

    if (existing) {
      return { credited: false, transaction: existing, balance: Number(existing.balance_after) };
    }

    const balanceAfter = await adjustCreditBalance(userId, credited, exec);

    const transaction = await insertCreditTransaction(
      { userId, type: 'topup', amount: credited, balanceAfter, stripePaymentId },
      exec,
    );

    return { credited: true, transaction, balance: Number(balanceAfter) };
  });
}
