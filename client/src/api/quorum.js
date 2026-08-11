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
import { BASE_URL, api } from './client.js';

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

/**
 * `verdict` filters on the LATEST round's verdict_type — see the note in the
 * server's sessionModel for why that is the only reading of "sessions with a
 * merged verdict" that produces a stable list. Omitted or 'all' means no filter.
 */
export async function listSessions({ limit = 50, offset = 0, search, verdict } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (search) params.set('search', search);
  if (verdict && verdict !== 'all') params.set('verdict', verdict);

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

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * `{ presets }`. Each carries a `council` block shaped exactly like a session's,
 * which is what lets the picker on /new be filled from either without a
 * translation step — the whole point of a preset.
 */
export async function listPresets() {
  const { presets } = await api.get('/api/presets');
  return presets;
}

export async function createPreset(body) {
  const { preset } = await api.post('/api/presets', body);
  return preset;
}

export async function updatePreset(presetId, body) {
  const { preset } = await api.patch(`/api/presets/${presetId}`, body);
  return preset;
}

export async function deletePreset(presetId) {
  return api.del(`/api/presets/${presetId}`);
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/** Idempotent on the server: calling twice returns the same token rather than
 *  rotating it and breaking a link the user has already sent. */
export async function shareSession(sessionId) {
  return api.post(`/api/sessions/${sessionId}/share`);
}

export async function revokeShare(sessionId) {
  return api.del(`/api/sessions/${sessionId}/share`);
}

/**
 * The public read. The only call in this file that works without a cookie, and
 * the only one whose 404 is a normal outcome rather than a bug — an unknown
 * token and a revoked one are deliberately indistinguishable.
 */
export async function fetchSharedSession(shareToken) {
  const { session } = await api.get(`/api/share/${encodeURIComponent(shareToken)}`);
  return session;
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

/** Balance, mode, 7-day spend, today's free remaining, and the top-up amounts. */
export async function fetchWallet() {
  const { wallet } = await api.get('/api/wallet');
  return wallet;
}

export async function fetchTransactions({ limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });

  return api.get(`/api/wallet/transactions?${params}`);
}

/**
 * Starts a top-up and returns Stripe's hosted Checkout URL. The caller
 * navigates to it — there is no Stripe library in this client, because hosted
 * Checkout is a redirect and a card form here would put the product in PCI
 * scope for no gain.
 */
export async function startCheckout(amount) {
  const { checkout } = await api.post('/api/wallet/checkout', { amount });
  return checkout;
}

/**
 * The CSV export as a plain URL rather than a fetch. An anchor the browser
 * follows carries the session cookie by itself and gets the server's
 * Content-Disposition filename; a fetch would need a Blob, an object URL and a
 * synthetic click to land in the same place, and would name the file itself.
 */
export function transactionsCsvUrl() {
  return `${BASE_URL}/api/wallet/transactions?format=csv`;
}
