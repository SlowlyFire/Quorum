/**
 * POST /api/webhooks/stripe — the only thing that credits a balance.
 *
 * NOT BEHIND requireAuth, and it cannot be: the caller is Stripe, which has no
 * cookie and no account. The signature IS the authentication, and it is checked
 * before a single field of the body is read. An unsigned or wrongly signed
 * request is a 400 and nothing happens.
 *
 * `req.body` here is a Buffer, not an object, because app.js mounts
 * `express.raw` on this path and mounts it BEFORE `express.json()`. Stripe
 * signs the exact bytes it sent, so a body that has been parsed and
 * re-serialised fails verification every time — and fails looking like a bad
 * secret rather than like a mangled body, which is why this is the classic
 * Stripe integration bug and why it is written down in three places.
 *
 * ALWAYS ANSWER 2xx ONCE THE SIGNATURE CHECKS OUT. Stripe redelivers on any
 * non-2xx, so a 4xx for "I do not handle this event type" or for "I have
 * already credited this payment" would earn a retry of something that is not
 * going to change. Only a genuine failure to write should be a 500 — that one
 * we do want redelivered.
 */
import { CHECKOUT_COMPLETED, constructEvent, readCheckoutSession } from '../services/stripeService.js';
import { creditTopup } from '../services/walletService.js';

export async function handleStripeWebhook(req, res, next) {
  let event;

  try {
    event = constructEvent(req.body, req.get('stripe-signature'));
  } catch (error) {
    return next(error);
  }

  try {
    if (event.type !== CHECKOUT_COMPLETED) {
      // Acknowledged and ignored. Stripe sends whatever the endpoint is
      // subscribed to, and `stripe listen` forwards nearly everything.
      console.log(`[stripe] ${event.id} ${event.type} — not handled, acknowledged`);

      return res.json({ received: true, handled: false });
    }

    const checkout = readCheckoutSession(event.data.object);

    /**
     * A session can complete without being paid — Checkout's delayed payment
     * methods finish the session and settle later. Crediting on that would give
     * credits away for a payment that may still fail, so the only status that
     * moves a balance is `paid`.
     */
    if (checkout.paymentStatus !== 'paid') {
      console.log(
        `[stripe] ${event.id} checkout complete but payment_status=${checkout.paymentStatus} — not credited`,
      );

      return res.json({ received: true, handled: false });
    }

    if (!checkout.userId || !(checkout.credits > 0)) {
      // Metadata we set ourselves in createCheckoutSession. Missing means the
      // session came from somewhere else — the dashboard, an old deploy — and
      // there is no user to credit. Logged loudly, acknowledged, not retried.
      console.error(
        `[stripe] ${event.id} has no usable metadata (userId=${checkout.userId}, credits=${checkout.credits}) — not credited`,
      );

      return res.json({ received: true, handled: false });
    }

    const result = await creditTopup({
      userId: checkout.userId,
      amount: checkout.credits,
      stripePaymentId: checkout.paymentId,
    });

    if (result.credited) {
      console.log(
        `[stripe] ${event.id} credited $${checkout.credits.toFixed(2)} to ${checkout.userId} — ` +
          `balance now $${result.balance.toFixed(6)}`,
      );
    } else {
      // The retry path, and it is the normal one rather than an error: Stripe
      // redelivers until it gets a 2xx, and a blip after our commit is enough.
      console.log(`[stripe] ${event.id} payment ${checkout.paymentId} already credited — ignored`);
    }

    res.json({ received: true, handled: true, credited: result.credited });
  } catch (error) {
    // A genuine write failure. This one SHOULD be a 500 and SHOULD be
    // redelivered — the payment is real and the credit has not landed.
    console.error(`[stripe] ${event.id} failed to credit: ${error.message}`);
    next(error);
  }
}
