/**
 * The only place the server talks to OpenRouter.
 *
 * One key, one OpenAI-compatible endpoint, every model. Adding a model is a row
 * in `models`; nothing in this file knows which providers exist.
 *
 * TWO CALL PATHS, AND WHICH ONE A STAGE GETS IS NOT A DETAIL.
 *
 * `callModel` is non-streaming and is what stages 1, 2 and 3 use. Each of those
 * feeds the next stage, which cannot begin until the previous output is
 * complete, so streaming them would buy nothing and cost a chunk parser on
 * every one.
 *
 * `callModelStreaming` is Session 14's, and stage 4 is its only caller. The
 * final answer goes straight to the user rather than into another prompt, which
 * makes it the one place in a debate where tokens arriving early are worth
 * anything. It is a SECOND function rather than a flag on the first, so a
 * caller that does not want deltas cannot accidentally get a different code
 * path: `callModel` sends exactly the body it sent in Session 4.
 *
 * Both return the identical shape and both settle through `settleCall`, which
 * is the only place cost and tokens are read off a response. The wallet debits
 * `usage.cost` and it must not matter which path produced it — the only
 * difference is WHERE the usage block arrives, which on a streamed call is the
 * last SSE message rather than the whole body.
 *
 * Nothing here logs prompt or completion text. A debate is a user's question
 * and four models' answers to it; the log gets slugs, timings, tokens and cost.
 */
import { env } from '../config/env.js';
import { httpError } from '../lib/httpError.js';
import { findModelBySlug } from '../models/llmModel.js';

const CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';

/**
 * A debate stage is slow by nature — a chairman reading three drafts and
 * writing a verdict is routinely 20s, and a slow provider under load is worse.
 * 30s would abort calls that were going to succeed, and an aborted call is
 * billed just the same.
 */
const REQUEST_TIMEOUT_MS = 90_000;

/** The catalogue is 400 rows of JSON off a CDN, not an inference call. */
const CATALOGUE_TIMEOUT_MS = 30_000;

const RETRY_BACKOFF_MS = 2_000;

/**
 * Retry 429 and 5xx once, and nothing else. A 400 is a malformed request, a 401
 * a bad key, a 402 an empty OpenRouter account and a 404 a slug that does not
 * exist — none of them become true on a second attempt, and an inference call
 * that is retried is an inference call that may be billed twice.
 *
 * A timeout is not retried either: the ceiling is 90s, and a second attempt
 * would make a stalled stage cost the user three minutes before failing.
 */
function isRetryable(status) {
  return status === 429 || status >= 500;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    // OpenRouter attributes usage to these two on its dashboard and rankings.
    'HTTP-Referer': env.CLIENT_URL,
    'X-Title': 'Quorum',
  };
}

/**
 * A text-only turn is a plain string; adding attachments makes it the
 * OpenAI-compatible parts array. Kept as a string in the common case because
 * some providers still treat a one-element text array differently.
 *
 * Session 4 built this against images and Session 11 gave it callers. The
 * parameter is still named `images` — it is what every caller has always passed
 * — but an item may now carry `kind: 'document'`, and that changes the part it
 * becomes:
 *
 *   image     { type: 'image_url', image_url: { url: 'data:…' } }
 *   document  { type: 'file',      file: { filename, file_data: 'data:…' } }
 *
 * A PDF is NOT an image_url with a different media type. OpenRouter routes the
 * two through different upstream shapes and the set of models accepting a
 * `file` part is smaller than the set accepting an image — which is why
 * `models.supports_documents` exists alongside `supports_vision`, and why
 * deciding which parts a given model gets is the caller's job (debateService),
 * not this function's.
 *
 * `filename` is synthesised. We never store the client's, because it is
 * attacker-controlled and we have no use for it; OpenRouter wants a name on the
 * part, so it gets an honest one.
 */
