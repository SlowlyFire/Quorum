/**
 * Server-Sent Events for a running debate.
 *
 * THE RACE THIS EXISTS FOR
 *
 * POST /api/sessions/:id/rounds answers 202 and starts the debate immediately;
 * the client cannot open GET /api/rounds/:id/stream until it has read that
 * response and constructed an EventSource. Events are therefore emitted before
 * anyone is listening — on a fast drafter, `round_started`, `stage_started` and
 * a first `response_ready` can all fire inside that window.
 *
 * So every event is appended to a per-round buffer as well as pushed to whoever
 * is currently connected, and a new subscriber is replayed the whole buffer
 * before it receives a single live frame. Without the buffer the first drafts
 * are lost every single time, and the bug looks like "sometimes draft A never
 * arrives" rather than like a race.
 *
 * Each frame carries a monotonic id, so a client that drops mid-round can send
 * Last-Event-ID and be given only what it missed instead of the round so far.
 *
 * The registry is per-process and in memory. A restart mid-debate orphans the
 * stream: the round still completes and is readable through GET /api/rounds/:id,
 * but its remaining frames go nowhere. Acceptable on a single instance, and the
 * fix if this is ever scaled out is a shared bus (Postgres LISTEN/NOTIFY or
 * Redis) rather than a bigger Map.
 */

/** SSE comment frame. Content-free by design: proxies and Render kill idle
 *  connections, and a comment resets that clock without reaching the client's
 *  message handler. */
const HEARTBEAT_FRAME = ':\n\n';
const HEARTBEAT_MS = 15_000;

/**
 * How long a finished round's buffer is kept so a late or reconnecting client
 * can still replay it. After that the entry is dropped and the endpoint 404s,
 * which is the signal to fetch GET /api/rounds/:id instead — the durable record
 * was written to the database as the round ran, so nothing is lost.
 */
const STREAM_TTL_MS = 15 * 60 * 1000;

/**
 * A bound on memory, not on a real round: four stages over an eight-model
 * council is well under a hundred events. If a future engine ever exceeded it,
 * dropping frames from the replay buffer beats holding a process open, and the
 * log line says which round was truncated.
 */
const MAX_BUFFERED_EVENTS = 1000;

/** After either of these the debate is over and the response is closed. */
const TERMINAL_EVENTS = new Set(['round_complete', 'round_failed']);

/** roundId -> { events, subscribers, status, createdAt, cleanupTimer } */
const streams = new Map();

/**
 * Called by roundService the moment the round row exists and before runRound is
 * launched, so that the buffer is in place before the first event can fire.
 */
export function openStream(roundId) {
  const existing = streams.get(roundId);
  if (existing) return existing;

  const entry = {
    events: [],
    subscribers: new Set(),
    status: 'running',
    createdAt: new Date().toISOString(),
    nextId: 1,
    truncated: false,
    cleanupTimer: null,
  };

  streams.set(roundId, entry);

  return entry;
}

/**
 * The bridge from the engine's `onEvent` to the wire. runRound wraps whatever
 * it is handed so a throw here can never kill a paid-for debate, but there is
 * nothing in this path that should throw in the first place.
 */
export function makeStreamEmitter(roundId) {
  return function onEvent(event, payload) {
    publishEvent(roundId, event, payload);
  };
}

/**
 * Append, then fan out. Appending first is what makes the buffer authoritative:
 * a subscriber that connects between these two statements is impossible,
 * because neither awaits.
 */
export function publishEvent(roundId, event, payload) {
  const entry = streams.get(roundId);

  // A round whose stream has already been cleaned up, or one started by
  // verify:debate rather than by HTTP. Not an error — the database is the
  // durable record and it has already been written.
  if (!entry) return null;

  const frame = {
    id: entry.nextId,
    event,
    data: payload ?? {},
    at: new Date().toISOString(),
  };

  entry.nextId += 1;

  if (entry.events.length < MAX_BUFFERED_EVENTS) {
    entry.events.push(frame);
  } else if (!entry.truncated) {
    entry.truncated = true;
    console.warn(`[stream] ${roundId} exceeded ${MAX_BUFFERED_EVENTS} events — replay truncated`);
  }

  const wire = formatFrame(frame);

  for (const subscriber of entry.subscribers) {
    write(subscriber, wire);
  }

  if (TERMINAL_EVENTS.has(event)) {
    closeStream(roundId, event === 'round_complete' ? 'complete' : 'failed');
  }

  return frame;
}

/**
 * The engine emits `round_failed` itself before rethrowing, so this is only
 * reached when a round died somewhere the engine does not cover — which would
 * otherwise leave every subscriber waiting on a terminal frame that never
 * comes, for as long as the socket stays open. Idempotent: a stream that has
 * already ended is left alone.
 */
