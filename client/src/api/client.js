/**
 * The single place the client talks to the API.
 *
 * Two invariants hold for every call made through here:
 *
 * 1. `credentials: 'include'`, because the JWT lives in an httpOnly cookie the
 *    JavaScript cannot read, and the two origins differ in development.
 * 2. Every failure — a 4xx, a 5xx, a body that is not JSON, a server that is
 *    not running — arrives at the caller as an `ApiError`. A component should
 *    never have to tell a `TypeError: Failed to fetch` from a 500.
 */
import { notifications } from '@mantine/notifications';
import { AUTH_FAILURE_CODES } from '../lib/errorMessages.js';

/**
 * Exported because an EventSource cannot go through `request()` — it is a
 * connection rather than a call — and it still has to reach the same origin.
 * useRoundStream builds its URL from this.
 */
export const BASE_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/**
 * Mirrors the server's error envelope: { error: { message, code } }, plus two
 * optional blocks it adds on nothing else — `details`, an array of field
 * complaints from Zod, and `billing`, the numbers behind a 402 from
 * POST /rounds.
 *
 * They are separate properties here because they are separate on the wire and
 * for the same reason: a form reads `details` by field name and would have
 * nowhere to render a balance, while the top-up prompt reads three figures and
 * has no field to attach them to.
 *
 * `status` is 0 for a request that never reached the server, which is the one
 * case where the message is ours rather than the server's.
 */
export class ApiError extends Error {
  constructor(message, status, code, details = null, billing = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.billing = billing;
  }

  /** True when the request never got an answer — server down, DNS, offline. */
  get isNetworkError() {
    return this.status === 0;
  }

  /**
   * The `details` entry for one field, if the server named one.
   * Shape: { in: 'body', field: 'password', message: '...' }
   */
  fieldError(field) {
    return this.details?.find((detail) => detail.field === field)?.message ?? null;
  }
}

/**
 * Paths where a 401 is an answer rather than an accident.
 *
 * `/api/auth/me` returns 401 on every cold load by an anonymous visitor — that
 * is how the bootstrap discovers there is no session — and login returns 401
 * for a wrong password. Redirecting on either would mean the login page
 * redirecting to itself, and the landing page bouncing an anonymous visitor to
 * a login screen they never asked for.
 */
const AUTH_PATHS = ['/api/auth/me', '/api/auth/login', '/api/auth/register', '/api/auth/logout'];

/**
 * Set by AuthContext at mount. Kept as a module-level hook rather than passed
 * per call because a 401 has exactly one remedy — drop the local user and go to
 * /login — and every caller wanting it would be every caller.
 */
let onUnauthorized = null;

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

/**
 * The failures that are about the *system* rather than about what the user
 * typed: the server is unreachable, or it broke. They get a notification here
 * as well as reaching the caller, because they can happen on a call no form is
 * waiting on — the session bootstrap, a background refresh — and those have
 * nowhere to render an inline alert.
 *
 * A 4xx never notifies. "That password is wrong" belongs against the field,
 * and a toast saying it as well is noise.
 */
function notifyTransportFailure(error) {
  notifications.show({
    id: `api-${error.code}`, // dedupes a burst of parallel failures into one
    color: 'red',
    title: error.isNetworkError ? 'Cannot reach the server' : 'Server error',
    message: error.message,
    // Longer than Mantine's 4s default. This one is not an acknowledgement of
    // something the user just did — it can arrive while they are reading — and
    // it is the only signal that the app is not talking to anything.
    autoClose: 8000,
  });
}

