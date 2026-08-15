/**
 * Thin by policy: read the request, call one service, send the response.
 * No SQL, no bcrypt, no error construction.
 *
 * Bodies are already validated and normalised — validate() ran in front of
 * every route that has a body.
 */
import * as authService from '../services/authService.js';
import {
  TOKEN_COOKIE_NAME,
  clearCookieOptions,
  cookieOptions,
  hostOnlyClearCookieOptions,
  sign,
} from '../services/tokenService.js';

/**
 * Clearing before setting, not after: both go out as Set-Cookie headers on one
 * response and the browser applies them in order, so the reverse would delete
 * the session just issued if the two ever came to have the same identity. See
 * tokenService for why the host-only variant has to be swept at all — in short,
 * `Domain` is part of a cookie's identity, so switching COOKIE_DOMAIN on leaves
 * the old cookie in place, sent alongside the new one and parsed in preference
 * to it. A no-op when no cookie domain is configured.
 */
function issueSession(res, user) {
  if (hostOnlyClearCookieOptions) {
    res.clearCookie(TOKEN_COOKIE_NAME, hostOnlyClearCookieOptions);
  }
  res.cookie(TOKEN_COOKIE_NAME, sign({ userId: user.id, role: user.role }), cookieOptions);
}

export async function register(req, res, next) {
  try {
    const user = await authService.register(req.body);

    issueSession(res, user);
    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
}

export async function login(req, res, next) {
  try {
    const user = await authService.login(req.body);

    issueSession(res, user);
    res.json({ user });
  } catch (error) {
    next(error);
  }
}

/**
 * Always 204, with no read of the incoming cookie. Logging out is not an
 * operation that can fail, and telling a caller whether they had been signed in
 * is a fact worth nothing to them and something to an attacker.
 */
export function logout(req, res) {
  res.clearCookie(TOKEN_COOKIE_NAME, clearCookieOptions);
  if (hostOnlyClearCookieOptions) {
    res.clearCookie(TOKEN_COOKIE_NAME, hostOnlyClearCookieOptions);
  }
  res.status(204).end();
}

/**
 * requireAuth already loaded the row this request is acting as, so there is
 * nothing left to do but hand it over.
 */
export function me(req, res) {
  res.json({ user: req.user });
}
