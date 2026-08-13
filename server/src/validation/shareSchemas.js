/**
 * Zod for the one unauthenticated data route in the product.
 *
 * `GET /api/share/:token` was the only route reaching a service without passing
 * through `validate()` — the project's own convention is that everything
 * checkable from the request alone is checked at the edge, and this was the
 * exception nobody noticed because the token is used as a parameterised query
 * argument and was therefore never an injection risk.
 *
 * WHAT THIS DOES AND DOES NOT PROTECT.
 *
 * It is NOT the defence against guessing a token — that is the token's 192 bits,
 * and no amount of shape-checking changes a search of that size. What it stops
 * is an arbitrary string reaching Postgres from an unauthenticated caller: a URL
 * path can carry kilobytes, and there is no reason for any of them to become a
 * query parameter on the one endpoint anybody on the internet may call.
 *
 * A MALFORMED TOKEN IS A 400 AND AN UNKNOWN ONE IS STILL A 404, and that
 * distinction is deliberately safe. The invariant in CLAUDE.md is that an
 * unknown token and a REVOKED one are indistinguishable — because telling the
 * holder of a leaked link that the string was once real is the thing revoking
 * exists to prevent. The token's FORMAT is not a secret: it is visible in every
 * share URL ever sent. So a 400 for "that is not a token" leaks nothing, while
 * every well-formed guess — live, revoked or never issued — still gets the same
 * 404.
 */
import { z } from 'zod';

/**
 * 24 random bytes, base64url. `randomBytes(24).toString('base64url')` is exactly
 * 32 characters from the URL-safe alphabet with no padding, so the length is
 * fixed rather than a range — see shareService, which is the only thing that
 * mints these.
 */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export const shareTokenParamSchema = z.object({
  token: z
    .string()
    .regex(SHARE_TOKEN_PATTERN, 'is not a valid share token'),
});
