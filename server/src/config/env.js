import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(currentDir, '../../.env'), quiet: true });

/**
 * A copied .env.example leaves keys present but empty. Treat empty as absent so
 * defaults apply and the "required" checks below actually fire.
 */
const blankToUndefined = (value) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalSecret = () => z.preprocess(blankToUndefined, z.string().min(1).optional());
const requiredSecret = () =>
  z.preprocess(blankToUndefined, z.string({ error: 'is required' }).min(1, 'must not be empty'));

/**
 * Secrets that no code path uses yet. They are optional in development so the
 * API boots on a fresh clone, and required in production so a real deployment
 * cannot start half-configured. Move a key to the always-required block below
 * in the session that starts using it.
 *
 * DATABASE_URL and JWT_SECRET left this list in Session 3, OPENROUTER_API_KEY
 * in Session 4 — the models layer, the auth stack and every debate call use
 * them, so an unset key is a crash at the first request that needs it rather
 * than an absent feature. Better to fail at boot.
 *
 * THE TWO STRIPE KEYS STAY HERE DELIBERATELY, even though Session 9 uses them.
 * Everything else in the product works without them: a user signs in, assembles
 * a council, debates, and is billed against a balance. Only topping that
 * balance up needs Stripe. Making them required in development would mean a
 * fresh clone cannot boot without someone's test credentials, to run a feature
 * they may not be working on — so the two endpoints that need them raise a 503
 * saying so instead (see stripeService), and production still cannot start
 * half-configured.
 */
const REQUIRED_IN_PRODUCTION = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

/** An HS256 key shorter than the 256-bit digest it signs weakens the MAC. */
const MIN_PRODUCTION_JWT_SECRET_LENGTH = 32;

const envSchema = z
  .object({
    NODE_ENV: z.preprocess(
      blankToUndefined,
      z.enum(['development', 'test', 'production']).default('development'),
    ),
    PORT: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(3000)),
    /**
     * NORMALISED HERE, ONCE, SO NO CONSUMER HAS TO REMEMBER TO.
     *
     * A trailing slash in this variable is the easiest deployment mistake to
     * make and one of the least legible to debug, because it breaks two
     * unrelated things in two unrelated ways:
     *
     *   * CORS. The value is echoed verbatim as `Access-Control-Allow-Origin`,
     *     and a browser compares it to the `Origin` header it sent — which
     *     never has a trailing slash. `https://app.example.com/` therefore
     *     matches nothing, and every credentialed request fails with a CORS
     *     error that names no cause.
     *   * Every URL built from it — share links, both Stripe redirects — grows
     *     a double slash. Harmless-looking, and then a router does not match.
     *
     * Stripped at parse time rather than at each use, because five call sites
     * each doing their own `.replace()` is five chances to add a sixth that
     * does not (decision 65).
     */
    CLIENT_URL: z.preprocess(
      blankToUndefined,
      z
        .string()
        .url()
        .default('http://localhost:5173')
        .transform((value) => value.replace(/\/+$/, '')),
    ),

    /**
     * EXTRA ORIGINS, COMMA-SEPARATED. FOR A MIGRATION, NOT FOR A SECOND CLIENT.
     *
     * CLIENT_URL names the ONE canonical client — it is what share links and
     * both Stripe redirects are built from, and it is always allowed whether or
     * not it appears here (see ALLOWED_ORIGINS below). This variable exists so
     * that a client moving from one hostname to another can have both answered
     * for the length of the move, which is the only way to verify the new one
     * without having already broken the old one.
     *
     * Empty is the steady state. A value left here after a migration is an
     * origin that may still make credentialed calls with a user's cookie, so
     * it is something to remove rather than something to leave lying around.
     */
    CORS_ORIGINS: z.preprocess(blankToUndefined, z.string().optional()),

    /**
     * THE COOKIE'S `Domain`, AND THE SWITCH THAT SAYS "CLIENT AND API NOW SHARE
     * AN APEX". UNSET IN DEVELOPMENT, AND UNSET IS THE SAFE VALUE.
     *
     * Setting it does two things at once, and the second is the one that
     * matters — see tokenService: the cookie gains a `Domain` attribute, and
     * SameSite drops from `none` back to `lax`. That pair is deliberate. `lax`
     * is only correct once every client that needs the cookie is same-site with
     * this API, and the operator declaring a shared cookie domain is exactly
     * the statement that they are. Flipping SameSite independently of the
     * domain would let a deployment sit in the one combination that silently
     * signs everybody out.
     *
     * A leading dot is optional and ignored by every browser (RFC 6265 §5.2.3
     * strips it); `.askthequorum.com` and `askthequorum.com` are the same
     * cookie, sent to the apex and to every subdomain of it.
     */
    COOKIE_DOMAIN: z.preprocess(blankToUndefined, z.string().optional()),

    DATABASE_URL: requiredSecret(),
    JWT_SECRET: requiredSecret(),
    OPENROUTER_API_KEY: requiredSecret(),

    SUPABASE_URL: optionalSecret(),
    SUPABASE_SERVICE_KEY: optionalSecret(),

    /** Test-mode credentials in every environment we have. §9: the integration
     *  is production-shaped — Checkout plus a webhook — and only the keys are
     *  test keys. */
    STRIPE_SECRET_KEY: optionalSecret(),
    STRIPE_WEBHOOK_SECRET: optionalSecret(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;

    for (const key of REQUIRED_IN_PRODUCTION) {
      if (value[key]) continue;
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'is required when NODE_ENV=production',
      });
    }

    if (value.JWT_SECRET.length < MIN_PRODUCTION_JWT_SECRET_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: `must be at least ${MIN_PRODUCTION_JWT_SECRET_LENGTH} characters when NODE_ENV=production`,
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(`Invalid environment configuration:\n${details}\n\nSee server/.env.example.`);
}

