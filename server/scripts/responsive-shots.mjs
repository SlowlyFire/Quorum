#!/usr/bin/env node
/**
 * Real screenshots and real layout measurements at exact viewport widths.
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
 * Session 19 widened this from a 390/1440 sanity check to the real Android
 * matrix — 320 through 1024 — and added three checks beyond horizontal
 * overflow: elements clipped off the right/left edge, interactive controls
 * under a 44px tap target, and text under 12px. All four are cheap in-page
 * `Runtime.evaluate` calls; nothing here needs a DOM diffing library.
 *
 *   node scripts/responsive-shots.mjs
 *   BASE=http://localhost:4173 OUT=/tmp/shots node scripts/responsive-shots.mjs
 *   WIDTHS=320,360 ROUTES=landing,new node scripts/responsive-shots.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** One apex since Session 24. BASE is the page the browser loads, so it is also
 *  the Origin every API call carries — it must be an origin CORS allows. */
const BASE = process.env.BASE ?? 'https://app.askthequorum.com';
const API = process.env.API ?? 'https://api.askthequorum.com';
const OUT = process.env.OUT ?? path.join(tmpdir(), 'shots');
const PORT = 9333;

const ACCOUNT = {
  email: process.env.EMAIL ?? 'leaderboard-seed@quorum.local',
  password: process.env.PASSWORD ?? 'leaderboard volume, not a study',
};

/**
 * The real Android/tablet matrix (decision: previous sweep only ran 390/1440,
 * which is one Android width off the true minimum and skips every tablet
 * breakpoint). Heights are a plausible viewport for each, chrome UI excluded.
 */
const DEFAULT_WIDTHS = [
  { label: '320', width: 320, height: 640 },
  { label: '360', width: 360, height: 740 },
  { label: '393', width: 393, height: 852 },
  { label: '412', width: 412, height: 915 },
  { label: '768', width: 768, height: 1024 },
  { label: '1024', width: 1024, height: 768 },
];

const WIDTHS = process.env.WIDTHS
  ? process.env.WIDTHS.split(',').map((label) => {
      const found = DEFAULT_WIDTHS.find((w) => w.label === label.trim());
      return found ?? { label: label.trim(), width: Number(label.trim()), height: 900 };
    })
  : DEFAULT_WIDTHS;

/** Every route in the product. `chat` and `shared` are resolved to real ids below. */
const ALL_ROUTES = [
  { name: 'landing', path: '/', auth: false },
  { name: 'login', path: '/login', auth: false },
  { name: 'register', path: '/register', auth: false },
  { name: 'new', path: '/new', auth: true },
  { name: 'chat', path: null, auth: true },
  { name: 'sessions', path: '/sessions', auth: true },
  { name: 'wallet', path: '/wallet', auth: true },
  { name: 'leaderboard', path: '/leaderboard', auth: true },
  { name: 'shared', path: null, auth: false },
];

const ROUTES = process.env.ROUTES
  ? ALL_ROUTES.filter((r) => process.env.ROUTES.split(',').includes(r.name))
  : ALL_ROUTES;

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

/**
 * The in-page measurement. Runs once per (route, width). Returns overflow (as
 * before), plus up to five clipped elements, up to eight sub-44px interactive
 * controls, and up to eight sub-12px text nodes — enough to name the offenders
 * without dumping the whole DOM.
 */
