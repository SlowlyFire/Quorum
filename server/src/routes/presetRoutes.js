/**
 * §8 Presets — the caller's saved council line-ups.
 *
 * Middleware order on the two :id routes is the same as everywhere else and for
 * the same reason: requireAuth, then validate, then requireOwnership. The
 * ownership loader passes `req.params.id` straight into a query, so an id that
 * is not a uuid must be a 400 from Zod rather than a 500 from Postgres.
 *
 * GET and POST have no :id and so no ownership check — a list is scoped by
 * `req.user.id`, and a create belongs to whoever asked for it.
 */
import { Router } from 'express';

import {
  createPreset,
  deletePreset,
  listPresets,
  updatePreset,
} from '../controllers/presetController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireOwnership } from '../middleware/requireOwnership.js';
import { validate } from '../middleware/validate.js';
import { loadPresetForOwnership } from '../services/presetService.js';
import {
  createPresetSchema,
  presetIdParamSchema,
  updatePresetSchema,
} from '../validation/presetSchemas.js';

const router = Router();

router.use(requireAuth);

const owned = () => requireOwnership(loadPresetForOwnership);

router.get('/', listPresets);
router.post('/', validate({ body: createPresetSchema }), createPreset);

router.patch(
  '/:id',
  validate({ params: presetIdParamSchema, body: updatePresetSchema }),
  owned(),
  updatePreset,
);
router.delete('/:id', validate({ params: presetIdParamSchema }), owned(), deletePreset);

export { router as presetRoutes };