export const env = Object.freeze(parsed.data);

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';

/**
 * WHAT CORS COMPARES AGAINST, WHICH IS NOT THE SAME STRING AS CLIENT_URL.
 *
 * A browser's `Origin` header is scheme + host + port and nothing else — never a
 * path, never a trailing slash. `CLIENT_URL` is a base for building links and
 * may legitimately carry a path one day (`https://example.com/quorum`), so the
 * two must not be the same value: echoing a path back as
 * `Access-Control-Allow-Origin` matches no origin any browser will ever send.
 *
 * `URL.origin` is the exact normalisation the browser itself performs, so this
 * cannot drift from what is on the wire.
 */
function toOrigin(value, source) {
  const trimmed = String(value).trim().replace(/\/+$/, '');

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid environment configuration:\n  - ${source}: "${trimmed}" is not an absolute URL` +
        ` (expected a scheme and a host, e.g. https://app.example.com)\n\nSee server/.env.example.`,
    );
  }

  return parsed.origin;
}

export const CLIENT_ORIGIN = toOrigin(env.CLIENT_URL, 'CLIENT_URL');

/**
 * THE COMPLETE ALLOW-LIST, AND CLIENT_ORIGIN IS ALWAYS IN IT.
 *
 * That is the whole reason this is a union rather than a plain read of
 * CORS_ORIGINS. The canonical client is the one origin whose exclusion is
 * unrecoverable from outside the dashboard — every screen in the product stops
 * working at once and the failure is a browser-side CORS error that names no
 * cause — so it cannot be something an operator has to remember to repeat in a
 * second variable. Editing CORS_ORIGINS can add and remove transitional
 * origins; it cannot lock you out.
 *
 * Deduplicated because listing the canonical origin here as well is the obvious
 * thing to do and must not produce a doubled entry. Order is stable with
 * CLIENT_ORIGIN first, so the boot log reads as "canonical, then extras".
 *
 * Normalised through `URL.origin` per entry, so a trailing slash, a stray path
 * or an upper-case host in the variable becomes what a browser actually sends
 * rather than a member that can never match (decision 65's rule, applied to
 * every entry rather than only to the first).
 */
export const ALLOWED_ORIGINS = Object.freeze([
  ...new Set([
    CLIENT_ORIGIN,
    ...(env.CORS_ORIGINS ?? '')
      .split(',')
      .filter((entry) => entry.trim() !== '')
      .map((entry) => toOrigin(entry, 'CORS_ORIGINS')),
  ]),
]);
