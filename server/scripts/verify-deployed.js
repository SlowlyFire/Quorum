#!/usr/bin/env node
/**
 * Proof that the DEPLOYED product works — not localhost.
 *
 * Everything here is checked against the real API over the public internet,
 * with the browser's own `Origin` header set on every request, because the
 * things that break in production are exactly the things localhost cannot see:
 *
 *   * a `SameSite=Lax` cookie is not attached to a cross-site request, so the
 *     user appears to be signed out the instant the page reloads;
 *   * `Access-Control-Allow-Origin: *` is illegal in a credentialed response
 *     and the browser rejects it outright;
 *   * a proxy that buffers a response holds every SSE frame until the round
 *     ends, which does not error — it just delivers a 40-second debate as one
 *     blob, and the live view looks like it produced nothing.
 *
 * The last of those is why this script times every frame rather than counting
 * them. A count passes identically whether the frames trickled or arrived
 * together; only the arrival spread tells them apart.
 *
 * It registers a throwaway account each run and leaves it behind. The debate
 * runs on the free tier, so it costs the wallet nothing and us about $0.01.
 *
 *   npm run verify:deployed
 *   API=https://… CLIENT=https://… npm run verify:deployed
 */
import { randomUUID } from 'node:crypto';

const API = (process.env.API ?? 'https://quorum-production-9200.up.railway.app').replace(/\/+$/, '');
const CLIENT = (process.env.CLIENT ?? 'https://quorum-gal-giladi.vercel.app').replace(/\/+$/, '');

/** The exact header a browser on the client origin would send. */
const ORIGIN = new URL(CLIENT).origin;

const failures = [];

function heading(text) {
  console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);
}

function check(label, passed, note = '') {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`);
  if (!passed) failures.push(label);
}

function truncate(text, length) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > length ? `${oneLine.slice(0, length)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// A client that behaves like the browser: cookie jar, Origin on every call
// ---------------------------------------------------------------------------

function makeClient() {
  let cookie = null;
  let lastSetCookie = null;

  async function request(method, path, body) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Origin: ORIGIN,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const setCookie = response.headers.getSetCookie?.() ?? [];

    for (const value of setCookie) {
      lastSetCookie = value;
      const [pair] = value.split(';');
      if (pair.startsWith('quorum_token=')) cookie = pair;
    }

    const text = await response.text();
    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { rawBody: text };
    }

    return { status: response.status, body: payload, headers: response.headers, setCookie };
  }

  return {
    request,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    get cookie() {
      return cookie;
    },
    get lastSetCookie() {
      return lastSetCookie;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. CORS and the cookie
// ---------------------------------------------------------------------------

async function verifyCorsAndCookie(client, account) {
  heading('1. CORS, and the Set-Cookie a cross-site browser will actually store');

  const preflight = await fetch(`${API}/api/auth/me`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'content-type',
    },
  });

  const allowOrigin = preflight.headers.get('access-control-allow-origin');
  const allowCreds = preflight.headers.get('access-control-allow-credentials');

  console.log(`  OPTIONS ${API}/api/auth/me  ->  ${preflight.status}`);
  console.log(`    access-control-allow-origin:      ${allowOrigin}`);
  console.log(`    access-control-allow-credentials: ${allowCreds}`);
  console.log(`    vary:                             ${preflight.headers.get('vary')}`);

  check('the preflight succeeds', preflight.status >= 200 && preflight.status < 300, String(preflight.status));
  check('it echoes the exact client origin', allowOrigin === ORIGIN, `${allowOrigin} vs ${ORIGIN}`);
  check('and NOT a wildcard, which is illegal with credentials', allowOrigin !== '*');
  check('credentials are allowed', allowCreds === 'true', String(allowCreds));

  /**
   * A foreign origin must never be echoed back. The server holds one allowed
   * origin and returns it whatever was asked, which is what makes the browser
   * — the only thing that can enforce this — refuse the response.
   */
  const foreign = await fetch(`${API}/api/auth/me`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET' },
  });

  check(
    'a foreign Origin is never echoed back to itself',
    foreign.headers.get('access-control-allow-origin') !== 'https://evil.example.com',
    `got ${foreign.headers.get('access-control-allow-origin')}`,
  );

  // -- register -----------------------------------------------------------

  const registered = await client.post('/api/auth/register', {
    email: account.email,
    password: account.password,
    displayName: 'Deployed Verification',
  });

  console.log(`\n  POST /api/auth/register  ->  ${registered.status}`);
  console.log('\n  Set-Cookie, exactly as sent:\n');
  for (const value of registered.setCookie) console.log(`    ${value}`);
  console.log('');

  check('register returns 201', registered.status === 201, String(registered.status));
  check('a user came back', Boolean(registered.body?.user?.id), registered.body?.user?.email);

  const raw = registered.setCookie.find((value) => value.startsWith('quorum_token=')) ?? '';
  const attrs = raw.split(';').map((part) => part.trim());
  const has = (name) => attrs.some((part) => part.toLowerCase() === name.toLowerCase());
  const valueOf = (name) =>
    attrs.find((part) => part.toLowerCase().startsWith(`${name.toLowerCase()}=`))?.split('=')[1];

  check('the token cookie is set', raw.length > 0);
  check('HttpOnly — JavaScript cannot read it', has('HttpOnly'));
  check('Secure — required by SameSite=None, and correct over https anyway', has('Secure'));
  check(
    'SameSite=None — WITHOUT this the browser drops it on every cross-site call',
    (valueOf('SameSite') ?? '').toLowerCase() === 'none',
    valueOf('SameSite'),
  );
  check('Path=/', valueOf('Path') === '/');
  check('Max-Age matches the 7-day token', Number(valueOf('Max-Age')) === 7 * 24 * 60 * 60, valueOf('Max-Age'));

  return registered.body?.user ?? null;
}

