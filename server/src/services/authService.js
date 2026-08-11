/**
 * Registration and password login.
 *
 * Nothing here logs. An email address next to a failure reason is a record of
 * who tried to sign in and failed, sitting in a log file that is not held to
 * the standard the users table is — so the failure paths throw and say nothing.
 */
import { compare, hash, hashSync } from 'bcryptjs';

import { httpError } from '../lib/httpError.js';
import { findUserById, findUserCredentialsByEmail, insertUser } from '../models/userModel.js';

/**
 * Cost 10 is roughly 60-80ms per hash on this hardware. High enough to make
 * offline cracking expensive, low enough that a login is not a DoS lever.
 *
 * bcrypt hashes the first 72 bytes of the password and silently ignores the
 * rest, so the schema's 200-character ceiling is a request-size limit rather
 * than 200 characters of real strength. Known and accepted; see the build log.
 */
const BCRYPT_COST = 10;

const UNIQUE_VIOLATION = '23505';

/**
 * Login must take the same time whether the email exists or not, or the
 * response time itself becomes an account-enumeration oracle. When there is no
 * user to compare against we compare against this instead — a real hash at the
 * real cost, of a value no one can supply. Generated at import rather than
 * hard-coded so it always tracks BCRYPT_COST.
 */
const ABSENT_USER_HASH = hashSync('no user with this email address exists', BCRYPT_COST);

/**
 * The wire shape of a user. Models return rows as Postgres produces them; this
 * is the one place they become camelCase, and the one place that decides what
 * a client is allowed to see — google_id and password_hash are not on the list.
 *
 * credit_balance is numeric(12,6), which the pg driver returns as a string to
 * avoid float surprises. Six decimal places fit a double exactly, so the API
 * hands out a number and the client is spared parsing it.
 */
function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    creditBalance: Number(row.credit_balance),
    createdAt: row.created_at,
  };
}

export async function register({ email, password, displayName }) {
  const passwordHash = await hash(password, BCRYPT_COST);

  try {
    // Uniqueness is the database's UNIQUE constraint, not a SELECT first. A
    // check-then-insert loses the race between two simultaneous sign-ups; the
    // constraint cannot.
    return toPublicUser(await insertUser({ email, passwordHash, displayName }));
  } catch (cause) {
    if (cause.code !== UNIQUE_VIOLATION) throw cause;

    // Deliberately no `cause`: the driver's error carries
    // "Key (email)=(...) already exists" in its detail, and in development
    // errorHandler prints the whole error object.
    throw httpError(409, 'CONFLICT', 'An account with that email already exists');
  }
}

/**
 * One failure, one message, one timing. Whether the email is unknown, the
 * account is Google-only, or the password is simply wrong, the caller gets a
 * byte-identical 401 after a comparison of the same cost — so a response tells
 * an attacker nothing about which half was right.
 */
export async function login({ email, password }) {
  const record = await findUserCredentialsByEmail(email);
  const passwordHash = record?.password_hash ?? null;

  const matches = await compare(password, passwordHash ?? ABSENT_USER_HASH);

  if (!record || !passwordHash || !matches) {
    throw httpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  return toPublicUser(record);
}

/**
 * Resolves the user a verified token points at. Used by requireAuth on every
 * protected request, which is why authorization reads the database instead of
 * trusting the token's own role claim: a token lives seven days, and a role or
 * a deleted account can change inside that window.
 */
export async function getAuthenticatedUser(userId) {
  const row = await findUserById(userId);

  if (!row) {
    // Signature valid, subject gone. The token is genuine and worthless.
    throw httpError(401, 'UNAUTHENTICATED', 'Session is invalid or has expired');
  }

  return toPublicUser(row);
}
