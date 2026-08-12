/**
 * §Technical Requirements' "external storage for media files", and §8's two
 * attachment endpoints, in numbers. One file, as `config/billing.js` and
 * `config/leaderboard.js` are for theirs.
 */

/** §8: Supabase Storage. Private — every read is a signed URL, never a public
 *  object path. Created by `npm run storage:init` if it does not exist. */
export const BUCKET = 'attachments';

/**
 * 8 MB. The whole file is held in memory by multer and then base64-encoded into
 * a prompt, which inflates it by a third before it is even sent — so this is a
 * bound on request memory and on token spend at once, not just on disk.
 */
export const MAX_BYTES = 8 * 1024 * 1024;

/**
 * How many may ride on one round. A prompt with twelve images is a prompt no
 * model reads well and every drafter pays for N times over.
 */
export const MAX_PER_ROUND = 4;

/**
 * THE ALLOW-LIST IS OF MAGIC BYTES, NOT OF MIME TYPES OR EXTENSIONS.
 *
 * Both of those are the client's to write: a `.png` name and an
 * `image/png` Content-Type are two strings an attacker chooses, and neither has
 * ever been evidence about the bytes behind them. What we store, what we bill a
 * vision model to read, and what we hand back in a signed URL is decided by the
 * first few bytes of the file and nothing else. `sniffMimeType` returns one of
 * these or null, and null is a 415.
 *
 * `offset` is where the signature starts — WebP's RIFF header carries the
 * container's size in bytes 4-7, so its distinguishing 'WEBP' is at 8.
 */
export const SIGNATURES = Object.freeze([
  {
    mimeType: 'image/png',
    extension: 'png',
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  {
    mimeType: 'image/jpeg',
    extension: 'jpg',
    offset: 0,
    // SOI plus the first marker's prefix. The fourth byte varies by encoder
    // (0xE0 JFIF, 0xE1 Exif, 0xDB raw quantisation table), so it is not checked.
    bytes: [0xff, 0xd8, 0xff],
  },
  {
    mimeType: 'image/webp',
    extension: 'webp',
    offset: 0,
    bytes: [0x52, 0x49, 0x46, 0x46], // 'RIFF'
    also: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // 'WEBP'
  },
  {
    mimeType: 'application/pdf',
    extension: 'pdf',
    offset: 0,
    bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], // '%PDF-'
  },
]);

export const ACCEPTED_MIME_TYPES = Object.freeze(SIGNATURES.map((s) => s.mimeType));

/** The extension we give the stored object. Never the client's — see
 *  attachmentService for why the client's filename is not used at all. */
export const EXTENSION_FOR = Object.freeze(
  Object.fromEntries(SIGNATURES.map((s) => [s.mimeType, s.extension])),
);

/**
 * How long a preview link lives. Long enough to open a round and read it,
 * short enough that a URL copied out of devtools and pasted somewhere is dead
 * by the time anyone follows it — which is the entire reason the bucket is
 * private and this is signed rather than public.
 */
export const SIGNED_URL_TTL_SECONDS = 10 * 60;

/**
 * The public share route signs its own, shorter. A shared debate is handed to
 * strangers and stays reachable for as long as the token does, so the image URL
 * inside it must expire far faster than the page that carries it — the reader
 * refetches, and a revoked share stops minting new ones immediately.
 */
export const SHARED_SIGNED_URL_TTL_SECONDS = 5 * 60;