// ---------------------------------------------------------------------------
// 2. The cookie is accepted back
// ---------------------------------------------------------------------------

async function verifyMe(client, account) {
  heading('2. GET /api/auth/me with that cookie');

  const me = await client.get('/api/auth/me');

  console.log(`  GET /api/auth/me  ->  ${me.status}`);
  console.log(`  ${JSON.stringify(me.body?.user)}`);

  check('200, not 401 — the cookie survived the round trip', me.status === 200, String(me.status));
  check('it is the account we just registered', me.body?.user?.email === account.email);
  check('the wire shape has no password hash on it', !JSON.stringify(me.body ?? {}).includes('$2b$'));

  const anonymous = await fetch(`${API}/api/auth/me`, { headers: { Origin: ORIGIN } });

  check('and without the cookie it is 401', anonymous.status === 401, String(anonymous.status));

  return me.body?.user ?? null;
}

// ---------------------------------------------------------------------------
// 3 & 4. A real debate, and whether the frames trickle or arrive as one blob
// ---------------------------------------------------------------------------

/**
 * Reads the SSE body off the socket and records the wall-clock arrival of every
 * frame. The timings ARE the test: a proxy that buffers still delivers every
 * frame, so a count proves nothing and only the spread tells them apart.
 */
async function readStream(client, roundId, onFrame) {
  const startedAt = Date.now();

  const response = await fetch(`${API}/api/rounds/${roundId}/stream`, {
    headers: { Origin: ORIGIN, ...(client.cookie ? { Cookie: client.cookie } : {}) },
  });

  const frames = [];

  if (!response.ok || !response.body) {
    await response.text().catch(() => {});
    return { status: response.status, frames, headers: response.headers };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let boundary;

    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      if (raw.startsWith(':')) continue;

      const frame = { atMs: Date.now() - startedAt };

      for (const line of raw.split('\n')) {
        const separator = line.indexOf(':');
        const field = line.slice(0, separator);
        const text = line.slice(separator + 1).replace(/^ /, '');

        if (field === 'id') frame.id = Number(text);
        else if (field === 'event') frame.event = text;
        else if (field === 'data') frame.data = text;
      }

      if (!frame.event) continue;

      try {
        frame.payload = JSON.parse(frame.data);
      } catch {
        frame.payload = {};
      }

      frames.push(frame);
      onFrame?.(frame);
    }
  }

  return { status: response.status, frames, headers: response.headers };
}

