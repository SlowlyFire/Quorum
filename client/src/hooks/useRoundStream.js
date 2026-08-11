/**
 * Watching one debate happen.
 *
 * The server buffers every frame as well as pushing it, and replays the buffer
 * to a new subscriber before joining it to the fan-out — which is the only
 * reason a client that connects after POST /rounds has returned sees stage 1 at
 * all. Two consequences land here:
 *
 *   * frames arrive twice by design — once replayed, once live, and again after
 *     any reconnect — so every frame carries a monotonic id and this hook
 *     applies each id exactly once. The reducer is idempotent as well, but
 *     belt and braces: a double-applied `response_ready` would render two cards
 *     for one draft.
 *   * a reconnect is cheap. The browser resends `Last-Event-ID` on its own
 *     automatic retry and the server sends only what came after it.
 *
 * WHEN THE STREAM IS NOT THERE. A round's buffer is released fifteen minutes
 * after it ends, and the registry is per-process, so a server restart mid-debate
 * orphans it. Both cases are recoverable and neither is an error: the durable
 * record is in the database, and `GET /api/rounds/:id` returns it. So the hook
 * falls back to polling — immediately on `stream_closed`, and after three
 * failed connections otherwise — rather than showing a broken screen.
 *
 * `withCredentials: true` is load-bearing. The stream is authenticated by the
 * httpOnly cookie exactly like every other route, and in development the client
 * and the API are different origins; without it the browser sends no cookie and
 * the connection is a 401 that EventSource reports only as a bare error.
 */
import { useEffect, useRef, useState } from 'react';

import { BASE_URL } from '../api/client.js';
import { fetchRound } from '../api/quorum.js';
import { applyStreamEvent, liveRoundSeed, roundFromDetail } from '../lib/round.js';

/** The nine the engine emits, plus the one the controller sends by itself. */
const STREAM_EVENTS = [
  'round_started',
  'stage_started',
  'stage_skipped',
  'response_ready',
  'response_failed',
  'verdict',
  'stance',
  'round_complete',
  'round_failed',
  'stream_closed',
];

const TERMINAL_EVENTS = new Set(['round_complete', 'round_failed']);

/**
 * Three, because EventSource retries on its own and most single failures are a
 * dev-server restart that the second attempt fixes. Three consecutive ones mean
 * something that will not fix itself, and polling is strictly better than a
 * fourth attempt: it works against a stream that no longer exists.
 */
const MAX_CONNECTION_FAILURES = 3;

const POLL_INTERVAL_MS = 3000;

/**
 * @param roundId  the round to watch, or null for "nothing is running"
 * @param prompt   the question, known before any frame arrives
 * @param onSettled called once, with the round id, when it completes or fails —
 *                  the cue to refetch the session so the persisted row (with its
 *                  token counts) replaces this live view
 */
export function useRoundStream({ roundId, prompt, onSettled }) {
  const [round, setRound] = useState(null);
  /** connecting | live | polling | closed */
  const [transport, setTransport] = useState('closed');

  // Held in a ref so that changing the callback — which a parent re-renders
  // constantly — cannot tear down and rebuild the connection.
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  useEffect(() => {
    if (!roundId) {
      setRound(null);
      setTransport('closed');
      return undefined;
    }

    const applied = new Set();
    let source = null;
    let pollTimer = null;
    let failures = 0;
    let done = false;

    setRound(liveRoundSeed({ roundId, prompt: promptRef.current }));
    setTransport('connecting');

    const settle = () => {
      if (done) return;
      done = true;
      close();
      onSettledRef.current?.(roundId);
    };

    function close() {
      source?.close();
      source = null;
      clearInterval(pollTimer);
      pollTimer = null;
    }

    function handleFrame(message) {
      const id = Number(message.lastEventId);

      // The whole point of the id. A replay after a reconnect re-sends frames
      // this hook has already folded in.
      if (Number.isFinite(id) && applied.has(id)) return;
      applied.add(id);

      let data;

      try {
        data = JSON.parse(message.data);
      } catch {
        // The server writes every frame with JSON.stringify, so this is
        // unreachable for anything it sent.
        return;
      }

      if (message.type === 'stream_closed') {
        // No buffer for this round: it ended more than fifteen minutes ago, or
        // the process restarted. The record is in the database.
        close();
        startPolling();
        return;
      }

      failures = 0;
      setTransport('live');
      setRound((current) => applyStreamEvent(current ?? liveRoundSeed({ roundId }), { event: message.type, data }));

      if (TERMINAL_EVENTS.has(message.type)) settle();
    }

    function connect() {
      source = new EventSource(`${BASE_URL}/api/rounds/${roundId}/stream`, { withCredentials: true });

      for (const name of STREAM_EVENTS) source.addEventListener(name, handleFrame);

      source.addEventListener('open', () => {
        failures = 0;
        setTransport('live');
      });

      source.addEventListener('error', () => {
        // Fired both for a dropped connection the browser will retry and for
        // one it has given up on; readyState tells them apart. A round that has
        // already finished closed the socket itself, and that is not a failure.
        if (done) return;

        failures += 1;

        if (failures >= MAX_CONNECTION_FAILURES || source?.readyState === EventSource.CLOSED) {
          close();
          startPolling();
          return;
        }

        setTransport('connecting');
      });
    }

    async function poll() {
      try {
        const detail = await fetchRound(roundId);

        setRound(roundFromDetail(detail));

        if (detail.status === 'complete' || detail.status === 'failed') settle();
      } catch {
        // A 401 has already cleared the user through api/client.js, and a 404
        // means the round is gone. Neither is worth a second message on top of
        // the notification the client shows for a transport failure.
      }
    }

    function startPolling() {
      if (done || pollTimer) return;

      setTransport('polling');
      void poll();
      pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    }

    connect();

    /**
     * An EventSource survives the component that made it. Left open it keeps
     * streaming into a dead reducer, holds a server-side subscriber and its
     * heartbeat, and — on the next visit to the page — leaves two connections
     * feeding one view.
     */
    return () => {
      done = true;
      close();
    };
  }, [roundId]);

  return { round, transport };
}
