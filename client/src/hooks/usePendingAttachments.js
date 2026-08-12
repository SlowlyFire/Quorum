import { useCallback, useEffect, useRef, useState } from 'react';

import { deleteAttachment, uploadAttachment } from '../api/quorum.js';
import { MAX_PER_ROUND, localRejection } from '../lib/attachments.js';

/**
 * The files staged against the composer, from "chosen" to "on a round".
 *
 * UPLOADING HAPPENS ON CHOOSE, NOT ON SEND. An 8 MB PNG should be going up while
 * the question is still being typed; by the time Send is pressed there is an id
 * to name in the body and the round starts immediately. Deferring the upload to
 * Send would mean a Send button that hangs for several seconds on a slow
 * connection and a round that fails for a reason belonging to the file.
 *
 * That choice is what makes the two housekeeping jobs below necessary. Removing
 * a staged file deletes a real object from the bucket, and abandoning the page
 * with files staged leaves rows nothing points at — see `clear` and the unmount
 * effect.
 *
 * Every item is one shape at every stage, so the chip renders one thing:
 *
 *   { key, name, sizeBytes, mimeType, kind, previewUrl,
 *     progress?, id?, signedUrl?, error? }
 *
 * `key` is local and stable from the moment the file is chosen; `id` only
 * appears once the server has the bytes. The chip keys on `key ?? id` precisely
 * so a card does not remount when the id arrives.
 */
export function usePendingAttachments() {
  const [items, setItems] = useState([]);

  /**
   * The live list, for the unmount cleanup. A cleanup that closed over `items`
   * would run against whatever the array was when the effect last ran, which is
   * exactly the wrong moment.
   */
  const latest = useRef(items);
  latest.current = items;

  const update = useCallback((key, patch) => {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }, []);

  const attach = useCallback(
    async (files) => {
      /**
       * The cap is applied against what is already staged, and the excess is
       * dropped silently rather than reported: the button is already disabled at
       * the limit, so reaching here means a multi-select that overshot, and a
       * red alert for "we took the first four" is louder than the fact deserves.
       */
      const room = MAX_PER_ROUND - latest.current.length;
      const accepted = files.slice(0, Math.max(0, room));

      const staged = accepted.map((file) => {
        const rejection = localRejection(file);

        return {
          key: `${file.name}-${file.size}-${crypto.randomUUID()}`,
          name: file.name,
          sizeBytes: file.size,
          mimeType: file.type,
          /**
           * A local preview, so the thumbnail is there before a byte has left
           * the machine. Revoked in `remove`, `clear` and on unmount — an
           * object URL holds the whole file in memory until it is.
           */
          previewUrl: rejection ? null : URL.createObjectURL(file),
          progress: rejection ? undefined : 0,
          error: rejection,
          file,
        };
      });

      setItems((current) => [...current, ...staged]);

      await Promise.all(
        staged
          .filter((item) => !item.error)
          .map(async (item) => {
            try {
              const attachment = await uploadAttachment(item.file, {
                onProgress: (fraction) => update(item.key, { progress: Math.min(fraction, 0.99) }),
              });

              /**
               * `progress: 1` rather than undefined: the chip reads
               * `progress < 1` as "still going", and deleting the key would make
               * a finished upload indistinguishable from one that never started.
               */
              update(item.key, { ...attachment, progress: 1, error: null });
            } catch (error) {
              update(item.key, { error: error.message, progress: undefined });
            }
          }),
      );
    },
    [update],
  );

  /**
   * Removing a staged file deletes the object, because it exists: the upload
   * already happened. A failed one has nothing on the server and is only
   * forgotten.
   *
   * The row goes from the list first and the DELETE is fired after, unawaited.
   * The user asked for the chip to go away, and making that wait on a round trip
   * — or worse, undoing it when the round trip fails — would be a UI arguing
   * with them about a file they have already dismissed. A DELETE that fails
   * leaves an unreferenced row, which the session sweep and the round's own
   * lifecycle both tolerate.
   */
  const remove = useCallback((item) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);

    setItems((current) => current.filter((staged) => staged.key !== item.key));

    if (item.id) {
      void deleteAttachment(item.id).catch(() => {
        // Nothing to tell the user: from their point of view it is gone, and it
        // is — the round they are about to start will not name it.
      });
    }
  }, []);

  /**
   * Called once the ids are on a round. The objects now belong to the round, so
   * nothing is deleted — only the local previews are released.
   */
  const clear = useCallback(() => {
    for (const item of latest.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }

    setItems([]);
  }, []);

  useEffect(
    () => () => {
      for (const item of latest.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    },
    [],
  );

  /** The ids to send with the round: uploaded, and not the failed ones. */
  const readyIds = items.filter((item) => item.id && !item.error).map((item) => item.id);

  return { items, attach, remove, clear, readyIds };
}
