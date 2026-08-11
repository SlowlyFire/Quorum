/**
 * The eight session and round endpoints, plus the catalogue, as named calls.
 *
 * A thin layer on `api.*` and deliberately nothing more: no caching, no state,
 * no retries. What it buys is that a path and its query string are written once
 * — `/api/sessions/${id}` appears here and in no component — and that the shape
 * a caller gets back is unwrapped at the boundary rather than in every page
 * (`{ session }` in, a session out).
 *
 * The one call that is NOT here is the stream. An EventSource is a connection
 * with a lifetime rather than a request, so it belongs to the hook that owns
 * that lifetime — see hooks/useRoundStream.js.
 */
import { api } from './client.js';

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/**
 * `{ models, estimate }`. The estimate block is what the council picker
 * multiplies prices by; see the server's modelCatalogueService for why it
 * travels with the prices rather than being restated here.
 */
export async function fetchCatalogue() {
  return api.get('/api/models');
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function listSessions({ limit = 50, offset = 0, search } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (search) params.set('search', search);

  return api.get(`/api/sessions?${params}`);
}

export async function createSession(body) {
  const { session } = await api.post('/api/sessions', body);
  return session;
}

/** Session + every round + every response, in five queries on the server. */
export async function fetchSession(sessionId) {
  const { session } = await api.get(`/api/sessions/${sessionId}`);
  return session;
}

export async function updateSession(sessionId, body) {
  const { session } = await api.patch(`/api/sessions/${sessionId}`, body);
  return session;
}

export async function deleteSession(sessionId) {
  return api.del(`/api/sessions/${sessionId}`);
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

/**
 * 202, not 201 — the row exists and the debate has not happened yet. Returns
 * `{ roundId, sessionId, status, streamUrl }`; watching it is a second call.
 */
export async function startRound(sessionId, { prompt, council } = {}) {
  return api.post(`/api/sessions/${sessionId}/rounds`, council ? { prompt, council } : { prompt });
}

/**
 * The durable record, and the fallback for every stream that has closed: a
 * round's buffer is dropped fifteen minutes after it ends, by design.
 */
export async function fetchRound(roundId) {
  const { round } = await api.get(`/api/rounds/${roundId}`);
  return round;
}