function buildUserContent(user, images) {
  if (!images || images.length === 0) return user;

  return [
    { type: 'text', text: user },
    ...images.map(({ mediaType, base64, kind }, index) => {
      const dataUri = `data:${mediaType};base64,${base64}`;

      if (kind === 'document') {
        return {
          type: 'file',
          file: { filename: `attachment-${index + 1}.pdf`, file_data: dataUri },
        };
      }

      return { type: 'image_url', image_url: { url: dataUri } };
    }),
  ];
}

/**
 * One model, one question, one answer.
 *
 * Returns exactly:
 *   { content, promptTokens, completionTokens, cost, latencyMs, finishReason, raw }
 *
 * `cost` is real dollars from OpenRouter's own accounting where it is present,
 * and computed from the `models` table where it is not. `raw` is the whole
 * response body, so a caller that needs a field this shape does not carry has
 * it without a second call.
 *
 * `timeoutMs` is an override for tests and the verification script; every
 * production caller leaves it alone.
 */
export async function callModel({
  modelSlug,
  system,
  user,
  maxTokens = 1200,
  temperature = 0.7,
  images = [],
  reasoning = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!modelSlug || !user) {
    // A programming fault, not a provider fault: a 500, not a mapped 502.
    throw new Error('callModel requires modelSlug and user');
  }

  const body = {
    model: modelSlug,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: buildUserContent(user, images) },
    ],
    max_tokens: maxTokens,
    temperature,
    stream: false,
    // No usage:{include:true}, no stream_options. Usage accounting is automatic
    // on OpenRouter and both of those parameters are deprecated no-ops.
  };

  /**
   * OpenRouter's `reasoning` control — `{ effort: 'low' | 'medium' | 'high' }`
   * or `{ max_tokens: n }` — omitted entirely unless a caller asks for it, so
   * the default request body is byte-identical to what Sessions 4 and 5 sent.
   *
   * Support varies by model and by which upstream OpenRouter routes to, and the
   * parameter cuts both ways: on a model that reasons by default it lowers the
   * budget, and on one that does not it can switch reasoning ON. Measure before
   * adopting; Session 6's experiment did, and did not adopt.
   */
  if (reasoning) body.reasoning = reasoning;

  const startedAt = process.hrtime.bigint();
  const payload = await postWithOneRetry(body, timeoutMs, modelSlug);
  // Wall clock across every attempt, because that is what the user waited for.
  const latencyMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

  return settleCall(payload, modelSlug, latencyMs);
}

/**
 * The same call, with the completion delivered as it is generated.
 *
 * Stage 4 is the only caller, and `onDelta(text)` is handed each `delta.content`
 * fragment exactly as OpenRouter emitted it — raw model output, not a preview of
 * anything. Deciding what a user should be shown of that is debateService's job;
 * this function's job is to hand the fragments over in order and then produce
 * the identical `{ content, promptTokens, completionTokens, cost, latencyMs,
 * finishReason, raw }` a non-streamed call would have produced, so that
 * persistence and billing downstream cannot tell the two apart.
 *
 * `onDelta` IS TELEMETRY AND CANNOT FAIL THE CALL. It is wrapped, and one throw
 * disables it for the rest of the call rather than aborting a generation the
 * user has already been quoted for. The debate engine wraps its own emitter for
 * the same reason; this is the second of the two nets.
 */
