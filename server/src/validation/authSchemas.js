/**
 * Zod schemas for the auth endpoints. Validation happens at the edge, in
 * middleware, before any service or bcrypt call runs.
 *
 * Every schema normalises as well as checks: the value the service receives is
 * the trimmed, lower-cased one, so `  Ada@Example.COM ` and `ada@example.com`
 * can never become two accounts.
 */
import { z } from 'zod';

/**
 * trim/lowercase are piped *before* the format check rather than chained after
 * it, so " ADA@EXAMPLE.COM " validates instead of being rejected for its
 * spaces. 254 is the RFC 5321 ceiling on a whole address.
 */
const email = z
  .string({ error: 'is required' })
  .trim()
  .toLowerCase()
  .pipe(z.email('must be a valid email address'))
  .pipe(z.string().max(254, 'must be at most 254 characters'));

/**
 * Length only, no composition rules. A 12-character passphrase beats an
 * 8-character one with a digit and a symbol bolted on, and character-class
 * rules mostly teach people to write Password1!.
 *
 * The 200 ceiling is a denial-of-service guard, not a security property —
 * bcrypt hashes the whole input at cost 10 whatever its length.
 */
const password = z
  .string({ error: 'is required' })
  .min(8, 'must be at least 8 characters')
  .max(200, 'must be at most 200 characters');

const displayName = z
  .string({ error: 'is required' })
  .trim()
  .min(1, 'must not be empty')
  .max(60, 'must be at most 60 characters');

export const registerSchema = z
  .object({ email, password, displayName })
  .strict('is not a recognised field');

/**
 * Login deliberately does NOT reuse the 8-character minimum. A short password
 * must fail the same way a wrong one does — 401 INVALID_CREDENTIALS — or the
 * 400 tells an attacker something about the input space that a 401 would not.
 */
export const loginSchema = z
  .object({
    email,
    password: z.string({ error: 'is required' }).min(1, 'must not be empty').max(200),
  })
  .strict('is not a recognised field');
