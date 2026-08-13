/**
 * Everything the client knows about an attachment, in one place.
 *
 * THE "COULD NOT SEE IT" MARKER IS DERIVED, NOT STORED. Nothing records per
 * round which model was shown which file — no column, no event, no field on a
 * response row. It does not need one: an attachment's `mimeType` says whether it
 * is an image or a document, a council member's `supportsVision` and
 * `supportsDocuments` say what it accepts, and the engine's rule is exactly the
 * comparison below. `canSee` is that rule restated on this side, and it is the
 * ONLY copy here — the live view and the reloaded one both call it, so they
 * cannot disagree about who was blind.
 *
 * It is a restatement of a server rule, which is a thing this repo normally
 * refuses to do. The alternative was a per-round table recording a fact that is
 * a pure function of two columns already on the wire, and a fact that would then
 * be wrong for every round already run. See docs/decisions.md.
 */

/** The MIME types POST /api/attachments accepts, for the file picker. */
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

/** Kept in step with `server/src/config/attachments.js`. */
export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_PER_ROUND = 4;

export function isImage(attachment) {
  return (attachment?.mimeType ?? '').startsWith('image/');
}

/**
 * @param {{ supportsVision?: boolean, supportsDocuments?: boolean }} model
 *   a council member from a round, or a catalogue row — both carry the two
 *   flags under the same names.
 */
export function canSee(model, attachment) {
  return isImage(attachment) ? model?.supportsVision === true : model?.supportsDocuments === true;
}

/**
 * The council members that were shown less than the whole attachment set.
 *
 * Drafters only. The chairman never receives an attachment — only
 * `server/prompts/01-draft.md` has an `{{ATTACHMENTS}}` block and that directory
 * is frozen — so
 * marking it "could not see this" would be reporting a design decision as a
 * model limitation.
 */
export function blindDrafters(council = [], attachments = []) {
  if (attachments.length === 0) return [];

  return council
    .filter((member) => member.role === 'drafter' || member.role === 'both')
    .filter((member) => attachments.some((attachment) => !canSee(member, attachment)));
}

/** "90 KB", "1.4 MB". Two significant places at MB, none below. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Why an upload was refused, in the words the UI shows. The server says the
 * same things — these are the two it can answer without a round trip, so the
 * user is not made to wait 8 MB to be told the file is 9.
 */
export function localRejection(file) {
  if (file.size > MAX_BYTES) {
    return `${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_BYTES)}.`;
  }

  /**
   * Checked against the browser's guess, which is the same untrustworthy string
   * the server refuses to believe. That is fine HERE: this is a courtesy so a
   * .txt does not cost a round trip, and the decision that matters is still made
   * from the bytes on the server. It must never be the only check, and it is
   * not.
   */
  if (file.type && !ACCEPTED_TYPES.includes(file.type)) {
    return `${file.name} is not a PNG, JPEG, WebP or PDF.`;
  }

  return null;
}