const MEASURE_EXPR = (viewportWidth) => `(() => {
  const vw = ${viewportWidth};
  const de = document.documentElement;

  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '';
    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30);
    return (el.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : '')).slice(0, 70);
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };

  // --- horizontal overflow -------------------------------------------------
  const overflowCandidates = [...document.querySelectorAll('*')]
    .map((el) => ({ w: Math.round(el.getBoundingClientRect().width), el }))
    .filter((x) => x.w > vw + 1);
  overflowCandidates.sort((a, b) => b.w - a.w);
  const widest = overflowCandidates[0] ? { w: overflowCandidates[0].w, cls: describe(overflowCandidates[0].el) } : null;

  // --- clipped off the left/right edge (visible, but partly or wholly outside) ---
  const clipped = [...document.querySelectorAll('button, a, input, select, [role="button"], img, h1, h2, h3, [class*="Card"], [class*="card"]')]
    .filter(visible)
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.right > vw + 1 || r.left < -1)
    .slice(0, 5)
    .map(({ el, r }) => ({ desc: describe(el), left: Math.round(r.left), right: Math.round(r.right) }));

  // --- interactive controls under a 44px tap target ------------------------
  const smallTargets = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="radio"], [role="checkbox"]')]
    .filter(visible)
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => Math.min(r.width, r.height) < 44 && Math.min(r.width, r.height) > 0)
    .slice(0, 8)
    .map(({ el, r }) => ({ desc: describe(el), w: Math.round(r.width), h: Math.round(r.height) }));

  // --- text under 12px -------------------------------------------------------
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const smallText = [];
  let node;
  while ((node = walker.nextNode()) && smallText.length < 8) {
    const el = node.parentElement;
    if (!el || !visible(el)) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px < 12) smallText.push({ desc: describe(el), px: Math.round(px * 10) / 10 });
  }

  return {
    scrollW: de.scrollWidth,
    clientW: de.clientWidth,
    overflow: de.scrollWidth > de.clientWidth + 1,
    widest,
    clipped,
    smallTargets,
    smallText,
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 60),
  };
})()`;

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

  // A real share token, minted the way the product mints one — POSTing to a
  // real session's share endpoint, idempotent, so re-running this costs nothing.
  let shareUrl = null;
  if (newest) {
    const share = await fetch(`${API}/api/sessions/${newest}/share`, {
      method: 'POST',
      headers: { Cookie: cookie },
    }).then((r) => (r.ok ? r.json() : null));
    shareUrl = share?.shareToken ? `/s/${share.shareToken}` : null;
  }

  const routes = ROUTES.map((r) => {
    if (r.name === 'chat') return { ...r, path: newest ? `/chat/${newest}` : null };
    if (r.name === 'shared') return { ...r, path: shareUrl };
    return r;
  }).filter((r) => r.path);

  if (routes.length < ROUTES.length) {
    console.log(`  (skipped ${ROUTES.length - routes.length} route(s) with no id to resolve)`);
  }

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

  async function setAuthCookie() {
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
  }

  async function clearAuthCookie() {
    await client.send('Network.clearBrowserCookies', {}, sessionId);
  }

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
      // Public routes are tested logged OUT — /login and /register redirect an
      // authenticated visitor away via PublicOnlyRoute, which would silently
      // test the wrong page.
      if (route.auth) await setAuthCookie();
      else await clearAuthCookie();

      await client.send('Page.navigate', { url: `${BASE}${route.path}` }, sessionId);
      await wait(3200);

      const { result } = await client.send(
        'Runtime.evaluate',
        { returnByValue: true, expression: MEASURE_EXPR(viewport.width) },
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

  console.log(`\n  ${'route'.padEnd(11)} ${'width'.padEnd(6)} overflow  tapTargets<44  text<12px  widest offender`);
  console.log(`  ${'-'.repeat(100)}`);

  let overflowCount = 0;
  let tapCount = 0;
  let textCount = 0;

  for (const row of rows) {
    if (row.overflow) overflowCount += 1;
    if (row.smallTargets?.length) tapCount += 1;
    if (row.smallText?.length) textCount += 1;

    console.log(
      `  ${row.route.padEnd(11)} ${row.width.padEnd(6)} ${row.overflow ? 'YES     ' : 'no      '}  ` +
        `${String(row.smallTargets?.length ?? 0).padEnd(14)} ${String(row.smallText?.length ?? 0).padEnd(10)} ` +
        `${row.widest ? `${row.widest.w}px ${row.widest.cls}` : '—'}`,
    );

    for (const c of row.clipped ?? []) {
      console.log(`      CLIPPED  left=${c.left} right=${c.right}  ${c.desc}`);
    }
    for (const t of row.smallTargets ?? []) {
      console.log(`      TAP ${t.w}x${t.h}px  ${t.desc}`);
    }
    for (const s of row.smallText ?? []) {
      console.log(`      TEXT ${s.px}px  ${s.desc}`);
    }
  }

  console.log(
    `\n  ${rows.length} page/width combinations — ${overflowCount} with horizontal overflow, ` +
      `${tapCount} with a sub-44px control, ${textCount} with sub-12px text`,
  );
  console.log(`  screenshots in ${OUT}\n`);

  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 2));

  if (overflowCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('responsive-shots failed:', error.message);
  process.exitCode = 1;
});
