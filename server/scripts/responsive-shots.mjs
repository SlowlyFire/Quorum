#!/usr/bin/env node
/**
 * Real screenshots and real overflow measurements at exact viewport widths.
 *
 * WHY THIS EXISTS RATHER THAN "RESIZE THE BROWSER". The browser-automation
 * extension reports a successful resize and leaves `innerWidth` untouched, and
 * Chrome enforces a minimum window width well above 390px anyway — so a
 * responsive pass driven that way measures whatever width the window happened to
 * be, which is the one thing it must not do. `Emulation.setDeviceMetricsOverride`
 * sets the viewport the layout engine actually uses, so media queries fire at
 * the width asked for.
 *
 * No dependencies: Chrome speaks CDP over a WebSocket and Node 22 has one built
 * in. Launch headless with a throwaway profile, set the auth cookie, override
 * the metrics, navigate, measure, capture.
 *
 *   node scripts/responsive-shots.mjs
 *   BASE=http://localhost:4173 OUT=/tmp/shots node scripts/responsive-shots.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE ?? 'http://localhost:4173';
const API = process.env.API ?? 'https://quorum-production-9200.up.railway.app';
const OUT = process.env.OUT ?? path.join(tmpdir(), 'shots');
const PORT = 9333;

const ACCOUNT = {
  email: process.env.EMAIL ?? 'leaderboard-seed@quorum.local',
  password: process.env.PASSWORD ?? 'leaderboard volume, not a study',
};

/** Width, and the pages worth looking at on each. */
const WIDTHS = [
  { label: '390', width: 390, height: 844 },
  { label: '1440', width: 1440, height: 900 },
];

const ROUTES = [
  { name: 'landing', path: '/', auth: false },
  { name: 'login', path: '/login', auth: false },
  { name: 'notfound', path: '/definitely-not-real', auth: false },
  { name: 'sessions', path: '/sessions', auth: true },
  { name: 'new', path: '/new', auth: true },
  { name: 'wallet', path: '/wallet', auth: true },
  { name: 'leaderboard', path: '/leaderboard', auth: true },
  { name: 'chat', path: null, auth: true }, // resolved to the newest session below
];

// ---------------------------------------------------------------------------
// A very small CDP client
// ---------------------------------------------------------------------------

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);

    if (!entry) return;

    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });

  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = nextId++;

      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close: () => socket.close(),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  mkdirSync(OUT, { recursive: true });

  // --- a real session cookie, from a real login ---------------------------
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ACCOUNT),
  });

  if (!login.ok) throw new Error(`login failed: ${login.status}`);

  const raw = (login.headers.getSetCookie?.() ?? []).find((v) => v.startsWith('quorum_token='));
  const token = raw?.split(';')[0].split('=')[1];

  if (!token) throw new Error('no quorum_token in the login response');

  const cookie = raw.split(';')[0];
  const sessions = await fetch(`${API}/api/sessions?limit=1`, {
    headers: { Cookie: cookie },
  }).then((r) => r.json());

  const newest = sessions?.sessions?.[0]?.id;
  const routes = ROUTES.map((r) => (r.name === 'chat' ? { ...r, path: newest ? `/chat/${newest}` : null } : r))
    .filter((r) => r.path);

  // --- headless chrome ----------------------------------------------------
  const profile = path.join(tmpdir(), `quorum-shots-${Date.now()}`);
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ]);

  let version = null;

  for (let i = 0; i < 40 && !version; i += 1) {
    await wait(250);
    version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
  }

  if (!version) throw new Error('chrome did not expose a debugging port');

  const client = connect(version.webSocketDebuggerUrl);
  await client.ready;

  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });

  await client.send('Page.enable', {}, sessionId);
  await client.send('Network.enable', {}, sessionId);

  const apiHost = new URL(API).hostname;

  /**
   * The cookie's attributes have to match the ones the API actually set, or the
   * browser stores it and never sends it. Production is `Secure; SameSite=None`
   * because the client and API are different sites; a local API is plain http
   * and `Lax`. Deriving both from the API's scheme is what lets this script run
   * against either without a flag.
   */
  const secureApi = new URL(API).protocol === 'https:';

  await client.send(
    'Network.setCookie',
    {
      name: 'quorum_token',
      value: token,
      domain: apiHost,
      path: '/',
      httpOnly: true,
      secure: secureApi,
      sameSite: secureApi ? 'None' : 'Lax',
    },
    sessionId,
  );

  const rows = [];

  for (const viewport of WIDTHS) {
    await client.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 2,
        mobile: viewport.width < 700,
      },
      sessionId,
    );

    for (const route of routes) {
      await client.send('Page.navigate', { url: `${BASE}${route.path}` }, sessionId);
      await wait(3200);

      const { result } = await client.send(
        'Runtime.evaluate',
        {
          returnByValue: true,
          expression: `(() => {
            const de = document.documentElement;
            const over = [...document.querySelectorAll('*')]
              .map(el => ({ w: Math.round(el.getBoundingClientRect().width),
                            cls: String(el.className || el.tagName).slice(0, 34) }))
              .filter(x => x.w > ${viewport.width} + 1)
              .sort((a, b) => b.w - a.w)[0] || null;
            return {
              scrollW: de.scrollWidth, clientW: de.clientWidth,
              overflow: de.scrollWidth > de.clientWidth + 1,
              widest: over,
              text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 60),
            };
          })()`,
        },
        sessionId,
      );

      const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const file = path.join(OUT, `${route.name}-${viewport.label}.png`);

      writeFileSync(file, Buffer.from(shot.data, 'base64'));

      rows.push({ route: route.name, width: viewport.label, ...result.value, file });
    }
  }

  client.close();
  chrome.kill();

  console.log(`\n  ${'route'.padEnd(12)} ${'width'.padEnd(6)} ${'scrollW'.padEnd(8)} ${'clientW'.padEnd(8)} overflow  widest offender`);
  console.log(`  ${'-'.repeat(86)}`);

  let bad = 0;

  for (const row of rows) {
    if (row.overflow) bad += 1;
    console.log(
      `  ${row.route.padEnd(12)} ${row.width.padEnd(6)} ${String(row.scrollW).padEnd(8)} ` +
        `${String(row.clientW).padEnd(8)} ${row.overflow ? 'YES     ' : 'no      '}  ` +
        `${row.widest ? `${row.widest.w}px ${row.widest.cls}` : '—'}`,
    );
  }

  console.log(`\n  ${rows.length} page/width combinations, ${bad} with horizontal overflow`);
  console.log(`  screenshots in ${OUT}\n`);

  if (bad > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('responsive-shots failed:', error.message);
  process.exitCode = 1;
});
