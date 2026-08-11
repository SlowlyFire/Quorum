import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(currentDir, '../../.env'), quiet: true });

/**
 * A copied .env.example leaves keys present but empty. Treat empty as absent so
 * defaults apply and the "required" checks below actually fire.
 */
const blankToUndefined = (value) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalSecret = () => z.preprocess(blankToUndefined, z.string().min(1).optional());
const requiredSecret = () =>
  z.preprocess(blankToUndefined, z.string({ error: 'is required' }).min(1, 'must not be empty'));

/**
 * Secrets that no code path uses yet. They are optional in development so the
 * API boots on a fresh clone, and required in production so a real deployment
 * cannot start half-configured. Move a key to the always-required block below
 * in the session that starts using it.
 *
 * DATABASE_URL and JWT_SECRET left this list in Session 3, OPENROUTER_API_KEY
 * in Session 4 — the models layer, the auth stack and every debate call use
 * them, so an unset key is a crash at the first request that needs it rather
 * than an absent feature. Better to fail at boot.
 */
const REQUIRED_IN_PRODUCTION = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];

/** An HS256 key shorter than the 256-bit digest it signs weakens the MAC. */
const MIN_PRODUCTION_JWT_SECRET_LENGTH = 32;

const envSchema = z
  .object({
    NODE_ENV: z.preprocess(
      blankToUndefined,
      z.enum(['development', 'test', 'production']).default('development'),
    ),
    PORT: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(3000)),
    CLIENT_URL: z.preprocess(blankToUndefined, z.string().url().default('http://localhost:5173')),

    DATABASE_URL: requiredSecret(),
    JWT_SECRET: requiredSecret(),
    OPENROUTER_API_KEY: requiredSecret(),

    SUPABASE_URL: optionalSecret(),
    SUPABASE_SERVICE_KEY: optionalSecret(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;

    for (const key of REQUIRED_IN_PRODUCTION) {
      if (value[key]) continue;
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'is required when NODE_ENV=production',
      });
    }

    if (value.JWT_SECRET.length < MIN_PRODUCTION_JWT_SECRET_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: `must be at least ${MIN_PRODUCTION_JWT_SECRET_LENGTH} characters when NODE_ENV=production`,
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(`Invalid environment configuration:\n${details}\n\nSee server/.env.example.`);
}

export const env = Object.freeze(parsed.data);

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
