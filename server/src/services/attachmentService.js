/**
 * §8's two attachment endpoints, and everything the debate engine needs to put
 * an image in front of a model.
 *
 * THREE THINGS THE CLIENT SENDS THAT ARE NOT TRUSTED, and what replaces each:
 *
 *   the Content-Type   replaced by `sniffMimeType`, which reads the first bytes
 *                      of the file. A multipart part's type is a string the
 *                      uploader writes; it is a hint, never evidence.
 *   the filename       discarded entirely. The stored object is
 *                      `userId/uuid.ext`, where the extension comes from the
 *                      sniffed type. A client-supplied name is the classic path
 *                      traversal (`../../`), the classic double extension
 *                      (`x.png.html`), and a way to write somebody else's name
 *                      into our bucket — and we have no use for it, because the
 *                      thing the user sees is a thumbnail of the image itself.
 *   the size header    ignored; `file.size` is the bytes actually received, and
 *                      multer's own limit refuses the rest mid-stream.
 */
import { randomUUID } from 'node:crypto';

import {
  ACCEPTED_MIME_TYPES,
  EXTENSION_FOR,
  MAX_BYTES,
  MAX_PER_ROUND,
  SIGNATURES,
  SIGNED_URL_TTL_SECONDS,
} from '../config/attachments.js';
import { httpError } from '../lib/httpError.js';
import {
  attachToRound,
  deleteAttachment,
  findAttachmentById,
  findClaimableAttachments,
  insertAttachment,
  listAttachmentsByRound,
  listAttachmentsBySession,
} from '../models/attachmentModel.js';
import { createSignedUrl, downloadObject, removeObject, uploadObject } from './storageService.js';

// ---------------------------------------------------------------------------
// Magic bytes
// ---------------------------------------------------------------------------

function matchesAt(buffer, offset, bytes) {
  if (buffer.length < offset + bytes.length) return false;

  for (const [index, byte] of bytes.entries()) {
    if (buffer[offset + index] !== byte) return false;
  }

  return true;
}

/**
 * The file's real type, or null.
 *
 * Null is the answer for a PDF renamed `.png`, for an HTML page claiming to be
 * a JPEG, and for anything else not on the list — one refusal for every way of
 * lying about a file, because there is only one question being asked and it is
 * asked of the bytes.
 */
