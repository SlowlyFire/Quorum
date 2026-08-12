/**
 * Starting a debate, reading one back, and watching one happen.
 *
 * The stream handler is the one place in the server that writes to `res`
 * directly rather than returning a body, because SSE is a response that stays
 * open. Even there the split holds: the controller owns the HTTP — status,
 * headers, and tearing down on disconnect — while every decision about what to
 * send, in what order, and to whom lives in roundStreamService.
 */
import * as roundService from '../services/roundService.js';
import { STREAM_CONSTANTS, subscribe } from '../services/roundStreamService.js';

/**
 * 202 Accepted, not 201: the round row exists, but the thing the caller asked
 * for — a debate — has not happened yet. The client follows `streamUrl` to
 * watch it, or polls `GET /api/rounds/:id`.
 */
export async function startRound(req, res, next) {
  try {
    const result = await roundService.startRound({
      session: req.resource,
      userId: req.user.id,
      prompt: req.body.prompt,
      council: req.body.council,
      attachmentIds: req.body.attachmentIds,
    });

    res.status(202).json(result);
  } catch (error) {
    next(error);
  }
}

export async function getRound(req, res, next) {
  try {
    res.json({ round: await roundService.getRoundDetail(req.resource.id) });
  } catch (error) {
    next(error);
  }
}

/**
 * Ownership applies to the stream exactly as it does to everything else: this
 * runs behind requireAuth and requireOwnership, so a user cannot watch someone
 * else's debate. EventSource cannot set an Authorization header, which is one
 * more reason the JWT lives in a cookie — the browser attaches it to this GET
 * without the client doing anything.
 */
export function streamRound(req, res) {
  const roundId = req.resource.id;

  /**
   * Browsers send Last-Event-ID on their own automatic reconnects. The query
   * parameter is the manual equivalent, for a client that reconnects
   * deliberately — and it is what makes resume testable with curl.
   */
  const headerId = Number.parseInt(req.get('Last-Event-ID') ?? '', 10);
  const lastEventId = Number.isInteger(headerId) ? headerId : (req.query.lastEventId ?? 0);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    /**
     * `no-transform` is not decoration. It is the documented opt-out honoured by
     * the `compression` middleware, which would otherwise buffer this response
     * and hold every frame until the round ended — SSE dying silently, and
     * looking exactly like a debate that produced nothing. No compression
     * middleware is mounted today; this route must keep working on the day one
     * is, and the app.js comment says the same thing from the other side.
     */
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    /** nginx and Render buffer proxied responses by default. */
    'X-Accel-Buffering': 'no',
  });

  // Headers out before the first frame, so a client that connects to a round
  // mid-stage sees the connection open rather than waiting on the next event.
  res.flushHeaders();

  /**
   * The reconnect interval the client should use if the connection drops. Sent
   * as a bare SSE field before any event, which is where the grammar allows it.
   */
  res.write(`retry: ${STREAM_CONSTANTS.HEARTBEAT_MS / 5}\n\n`);

  const subscription = subscribe(roundId, res, { lastEventId });

  if (!subscription) {
    /**
     * No buffer for this round: it finished more than STREAM_TTL_MS ago, or the
     * process restarted mid-debate and took the registry with it. Say so and
     * close rather than holding a socket open on a stream that will never
     * produce a frame. The durable record is in the database, so the client's
     * remedy is GET /api/rounds/:id — which is what this frame tells it.
     */
    res.write(
      `event: stream_closed\ndata: ${JSON.stringify({
        roundId,
        reason: 'No live stream for this round. Fetch GET /api/rounds/:id for the full record.',
      })}\n\n`,
    );
    res.end();

    return;
  }

  console.log(
    `[stream] ${roundId} subscriber attached — replayed ${subscription.replayed} buffered event(s)`,
  );

  /**
   * A writer left in the subscriber set after its socket has gone is the
   * classic SSE memory leak: every later frame is written into a dead
   * connection and the heartbeat keeps the entry alive for the life of the
   * process. 'close' fires for a client that navigated away, a network drop,
   * and our own res.end() alike, so one listener covers all three.
   */
  req.on('close', () => {
    subscription.unsubscribe();
    console.log(`[stream] ${roundId} subscriber detached`);
  });
}
