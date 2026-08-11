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

  const body = { error: { message, code } };

  /**
   * Field-level detail, set only by validate(). Guarded on status because an
   * unexpected 500 must never carry a payload out of the server — the message
   * is already suppressed above for the same reason.
   */
  if (status < 500 && Array.isArray(error.details) && error.details.length > 0) {
    body.error.details = error.details;
  }

  res.status(status).json(body);
}