export function failStream(roundId, error) {
  const entry = streams.get(roundId);
  if (!entry || entry.status !== 'running') return;

  publishEvent(roundId, 'round_failed', {
    roundId,
    error: `${error?.code ?? 'ERROR'}: ${error?.message ?? 'The round failed'}`,
  });
}

/**
 * Attaches a live listener. Everything already buffered is written first, in
 * order, then the sink joins the fan-out — with no await between the two, so no
 * event can slip through the gap.
 *
 * `sink` is anything with write() and end(); in practice the Express response.
 * The service formats frames and owns the buffer and the heartbeat; it knows
 * nothing about status codes or headers, which stay in the controller.
 *
 * Returns null when there is no stream for that round, so the caller can 404 —
 * an EventSource stops reconnecting on a non-200 and would otherwise retry a
 * dead round every three seconds forever.
 */
export function subscribe(roundId, sink, { lastEventId = 0 } = {}) {
  const entry = streams.get(roundId);
  if (!entry) return null;

  const subscriber = { sink, heartbeat: null, alive: true };

  entry.subscribers.add(subscriber);

  /**
   * A reconnecting client sends the id of the last frame it saw and is given
   * only what followed it. A first-time subscriber sends nothing, lastEventId
   * is 0, and it gets the round from the beginning.
   */
  const missed = entry.events.filter((frame) => frame.id > lastEventId);

  if (missed.length > 0) {
    write(subscriber, missed.map(formatFrame).join(''));
  }

  if (entry.status !== 'running') {
    // The round finished before this client connected. It has just been given
    // the whole record; there is nothing further to send.
    detach(entry, subscriber);
    end(subscriber);

    return { replayed: missed.length, live: false, unsubscribe: () => {} };
  }

  subscriber.heartbeat = setInterval(() => write(subscriber, HEARTBEAT_FRAME), HEARTBEAT_MS);
  // A pending heartbeat must not hold the process open at shutdown.
  subscriber.heartbeat.unref?.();

  return {
    replayed: missed.length,
    live: true,
    /**
     * Wired to req.on('close'). A writer left in the set after its socket has
     * gone is the classic SSE leak: every later frame is written into a dead
     * connection, and the timer keeps the entry referenced for as long as the
     * process lives.
     */
    unsubscribe: () => detach(entry, subscriber),
  };
}

/** For the controller's opening frame, and for tests. */
export function streamState(roundId) {
  const entry = streams.get(roundId);
  if (!entry) return null;

  return {
    status: entry.status,
    bufferedEvents: entry.events.length,
    subscribers: entry.subscribers.size,
    createdAt: entry.createdAt,
    lastEventId: entry.nextId - 1,
  };
}

/** Test and shutdown hook. Not used on any request path. */
export function dropStream(roundId) {
  const entry = streams.get(roundId);
  if (!entry) return;

  clearTimeout(entry.cleanupTimer);

  for (const subscriber of entry.subscribers) {
    detach(entry, subscriber);
    end(subscriber);
  }

  streams.delete(roundId);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * "id: 7\nevent: response_ready\ndata: {…}\n\n".
 *
 * The id goes first so that a client parsing frame-by-frame has it before the
 * data, and the blank line terminates the frame. JSON.stringify cannot emit a
 * newline unescaped, so `data:` is always exactly one line — which is why this
 * does not need the multi-line `data:` folding the SSE grammar allows for.
 */
function formatFrame(frame) {
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

function write(subscriber, text) {
  if (!subscriber.alive) return;

  try {
    subscriber.sink.write(text);
  } catch (error) {
    // A socket that died between the close event and this write. Stop writing
    // to it; req.on('close') will remove it from the set.
    subscriber.alive = false;
    console.warn(`[stream] dropping a subscriber that could not be written to: ${error.message}`);
  }
}

function end(subscriber) {
  try {
    subscriber.sink.end();
  } catch {
    // Already closed by the client. Nothing to do and nothing to report.
  }
}

function detach(entry, subscriber) {
  clearInterval(subscriber.heartbeat);
  subscriber.heartbeat = null;
  entry.subscribers.delete(subscriber);
}

/**
 * Ends every open response, then schedules the entry's removal. The buffer
 * outlives the connections on purpose: a client that reconnects one second
 * after `round_complete` still gets the whole round replayed.
 */
function closeStream(roundId, status) {
  const entry = streams.get(roundId);
  if (!entry) return;

  entry.status = status;

  for (const subscriber of entry.subscribers) {
    detach(entry, subscriber);
    end(subscriber);
  }

  entry.cleanupTimer = setTimeout(() => {
    streams.delete(roundId);
    console.log(`[stream] ${roundId} buffer released after ${STREAM_TTL_MS / 60000} minutes`);
  }, STREAM_TTL_MS);

  entry.cleanupTimer.unref?.();
}

export const STREAM_CONSTANTS = Object.freeze({
  HEARTBEAT_MS,
  STREAM_TTL_MS,
  MAX_BUFFERED_EVENTS,
});
