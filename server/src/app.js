import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';

import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { apiRoutes } from './routes/index.js';

export const app = express();

// credentials:true is required for the JWT httpOnly cookie to travel cross-origin,
// and it is what lets the client's EventSource carry the cookie to
// GET /api/rounds/:id/stream — with `withCredentials: true` on the client side,
// since an EventSource cannot set a header and has no other way to authenticate.
app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
app.use(cookieParser());
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
