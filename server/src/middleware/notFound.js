/**
 * Turns an unmatched route into an error so errorHandler stays the single
 * place where an error becomes a response body.
 */
export function notFound(req, res, next) {
  const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  error.status = 404;
  error.code = 'NOT_FOUND';
  next(error);
}