export function sniffMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  for (const signature of SIGNATURES) {
    if (!matchesAt(buffer, signature.offset, signature.bytes)) continue;
    if (signature.also && !matchesAt(buffer, signature.also.offset, signature.also.bytes)) continue;

    return signature.mimeType;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

export function isImage(mimeType) {
  return mimeType.startsWith('image/');
}

/**
 * The single place an `attachments` row becomes wire shape.
 *
 * `signedUrl` is passed in rather than read off the row, because it is not on
 * the row: a signed URL is a bearer credential with an expiry and storing one
 * would be storing a credential that outlives the check that produced it. Every
 * caller mints it at request time, which is also what makes the shared view's
 * links expire on their own schedule.
 *
 * `storagePath` is deliberately absent. It contains the owner's user id, and a
 * reader of a shared debate has no use for it.
 */
export function toPublicAttachment(row, signedUrl = null) {
  return {
    id: row.id,
    roundId: row.round_id,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    kind: isImage(row.mime_type) ? 'image' : 'document',
    createdAt: row.created_at,
    signedUrl,
  };
}

// ---------------------------------------------------------------------------
// Upload and delete
// ---------------------------------------------------------------------------

/**
 * @param {{ userId: string, file: { buffer: Buffer, size: number, mimetype?: string } }} input
 *   `file` is multer's, from memory storage. `file.mimetype` is read only to be
 *   compared against the truth in the log line below — it is never used to
 *   decide anything.
 */
export async function createAttachment({ userId, file }) {
  if (!file?.buffer) {
    throw httpError(400, 'NO_FILE', 'No file was uploaded. Send one part named "file".');
  }

  /**
   * multer's own `limits.fileSize` refuses a larger upload mid-stream and its
   * error is mapped to this same 413 by the route. This check is the second
   * line: a caller reaching the service some other way gets the same answer,
   * and the two cannot disagree because both read MAX_BYTES.
   */
  if (file.size > MAX_BYTES) {
    throw tooLarge(file.size);
  }

  const mimeType = sniffMimeType(file.buffer);

  if (!mimeType) {
    throw httpError(
      415,
      'UNSUPPORTED_FILE_TYPE',
      `That file is not one of ${ACCEPTED_MIME_TYPES.join(', ')}. ` +
        'The check reads the file itself, so renaming it will not help.',
    );
  }

  /**
   * A CONCRETE DECLARED TYPE THAT DISAGREES WITH THE BYTES IS A REFUSAL, NOT A
   * CORRECTION — even when the bytes are a type we accept.
   *
   * Reclassifying silently is the tempting option and it is wrong twice over. To
   * the user it means attaching a PDF and being told nothing while the UI, which
   * asked for an image, renders it as one. To an attacker it means the two
   * fields are allowed to disagree, which is the premise of every content-type
   * confusion trick — get one layer to read the label and another to read the
   * bytes. Here they must agree or nothing happens.
   *
   * `application/octet-stream` and a missing type are not disagreements: they
   * are a client that did not know, which browsers and curl both produce
   * routinely, and the bytes settle it.
   */
  const declared = file.mimetype?.toLowerCase();

  if (declared && declared !== 'application/octet-stream' && declared !== mimeType) {
    // Logged WITHOUT the filename. It is the one part of an upload an attacker
    // fully controls, so it does not go in the log any more than it goes in the
    // storage path.
    console.warn(`[attachments] declared ${declared} but the bytes are ${mimeType} — refused`);

    throw httpError(
      415,
      'FILE_TYPE_MISMATCH',
      `That file is labelled ${declared} but its contents are ${mimeType}. ` +
        'The check reads the file itself; upload it with the right type.',
    );
  }

  /**
   * `userId/uuid.ext`. The user id prefix is what makes an owner's objects
   * enumerable as a group for administration, and the uuid is what makes a path
   * unguessable and collision-free. Neither half comes from the request.
   */
  const storagePath = `${userId}/${randomUUID()}.${EXTENSION_FOR[mimeType]}`;

  await uploadObject({ path: storagePath, body: file.buffer, contentType: mimeType });

  let row;

  try {
    row = await insertAttachment({ userId, storagePath, mimeType, sizeBytes: file.size });
  } catch (error) {
    // The object is up and the row is not, so nothing will ever reference the
    // object again. Remove it rather than leak it, and let the original error
    // be the one the caller sees.
    await removeObject(storagePath).catch((cleanupError) => {
      console.error(`[attachments] orphaned object ${storagePath}: ${cleanupError.message}`);
    });

    throw error;
  }

  return toPublicAttachment(row, await createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS));
}

export function tooLarge(sizeBytes = null) {
  const megabytes = (MAX_BYTES / 1024 / 1024).toFixed(0);

  return httpError(
    413,
    'FILE_TOO_LARGE',
    sizeBytes === null
      ? `That file is larger than the ${megabytes} MB limit.`
      : `That file is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB; the limit is ${megabytes} MB.`,
  );
}

/** The requireOwnership loader for DELETE /api/attachments/:id. A service
 *  function, because middleware never imports a model. */
export async function loadAttachmentForOwnership(id) {
  return findAttachmentById(id);
}

/**
 * `attachment` is the row requireOwnership already loaded, so ownership is
 * settled before this runs.
 *
 * Object first, row second. An orphaned object is invisible and costs a few
 * kilobytes; an orphaned row is a broken thumbnail on a debate somebody is
 * reading, and there is no way back from it.
 */
export async function removeAttachment(attachment) {
  await removeObject(attachment.storage_path);
  await deleteAttachment(attachment.id);
}

// ---------------------------------------------------------------------------
// Reading them back
// ---------------------------------------------------------------------------

/** One signed URL per row, minted now. Concurrent because a round with four
 *  attachments should not be four sequential round trips to Supabase. */
export async function withSignedUrls(rows, ttlSeconds = SIGNED_URL_TTL_SECONDS) {
  return Promise.all(
    rows.map(async (row) =>
      toPublicAttachment(row, await createSignedUrl(row.storage_path, ttlSeconds)),
    ),
  );
}

