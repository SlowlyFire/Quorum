/**
 * Zod at the edge. A handler downstream of validate() can treat req.body,
 * req.params and req.query as already-checked, already-normalised data.
 *
 *   validate({ body: registerSchema })
 *   validate({ params: sessionIdSchema, query: listQuerySchema })
 *
 * The parsed value is written back over the raw one, so a service receives the
 * trimmed and coerced version rather than whatever arrived on the wire.
 */
import { httpError } from '../lib/httpError.js';

const SOURCES = ['body', 'params', 'query'];

export function validate(schemas) {
  return function validateRequest(req, res, next) {
    const details = [];

    for (const source of SOURCES) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);

      if (result.success) {
        req[source] = result.data;
        continue;
      }

      // Every failing field is reported, not just the first, so a form can mark
      // all of its bad inputs in one round trip.
      for (const issue of result.error.issues) {
        details.push({
          in: source,
          field: issue.path.join('.') || source,
          message: issue.message,
        });
      }
    }

    if (details.length > 0) {
      return next(httpError(400, 'VALIDATION_ERROR', 'Request validation failed', { details }));
    }

    next();
  };
}
