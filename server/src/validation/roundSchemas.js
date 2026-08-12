/**
 * Zod schemas for §8's round endpoints.
 *
 * The council is optional on POST /api/sessions/:id/rounds and that optionality
 * is the feature: omitted, the round inherits the session's council from
 * session_models; supplied, it overrides for this round only and leaves
 * session_models untouched. One-off "ask the same question of a different
 * line-up" is a round-shaped operation, not a session-shaped one.
 */
import { z } from 'zod';

import { attachmentIdsSchema } from './attachmentSchemas.js';
import { councilSchema, uuid } from './sessionSchemas.js';

/**
 * 8000 characters is roughly 2000 tokens of question, which every drafter pays
 * for in its prompt and the chairman pays for again in stages 2 and 4. The
 * ceiling is a cost guard rather than a model limit.
 */
export const createRoundSchema = z
  .object({
    prompt: z
      .string({ error: 'is required' })
      .trim()
      .min(1, 'must not be empty')
      .max(8000, 'must be at most 8000 characters'),
    council: councilSchema.optional(),
    /**
     * Ids from POST /api/attachments, uploaded before this call. Imported from
     * attachmentSchemas rather than restated, exactly as councilSchema is: the
     * cap and the duplicate rule belong to attachments, and a second copy would
     * drift into an upload that succeeds and then cannot be used.
     */
    attachmentIds: attachmentIdsSchema.optional(),
  })
  .strict('is not a recognised field');

export const roundIdParamSchema = z.object({ id: uuid }).strict();

/**
 * EventSource cannot set a header, so a client that has been disconnected and
 * wants to resume has only the URL. Browsers do send `Last-Event-ID` on their
 * own automatic reconnects — the header is read first and this is the fallback,
 * which is also what makes the replay testable with curl.
 */
export const streamQuerySchema = z
  .object({
    lastEventId: z.coerce.number().int().min(0).optional(),
  })
  .strict('is not a recognised query parameter');
