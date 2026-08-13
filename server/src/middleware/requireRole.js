/**
 * Authorization by role. Mounted after requireAuth, never instead of it —
 * the 401 branch below is a wiring guard, not a code path a request should
 * reach.
 *
 * users.role is CHECK (role IN ('user', 'admin')), so this has exactly one
 * caller in the plan: the admin model-catalogue routes in §10's extensions.
 */
import { httpError } from '../lib/httpError.js';

export function requireRole(role) {
  return function requireRoleOf(req, res, next) {
    if (!req.user) {
      return next(httpError(401, 'AUTH_REQUIRED', 'Authentication required'));
    }

    if (req.user.role !== role) {
      return next(httpError(403, 'FORBIDDEN', 'You do not have access to this resource'));
    }

    next();
  };
}
