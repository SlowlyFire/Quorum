/**
 * Turning a model's text back into an object.
 *
 * Stages 2, 3 and 4 all ask for "only a JSON object, no markdown fence, no
 * preamble", and models comply most of the time. This is what handles the rest:
 * a fence the model added anyway, a sentence of throat-clearing before the
 * brace, or trailing commentary after the closing one.
 *
 * It parses; it does not judge. Whether the object has the keys a stage needs
 * is that stage's business.
 */
import { httpError } from '../lib/httpError.js';

/**
 * The first fenced block in the text, with or without a language tag. Lazy so
 * ```json { ... } ``` followed by prose does not swallow the prose.
 */
const FENCED_BLOCK = /```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/;

export function parseModelJson(content) {
  const text = typeof content === 'string' ? content.trim() : '';

  if (text) {
    const unfenced = stripFence(text);

    // In order of preference: the whole thing, then the whole thing minus the
    // fence, then whatever sits between the outermost braces of either.
    const candidates = [unfenced, outermostObject(unfenced), outermostObject(text)];

    for (const candidate of candidates) {
      const parsed = tryParseObject(candidate);
      if (parsed) return parsed;
    }
  }

  const error = httpError(
    502,
    'MODEL_JSON_INVALID',
    'The model returned a response that could not be read as JSON',
  );

  /**
   * The raw text rides along for `model_responses.error_text`, which is where
   * the orchestrator records a stage that failed to parse. errorHandler emits
   * `message`, `code` and validation `details` only, so this never reaches a
   * client — it exists to be stored and read later.
   */
  error.rawContent = typeof content === 'string' ? content : String(content ?? '');

  throw error;
}

function stripFence(text) {
  const fenced = FENCED_BLOCK.exec(text);
  return fenced ? fenced[1].trim() : text;
}

/**
 * First `{` to last `}`. Crude on purpose — it is the fallback for text that
 * has already failed to parse cleanly, and a brace-counting walk would still
 * lose to a `{` inside a string literal.
 */
function outermostObject(text) {
  if (!text) return null;

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');

  return first === -1 || last <= first ? null : text.slice(first, last + 1);
}

/**
 * Every stage prompt asks for an object, so `"maybe"` and `42` are parse
 * successes that would fail two lines later in the caller. Rejecting them here
 * means a stage reads its own keys off something that has them.
 */
function tryParseObject(candidate) {
  if (!candidate) return null;

  try {
    const value = JSON.parse(candidate);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
