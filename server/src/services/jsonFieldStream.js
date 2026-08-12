/**
 * Reading one string value out of JSON that has not finished arriving.
 *
 * THE PROBLEM THIS SOLVES. `prompts/04-final.md` asks the chairman for an
 * object — `verdict_type`, `changed_from_initial`, `final_answer`,
 * `open_questions` — and `prompts/` is frozen, so streaming stage 4 means
 * streaming JSON. Showing the user JSON assembling itself character by character
 * is worse than showing nothing: they came for an answer and would watch a
 * `{"verdict_type":"pi` appear instead. So the bytes are scanned as they arrive
 * and only the text INSIDE the `final_answer` string is handed on.
 *
 * WHAT THIS IS NOT. It is not a JSON parser, it does not validate, and nothing
 * it produces is authoritative. `parseModelJson` still parses the complete
 * buffer when the stream ends, exactly as it does for a non-streamed call, and
 * that object is the source of truth for everything persisted and everything
 * billed. This produces a PREVIEW — and `verify:streaming` asserts the preview
 * and the parsed value come out byte-identical rather than assuming it.
 *
 * SO IT DEGRADES TO SILENCE, NEVER TO GARBAGE. Every case it does not
 * understand — the key never appears, the value is `null` rather than a string,
 * an escape it cannot decode — ends in the `lost` state, after which `push`
 * returns the empty string forever. The caller stops emitting and the round
 * finishes from the parsed object with nobody any the wiser. There is no failure
 * mode here that can cost a user their debate.
 *
 * RESUMABLE, BECAUSE A CHUNK BOUNDARY FALLS WHERE IT LIKES. `\uD83D` can arrive
 * as `\u`, `D8`, `3D` across three chunks, and `\` and `n` can arrive in
 * different ones. Anything incomplete is held in `pending` and reconsidered when
 * more text turns up, which is why this is a state machine and not a regex over
 * the accumulated buffer.
 */

/** JSON's eight two-character escapes. `\uXXXX` is handled separately. */
const SIMPLE_ESCAPES = Object.freeze({
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
});

const FOUR_HEX = /^[0-9a-fA-F]{4}$/;

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/**
 * seeking  looking for the key
 * colon    found the key, expecting `:`
 * quote    found the colon, expecting the opening `"`
 * reading  inside the string, emitting
 * finished reached the unescaped closing `"`
 * lost     something unexpected; emitting nothing further
 */
const STATE = Object.freeze({
  seeking: 'seeking',
  colon: 'colon',
  quote: 'quote',
  reading: 'reading',
  finished: 'finished',
  lost: 'lost',
});

/**
 * @param field the JSON key whose string value should be streamed out
 * @returns a scanner with `push(chunk) -> decoded text`, plus the state a caller
 *          needs to decide when to stop: `done`, `complete`, `lost`, `chars`.
 */
export function createFieldScanner(field) {
  /**
   * The key WITH its quotes, which is most of why searching for it is safe. A
   * `"final_answer"` occurring inside an earlier string value would have to
   * arrive as `\"final_answer\"` — JSON escapes the quotes — and that does not
   * contain this needle, because the character after `answer` is a backslash.
   * An unquoted mention (`the final_answer field`) does not match either. The
   * residual case is a model emitting invalid JSON with a raw quote inside a
   * string, which fails `parseModelJson` a moment later anyway.
   */
  const key = `"${field}"`;
  /** A partial key may straddle a chunk boundary, so this much tail is kept. */
  const keepWhileSeeking = key.length - 1;

  let state = STATE.seeking;
  let pending = '';
  let chars = 0;

  function push(chunk) {
    if (state === STATE.finished || state === STATE.lost) return '';

    pending += chunk ?? '';

    for (;;) {
      if (state === STATE.seeking) {
        const at = pending.indexOf(key);

        if (at === -1) {
          if (pending.length > keepWhileSeeking) pending = pending.slice(-keepWhileSeeking);
          return '';
        }

        pending = pending.slice(at + key.length);
        state = STATE.colon;
        continue;
      }

      if (state === STATE.colon || state === STATE.quote) {
        const expected = state === STATE.colon ? ':' : '"';
        let i = 0;

        while (i < pending.length && WHITESPACE.has(pending[i])) i += 1;

        if (i === pending.length) {
          // Whitespace only so far. Drop it — it carries nothing — and wait.
          pending = '';
          return '';
        }

        if (pending[i] !== expected) {
          /**
           * `"final_answer": null` lands here, and so does `"final_answer": {`.
           * Both are a chairman that did not answer the question the template
           * asked; validateFinal will reject the object and the retry will run.
           * Nothing to preview either way.
           */
          return giveUp();
        }

        pending = pending.slice(i + 1);
        state = state === STATE.colon ? STATE.quote : STATE.reading;
        continue;
      }

      return read();
    }
  }

  /**
   * Walks the string body. Returns everything it could decode this time round
   * and leaves any incomplete escape in `pending` for the next chunk.
   */
  function read() {
    let i = 0;
    let out = '';

    while (i < pending.length) {
      const character = pending[i];

      if (character === '"') {
        // The unescaped closing quote — every escaped one was consumed below as
        // half of a pair, so reaching this means the value has ended.
        pending = pending.slice(i + 1);
        state = STATE.finished;
        chars += out.length;

        return out;
      }

      if (character !== '\\') {
        /**
         * A raw control character is illegal inside a JSON string, and a model
         * that emits one has produced an object that will not parse. It is
         * passed through rather than treated as a loss: the preview is the only
         * thing the user will ever see of that attempt, and showing the text is
         * better than showing nothing while the retry runs.
         */
        out += character;
        i += 1;
        continue;
      }

      // An escape. The escaped character may not have arrived yet.
      if (i + 1 >= pending.length) break;

      const escaped = pending[i + 1];

      if (escaped === 'u') {
        if (i + 6 > pending.length) break;

        const hex = pending.slice(i + 2, i + 6);

        if (!FOUR_HEX.test(hex)) {
          chars += out.length;
          return out + giveUp();
        }

        /**
         * Surrogate pairs are emitted as two separate code units, in order,
         * possibly in two different frames. Concatenating them on the client
         * reassembles the character, and `JSON.stringify` escapes a lone
         * surrogate rather than corrupting it, so the frame in between is
         * still valid JSON.
         */
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }

      const decoded = SIMPLE_ESCAPES[escaped];

      if (decoded === undefined) {
        chars += out.length;
        return out + giveUp();
      }

      out += decoded;
      i += 2;
    }

    pending = pending.slice(i);
    chars += out.length;

    return out;
  }

  function giveUp() {
    state = STATE.lost;
    pending = '';

    return '';
  }

  return {
    push,
    get state() {
      return state;
    },
    /** Nothing further will ever be emitted — cleanly or otherwise. */
    get done() {
      return state === STATE.finished || state === STATE.lost;
    },
    /** The closing quote was reached, so the preview is the whole value. */
    get complete() {
      return state === STATE.finished;
    },
    get lost() {
      return state === STATE.lost;
    },
    /** How many characters have been handed out. */
    get chars() {
      return chars;
    },
  };
}