async function verifyDebate(client) {
  heading('3. A real debate on the deployed API, watched frame by frame');

  const catalogue = await client.get('/api/models');

  check('GET /api/models works with the cookie', catalogue.status === 200, String(catalogue.status));

  const models = catalogue.body?.models ?? [];

  console.log(`  catalogue: ${models.length} active models`);
  for (const model of models) console.log(`    ${model.slug.padEnd(34)} $${model.inputPer1k}/1k in`);

  check('the models seed is present in the production database', models.length >= 3, `${models.length} models`);

  const by = (slug) => models.find((model) => model.slug === slug);
  const wanted = ['google/gemini-2.5-flash', 'anthropic/claude-haiku-4.5', 'meta-llama/llama-4-maverick']
    .map(by)
    .filter(Boolean);

  const council = wanted.length === 3 ? wanted : models.slice(0, 3);

  const session = await client.post('/api/sessions', {
    title: 'Deployed verification',
    council: { modelIds: council.map((model) => model.id), chairmanId: council[0].id },
  });

  check('POST /api/sessions returns 201', session.status === 201, String(session.status));

  const sessionId = session.body?.session?.id;

  console.log(`\n  session ${sessionId}, chairman ${council[0].displayName}`);

  const started = await client.post(`/api/sessions/${sessionId}/rounds`, {
    prompt:
      'A team is deciding whether to run their own Postgres or use a managed one. ' +
      'Give a clear recommendation and say what would change it.',
  });

  check('POST /rounds returns 202', started.status === 202, String(started.status));

  const roundId = started.body?.roundId;

  console.log(`  round ${roundId} — billed as ${started.body?.billing?.mode}`);

  const openedAt = Date.now();
  const { status, frames, headers } = await readStream(client, roundId, (frame) => {
    if (frame.event === 'round_started' || frame.event === 'stage_started') {
      console.log(`    +${String(frame.atMs).padStart(6)}ms  ${frame.event} ${frame.payload.stage ?? ''}`);
    }
  });

  const totalMs = Date.now() - openedAt;

  check('the stream opened', status === 200, String(status));
  check(
    'Cache-Control carries no-transform, the compression opt-out',
    (headers.get('cache-control') ?? '').includes('no-transform'),
    headers.get('cache-control'),
  );
  check(
    'X-Accel-Buffering: no, which is what asks a proxy not to buffer',
    headers.get('x-accel-buffering') === 'no',
    headers.get('x-accel-buffering'),
  );
  check(
    'the stream is CORS-enabled too — EventSource is cross-site like everything else',
    headers.get('access-control-allow-origin') === ORIGIN,
    headers.get('access-control-allow-origin'),
  );

  // -- did they trickle, or arrive together? -------------------------------

  const first = frames[0];
  const last = frames[frames.length - 1];
  const complete = frames.find((frame) => frame.event === 'round_complete');
  const spreadMs = last.atMs - first.atMs;
  const gaps = frames.slice(1).map((frame, index) => frame.atMs - frames[index].atMs);
  const biggestGap = Math.max(...gaps);

  console.log(`\n  ${frames.length} frames over ${totalMs}ms`);
  console.log(`    first frame at   +${first.atMs}ms`);
  console.log(`    last frame at    +${last.atMs}ms`);
  console.log(`    arrival spread    ${spreadMs}ms  (${((spreadMs / totalMs) * 100).toFixed(1)}% of the stream's life)`);
  console.log(`    largest gap       ${biggestGap}ms between consecutive frames`);

  /**
   * THE BUFFERING TEST. If Railway's proxy held the response, every frame lands
   * in the same few milliseconds at the end — the count is identical, the
   * timings are not. Requiring the spread to be most of the stream's life is
   * the assertion a frame count cannot make.
   */
  check(
    'FRAMES ARRIVED PROGRESSIVELY, not as one blob at the end',
    spreadMs > totalMs * 0.5,
    `${spreadMs}ms of spread across a ${totalMs}ms stream`,
  );
  check(
    'and there was real time between frames — a buffered stream has none',
    biggestGap > 500,
    `largest gap ${biggestGap}ms`,
  );
  check('the round completed', Boolean(complete), complete ? 'round_complete' : 'no terminal frame');

  return { roundId, frames, totalMs, council };
}

