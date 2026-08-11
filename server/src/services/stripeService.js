/**
 * Stripe, in test mode. §9: the integration is production-shaped — hosted
 * Checkout plus a signed webhook — and only the credentials are test
 * credentials.
 *
 * HOSTED CHECKOUT AND A REDIRECT, NOT A CARD FORM. We never see a card number,
 * which keeps the product out of PCI scope entirely, and it means no Stripe
 * library in the client: the server creates a session, the client sets
 * `location.href` to the URL it gets back, and Stripe brings the user home to
 * /wallet. One dependency, on the side that has the secret key.
 *
 * THE AMOUNT IS NEVER THE CLIENT'S. TOPUP_AMOUNTS below is the allow-list, and
 * a request naming anything else is a 400 — the amount is what we charge and
 * what we credit, so a client that could name it could name $0.01 for $50 of
 * credits. The value that reaches Stripe is the one from this array, not the
 * one from the body, even after validation has confirmed they match.
 *
 * WHAT THE WEBHOOK IS FOR. The success_url is a redirect a user can fabricate,
 * skip, or simply close the tab before reaching. The webhook is Stripe telling
 * the server directly, signed, and it is the only thing that credits a balance.
 */
import Stripe from 'stripe';

import { TOPUP_AMOUNTS } from '../config/billing.js';
import { env } from '../config/env.js';
import { httpError } from '../lib/httpError.js';

/** The one event we act on. */
export const CHECKOUT_COMPLETED = 'checkout.session.completed';

/**
 * Built once, lazily, and only if the key is set — the two Stripe keys are
 * optional outside production (see config/env.js), so a fresh clone boots and
 * every part of the product except topping up works. Constructing the client at
 * import would turn "no Stripe key" into "the API will not start".
 */
let client = null;

function stripe() {
  if (!env.STRIPE_SECRET_KEY) {
    throw httpError(
      503,
      'STRIPE_NOT_CONFIGURED',
      'Top-ups are unavailable: this deployment has no Stripe credentials.',
    );
  }

  // eslint-disable-next-line no-return-assign
  return (client ??= new Stripe(env.STRIPE_SECRET_KEY));
}

export function isConfigured() {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

/**
 * A Checkout session for one of the three amounts, and the URL to send the
 * browser to.
 *
 * `metadata` carries the two things the webhook cannot work out for itself: who
 * this is for, and how many credits it buys. It is set on the PaymentIntent as
 * well as the session, because a refund or a dispute in the dashboard shows the
 * intent, and an entry there with no user on it is unresolvable by hand.
 *
 * `client_reference_id` is the user id again, in the field Stripe's own UI
 * indexes and searches on.
 */
export async function createCheckoutSession({ userId, email, amount }) {
  if (!TOPUP_AMOUNTS.includes(amount)) {
    // Unreachable through the route — Zod checks the same list — and kept
    // because this function is what actually names a price to Stripe, and a
    // second caller must not be able to name a different one.
    throw httpError(400, 'INVALID_TOPUP_AMOUNT', `Top-ups are $${TOPUP_AMOUNTS.join(', $')} only.`);
  }

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    // Prefilled but editable: the receipt should reach the account's owner,
    // and Stripe is entitled to be told who is paying.
    customer_email: email,
    client_reference_id: userId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          // Cents. Stripe's smallest-unit convention, and the one place in the
          // product where money is an integer rather than a numeric.
          unit_amount: amount * 100,
          product_data: {
            name: `Quorum credits — $${amount}`,
            description: 'Wallet credit for AI model debates. Test mode.',
          },
        },
      },
    ],
    metadata: { userId, credits: String(amount) },
    payment_intent_data: { metadata: { userId, credits: String(amount) } },
    /** Back to the wallet either way; the query parameter is what the page
     *  renders a banner from. Stripe substitutes the session id itself. */
    success_url: `${env.CLIENT_URL}/wallet?topup=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.CLIENT_URL}/wallet?topup=cancelled`,
  });

  return { id: session.id, url: session.url, amount };
}

/**
 * Verifies a webhook's signature and returns the event.
 *
 * `payload` MUST be the raw request body as bytes. Stripe signs what it sent,
 * so a body that has been through `express.json()` — parsed and re-serialised,
 * with its key order and whitespace no longer guaranteed — fails verification
 * every time, and the failure looks like a bad secret rather than like a
 * mangled body. That is why app.js mounts `express.raw` on this one path,
 * BEFORE the JSON parser, and why the route is outside the /api router.
 *
 * An unverifiable event is a 400 and nothing else: it is either not from
 * Stripe, or it is from Stripe and something has rewritten it in flight.
 */
export function constructEvent(payload, signature) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw httpError(
      503,
      'STRIPE_NOT_CONFIGURED',
      'This deployment has no Stripe webhook secret, so webhook events cannot be verified.',
    );
  }

  try {
    return stripe().webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (cause) {
    // Deliberately no `cause`: Stripe's message quotes the signature header it
    // was given, and in development errorHandler prints the whole error object.
    throw httpError(
      400,
      'STRIPE_SIGNATURE_INVALID',
      'This request could not be verified as coming from Stripe.',
    );
  }
}

/**
 * The two things a completed checkout tells us, pulled out of the shapes Stripe
 * uses so nothing downstream has to know them.
 *
 * `payment_intent` is the idempotency key rather than the session id, because
 * it is the identity of the *payment* — the thing that must be credited once —
 * and it is what a refund or a dispute in the dashboard refers back to. It
 * arrives as a string on a normal session and as an expanded object when
 * something asked for one, so both are handled; the session id is the fallback
 * for a zero-amount session that has no intent at all.
 */
export function readCheckoutSession(session) {
  const intent = session.payment_intent;

  return {
    userId: session.metadata?.userId ?? session.client_reference_id ?? null,
    credits: Number(session.metadata?.credits ?? 0),
    /** What Stripe actually collected, in cents, as a cross-check. */
    amountTotal: session.amount_total,
    paymentStatus: session.payment_status,
    paymentId: (typeof intent === 'string' ? intent : intent?.id) ?? session.id,
  };
}
