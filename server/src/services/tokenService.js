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
 * WHETHER THE COOKIE IS CROSS-SITE IS A DEPLOYMENT FACT, WHICH IS WHY THESE
 * THREE ATTRIBUTES ARE COMPUTED IN ONE PLACE RATHER THAN WRITTEN DOWN.
 *
 * `COOKIE_DOMAIN` IS THE SWITCH. Set, it says the client and this API share a
 * registrable domain — `app.` and `api.` of one apex — and the cookie is
 * first-party. Unset, the two are on different sites, as Vercel and Railway
 * were, and it is third-party.
 *
 * WHY SameSite MOVES WITH IT, RATHER THAN BEING ITS OWN VARIABLE. A
 * `SameSite=Lax` cookie is simply not attached to a cross-site XHR or fetch —
 * the request goes out anonymous, `GET /api/auth/me` answers 401, and the app
 * looks like it signed the user straight back out. `None` is the only value a
 * browser sends in that position. So `lax` is correct exactly when the client
 * is same-site, which is exactly what setting a shared cookie domain asserts.
 * Two independent flags would have a fourth combination — a domain set and
 * `None` kept, or worse `Lax` with no shared domain — and one of those signs
 * every user out with nothing in the logs.
 *
 * `None` REQUIRES `Secure`, and a browser silently rejects the pair without it,
 * so the cookie is never stored at all — indistinguishable from the case above.
 * The expression below cannot produce `none` outside production, so `None`
 * without `Secure` is unreachable rather than merely avoided.
 *
 * Development keeps `Lax` deliberately. localhost is plain http, so `Secure`
 * would mean no cookie at all; and `Lax` is what still sends the cookie on a
 * top-level GET navigation, which the deferred Google OAuth callback will need
 * when it lands ('strict' would drop it).
 *
 * WHAT THE DOMAIN DOES NOT DO: it is not what makes WebKit accept the cookie.
 * Decision 77's fix is the shared registrable domain itself — once the client
 * is `app.` and the API `api.` of one apex, ITP does not apply whatever the
 * `Domain` attribute says, and a host-only cookie on the API's own hostname
 * works and is narrower. Setting `Domain` widens the cookie to every present
 * and future subdomain of the apex; it buys sharing, not the fix.
 *
 * maxAge matches the token's own expiry, so the cookie and the claim inside it
 * die together instead of the browser holding a token the server rejects.
 */
const SITE_ATTRIBUTES = Object.freeze({
  sameSite: env.COOKIE_DOMAIN || !isProduction ? 'lax' : 'none',
  secure: isProduction,
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});

export const cookieOptions = Object.freeze({
  httpOnly: true,
  ...SITE_ATTRIBUTES,
  maxAge: EXPIRY_SECONDS * 1000,
  path: '/',
});

/**
 * A browser only replaces a cookie when name, path, domain and the security
 * attributes all match, so logout has to clear it with the same options it was
 * set with — minus maxAge, which res.clearCookie supplies itself. Spreading the
 * same SITE_ATTRIBUTES object is what makes that true by construction: setting
 * and clearing cannot disagree, which they would the first time somebody edited
 * one literal and not the other, and the symptom would be a logout that appears
 * to work until the next page load.
 */
export const clearCookieOptions = Object.freeze({
  httpOnly: true,
  ...SITE_ATTRIBUTES,
  path: '/',
});

/**
 * THE COOKIE THIS SERVER USED TO SET, WHICH THE BROWSER STILL HAS AND WILL
 * STILL SEND. NULL UNLESS A COOKIE DOMAIN IS CONFIGURED.
 *
 * `Domain` is part of a cookie's identity, so the day COOKIE_DOMAIN is switched
 * on, the domain-scoped cookie this server now sets does NOT replace the
 * host-only one it set yesterday. A browser that has both sends both, under one
 * name:
 *
 *     Cookie: quorum_token=<stale host-only>; quorum_token=<fresh domain>
 *
 * and `cookie-parser` keeps the first. RFC 6265 §5.4 orders equal-path cookies
 * by creation time, so the first is the older one — the stale token wins, for
 * up to seven days, and logging out does not help because `clearCookieOptions`
 * carries the domain and therefore matches only the fresh one. The user sees a
 * session they cannot end and an account they cannot switch away from.
 *
 * So every response that issues a session also deletes the host-only variant,
 * and so does logout. Deleting a cookie that was never there is a no-op, which
 * is what makes this safe to leave in place permanently rather than something
 * to remember to remove after the migration.
 *
 * Null rather than an always-on object: with no COOKIE_DOMAIN this IS the
 * cookie being set, and clearing it in the same response would delete the
 * session that response just issued.
 */
export const hostOnlyClearCookieOptions = env.COOKIE_DOMAIN
  ? Object.freeze({
      httpOnly: true,
      sameSite: SITE_ATTRIBUTES.sameSite,
      secure: SITE_ATTRIBUTES.secure,
      path: '/',
    })
  : null;

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
