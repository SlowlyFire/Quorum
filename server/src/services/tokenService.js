/**
 * Minting and reading the session JWT, plus the cookie it travels in.
 *
 * The token is a bearer credential the browser never sees: httpOnly keeps it
 * out of document.cookie, so an XSS bug on the client cannot read it.
 */
import jwt from 'jsonwebtoken';

import { env, isProduction } from '../config/env.js';
import { httpError } from '../lib/httpError.js';

/**
 * Pinned on both sides. Verifying without an explicit algorithms list lets a
 * forged header choose the algorithm — the classic alg-confusion downgrade.
 */
const ALGORITHM = 'HS256';

const EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export const TOKEN_COOKIE_NAME = 'quorum_token';

/**
 * sameSite 'lax' still sends the cookie on a top-level GET navigation, which
 * the Google OAuth callback will need when it lands; 'strict' would drop it.
 * secure is off in development because localhost is plain http.
 * maxAge matches the token's own expiry, so the cookie and the claim inside it
 * die together instead of the browser holding a token the server rejects.
 */
export const cookieOptions = Object.freeze({
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
  maxAge: EXPIRY_SECONDS * 1000,
  path: '/',
});

/**
 * A browser only replaces a cookie when name, path, domain and the security
 * attributes all match, so logout has to clear it with the same options it was
 * set with — minus maxAge, which res.clearCookie supplies itself.
 */
export const clearCookieOptions = Object.freeze({
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
  path: '/',
});

export function sign({ userId, role }) {
  return jwt.sign({ userId, role }, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: EXPIRY_SECONDS,
  });
}

/**
 * Every failure mode — bad signature, wrong algorithm, expired, malformed,
 * truncated — comes back as the same 401. The client has one thing to do about
 * any of them, which is sign in again.
 */
export function verify(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: [ALGORITHM] });
  } catch (cause) {
    throw httpError(401, 'UNAUTHENTICATED', 'Session is invalid or has expired', { cause });
  }
}
