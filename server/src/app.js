import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { ALLOWED_ORIGINS } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { apiRoutes } from './routes/index.js';
import { webhookRoutes } from './routes/webhookRoutes.js';

export const app = express();

/**
 * SECURITY HEADERS, FIRST, SO THEY ARE ON EVERY RESPONSE INCLUDING THE ERRORS.
 *
 * This is a JSON API and an SSE stream. It serves no HTML, so most of what
 * helmet does by default is inert here — but the two that matter are not:
 * `X-Content-Type-Options: nosniff`, which stops a browser second-guessing a
 * declared `application/json` (an uploaded file echoed back with the wrong type
 * is the classic route to stored XSS), and `Strict-Transport-Security`, which
 * is real the moment anything is served over https.
 *
 * TWO DEFAULTS TURNED OFF, BOTH DELIBERATELY.
 *
 * `contentSecurityPolicy` is off because this origin renders no markup: helmet's
 * default policy exists to constrain a page's own script and style sources, and
 * there is no page. Leaving it on would put a long header on every JSON response
 * to constrain nothing. The CLIENT's CSP is Vercel's business and is where a
 * policy would actually bind.
 *
 * `crossOriginResourcePolicy` is off because its default is `same-origin`, and
 * this API is deliberately cross-origin: the client is on Vercel and the API on
 * Railway. Left on, it tells the browser to refuse exactly the requests the
 * whole product is made of. `cors` below is what governs who may read these
 * responses, and it names one origin rather than blanket-denying every other.
 */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
  }),
);

/**
 * AN EXACT-MATCH ALLOW-LIST. NEVER `*`, NEVER `origin: true`, AND NEVER A REGEX.
 *
 * `credentials: true` is not optional here: the JWT lives in an httpOnly cookie
 * and the client is on a different origin in every environment — a different
 * host in production, a different port in development. It is also what lets the
 * client's EventSource carry the cookie to `GET /api/rounds/:id/stream`, since
 * an EventSource cannot set a header and has no other way to authenticate.
 *
 * And the two settings constrain each other. **A wildcard
 * `Access-Control-Allow-Origin: *` is illegal in a credentialed response** —
 * the browser does not merely ignore it, it rejects the response outright — so
 * `origin: '*'` and `credentials: true` cannot both be right.
 *
 * `origin: true` would also avoid the wildcard, by reflecting whatever `Origin`
 * the request carried — which is to say it would allow every site on the
 * internet to make credentialed calls with the user's cookie. It is the same
 * shape as an allow-list with nothing in it.
 *
 * AN ARRAY RATHER THAN A STRING, AND THAT CHANGES THE HEADER'S MEANING.
 * Given a string the `cors` package emits it verbatim on every response,
 * including responses to callers it does not know — the browser is what
 * compares the two and refuses. Given an array it matches the request's
 * `Origin` with `===`, echoes back **that** origin when it is a member, and
 * emits no `Access-Control-Allow-Origin` header at all when it is not. Both are
 * safe; the array is the one that can express more than one client, and it is
 * also the one that makes the header a statement about the caller rather than a
 * constant. It adds `Vary: Origin` itself, which a shared cache needs the
 * moment the header can differ between two requests for the same URL.
 *
 * A regex or a `.endsWith('.askthequorum.com')` test is NOT the same thing and
 * must not replace this: it would admit every present and future subdomain,
 * including one that gets taken over, to make credentialed calls with a user's
 * session. The list is short on purpose.
 *
 * ALLOWED_ORIGINS, not CLIENT_URL: see config/env.js for why a trailing slash
 * or a path in that variable would match no origin a browser ever sends, and
 * for why CLIENT_ORIGIN is a member of this list by construction.
 */
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(cookieParser());

/**
 * THE STRIPE WEBHOOK IS MOUNTED HERE, ABOVE express.json(), AND THE ORDER IS
 * THE WHOLE POINT. DO NOT MOVE IT DOWN, AND DO NOT MOVE IT INTO
 * routes/index.js WITH THE REST OF /api.
 *
 * Stripe signs the exact bytes of the request body. `express.json()` consumes
 * the stream, parses it, and leaves an object behind — so by the time a handler
 * below this line runs, the bytes Stripe signed no longer exist and
 * `constructEvent` re-serialising the object cannot reproduce them: key order
 * and whitespace are not preserved by a round trip through JSON.parse.
 *
 * The failure is silent in the worst way. Verification throws "No signatures
 * found matching the expected signature", which reads as a wrong
 * STRIPE_WEBHOOK_SECRET, so the obvious next move is to go and change a secret
 * that was already correct. This is the classic Stripe integration bug, and
 * the mount order above is the entire fix.
 *
 * `express.raw` is scoped to this path only, so every other route still gets a
 * parsed body. The type matters too: Stripe sends application/json, and a raw
 * parser that does not claim that content type hands the handler an empty
 * object instead of a Buffer.
 */
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

app.use(express.json());

/**
 * NOTE FOR WHOEVER ADDS COMPRESSION.
 *
 * `compression` buffers a response to gzip it, which holds every SSE frame
 * until the round ends — the stream does not error, it simply delivers nothing
 * until it is too late to matter. The stream route already sends
 * `Cache-Control: no-cache, no-transform`, which is the opt-out `compression`
 * honours, so mounting it here would be safe as written. Do not "tidy" that
 * header away, and do not mount a compressor that ignores no-transform.
 */

app.use('/api', apiRoutes);

app.use(notFound);
app.use(errorHandler);
