/**
 * The one way an error is constructed anywhere in the server.
 *
 * errorHandler is the only place an error becomes a response; this is the only
 * place one becomes an error. It exists so `status` and `code` are never
 * misspelled and never forgotten — an Error without them is a 500
 * INTERNAL_ERROR, which is exactly right for a genuine bug and exactly wrong
 * for an expected refusal.
 *
 * `details` is optional and only ever set by validate(); errorHandler emits it
 * for statuses below 500 and drops it otherwise, so internals cannot ride out
 * on a 500.
 */
export function httpError(status, code, message, { cause, details } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);

  error.status = status;
  error.code = code;
  if (details) error.details = details;

  return error;
}
