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

const BASE_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/**
 * Mirrors the server's error envelope: { error: { message, code } }, plus the
 * optional `details` array it adds on validation failures only.
 *
 * `status` is 0 for a request that never reached the server, which is the one
 * case where the message is ours rather than the server's.
 */
export class ApiError extends Error {
  constructor(message, status, code, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
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
    if (response.status === 401 && !AUTH_PATHS.includes(path)) {
      // A session that expired mid-visit, or a cookie cleared in another tab.
      // Half-authenticated is the worst state to leave the app in: the shell
      // still shows a name and every call fails.
      onUnauthorized?.();
    }

    const error = new ApiError(
      payload?.error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      payload?.error?.code ?? 'UNKNOWN_ERROR',
      payload?.error?.details ?? null,
    );

    if (response.status >= 500) notifyTransportFailure(error);

    throw error;
  }

  // 204 No Content — logout and delete both use it.
  return payload;
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