export async function callModelStreaming({
  modelSlug,
  system,
  user,
  maxTokens = 1200,
  temperature = 0.7,
  images = [],
  reasoning = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
  onDelta = null,
}) {
  if (!modelSlug || !user) {
    throw new Error('callModelStreaming requires modelSlug and user');
  }

  const body = {
    model: modelSlug,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: buildUserContent(user, images) },
    ],
    max_tokens: maxTokens,
    temperature,
    stream: true,
    /**
     * No `usage: { include: true }` and no `stream_options`. Both are documented
     * as deprecated no-ops — OpenRouter includes full usage automatically, in
     * the LAST SSE message on a streamed call. That placement is the one thing
     * about this path the wallet depends on, so `readStream` keeps the last
     * usage block it sees rather than the first.
     */
  };

  if (reasoning) body.reasoning = reasoning;

  let sink = typeof onDelta === 'function' ? onDelta : null;

  const emitDelta = (text) => {
    if (!sink) return;

    try {
      sink(text);
    } catch (error) {
      sink = null;
      console.warn(`[openrouter] ${modelSlug} onDelta threw and was disabled: ${error.message}`);
    }
  };

  const startedAt = process.hrtime.bigint();
  const payload = await streamWithOneRetry(body, timeoutMs, modelSlug, emitDelta);
  const latencyMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

  return settleCall(payload, modelSlug, latencyMs, `stream=${payload.streamChunks} chunks`);
}

/**
 * Cost, tokens, the log line and the empty-completion guard — for both call
 * paths, because the wallet debits what this function reads and a second copy
 * of it is a second place for that to be got wrong.
 *
 * `payload` is a chat completion body. A streamed call does not receive one, so
 * `readStream` builds the same shape out of its chunks; that is what lets this
 * function stay ignorant of which path it is settling.
 */
async function settleCall(payload, modelSlug, latencyMs, note = '') {
  const choice = payload?.choices?.[0];

  if (!choice) {
    throw providerError(
      502,
      'OPENROUTER_UNAVAILABLE',
      'The model returned no completion',
      { modelSlug, providerStatus: 200 },
    );
  }

  const usage = payload.usage ?? {};
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;

  const { cost, source } = await resolveCost(usage, modelSlug, promptTokens, completionTokens);

  const finishReason = choice.finish_reason ?? null;
  const content = choice.message?.content ?? '';

  // Logged before the guard below, so a call that produced nothing still appears
  // in the log with whatever it cost.
  console.log(
    `[openrouter] ${modelSlug} ${latencyMs}ms tokens=${promptTokens}/${completionTokens} ` +
      `cost=${cost === null ? 'unknown' : `$${cost.toFixed(8)}`} source=${source} ` +
      `finish=${finishReason ?? 'none'}${note ? ` ${note}` : ''}`,
  );

  /**
   * An upstream failure dressed as a success. OpenRouter answers 200 with
   * `finish_reason: 'error'`, zero tokens and empty content when the provider it
   * routed to fell over — observed from google/gemini-2.5-flash after 20s.
   *
   * Returning that as a success is worse than failing: the caller has to infer
   * from an empty string that nothing happened, and the debate engine would
   * count it toward its two-draft quorum and send the chairman a headed but
   * empty draft. The usage figures ride on the error so the caller can still
   * record what the call cost — a failed call is billed like any other.
   */
  if (finishReason === 'error' || content.trim() === '') {
    throw providerError(
      502,
      'OPENROUTER_UNAVAILABLE',
      `The model returned no usable content (finish reason: ${finishReason ?? 'none'})`,
      {
        modelSlug,
        providerStatus: 200,
        usage: { promptTokens, completionTokens, cost, latencyMs, provider: payload.provider ?? null },
      },
    );
  }

  return {
    content,
    promptTokens,
    completionTokens,
    cost,
    latencyMs,
    finishReason,
    raw: payload,
  };
}

/**
 * The whole model catalogue — 400-odd rows. Used by a refresh script to keep
 * the `models` table's prices honest; never called at boot, and never on a
 * request path.
 */
export async function fetchCatalogue() {
  const { ok, status, body } = await send(
    CATALOGUE_URL,
    { method: 'GET', headers: authHeaders() },
    CATALOGUE_TIMEOUT_MS,
  );

  if (!ok) throw mapHttpFailure(status, body, CATALOGUE_URL);

  return body?.data ?? [];
}

