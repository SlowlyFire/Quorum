/**
 * Authorization by ownership — the check that stands between one user's
 * sessions, rounds, presets and attachments and every other user's.
 *
 * A factory rather than a middleware, because the only thing that differs
 * between resources is how you load one:
 *
 *   router.get(
 *     '/:id',
 *     requireAuth,
 *     requireOwnership((id) => getSessionForOwnershipCheck(id)),
 *     getSession,
 *   );
 *
 * The loader is a service function — middleware never imports a model. It is
 * handed the id and the request, and must return the resource or a nullish
 * value if there is none.
 *
 * On success the loaded resource is attached as req.resource, so the handler
 * does not fetch the same row a second time.
 */
import { httpError } from '../lib/httpError.js';

export function requireOwnership(loadResource, { param = 'id' } = {}) {
  return async function requireOwnershipOf(req, res, next) {
    try {
      if (!req.user) {
        throw httpError(401, 'AUTH_REQUIRED', 'Authentication required');
      }

      const resource = await loadResource(req.params[param], req);

      if (!resource) {
        throw httpError(404, 'NOT_FOUND', 'Resource not found');
      }

      /**
       * Rows arrive from models in snake_case and objects shaped by a service
       * in camelCase; accept either so a loader can return whichever it has.
       * A resource carrying neither key compares undefined against a uuid and
       * is refused — the failure mode is a 403, never an accidental pass.
       */
      const ownerId = resource.user_id ?? resource.userId;

      if (ownerId !== req.user.id) {
        /**
         * 403 rather than 404 tells the caller the id exists. That is the
         * trade the spec asks for and it is the honest status code; the
         * enumeration it permits is over unguessable uuids, so the exposure is
         * "this uuid is somebody's" and nothing more.
         */
        throw httpError(403, 'FORBIDDEN', 'You do not have access to this resource');
      }

      req.resource = resource;

      next();
    } catch (error) {
      next(error);
    }
  };
}