function verifyStreaming({ frames, totalMs }) {
  heading('4. STREAM_FINAL_ANSWER — the final answer arriving token by token');

  const deltas = frames.filter((frame) => frame.event === 'final_delta');
  const done = frames.filter((frame) => frame.event === 'final_done');
  const complete = frames.find((frame) => frame.event === 'round_complete');

  if (deltas.length === 0) {
    check(
      'final_delta frames arrived — if this fails, STREAM_FINAL_ANSWER is off in production',
      false,
      'no delta frames; the answer arrived only with round_complete',
    );
    return;
  }

  const text = deltas.map((frame) => frame.payload.text ?? '').join('');
  const bytes = deltas.reduce((total, frame) => total + Buffer.byteLength(frame.data, 'utf8'), 0);
  const firstAt = deltas[0].atMs;
  const lastAt = deltas[deltas.length - 1].atMs;

  console.log(`  final_delta frames: ${deltas.length}`);
  console.log(`  bytes on the wire:  ${bytes}, carrying ${text.length} characters of answer`);
  console.log(`  first delta at      +${firstAt}ms`);
  console.log(`  last delta at       +${lastAt}ms`);
  console.log(`  round_complete at   +${complete?.atMs}ms`);
  console.log(`  head start:         ${complete ? complete.atMs - firstAt : '?'}ms of answer before the round settled`);

  console.log('\n  the answer assembling — the growing edge of each snapshot:');
  for (const fraction of [0.15, 0.4, 0.7, 1]) {
    const upTo = Math.max(1, Math.round(deltas.length * fraction));
    const soFar = deltas
      .slice(0, upTo)
      .map((frame) => frame.payload.text ?? '')
      .join('');

    console.log(
      `    +${String(deltas[upTo - 1].atMs).padStart(6)}ms  ${String(upTo).padStart(3)} frames  ` +
        `${String(soFar.length).padStart(5)} chars  …${truncate(soFar.slice(-64), 64)}`,
    );
  }

  check('final_delta frames arrived — STREAM_FINAL_ANSWER is on in production', deltas.length > 0, `${deltas.length} frames`);
  check('final_done exactly once', done.length === 1, String(done.length));
  check('the scanner closed the string cleanly', done[0]?.payload?.complete === true);
  check(
    'the deltas were SPREAD OVER TIME, not flushed together at the end',
    lastAt - firstAt > 300,
    `${lastAt - firstAt}ms between the first and last delta`,
  );
  check(
    'the answer began before the round ended',
    complete ? firstAt < complete.atMs : false,
    complete ? `${complete.atMs - firstAt}ms of head start` : 'no round_complete',
  );

  const parsedFrame = frames.find(
    (frame) => frame.event === 'response_ready' && frame.payload.stage === 'final',
  );
  const parsed = parsedFrame ? JSON.parse(parsedFrame.payload.content).finalAnswer : null;

  check(
    'THE STREAMED TEXT IS THE PARSED final_answer, character for character',
    parsed !== null && text === parsed,
    text === parsed ? `${text.length} chars` : `streamed ${text.length} vs parsed ${parsed?.length}`,
  );
  check(
    'and round_complete carried the same answer',
    complete?.payload?.finalAnswer === parsed,
  );

  return { deltas: deltas.length, chars: text.length, firstAt, completeAt: complete?.atMs, totalMs };
}

