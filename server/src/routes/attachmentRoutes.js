/**
 * §8 Attachments — the two endpoints, and §9's "Storage as the external media
 * store for prompt attachments".
 *
 * Middleware order is the house order and for the house reason: requireAuth,
 * validate, requireOwnership. The ownership loader passes `req.params.id`
 * straight into a query, so a non-uuid has to be a 400 from Zod before it can
 * be a 500 from Postgres.
 *
 * The upload has no `validate` step because it has no JSON body to validate —
 * `uploadSingleFile` is the parser and the size limit, and the type check reads
 * the bytes in the service. It sits AFTER requireAuth so an anonymous caller is
 * refused before 8 MB is read into this process's memory.
 */
import { Router } from 'express';

import { deleteAttachment, uploadAttachment } from '../controllers/attachmentController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireOwnership } from '../middleware/requireOwnership.js';
import { uploadSingleFile } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import { loadAttachmentForOwnership } from '../services/attachmentService.js';
import { attachmentIdParamSchema } from '../validation/attachmentSchemas.js';

const router = Router();

router.post('/', requireAuth, uploadSingleFile, uploadAttachment);

router.delete(
  '/:id',
  requireAuth,
  validate({ params: attachmentIdParamSchema }),
  requireOwnership(loadAttachmentForOwnership),
  deleteAttachment,
);

export { router as attachmentRoutes };
