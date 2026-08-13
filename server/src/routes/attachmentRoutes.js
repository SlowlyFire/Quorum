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
import { createUploadRateLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireOwnership } from '../middleware/requireOwnership.js';
import { uploadSingleFile } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import { loadAttachmentForOwnership } from '../services/attachmentService.js';
import { attachmentIdParamSchema } from '../validation/attachmentSchemas.js';

const router = Router();

/**
 * The limiter sits AFTER requireAuth and BEFORE multer, and both halves of that
 * matter: after, because it is keyed on the user rather than the IP; before,
 * because the point is to refuse the request without first reading 8 MB of body
 * into memory.
 *
 * There is no `validate()` here and that is not an omission. The route carries
 * no body fields, no params and no query — the controller reads `req.file` and
 * `req.user` and nothing else — so there is nothing Zod could check. The file
 * itself is validated by magic bytes in attachmentService, deliberately not by
 * the declared type or the filename, which are the two things about an upload
 * nobody should believe (decision 48).
 */
router.post('/', requireAuth, createUploadRateLimiter(), uploadSingleFile, uploadAttachment);

router.delete(
  '/:id',
  requireAuth,
  validate({ params: attachmentIdParamSchema }),
  requireOwnership(loadAttachmentForOwnership),
  deleteAttachment,
);

export { router as attachmentRoutes };