export async function getRoundAttachments(roundId, ttlSeconds = SIGNED_URL_TTL_SECONDS) {
  return withSignedUrls(await listAttachmentsByRound(roundId), ttlSeconds);
}

/**
 * Every attachment in a session, grouped by round id — one query and one signing
 * pass for the whole conversation.
 */
export async function getSessionAttachmentsByRound(sessionId, ttlSeconds = SIGNED_URL_TTL_SECONDS) {
  const signed = await withSignedUrls(await listAttachmentsBySession(sessionId), ttlSeconds);
  const grouped = new Map();

  for (const attachment of signed) {
    if (!grouped.has(attachment.roundId)) grouped.set(attachment.roundId, []);
    grouped.get(attachment.roundId).push(attachment);
  }

  return grouped;
}

/**
 * Deletes every stored object belonging to a session, for the sweep that runs
 * before DELETE /api/sessions/:id lets Postgres cascade the rows away. The
 * cascade knows nothing about the bucket, so without this a deleted session
 * leaves its files behind forever.
 *
 * The rows are not deleted here — the cascade does that a moment later, and
 * doing it twice would mean two ways for the two to disagree.
 */
export async function removeSessionObjects(sessionId) {
  const rows = await listAttachmentsBySession(sessionId);

  await Promise.all(rows.map((row) => removeObject(row.storage_path)));

  return rows.length;
}

// ---------------------------------------------------------------------------
// Claiming them for a round
// ---------------------------------------------------------------------------

/**
 * Turns the `attachmentIds` on a POST /rounds body into rows this user may
 * actually use, or throws.
 *
 * Runs BEFORE the round row is inserted and before anything is spent, alongside
 * `planCouncil` and the entitlement check — an attachment id belonging to
 * somebody else is a 403 the caller gets as the answer to their POST, not a
 * round_failed frame thirty seconds later.
 *
 * ONE 403 FOR THREE CASES: not yours, does not exist, already used. They are
 * indistinguishable on purpose. Separating them would turn this endpoint into
 * an oracle answering "is this uuid somebody's attachment?" for anyone with a
 * session of their own — the same reasoning that makes an unknown share token
 * and a revoked one the same 404 (decision 41).
 */
export async function claimAttachments(attachmentIds, userId) {
  if (!attachmentIds || attachmentIds.length === 0) return [];

  if (attachmentIds.length > MAX_PER_ROUND) {
    throw httpError(
      400,
      'TOO_MANY_ATTACHMENTS',
      `A round may carry at most ${MAX_PER_ROUND} attachments; this one names ${attachmentIds.length}.`,
    );
  }

  const rows = await findClaimableAttachments(attachmentIds, userId);

  if (rows.length !== attachmentIds.length) {
    throw httpError(
      403,
      'ATTACHMENT_NOT_AVAILABLE',
      'One of those attachments does not exist, does not belong to you, or is already on another round.',
    );
  }

  return rows;
}

/** Called once the round row exists. Returns the claimed rows. */
export async function bindAttachmentsToRound(rows, roundId, userId) {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const bound = await attachToRound(ids, roundId, userId);

  if (bound.length !== ids.length) {
    // Two POSTs raced for the same attachment and the other one won. Refusing
    // is right: the file is now on their round, and silently running this one
    // without it would answer a question about an image the model never saw.
    throw httpError(
      409,
      'ATTACHMENT_ALREADY_USED',
      'One of those attachments was attached to another round while this one was starting.',
    );
  }

  return bound;
}

// ---------------------------------------------------------------------------
// Into a prompt
// ---------------------------------------------------------------------------

/**
 * Downloads and base64-encodes the rows, in the shape `callModel`'s `images`
 * parameter has been waiting for since Session 4:
 * `{ mediaType, base64 }`, sent as an OpenAI-compatible `image_url` part with a
 * `data:` URI.
 *
 * Done ONCE per round, not once per drafter: four models on a council would
 * otherwise download the same object four times, and the base64 is identical
 * for all of them.
 */
export async function loadAttachmentParts(rows) {
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      mediaType: row.mime_type,
      kind: isImage(row.mime_type) ? 'image' : 'document',
      sizeBytes: Number(row.size_bytes),
      base64: (await downloadObject(row.storage_path)).toString('base64'),
    })),
  );
}
