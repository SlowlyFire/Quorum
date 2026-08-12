/**
 * Supabase Storage — §9's "Storage as the external media store for prompt
 * attachments", and the only file that talks to it.
 *
 * The same shape as `openrouterService`: one client, one place credentials are
 * read, and every failure mapped to one of our codes before it leaves. Nothing
 * above this file knows that the store is Supabase, which is what would make
 * swapping it a change to one module.
 *
 * THE BUCKET IS PRIVATE AND STAYS PRIVATE. Every read is a signed URL minted at
 * request time with a short expiry; there is no public object path anywhere in
 * the product. A public bucket would make a storage path a permanent
 * credential — and an attachment's path contains the owner's user id, so
 * guessing one would be guessing at somebody's uploads.
 *
 * THE TWO KEYS ARE OPTIONAL OUTSIDE PRODUCTION, exactly as Stripe's are
 * (decision 36). Everything but attachments works without them, so a fresh
 * clone boots and the two endpoints that need them raise 503 STORAGE_NOT_
 * CONFIGURED instead. `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` were already in
 * `REQUIRED_IN_PRODUCTION`; this session is the one that gave them a caller.
 */
import { createClient } from '@supabase/supabase-js';

import { BUCKET, MAX_BYTES } from '../config/attachments.js';
import { env } from '../config/env.js';
import { httpError } from '../lib/httpError.js';

let client = null;

export function isStorageConfigured() {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

/**
 * The service-role key, which bypasses RLS — correct here and nowhere near a
 * browser. `persistSession: false` because this is a server with no user
 * session to persist, and leaving it on makes the client write to a storage
 * shim that does not exist in Node.
 */
function storage() {
  if (!isStorageConfigured()) {
    throw httpError(
      503,
      'STORAGE_NOT_CONFIGURED',
      'File attachments are not available: this server has no Supabase Storage credentials.',
    );
  }

  client ??= createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return client.storage;
}

/**
 * Supabase returns `{ data, error }` rather than throwing, and its errors carry
 * a message that may name the bucket and the path. Mapped to our envelope with
 * a fixed message, and the provider's words kept on `cause` for the log rather
 * than sent to the client.
 */
function fail(code, message, error) {
  return httpError(502, code, message, {
    cause: error instanceof Error ? error : new Error(String(error?.message ?? error)),
  });
}

/**
 * Creates the bucket if it is absent. Called by `npm run storage:init` and by
 * nothing on a request path — a per-upload existence check would be a round
 * trip on every upload to answer a question whose answer never changes.
 */
export async function ensureBucket() {
  const { data, error } = await storage().getBucket(BUCKET);

  if (data) return { created: false, bucket: data };

  // Any error here is "not found" in practice; creating and letting the create
  // fail is a clearer report than guessing at the error's shape.
  const created = await storage().createBucket(BUCKET, {
    public: false,
    fileSizeLimit: MAX_BYTES,
  });

  if (created.error) {
    throw fail('STORAGE_UNAVAILABLE', `Could not create the ${BUCKET} bucket.`, created.error ?? error);
  }

  return { created: true, bucket: created.data };
}

/**
 * @param {string} path  `userId/uuid.ext` — built by attachmentService, never
 *   from anything the client sent.
 */
export async function uploadObject({ path, body, contentType }) {
  const { error } = await storage()
    .from(BUCKET)
    .upload(path, body, {
      contentType,
      // A uuid never collides, so an upsert would only ever mask a bug.
      upsert: false,
    });

  if (error) throw fail('STORAGE_UPLOAD_FAILED', 'The file could not be stored.', error);

  return { path };
}

/** The bytes back, for base64-encoding into a prompt. */
export async function downloadObject(path) {
  const { data, error } = await storage().from(BUCKET).download(path);

  if (error) throw fail('STORAGE_DOWNLOAD_FAILED', 'The attachment could not be read.', error);

  return Buffer.from(await data.arrayBuffer());
}

/**
 * A time-limited URL. Minted per request and never stored: a signed URL is a
 * bearer credential with an expiry, and a column of them would be a column of
 * credentials that outlive whatever check produced them.
 */
export async function createSignedUrl(path, expiresInSeconds) {
  const { data, error } = await storage().from(BUCKET).createSignedUrl(path, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw fail('STORAGE_SIGN_FAILED', 'A preview link could not be created.', error);
  }

  return data.signedUrl;
}

/**
 * Best effort by design, and the caller decides what that means. DELETE
 * /api/attachments/:id removes the object first and the row second: an orphaned
 * object is invisible and costs a few kilobytes, while an orphaned row is a
 * broken thumbnail on a debate the user is still reading.
 */
export async function removeObject(path) {
  const { error } = await storage().from(BUCKET).remove([path]);

  if (error) throw fail('STORAGE_DELETE_FAILED', 'The file could not be removed.', error);
}
