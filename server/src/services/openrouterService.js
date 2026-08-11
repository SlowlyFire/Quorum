/**
 * The only place the server talks to OpenRouter.
 *
 * One key, one OpenAI-compatible endpoint, every model. Adding a model is a row
 * in `models`; nothing in this file knows which providers exist.
 *
 * Calls are non-streaming. Each debate stage needs the complete output of the
 * previous one before it can begin, so streaming would buy nothing and cost a
 * chunk parser. Session 12's token-by-token final answer is the one place that
 * may ever want `stream: true`, and it can have its own path.
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
 * A text-only turn is a plain string; adding images makes it the
 * OpenAI-compatible parts array. Kept as a string in the common case because
 * some providers still treat a one-element text array differently.
 *
 * Unused until Session 11's attachments — built now so the day attachments land
 * is not also the day this call signature changes.
 */
function buildUserContent(user, images) {
  if (!images || images.length === 0) return user;

  return [
    { type: 'text', text: user },
    ...images.map(({ mediaType, base64 }) => ({
      type: 'image_url',
      image_url: { url: `data:${mediaType};base64,${base64}` },
    })),
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

  const startedAt = process.hrtime.bigint();
  const payload = await postWithOneRetry(body, timeoutMs, modelSlug);
  // Wall clock across every attempt, because that is what the user waited for.
  const latencyMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

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
      `finish=${finishReason ?? 'none'}`,
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
