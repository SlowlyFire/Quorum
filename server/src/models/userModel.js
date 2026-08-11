/**
 * users table — accounts and wallet balance.
 *
 * password_hash is never in the default projection. Exactly one function
 * returns it, and only login should call that one.
 *
 * Rows are returned as Postgres produces them (snake_case). Shaping for the
 * wire is the service layer's job.
 */
import { query } from '../db/pool.js';

const PUBLIC_COLUMNS = `
  id,
  email,
  google_id,
  display_name,
  role,
  credit_balance,
  created_at
`;

/**
 * Every user function takes the query executor last, defaulting to the pool
 * helper. Passing a transaction client's query instead is what lets a debate
 * round debit the wallet and write its ledger row atomically.
 */

export async function insertUser({ email, passwordHash = null, googleId = null, displayName = null }, exec = query) {
  const { rows } = await exec(
    `
      INSERT INTO users (email, password_hash, google_id, display_name)
      VALUES ($1, $2, $3, $4)
      RETURNING ${PUBLIC_COLUMNS}
    `,
    [email, passwordHash, googleId, displayName],
  );

  return rows[0];
}

export async function findUserById(id, exec = query) {
  const { rows } = await exec(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`,
    [id],
  );

  return rows[0] ?? null;
}

export async function findUserByEmail(email, exec = query) {
  const { rows } = await exec(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE email = $1`,
    [email],
  );

  return rows[0] ?? null;
}

export async function findUserByGoogleId(googleId, exec = query) {
  const { rows } = await exec(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE google_id = $1`,
    [googleId],
  );

  return rows[0] ?? null;
}

/**
 * The one projection that includes password_hash. For password login only —
 * everything else must use findUserByEmail.
 */
export async function findUserCredentialsByEmail(email, exec = query) {
  const { rows } = await exec(
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE email = $1`,
    [email],
  );

  return rows[0] ?? null;
}

/**
 * Links a Google identity to an account that already exists under the same
 * email, so signing in with Google does not create a duplicate account.
 */
export async function attachGoogleId(id, googleId, exec = query) {
  const { rows } = await exec(
    `
      UPDATE users
      SET google_id = $2
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}
    `,
    [id, googleId],
  );

  return rows[0] ?? null;
}

/**
 * Takes the row's write lock and returns the balance under it.
 *
 * FOR UPDATE is what serialises two rounds settling at the same moment. The
 * arithmetic in adjustCreditBalance below is already atomic on its own — the
 * database adds the delta, so neither debit can be lost — but `balance_after`
 * is not: without the lock, two concurrent debits can both land correctly on
 * `credit_balance` and both write the *same* `balance_after`, leaving a ledger
 * whose running total goes sideways. Locking first makes the pair one step.
 *
 * Only ever called inside withTransaction. A lock taken on the pool's own
 * executor is released by the implicit commit of the statement that took it,
 * which is to say immediately, which is to say it is not a lock.
 */
export async function lockUserForUpdate(id, exec) {
  const { rows } = await exec(`SELECT id, credit_balance FROM users WHERE id = $1 FOR UPDATE`, [id]);

  return rows[0] ?? null;
}

/**
 * Moves the wallet by a signed delta and returns the resulting balance, which
 * the caller writes to credit_transactions.balance_after.
 *
 * The arithmetic happens in the database so two concurrent rounds cannot both
 * read the same starting balance and lose one of the debits.
 */
export async function adjustCreditBalance(id, delta, exec = query) {
  const { rows } = await exec(
    `
      UPDATE users
      SET credit_balance = credit_balance + $2
      WHERE id = $1
      RETURNING credit_balance
    `,
    [id, delta],
  );

  return rows[0]?.credit_balance ?? null;
}
