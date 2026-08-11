/**
 * Zod schemas for §8's preset endpoints.
 *
 * `councilSchema` IS IMPORTED, NOT RESTATED. A preset's line-up and a session's
 * are the same object with the same three rules — at most eight models, no
 * duplicates, the chairman among them — and the whole reason a preset is useful
 * is that its council can be loaded straight into a session's. Two schemas would
 * be two chances for those rules to drift apart, and the drift would show up as
 * a preset that saves and then cannot be used.
 *
 * The same division of labour holds as everywhere else: shape, types and
 * internal consistency here; whether the uuids name live models is the
 * database's question, answered by councilService as UNKNOWN_MODEL /
 * INACTIVE_MODEL.
 */
import { z } from 'zod';

import { councilSchema, uuid } from './sessionSchemas.js';

/**
 * 1–60 characters. Trimmed before the length check, so "   " is empty rather
 * than three characters — and trimmed before the insert too, so trailing
 * whitespace cannot smuggle a duplicate past migration 006's unique index.
 */
const name = z
  .string({ error: 'is required' })
  .trim()
  .min(1, 'must not be empty')
  .max(60, 'must be at most 60 characters');

export const createPresetSchema = z
  .object({
    name,
    council: councilSchema,
    chairmanAbstains: z.boolean().optional(),
    rebuttalEnabled: z.boolean().optional(),
  })
  .strict('is not a recognised field');

/**
 * Every field optional, but not all of them at once — an empty PATCH is almost
 * always a client bug, and answering 200 would hide it behind a success. Same
 * rule, and the same wording, as updateSessionSchema.
 */
export const updatePresetSchema = z
  .object({
    name: name.optional(),
    council: councilSchema.optional(),
    chairmanAbstains: z.boolean().optional(),
    rebuttalEnabled: z.boolean().optional(),
  })
  .strict('is not a recognised field')
  .refine((body) => Object.keys(body).length > 0, {
    error: 'must change at least one of name, council, chairmanAbstains or rebuttalEnabled',
  });

/** Mounted BEFORE requireOwnership, for the reason sessionIdParamSchema records:
 *  a non-uuid must be a 400 from Zod, not a 500 from Postgres. */
export const presetIdParamSchema = z.object({ id: uuid }).strict();