/**
 * OpenRouter bills the call and reports what it charged, so `usage.cost` is the
 * number the wallet debits — not an estimate from our own price table, which
 * goes stale the moment a provider changes a price.
 *
 * The fallback exists because a debate that answered must not fail to be
 * billed, and it says loudly which path produced the figure.
 */
async function resolveCost(usage, modelSlug, promptTokens, completionTokens) {
  if (typeof usage.cost === 'number') return { cost: usage.cost, source: 'usage' };

  console.warn(
    `[openrouter] ${modelSlug} returned no usage.cost — falling back to the models table`,
  );

  try {
    const row = await findModelBySlug(modelSlug);

    if (!row) {
      console.warn(`[openrouter] ${modelSlug} is not in the models table — cost unknown`);
      return { cost: null, source: 'unknown' };
    }

    const cost =
      (promptTokens / 1000) * Number(row.input_per_1k) +
      (completionTokens / 1000) * Number(row.output_per_1k);

    return { cost, source: 'models-table' };
  } catch (cause) {
    // The call succeeded; a database hiccup must not turn it into a failure.
    console.warn(`[openrouter] cost lookup failed for ${modelSlug}: ${cause.message}`);
    return { cost: null, source: 'unknown' };
  }
}

async function postWithOneRetry(body, timeoutMs, modelSlug) {
  const request = { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) };

  for (let attempt = 0; attempt <= 1; attempt += 1) {
    const { ok, status, body: payload } = await send(CHAT_COMPLETIONS_URL, request, timeoutMs, modelSlug);

    if (ok) return payload;

    if (attempt === 0 && isRetryable(status)) {
      console.warn(`[openrouter] ${modelSlug} returned ${status} — one retry in ${RETRY_BACKOFF_MS}ms`);
      await delay(RETRY_BACKOFF_MS);
      continue;
    }

    throw mapHttpFailure(status, payload, modelSlug);
  }

  // Unreachable: the loop either returns or throws on its second pass.
  throw providerError(502, 'OPENROUTER_UNAVAILABLE', 'The model provider could not be reached', {
    modelSlug,
  });
}

/**
 * The streaming twin of postWithOneRetry, and it retries in exactly one place:
 * on a non-2xx STATUS, which is known from the response headers before a single
 * delta has been handed to the caller. Once the body is being read the retry is
 * off the table — a second attempt would replay a second answer into a client
 * that is already rendering the first, and the user would watch the final answer
 * restart itself.
 */
