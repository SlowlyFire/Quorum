/**
 * Zod for §8's attachment endpoints.
 *
 * There is no body schema for the upload, and that absence is the point: the
 * body is a multipart stream, not JSON, and everything checkable about it —
 * size, count, and what the bytes actually are — is checked by
 * `middleware/upload.js` and `attachmentService.sniffMimeType` rather than by a
 * schema over strings the client wrote.
 */
import { z } from 'zod';

import { MAX_PER_ROUND } from '../config/attachments.js';
import { uuid } from './sessionSchemas.js';

/**
 * Mounted BEFORE requireOwnership, like every other :id route: the ownership
 * loader passes the param into a query, so a non-uuid must be a 400 from Zod
 * rather than a 500 from Postgres.
 */
export const attachmentIdParamSchema = z.object({ id: uuid }).strict();

/**
 * The `attachmentIds` array on POST /sessions/:id/rounds.
 *
 * Exported and imported by `roundSchemas` rather than restated there, for the
 * same reason `presetSchemas` takes `councilSchema` from `sessionSchemas`: two
 * copies of a rule drift, and this drift would surface as an upload that
 * succeeds and then cannot be used.
 */
export const attachmentIdsSchema = z
  .array(uuid, { error: 'must be an array of attachment ids' })
  .max(MAX_PER_ROUND, `must name at most ${MAX_PER_ROUND} attachments`)
  .superRefine((ids, ctx) => {
    const seen = new Set();

    for (const [index, id] of ids.entries()) {
      if (seen.has(id)) {
        // `attachments.round_id` is one column, so the same file twice on one
        // round is unrepresentable — and it would double what the drafters are
        // billed to look at it.
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `${id} appears more than once`,
        });
      }
      seen.add(id);
    }
  });
