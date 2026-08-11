import { isProduction } from '../config/env.js';

/**
 * The only place in the server where an error becomes a response.
 * Controllers and services throw or call next(error); they never res.status(500).
 *
 * Express identifies an error handler by its four-parameter signature, so
 * `next` must stay in the list even though it is unused.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, next) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  const code = error.code ?? (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR');

  // An unexpected 500 can carry internals in its message; never leak it in production.
  const message =
    status === 500 && isProduction ? 'Internal server error' : (error.message ?? 'Unexpected error');

  if (isProduction) {
    if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl} ${code}: ${error.message}`);
  } else {
    console.error(`[error] ${req.method} ${req.originalUrl} ${status} ${code}`, error);
  }

  res.status(status).json({ error: { message, code } });
}
