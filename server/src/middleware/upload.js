/**
 * The one multipart parser in the product, and the only middleware that reads a
 * request body `express.json()` does not.
 *
 * MEMORY STORAGE, NOT DISK. The file's whole journey is: arrive, get sniffed,
 * go to Supabase, get base64-encoded into a prompt. It is never served from
 * here and never needed after the response, so a temp file would be a path to
 * clean up, a disk to fill and a second place the bytes exist. 8 MB in memory
 * is the trade, and `limits` below is what keeps it 8.
 *
 * NO `fileFilter`. multer's filter runs on the declared mime type and the
 * filename, which are the two things about an upload nobody should believe —
 * `attachmentService.sniffMimeType` reads the bytes instead. A filter here
 * would be a check that looks like a defence and is not one, and the next
 * person to read this file would reasonably assume the type had been verified.
 */
import multer from 'multer';

import { MAX_BYTES } from '../config/attachments.js';
import { httpError } from '../lib/httpError.js';
import { tooLarge } from '../services/attachmentService.js';

const parser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    /**
     * One file, and nothing else in the form. A round takes several attachments
     * by uploading several times, which keeps a failure attributable to one
     * file rather than to a batch. The field caps are there so a multipart body
     * cannot be a thousand tiny parts.
     */
    files: 1,
    fields: 2,
    parts: 4,
  },
});

/**
 * `upload.single('file')` with multer's errors translated into our envelope.
 *
 * The one that matters is LIMIT_FILE_SIZE: multer aborts the stream partway
 * through, and its default is a 500 with a bare message. §Attachments asks for
 * a 413 in our envelope, and this is where it becomes one — `tooLarge()` is
 * shared with the service so the two paths cannot quote different limits.
 */
export function uploadSingleFile(req, res, next) {
  parser.single('file')(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') return next(tooLarge());

      // multer's message names the field and the limit, never the file's
      // contents, so it is safe to pass through and it is the only thing that
      // says which of the caps was hit.
      return next(httpError(400, 'INVALID_UPLOAD', `Malformed upload: ${error.message}`));
    }

    return next(error);
  });
}
