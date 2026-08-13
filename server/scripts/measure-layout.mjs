#!/usr/bin/env node
/**
 * Measures the left and right margin of every major block on a page, at exact
 * viewport widths, so "is it centred" is answered with numbers rather than by
 * eye.
 *
 * Same CDP harness as responsive-shots.mjs and for the same reason: the
 * browser-automation extension cannot set a viewport, and a layout question
 * asked at the wrong width answers a different question.
 *
 *   node scripts/measure-layout.mjs                     # landing, 1440 + 1920
 *   PATHS=/,/leaderboard WIDTHS=1440,1920 node scripts/measure-layout.mjs
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE ?? 'http://localhost:5173';
const API = process.env.API ?? 'http://localhost:3000';
const PATHS = (process.env.PATHS ?? '/').split(',');
const WIDTHS = (process.env.WIDTHS ?? '1440,1920').split(',').map(Number);
const PORT = 9455;

const ACCOUNT = {
  email: process.env.EMAIL ?? 'leaderboard-seed@quorum.local',
  password: process.env.PASSWORD ?? 'leaderboard volume, not a study',
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  const s = new WebSocket(url);
  const p = new Map();
  let id = 1;
  const ready = new Promise((res, rej) => {
    s.addEventListener('open', res, { once: true });
    s.addEventListener('error', rej, { once: true });
  });
  s.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const q = p.get(m.id);
    if (!q) return;
    p.delete(m.id);
    m.error ? q.reject(new Error(m.error.message)) : q.resolve(m.result);
  });
  return {
    ready,
    send: (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const i = id++;
        p.set(i, { resolve: res, reject: rej });
        s.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    close: () => s.close(),
  };
}

/**
 * Runs in the page. Picks the blocks a reader would perceive as "sections" —
 * direct children of the main content column, plus anything that declares its
 * own max-width — and reports where each one starts and ends.
 */
const MEASURE = (width) => `(() => {
  const vw = ${width};
  const seen = new Set();
  const rows = [];

  const record = (el, label) => {
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 24) return;
    const key = Math.round(r.left) + ':' + Math.round(r.width) + ':' + label;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      label,
      left: Math.round(r.left),
      right: Math.round(vw - r.right),
      width: Math.round(r.width),
      centred: Math.abs(Math.round(r.left) - Math.round(vw - r.right)) <= 1,
    });
  };

  // Every Mantine Container, every element with an explicit max-width, and the
  // top-level sections of the page.
  document.querySelectorAll('[class*="mantine-Container-root"]').forEach((el) => record(el, 'Container'));
  document.querySelectorAll('main, section, header').forEach((el) => record(el, el.tagName.toLowerCase()));

  [...document.querySelectorAll('*')].forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.maxWidth && cs.maxWidth !== 'none' && parseFloat(cs.maxWidth) > 300) {
      record(el, 'max-width:' + cs.maxWidth);
    }
  });

  rows.sort((a, b) => a.left - b.left || b.width - a.width);
  return rows.slice(0, 14);
})()`;

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ACCOUNT),
  });

  const raw = (login.headers.getSetCookie?.() ?? []).find((v) => v.startsWith('quorum_token='));
  const token = raw?.split(';')[0].split('=')[1];

  const profile = path.join(tmpdir(), `measure-${Date.now()}`);
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

  const client = connect(version.webSocketDebuggerUrl);
  await client.ready;

  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });

  await client.send('Page.enable', {}, sessionId);
  await client.send('Network.enable', {}, sessionId);

  if (token) {
    const secure = new URL(API).protocol === 'https:';
    await client.send(
      'Network.setCookie',
      {
        name: 'quorum_token',
        value: token,
        domain: new URL(API).hostname,
        path: '/',
        httpOnly: true,
        secure,
        sameSite: secure ? 'None' : 'Lax',
      },
      sessionId,
    );
  }

  let worst = 0;

  for (const width of WIDTHS) {
    await client.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height: 1000, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );

    for (const p of PATHS) {
      await client.send('Page.navigate', { url: `${BASE}${p}` }, sessionId);
      await wait(3000);

      const { result } = await client.send(
        'Runtime.evaluate',
        { returnByValue: true, expression: MEASURE(width) },
        sessionId,
      );

      console.log(`\n  ${p}  @  ${width}px`);
      console.log(`  ${'block'.padEnd(24)} ${'left'.padStart(6)} ${'right'.padStart(7)} ${'width'.padStart(7)}   centred`);
      console.log(`  ${'-'.repeat(64)}`);

      for (const row of result.value) {
        const gap = Math.abs(row.left - row.right);
        if (gap > worst) worst = gap;
        console.log(
          `  ${row.label.slice(0, 24).padEnd(24)} ${String(row.left).padStart(6)} ${String(row.right).padStart(7)} ` +
            `${String(row.width).padStart(7)}   ${row.centred ? 'yes' : `NO  (off by ${gap}px)`}`,
        );
      }
    }
  }

  client.close();
  chrome.kill();

  console.log(`\n  worst left/right asymmetry across every block measured: ${worst}px\n`);
  if (worst > 1) process.exitCode = 1;
}

main().catch((e) => {
  console.error('measure-layout failed:', e.message);
  process.exitCode = 1;
});