// ---------------------------------------------------------------------------
// 5. Stripe — the checkout session against the live webhook
// ---------------------------------------------------------------------------

async function verifyCheckout(client) {
  heading('5. Stripe Checkout on the deployed API');

  /** `{ wallet: { balance, mode, … } }` — the balance is a level down. */
  const wallet = await client.get('/api/wallet');
  const before = Number(wallet.body?.wallet?.balance ?? 0);

  check('GET /api/wallet works', wallet.status === 200, String(wallet.status));
  console.log(
    `  balance before: $${before.toFixed(6)} (${wallet.body?.wallet?.mode}, ` +
      `${wallet.body?.wallet?.freeRemaining} free round(s) left today)`,
  );

  const checkout = await client.post('/api/wallet/checkout', { amount: 5 });

  check('POST /api/wallet/checkout returns 201', checkout.status === 201, String(checkout.status));

  const url = checkout.body?.checkout?.url;

  check('Stripe is configured in production — no 503', checkout.status !== 503, checkout.body?.error?.code ?? 'configured');
  check('a hosted Checkout url came back', typeof url === 'string' && url.includes('checkout.stripe.com'));

  console.log(`\n  amount: $${checkout.body?.checkout?.amount}`);
  console.log(`  session: ${checkout.body?.checkout?.id}`);
  console.log(`\n  PAY IT: ${url}`);
  console.log('  card 4242 4242 4242 4242, any future expiry, any CVC, any postcode.\n');

  return { url, balanceBefore: before, sessionId: checkout.body?.checkout?.id };
}

/**
 * A card cannot be typed from a script, so the run ends by printing the exact
 * command that proves the webhook fired — rather than describing it and leaving
 * whoever comes next to reconstruct a cookie by hand.
 */
function printBalanceRecheck(account, checkout) {
  const login =
    `curl -s -i -X POST ${API}/api/auth/login -H 'Content-Type: application/json' ` +
    `-H 'Origin: ${ORIGIN}' -d '${JSON.stringify({ email: account.email, password: account.password })}'`;

  console.log('  Confirm the webhook credited it:\n');
  console.log(`    COOKIE=$(${login} \\\n      | grep -i '^set-cookie' | sed 's/.*\\(quorum_token=[^;]*\\).*/\\1/')`);
  console.log(`    curl -s ${API}/api/wallet -H "Cookie: $COOKIE" -H 'Origin: ${ORIGIN}'`);
  console.log(`\n  balance was $${checkout.balanceBefore.toFixed(2)}; after a $5 payment it must read 5.\n`);
}

// ---------------------------------------------------------------------------

async function main() {
  const account = {
    email: `deployed-verify-${randomUUID().slice(0, 8)}@example.com`,
    password: 'verify the deployed product',
  };

  console.log('Quorum — verifying the DEPLOYED product\n');
  console.log(`  API:    ${API}`);
  console.log(`  CLIENT: ${CLIENT}`);
  console.log(`  Origin sent on every request: ${ORIGIN}`);
  console.log(`  throwaway account: ${account.email}`);

  const client = makeClient();

  await verifyCorsAndCookie(client, account);
  await verifyMe(client, account);

  const round = await verifyDebate(client);
  verifyStreaming(round);

  const checkout = await verifyCheckout(client);

  heading('Result');

  if (failures.length === 0) {
    console.log('  All automated checks passed.\n');
  } else {
    console.log(`  ${failures.length} FAILED:`);
    for (const failure of failures) console.log(`    - ${failure}`);
    console.log('');
    process.exitCode = 1;
  }

  console.log('  Still manual — a card cannot be typed from here:');
  console.log(`    1. open the Checkout url above`);
  console.log('    2. pay with 4242 4242 4242 4242\n');

  printBalanceRecheck(account, checkout);
}

main().catch((error) => {
  console.error('\nverify:deployed could not finish:', error);
  process.exitCode = 1;
});
