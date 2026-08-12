/**
 * `npm run storage:init` — creates the private `attachments` bucket if it is
 * absent, and reports what it found.
 *
 * A one-off, idempotent, and deliberately NOT something the server does at
 * boot: creating infrastructure is an administrative act, and a process that
 * silently provisions storage on start is a process that will silently
 * provision it in the wrong project one day. Running it twice prints "already
 * exists" and changes nothing.
 */
import { BUCKET, MAX_BYTES } from '../src/config/attachments.js';
import { ensureBucket, isStorageConfigured } from '../src/services/storageService.js';

if (!isStorageConfigured()) {
  console.error('[storage] SUPABASE_URL and SUPABASE_SERVICE_KEY are not both set. See .env.example.');
  process.exit(1);
}

try {
  const { created, bucket } = await ensureBucket();

  console.log(
    created
      ? `[storage] created bucket "${BUCKET}" — private, ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB per object`
      : `[storage] bucket "${BUCKET}" already exists — public: ${bucket.public}`,
  );

  if (!created && bucket.public) {
    // The whole design assumes every read is a signed URL with an expiry. A
    // public bucket makes a storage path a permanent credential, and the path
    // contains the owner's user id.
    console.error('[storage] WARNING: this bucket is PUBLIC. Attachments must be served by signed URL only.');
    process.exit(1);
  }
} catch (error) {
  console.error(`[storage] ${error.code ?? 'ERROR'}: ${error.message}`);
  if (error.cause) console.error(`[storage] cause: ${error.cause.message}`);
  process.exit(1);
}
