import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';

import { CLIENT_ORIGIN } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { apiRoutes } from './routes/index.js';
import { webhookRoutes } from './routes/webhookRoutes.js';

export const app = express();

/**
 * ONE EXACT ORIGIN, ECHOED VERBATIM. NEVER `*`, AND NEVER `origin: true`.
 *
 * `credentials: true` is not optional here: the JWT lives in an httpOnly cookie
 * and the client is on a different site in production (Vercel) as well as in
 * development (:5173). It is also what lets the client's EventSource carry the
 * cookie to `GET /api/rounds/:id/stream`, since an EventSource cannot set a
 * header and has no other way to authenticate.
 *
 * And the two settings constrain each other. **A wildcard
 * `Access-Control-Allow-Origin: *` is illegal in a credentialed response** —
 * the browser does not merely ignore it, it rejects the response outright — so
 * `origin: '*'` and `credentials: true` cannot both be right. Passing a string
 * makes the `cors` package emit that string verbatim, which is the behaviour we
 * want and the reason this is not a function or an array.
 *
 * `origin: true` would also avoid the wildcard, by reflecting whatever `Origin`
 * the request carried — which is to say it would allow every site on the
 * internet to make credentialed calls with the user's cookie. It is the same
 * shape as an allow-list with nothing in it.
 *
 * CLIENT_ORIGIN, not CLIENT_URL: see config/env.js for why a trailing slash or
 * a path in that variable would match no origin a browser ever sends.
 */
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
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