async function streamWithOneRetry(body, timeoutMs, modelSlug, emitDelta) {
  const request = { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) };

  for (let attempt = 0; attempt <= 1; attempt += 1) {
    const controller = new AbortController();
    // One deadline for the whole call, the stream read included — a provider
    // that opens a connection and then stalls mid-answer hangs a stage exactly
    // as effectively as one that never answers.
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;

    try {
      response = await fetch(CHAT_COMPLETIONS_URL, { ...request, signal: controller.signal });
    } catch (cause) {
      clearTimeout(timer);
      throw transportFailure(cause, controller, timeoutMs, modelSlug);
    }

    if (!response.ok) {
      const payload = await readErrorBody(response);
      clearTimeout(timer);

      if (attempt === 0 && isRetryable(response.status)) {
        console.warn(
          `[openrouter] ${modelSlug} returned ${response.status} — one retry in ${RETRY_BACKOFF_MS}ms`,
        );
        await delay(RETRY_BACKOFF_MS);
        continue;
      }

      throw mapHttpFailure(response.status, payload, modelSlug);
    }

    if (!response.body) {
      clearTimeout(timer);
      throw providerError(502, 'OPENROUTER_UNAVAILABLE', 'The model returned an empty stream', {
        modelSlug,
        providerStatus: response.status,
      });
    }

    try {
      return await readStream(response.body, modelSlug, emitDelta);
    } catch (cause) {
      if (cause.code) throw cause;
      throw transportFailure(cause, controller, timeoutMs, modelSlug);
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable: the loop either returns or throws on its second pass.
  throw providerError(502, 'OPENROUTER_UNAVAILABLE', 'The model provider could not be reached', {
    modelSlug,
  });
}

/**
 * The SSE body, turned back into the chat completion body a non-streamed call
 * would have returned.
 *
 * Three things about the wire format that a naive reader gets wrong:
 *
 *   * OpenRouter sends `: OPENROUTER PROCESSING` comment lines to keep the
 *     connection alive. They are not JSON and `JSON.parse` on one throws, which
 *     is why every line starting with `:` is skipped before anything else.
 *   * The terminator is the literal `data: [DONE]`, not JSON either.
 *   * THE USAGE BLOCK IS IN THE LAST MESSAGE, not the first. A reader that took
 *     the first chunk's `usage` would debit every streamed round zero, which is
 *     a billing hole that no test of the visible output would ever notice — so
 *     the last one seen wins, and verify:streaming asserts the row has tokens
 *     and a cost on it.
 */
async function readStream(stream, modelSlug, emitDelta) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let content = '';
  let usage = null;
  let finishReason = null;
  let provider = null;
  let id = null;
  let model = null;
  let streamError = null;
  let chunks = 0;

  const consumeLine = (line) => {
    // A comment (the keep-alive) or the blank line between frames.
    if (line === '' || line.startsWith(':')) return;
    // OpenRouter sends no id:/event:/retry: fields, but the grammar allows them.
    if (!line.startsWith('data:')) return;

    const data = line.slice(5).trim();

    if (data === '' || data === '[DONE]') return;

    let chunk;

    try {
      chunk = JSON.parse(data);
    } catch {
      // Not something we sent and not something we can use. The finish_reason
      // and empty-content guards in settleCall catch the consequences.
      return;
    }

    chunks += 1;

    id ??= chunk.id ?? null;
    model ??= chunk.model ?? null;
    if (chunk.provider) provider = chunk.provider;
    // Last one wins — see the note above.
    if (chunk.usage) usage = chunk.usage;
    if (chunk.error) streamError = chunk.error;

    const choice = chunk.choices?.[0];

    if (!choice) return;

    if (choice.finish_reason) finishReason = choice.finish_reason;

    const text = choice.delta?.content;

    if (typeof text === 'string' && text !== '') {
      content += text;
      emitDelta(text);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline;

      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        consumeLine(line);
      }
    }

    // A final line with no trailing newline, plus whatever the decoder held.
    consumeLine((buffer + decoder.decode()).replace(/\r$/, '').trim());
  } finally {
    reader.cancel().catch(() => {});
  }

  if (streamError) {
    throw providerError(502, 'OPENROUTER_UNAVAILABLE', 'The model failed part-way through its answer', {
      modelSlug,
      providerStatus: 200,
      detail: providerMessage({ error: streamError }),
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            cost: typeof usage.cost === 'number' ? usage.cost : null,
            provider,
          }
        : undefined,
    });
  }

  /**
   * Shaped exactly like a non-streamed body, so `settleCall` — and everything
   * downstream that reads `raw.provider` — cannot tell which path it came from.
   * `streamChunks` is the one addition, and it exists so the log line can say
   * how many deltas a call produced.
   */
  return {
    id,
    model,
    provider,
    object: 'chat.completion',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: finishReason },
    ],
    usage: usage ?? {},
    streamed: true,
    streamChunks: chunks,
  };
}

async function readErrorBody(response) {
  const text = await response.text().catch(() => '');

  try {
    return JSON.parse(text);
  } catch {
    return { rawBody: text };
  }
}

/** The abort/transport split `send` makes, reused by the streaming path. */
function transportFailure(cause, controller, timeoutMs, modelSlug) {
  if (controller.signal.aborted) {
    const deadline = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;

    return providerError(504, 'OPENROUTER_TIMEOUT', `The model did not respond within ${deadline}`, {
      modelSlug,
      cause,
    });
  }

  return providerError(502, 'OPENROUTER_UNAVAILABLE', 'The model provider could not be reached', {
    modelSlug,
    cause,
  });
}

