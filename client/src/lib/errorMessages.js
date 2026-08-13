/**
 * Every failure becomes a sentence a person can read. Nothing renders a code.
 *
 * The server already sends a human `message` beside every `code`, and most of
 * them are good — "Llama 4 Maverick is no longer available" needs no help from
 * here. So this is NOT a translation table for every code: a second copy of
 * fifty messages would drift from the server's the first time one was reworded,
 * and the drift would be invisible.
 *
 * It does two things instead.
 *
 *   1. It OVERRIDES the handful of messages that are true but written for us
 *      rather than for the user. `MODEL_JSON_INVALID` says "could not be read as
 *      JSON", which is the right sentence in a log and the wrong one on a screen
 *      — the user did not ask a model for JSON and cannot act on the answer.
 *   2. It GUARANTEES a sentence when there is no usable message at all: a
 *      transport failure, a proxy's HTML error page, a thrown value that is not
 *      an Error. Those are exactly the cases where a bare code or an empty alert
 *      would otherwise reach the screen.
 */

/**
 * Codes whose server wording is internal-facing. Everything absent from this map
 * uses the server's own message, deliberately.
 */
const OVERRIDES = Object.freeze({
  // The chairman returned something unparseable. The user asked a question; the
  // shape of the model's reply is our problem, not theirs.
  MODEL_JSON_INVALID:
    'The chairman could not produce a usable answer this time. Try asking again — a different council often helps.',
  CHAIRMAN_RESPONSE_INVALID:
    'The chairman could not produce a usable answer, twice. Try again, or nominate a different chairman.',

  // Provider faults the user can neither cause nor fix.
  OPENROUTER_AUTH: 'We could not reach the model provider. This is a fault on our side, not yours.',
  OPENROUTER_INSUFFICIENT_CREDIT:
    'The model provider is temporarily unavailable. This is a fault on our side, not yours.',
  DATABASE_UNAVAILABLE: 'We are having trouble reaching our database. Please try again in a moment.',
  INTERNAL_ERROR: 'Something went wrong on our side. Please try again.',

  // Storage wording that names infrastructure the user has never heard of.
  STORAGE_NOT_CONFIGURED: 'File attachments are not available on this deployment.',
  STORAGE_UPLOAD_FAILED: 'That file could not be uploaded. Please try again.',
  STORAGE_DOWNLOAD_FAILED: 'That attachment could not be opened.',
  STORAGE_SIGN_FAILED: 'That attachment could not be opened.',
  STORAGE_UNAVAILABLE: 'File attachments are temporarily unavailable.',
  STRIPE_NOT_CONFIGURED: 'Top-ups are not available on this deployment.',
});

/**
 * THE 401s THAT MEAN "YOU ARE NOT SIGNED IN", AND NOTHING ELSE.
 *
 * The client used to sign the user out on ANY 401 from any path. That happened
 * to be safe, because today the only 401s this API emits are these two plus a
 * wrong password on /login — but it made the sign-out a property of the STATUS
 * rather than of the reason, so the first endpoint to answer 401 for some other
 * cause would have logged every user out. Matching the code makes the rule say
 * what it means.
 */
export const AUTH_FAILURE_CODES = new Set(['AUTH_REQUIRED', 'UNAUTHENTICATED']);

/**
 * What to tell somebody the app has just signed out, and it depends on WHY.
 *
 * `AUTH_REQUIRED` — the request carried no cookie. In production the usual cause
 * is not a signed-out visitor but a browser refusing to send one: the app and
 * the API sit on separate registrable domains, so the session cookie is
 * third-party, and WebKit blocks those outright. Safari and **every** browser on
 * iOS, Chrome included, are affected; desktop Chrome is not, which is exactly
 * the shape of the reports.
 *
 * Telling that user their session expired is false, and telling them to sign in
 * again is worse than useless — the new cookie is refused exactly as the old one
 * was, so the advice loops them through the failure. So this branch says what is
 * actually happening, what they can do now, and that it is being fixed properly.
 *
 * `UNAUTHENTICATED` — a credential did arrive and was rejected: expired, tampered
 * with, or the account is gone. Signing in again IS the remedy, and the server's
 * own sentence is the accurate one, so it is passed through rather than replaced.
 */
export function signedOutNotice(error) {
  if (error?.code === 'AUTH_REQUIRED') {
    return {
      title: 'Your browser is blocking the session cookie',
      message:
        'Quorum’s app and API are on different domains, so the sign-in cookie counts as ' +
        'third-party — Safari and every browser on iOS block those. Signing in again will not ' +
        'help. Use a browser that allows third-party cookies for now; we are moving to a single ' +
        'domain to remove the requirement.',
      /** Long enough to read, and it is not a transient blip. */
      autoClose: false,
    };
  }

  return {
    title: 'Signed out',
    // The server distinguishes expired from tampered-with; use its words.
    message: humanMessage(error) ?? 'Please sign in again.',
    autoClose: undefined,
  };
}

/** When there is no message and no override, the status still says something. */
function byStatus(status) {
  if (status === 0) return 'We could not reach the server. Check your connection and try again.';
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You do not have access to that.';
  if (status === 404) return 'We could not find that.';
  if (status === 409) return 'That conflicts with something that already exists.';
  if (status === 413) return 'That file is too large.';
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again.';

  return 'Something went wrong. Please try again.';
}

/**
 * The sentence to show for any thrown thing — an ApiError, a TypeError from a
 * dropped connection, or a value that is not an Error at all.
 *
 * Never returns an empty string, and never returns a code.
 */
export function humanMessage(error) {
  if (!error) return null;

  const override = OVERRIDES[error.code];

  if (override) return override;

  const message = typeof error.message === 'string' ? error.message.trim() : '';

  /**
   * A message that is just the code — which is what a hand-rolled `throw
   * new Error('NOT_FOUND')` produces — is not a sentence. Screening for it here
   * is cheaper than auditing every throw site, and the status fallback below is
   * a better answer than the code would have been.
   */
  const looksLikeACode = /^[A-Z][A-Z0-9_]{2,}$/.test(message);

  if (message && !looksLikeACode) return message;

  return byStatus(error.status);
}
