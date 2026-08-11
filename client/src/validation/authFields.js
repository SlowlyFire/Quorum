/**
 * The client's copy of server/src/validation/authSchemas.js.
 *
 * Duplicating a rule is a cost; the alternative is a round trip to learn that
 * a password is seven characters, which is worse. The rules below are written
 * to match the server's Zod schemas exactly — including the normalisation
 * order, where the email is trimmed and lower-cased BEFORE the format check,
 * so "  Ada@Example.COM " is valid on both sides rather than valid on one.
 *
 * The server still validates everything here. This is a courtesy, not a
 * control: it exists to answer faster, never to decide.
 */

/** RFC 5321's cap, same as the server's. */
const EMAIL_MAX = 254;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const DISPLAY_NAME_MAX = 60;

/**
 * Deliberately permissive, and deliberately not a "real" email regex — there
 * is no such thing, and the server's is Zod's. It catches the typo class
 * (no @, no dot, trailing comma) and lets the server be the authority.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(value) {
  return value.trim().toLowerCase();
}

export function validateEmail(value) {
  const email = normaliseEmail(value);

  if (email.length === 0) return 'Email is required';
  if (email.length > EMAIL_MAX) return `Email must be at most ${EMAIL_MAX} characters`;
  if (!EMAIL_SHAPE.test(email)) return 'Enter a valid email address';

  return null;
}

/** Registration's rule. */
export function validateNewPassword(value) {
  if (value.length === 0) return 'Password is required';
  if (value.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (value.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;

  return null;
}

/**
 * Login's rule is non-empty, NOT the 8-character minimum — matching the
 * server, and for the server's reason: a short password must come back as the
 * same 401 as any other wrong one. Telling the user here that it is too short
 * would say something about the stored password that the 401 does not.
 */
export function validateLoginPassword(value) {
  return value.length === 0 ? 'Password is required' : null;
}

export function validateDisplayName(value) {
  const name = value.trim();

  if (name.length === 0) return 'Display name is required';
  if (name.length > DISPLAY_NAME_MAX) {
    return `Display name must be at most ${DISPLAY_NAME_MAX} characters`;
  }

  return null;
}