/**
 * One HTTP round trip, with the timeout covering the body read as well as the
 * headers — a provider that accepts a connection and then stalls mid-response
 * hangs a stage just as effectively as one that never answers.
 *
 * Returns the status and parsed body rather than throwing on a non-2xx, so the
 * retry decision is made in one place above. Only transport failures throw.
 */
async function send(url, request, timeoutMs, modelSlug = url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...request, signal: controller.signal });
    const text = await response.text();

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // A proxy's HTML error page, or an empty body. The status still maps.
      body = { rawBody: text };
    }

    return { ok: response.ok, status: response.status, body };
  } catch (cause) {
    if (controller.signal.aborted) {
      const deadline = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;

      throw providerError(504, 'OPENROUTER_TIMEOUT', `The model did not respond within ${deadline}`, {
        modelSlug,
        cause,
      });
    }

    throw providerError(502, 'OPENROUTER_UNAVAILABLE', 'The model provider could not be reached', {
      modelSlug,
      cause,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Provider status to ours. The mapping is not the identity, and the two places
 * it deviates are the point of it:
 *
 * - OpenRouter's 401 is our key being wrong, not the user's session. Passing it
 *   through would tell the client to log in again over a fault it cannot fix.
 * - OpenRouter's 402 is our platform account out of credit. Ours is a user's
 *   wallet out of credit, which the wallet will use. Two different problems
 *   must not share a status.
 */
function mapHttpFailure(status, payload, modelSlug) {
  const detail = providerMessage(payload);

  if (status === 400) {
    return providerError(502, 'OPENROUTER_BAD_REQUEST', 'The model provider rejected the request', {
      modelSlug,
      providerStatus: status,
      detail,
    });
  }

  if (status === 404) {
    return providerError(502, 'OPENROUTER_BAD_REQUEST', 'That model is not available', {
      modelSlug,
      providerStatus: status,
      detail,
    });
  }

  if (status === 401 || status === 403) {
    return providerError(502, 'OPENROUTER_AUTH', 'The model provider rejected our credentials', {
      modelSlug,
      providerStatus: status,
      detail,
    });
  }

  if (status === 402) {
    return providerError(
      503,
      'OPENROUTER_INSUFFICIENT_CREDIT',
      'The model provider account is out of credit',
      { modelSlug, providerStatus: status, detail },
    );
  }

  if (status === 429) {
    return providerError(429, 'OPENROUTER_RATE_LIMIT', 'The model provider is rate limiting us', {
      modelSlug,
      providerStatus: status,
      detail,
    });
  }

  return providerError(502, 'OPENROUTER_UNAVAILABLE', 'The model provider is unavailable', {
    modelSlug,
    providerStatus: status,
    detail,
  });
}

/**
 * Every message above is fixed text. errorHandler suppresses the message of a
 * 500 in production but not of a 502, so the provider's own words — which for a
 * 402 read "your balance is $0.13" — are attached as fields instead. Nothing
 * emits them; they are for the development log and for `error_text`.
 */
function providerError(status, code, message, { modelSlug, providerStatus, detail, cause, usage } = {}) {
  const error = httpError(status, code, message, cause ? { cause } : undefined);

  error.modelSlug = modelSlug;
  if (providerStatus !== undefined) error.providerStatus = providerStatus;
  if (detail) error.providerMessage = detail;
  /** Present only when the failed call still reported tokens or cost. */
  if (usage) error.usage = usage;

  return error;
}

function providerMessage(payload) {
  if (!payload) return null;
  if (typeof payload.error === 'string') return payload.error;

  return payload.error?.message ?? payload.message ?? payload.rawBody ?? null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
