/**
 * Zod schemas for §8's session endpoints.
 *
 * The division of labour with the service below them is deliberate. Everything
 * checkable from the request alone is checked here — shape, types, uuid format,
 * duplicates, and whether the nominated chairman is one of the models listed.
 * Whether those uuids name models that exist and are active is a question only
 * the database can answer, so it is asked in sessionService and returns
 * UNKNOWN_MODEL / INACTIVE_MODEL rather than a validation failure.
 */
import { z } from 'zod';

export const uuid = z.uuid('must be a uuid');

/**
 * A council: who is on it, and which of them chairs.
 *
 * The chairman check lives here rather than only in the engine's planCouncil
 * because a Zod issue names the offending id in `details`, and the whole point
 * of returning 400 for this is telling the caller which id was wrong. planCouncil
 * still re-checks it — it guards every caller, including verify:debate, and a
 * validator that can be bypassed by a different entry point is not a guarantee.
 *
 * A ceiling of 8 is a cost guard, not a schema requirement: a round is up to 2N
 * calls, so a 20-model council is 40 inference calls from one POST.
 */
export const councilSchema = z
  .object({
    modelIds: z
      .array(uuid, { error: 'is required' })
      .min(1, 'must name at least one model')
      .max(8, 'must name at most 8 models'),
    chairmanId: uuid,
  })
  .strict('is not a recognised field')
  .superRefine((council, ctx) => {
    const seen = new Set();

    for (const [index, id] of council.modelIds.entries()) {
      if (seen.has(id)) {
        // round_models and session_models are both keyed on (parent, model_id),
        // so a duplicate is unrepresentable further down. Refusing it here means
        // the error names the id instead of being a primary key violation.
        ctx.addIssue({
          code: 'custom',
          path: ['modelIds', index],
          message: `${id} appears more than once; a model may sit on a council only once`,
        });
      }
      seen.add(id);
    }

    if (!seen.has(council.chairmanId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['chairmanId'],
        message: `${council.chairmanId} is not one of the models on this council`,
      });
    }
  });

const title = z
  .string({ error: 'is required' })
  .trim()
  .min(1, 'must not be empty')
  .max(120, 'must be at most 120 characters');

/**
 * A council is required, not optional. A session exists to be debated in, its
 * council is the default every round inherits, and a session created without one
 * could not answer POST /rounds without a council in the body — so "create a
 * session" and "choose who is on it" are one action, exactly as §8 words it.
 */
export const createSessionSchema = z
  .object({
    title: title.optional(),
    council: councilSchema,
    chairmanAbstains: z.boolean().optional(),
    rebuttalEnabled: z.boolean().optional(),
  })
  .strict('is not a recognised field');

/**
 * Every field optional, but not all of them at once: an empty PATCH is almost
 * always a client bug, and answering 200 to it would hide the bug behind a
 * success. Note that title cannot be set to null — §8 has no "clear the title"
 * operation, and omitting the key already means "leave it alone".
 */
export const updateSessionSchema = z
  .object({
    title: title.optional(),
    council: councilSchema.optional(),
    chairmanAbstains: z.boolean().optional(),
    rebuttalEnabled: z.boolean().optional(),
  })
  .strict('is not a recognised field')
  .refine((body) => Object.keys(body).length > 0, {
    error: 'must change at least one of title, council, chairmanAbstains or rebuttalEnabled',
  });

/**
 * Mounted BEFORE requireOwnership on every :id route. The ownership loader
 * passes the param straight to a query, and an id that is not a uuid would
 * reach Postgres and come back as a 500 `invalid input syntax for type uuid`
 * rather than the 400 it is.
 */
export const sessionIdParamSchema = z.object({ id: uuid }).strict();

/**
 * Pagination is capped rather than unbounded: `?limit=100000` on a list that
 * loads a council per row is a denial-of-service lever handed to any signed-in
 * user. Coerced because a query string carries only strings.
 *
 * §8 also lists a verdict filter on this route. It needs an aggregate over a
 * session's rounds and belongs with the leaderboard work; `search` is here
 * because it is a single ILIKE.
 */
export const listSessionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    search: z
      .string()
      .trim()
      .max(120)
      .optional()
      // `?search=` is "no filter", not "sessions whose title is empty".
      .transform((value) => (value ? value : undefined)),
  })
  .strict('is not a recognised query parameter');
