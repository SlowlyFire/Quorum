/**
 * Authentication: is there a real, current user behind this request?
 *
 * Reads the httpOnly cookie, verifies the signature, then loads the user from
 * the database and hangs it on req.user. Authorization decisions read that,
 * never the token.
 */
import { getAuthenticatedUser } from '../services/authService.js';
import { TOKEN_COOKIE_NAME, verify } from '../services/tokenService.js';
import { httpError } from '../lib/httpError.js';

export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[TOKEN_COOKIE_NAME];

    /**
     * NO CREDENTIAL ARRIVED — which is a different fact from one that arrived
     * and was rejected, and the client needs to tell them apart to say anything
     * true about why.
     *
     * The common cause in production is not a signed-out visitor: it is a
     * browser refusing to SEND the cookie. The app and the API are on separate
     * registrable domains, so the session cookie is third-party, and WebKit
     * blocks those outright — see docs/decisions.md 77. "Your session expired"
     * is the wrong sentence for that, and "sign in again" is the wrong remedy,
     * because the new cookie is refused exactly as the last one was.
     */
    if (!token) {
      throw httpError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    const payload = verify(token);

    /**
     * The role in the payload is whatever was true when the token was minted,
     * and a token lives seven days. Promote a user to admin and their old token
     * still claims 'user'; demote one and their old token still claims 'admin'.
     * The second case is the dangerous one, so the row wins — always. The claim
     * is carried only so a future revocation check has something to compare.
     */
    req.user = await getAuthenticatedUser(payload.userId);

    next();
  } catch (error) {
    next(error);
  }
}
