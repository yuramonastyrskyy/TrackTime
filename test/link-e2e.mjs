// End-to-end check of the laptop stopwatch link, with a local MQTT broker.
// Simulates the hotspot losing its internet by stopping the broker.
//
//   1. Serve TrackTime:      npx http-server -p 8081 -c-1 .
//   2. Run the stopwatch:    (in dcheglakov/stopwatch) pnpm dev --port 5173
//   3. node test/link-e2e.mjs direct      # direct link keeps laps flowing, relay down
//      node test/link-e2e.mjs late        # relay down 20 s, queued laps keep their times
//      node test/link-e2e.mjs blackhole   # relay silently drops, laps re-sent after reconnect
//
// Needs `ws` and `playwright` (npm i ws playwright, or NODE_PATH to them).
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';

const BROKER_PORT = 18830;
const TT = process.env.TT_URL || 'http://localhost:8081';
const SW = process.env.SW_URL || 'http://localhost:5173';
const CODE = 'TEST42';
const mode = process.argv[2] || 'direct'; // direct | late | blackhole

// ---------- tiny MQTT 3.1.1 broker over WebSocket ----------
let wss = null;
let blackhole = false;
const subs = new Map(); // ws -> Set(topic)
function frame(type, body) {
  const len = []; let n = body.length;
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; len.push(b); } while (n > 0);
  return Buffer.from([type, ...len, ...body]);
}
function startBroker() {
  wss = new WebSocketServer({ port: BROKER_PORT, handleProtocols: () => 'mqtt' });
  wss.on('connection', (ws) => {
    subs.set(ws, new Set());
    let buf = Buffer.alloc(0);
    ws.on('message', (data) => {
      if (blackhole) return;
      buf = Buffer.concat([buf, data]);
      for (;;) {
        let mult = 1, len = 0, i = 1, b;
        do { if (i >= buf.length) return; b = buf[i++]; len += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
        if (buf.length < i + len) return;
        const type = buf[0] >> 4, body = buf.subarray(i, i + len);
        buf = buf.subarray(i + len);
        if (type === 1) ws.send(frame(0x20, [0, 0]));
        else if (type === 8) {
          const tl = (body[2] << 8) | body[3];
          subs.get(ws).add(body.subarray(4, 4 + tl).toString());
          ws.send(frame(0x90, [body[0], body[1], 0]));
        } else if (type === 12) ws.send(Buffer.from([0xd0, 0]));
        else if (type === 3) {
          const tl = (body[0] << 8) | body[1];
          const topic = body.subarray(2, 2 + tl).toString();
          for (const [c, t] of subs) if (t.has(topic) && c.readyState === 1) c.send(frame(0x30, [...body]));
        }
      }
    });
    ws.on('close', () => subs.delete(ws));
  });
}
function stopBroker() {
  for (const c of wss.clients) c.terminate();
  wss.close();
  subs.clear();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(200); }
}

startBroker();
const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const q = `?relay=ws://localhost:${BROKER_PORT}/mqtt&ntfy=off${mode === 'direct' ? '' : '&direct=off'}`;

// Stopwatch (laptop)
const sw = await (await browser.newContext()).newPage();
sw.on('console', (m) => { if (m.type() === 'error') console.log('[sw]', m.text()); });
await sw.goto(SW + '/');
await sw.evaluate((code) => {
  localStorage.setItem('stopwatch-remote-enabled', 'true');
  localStorage.setItem('stopwatch-remote-code', JSON.stringify(code));
  localStorage.setItem('stopwatch-laps', '[]');
}, CODE);
await sw.goto(SW + '/' + q);

// TrackTime (phone): drive the link module directly
const tt = await (await browser.newContext()).newPage();
tt.on('console', (m) => console.log('[tt]', m.text()));
await tt.goto(TT + '/manifest.webmanifest');
await tt.evaluate(async ({ q, CODE }) => {
  const m = await import('/js/lapLink.js');
  window.sender = new m.LapSender({ ...m.linkOverrides(q), onState: (s) => { window.last = s; } });
  window.sender.setCode(CODE);
}, { q, CODE });

const ttState = () => tt.evaluate(() => window.last);
const laps = () => sw.evaluate(() => JSON.parse(localStorage.getItem('stopwatch-laps') || '[]').map((l) => l.elapsedTime).reverse());
const cross = (at, lap) => tt.evaluate(({ at, lap }) => window.sender.sendCrossing(at, lap), { at, lap });
const report = [];
const check = (name, ok, extra = '') => { report.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

await until(async () => (await ttState())?.connected, 10000, 'relay connect');
await until(async () => [...subs.values()].some((t) => t.has('tracktime/v1/' + CODE)), 15000, 'stopwatch subscribed');
const t0 = Date.now();
await cross(t0, 0); // starts the stopwatch
await until(async () => sw.evaluate(() => localStorage.getItem('stopwatch-is-running') === 'true'), 5000, 'stopwatch start');

if (mode === 'direct') {
  const s = await until(async () => { const s = await ttState(); return s.direct === 'open' && s; }, 20000, 'direct open');
  check('direct link opens', true, JSON.stringify(s.direct));
  await sleep(500);
  stopBroker();
  await sleep(1500);
  const s2 = await ttState();
  check('relays down, direct still open', s2.links.every((l) => l.status !== 'open') && s2.direct === 'open', JSON.stringify(s2.links));
  const n1 = Date.now(); await cross(n1, 1);
  await sleep(1300);
  const n2 = Date.now(); await cross(n2, 2);
  await until(async () => (await laps()).length >= 2, 5000, 'laps over direct');
  const L = await laps();
  const gap = L[1] - L[0], expGap = n2 - n1;
  check('2 laps arrive with no relay', L.length === 2, JSON.stringify(L));
  check('lap gap matches phone', Math.abs(gap - expGap) <= 30, `gap ${gap} vs ${expGap}`);
} else {
  // late: broker down (or silently dead), laps queued, broker back 20 s later
  if (mode === 'blackhole') blackhole = true; else stopBroker();
  await sleep(1000);
  const n1 = Date.now(); await cross(n1, 1);
  await sleep(2500);
  const n2 = Date.now(); await cross(n2, 2);
  await sleep(mode === 'blackhole' ? 3000 : 18000);
  if (mode === 'blackhole') {
    // the dead sockets are noticed by keep-alive; speed up by dropping them
    for (const c of wss.clients) c.terminate();
    blackhole = false;
  } else startBroker();
  try { await until(async () => (await laps()).length >= 2, 40000, 'late laps'); }
  catch (e) { console.log('tt', JSON.stringify(await ttState()), 'queue', await tt.evaluate(() => JSON.stringify(window.sender.queue.map((q) => ({ msg: q.msg, pend: [...q.pend.values()], ntfy: q.ntfy }))))); console.log('laps', await laps(), 'subs', [...subs.values()].map((t) => [...t])); throw e; }
  const L = await laps();
  check('queued laps delivered after reconnect', L.length === 2, JSON.stringify(L));
  check('lap 1 keeps its crossing time', Math.abs(L[0] - (n1 - t0)) <= 300, `${L[0]} vs ${n1 - t0}`);
  check('lap 2 keeps its crossing time', Math.abs(L[1] - (n2 - t0)) <= 300, `${L[1]} vs ${n2 - t0}`);
}
console.log(report.join('\n'));
await browser.close();
stopBroker();
process.exit(report.some((r) => r.startsWith('FAIL')) ? 1 : 0);