export async function request(path, { body, headers, ...options } = {}) {
  const hasBody = body !== undefined;

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    // fetch rejects only for a transport failure: the server is down, the host
    // does not resolve, the browser is offline, or CORS refused the response
    // outright. None of those has a status, so it gets 0.
    const error = new ApiError(
      'Could not reach the server. Check your connection and try again.',
      0,
      'NETWORK_ERROR',
    );

    notifyTransportFailure(error);
    throw error;
  }

  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    /**
     * SIGN OUT ON THE REASON, NOT ON THE STATUS.
     *
     * This used to fire for ANY 401 outside the auth paths. That is safe only
     * for as long as every 401 this API emits happens to be an auth failure —
     * true today, and a trap the first time an endpoint answers 401 for some
     * other reason, because it would silently log out every user who touched it.
     * `AUTH_FAILURE_CODES` names the two codes that actually mean "you are not
     * signed in".
     *
     * Half-authenticated is still the worst state to leave the app in — the
     * shell shows a name and every call fails — so when it IS an auth failure,
     * clearing the user immediately remains right. The whole ApiError is handed
     * over so the notice can say WHY; see signedOutNotice.
     */
    const authFailed =
      response.status === 401 &&
      !AUTH_PATHS.includes(path) &&
      AUTH_FAILURE_CODES.has(payload?.error?.code);

    const error = new ApiError(
      payload?.error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      payload?.error?.code ?? 'UNKNOWN_ERROR',
      payload?.error?.details ?? null,
      payload?.error?.billing ?? null,
    );

    // After the ApiError exists, so the handler receives the code and message
    // and can explain which kind of auth failure this was.
    if (authFailed) onUnauthorized?.(error);

    if (response.status >= 500) notifyTransportFailure(error);

    throw error;
  }

  // 204 No Content — logout and delete both use it.
  return payload;
}

/**
 * The one call in the client that is NOT `fetch`, and the reason is upload
 * progress.
 *
 * `fetch` reports nothing until the request body has finished going out — there
 * is no upload-side progress event, and the streaming request bodies that would
 * give one are not available cross-browser. An 8 MB attachment on a slow
 * connection is several seconds of a UI that has to say something, so this one
 * path uses XMLHttpRequest, which has had `upload.onprogress` for twenty years.
 *
 * Everything else is kept identical to `request()` on purpose: same base URL,
 * same credentials, same `ApiError` out, same notification rule (transport
 * failures and 5xx only). A caller should not be able to tell which transport
 * it got.
 *
 * NO Content-Type HEADER IS SET. The browser writes it itself for a FormData
 * body, including the multipart boundary — setting it by hand produces a
 * boundary-less header and multer rejects the body as malformed.
 */
export function upload(path, formData, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open('POST', `${BASE_URL}${path}`);
    xhr.withCredentials = true;
    xhr.responseType = 'json';

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        // `lengthComputable` is false while the browser is still working out the
        // body size; reporting NaN% for that instant is worse than reporting
        // nothing.
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      });
    }

    const failTransport = () => {
      const error = new ApiError(
        'Could not reach the server. Check your connection and try again.',
        0,
        'NETWORK_ERROR',
      );

      notifyTransportFailure(error);
      reject(error);
    };

    xhr.addEventListener('error', failTransport);
    xhr.addEventListener('timeout', failTransport);
    xhr.addEventListener('abort', () =>
      reject(new ApiError('The upload was cancelled.', 0, 'UPLOAD_ABORTED')),
    );

    xhr.addEventListener('load', () => {
      // responseType 'json' leaves this null when the body was not JSON.
      const payload = xhr.response;

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }

      const error = new ApiError(
        payload?.error?.message ?? `Request failed with status ${xhr.status}`,
        xhr.status,
        payload?.error?.code ?? 'UNKNOWN_ERROR',
        payload?.error?.details ?? null,
        payload?.error?.billing ?? null,
      );

      // Same rule as `request` above, and it has to be the same rule: an upload
      // is the one call that does not go through it, so a divergence here is a
      // second sign-out policy nobody would think to look for.
      if (xhr.status === 401 && AUTH_FAILURE_CODES.has(error.code)) onUnauthorized?.(error);

      if (xhr.status >= 500) notifyTransportFailure(error);

      reject(error);
    });

    xhr.send(formData);
  });
}

export const get = (path, options) => request(path, { ...options, method: 'GET' });
export const post = (path, body, options) => request(path, { ...options, method: 'POST', body });
export const patch = (path, body, options) => request(path, { ...options, method: 'PATCH', body });
export const del = (path, options) => request(path, { ...options, method: 'DELETE' });

export const api = { get, post, patch, del };

/**
 * The envelope's `details` array as { field: message }, for a form that wants
 * to render each server complaint under the box it belongs to.
 * Returns null when the error named no field, which is the alert's cue.
 */
export function fieldErrorMap(error) {
  if (!(error instanceof ApiError) || !error.details?.length) return null;

  return Object.fromEntries(error.details.map((detail) => [detail.field, detail.message]));
}
