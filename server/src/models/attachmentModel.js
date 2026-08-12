/**
 * attachments table — the thirteenth and, with §7's ERD fully covered, last
 * model file. CLAUDE.md has said since Session 2 that it "arrives with the
 * feature that needs it"; this is that session.
 *
 * `round_id` is nullable and starts null. POST /api/attachments uploads the file
 * and returns a signed URL before POST /api/sessions/:id/rounds creates the
 * round it belongs to, so a row exists unattached for the length of that window
 * — migration 001's comment says so, and `attachToRound` below is what closes
 * it.
 */
import { query } from '../db/pool.js';

const COLUMNS = `
  id,
  round_id,
  user_id,
  storage_path,
  mime_type,
  size_bytes,
  created_at
`;

export async function insertAttachment(
  { userId, storagePath, mimeType, sizeBytes },
  exec = query,
) {
  const { rows } = await exec(
    `
      INSERT INTO attachments (user_id, storage_path, mime_type, size_bytes)
      VALUES ($1, $2, $3, $4)
      RETURNING ${COLUMNS}
    `,
    [userId, storagePath, mimeType, sizeBytes],
  );

  return rows[0];
}

export async function findAttachmentById(id, exec = query) {
  const { rows } = await exec(`SELECT ${COLUMNS} FROM attachments WHERE id = $1`, [id]);

  return rows[0] ?? null;
}

/**
 * Every requested id that belongs to this user AND is not already on a round.
 *
 * The two predicates are what makes this safe to call with ids straight off a
 * request body: the caller compares the returned count against what it asked
 * for and raises a 403 or a 409 on the difference, rather than trusting the
 * list. Reusing an attachment across two rounds is refused rather than copied,
 * because `attachments.round_id` is a single column and a second round would
 * silently move the file off the first.
 */
export async function findClaimableAttachments(ids, userId, exec = query) {
  const { rows } = await exec(
    `
      SELECT ${COLUMNS}
      FROM attachments
      WHERE id = ANY($1::uuid[])
        AND user_id = $2
        AND round_id IS NULL
      ORDER BY created_at
    `,
    [ids, userId],
  );

  return rows;
}

export async function listAttachmentsByRound(roundId, exec = query) {
  const { rows } = await exec(
    `SELECT ${COLUMNS} FROM attachments WHERE round_id = $1 ORDER BY created_at`,
    [roundId],
  );

  return rows;
}

/**
 * Every attachment across a session's rounds, in one query — the same reason
 * `listResponsesBySession` exists: reading a twenty-round session must not be
 * twenty-one round trips.
 */
export async function listAttachmentsBySession(sessionId, exec = query) {
  const { rows } = await exec(
    `
      SELECT a.id, a.round_id, a.user_id, a.storage_path, a.mime_type, a.size_bytes, a.created_at
      FROM attachments a
      JOIN rounds r ON r.id = a.round_id
      WHERE r.session_id = $1
      ORDER BY a.created_at
    `,
    [sessionId],
  );

  return rows;
}

/**
 * Claims the rows for a round. Guarded on `round_id IS NULL` as well as on the
 * owner so that two concurrent POSTs naming the same attachment cannot both
 * claim it — the second updates nothing and the caller sees a short count.
 */
export async function attachToRound(ids, roundId, userId, exec = query) {
  const { rows } = await exec(
    `
      UPDATE attachments
      SET round_id = $2
      WHERE id = ANY($1::uuid[])
        AND user_id = $3
        AND round_id IS NULL
      RETURNING ${COLUMNS}
    `,
    [ids, roundId, userId],
  );

  return rows;
}

export async function deleteAttachment(id, exec = query) {
  const { rows } = await exec(`DELETE FROM attachments WHERE id = $1 RETURNING id`, [id]);

  return rows[0] ?? null;
}
