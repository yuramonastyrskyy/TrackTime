#!/usr/bin/env node
// One-command screenshot of the app on a phone-sized screen, with a fake
// camera, so UI changes can be checked without building a harness each time.
//
//   node scripts/screenshot.mjs [out.png] [options]
//
//   --click a,b,c   tap these element ids in order after load (e.g. cameraBtn,settingsBtn)
//   --hash '#pm=…'  open with this hash (a Pacemaker plan link) or '?x=1' query
//   --size 390x844  viewport (default iPhone-ish portrait); 844x390 for landscape
//   --still f.y4m   camera picture (default: a drawn track with a finish line)
//   --wait 800      ms to wait after the last tap
//   --scale 1       deviceScaleFactor (use 2 for pictures people will look at)
//
// Prints browser console errors and page errors, and exits 1 if there were any.
// Needs Playwright (preinstalled in Claude's cloud container; locally `npm i -g playwright`).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : def; };
const clicks = opt('click', '').split(',').filter(Boolean);
const hash = opt('hash', '');
const [vw, vh] = opt('size', '390x844').split('x').map(Number);
const still = opt('still', '');
const wait = Number(opt('wait', '800'));
const scale = Number(opt('scale', '1'));
const out = path.resolve(args[0] || 'screenshot.png');

let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  try { ({ chromium } = (await import('node:module')).createRequire(import.meta.url)('playwright')); } catch {
    console.error('Playwright not found. Install it with: npm i -g playwright && npx playwright install chromium');
    process.exit(2);
  }
}

// A 1280x720 still: dark track, white finish line with a black centre line, blue apron at the bottom.
function drawnTrack(file) {
  const W = 1280, H = 720, Y = Buffer.alloc(W * H), U = Buffer.alloc((W / 2) * (H / 2), 128), V = Buffer.alloc((W / 2) * (H / 2), 128);
  for (let y = 0; y < H; y++) {
    const cx = 620 + (y - H / 2) * 0.12; // line leans a little
    for (let x = 0; x < W; x++) {
      const d = Math.abs(x - cx);
      Y[y * W + x] = d < 3 ? 20 : d < 22 ? 235 : y > H * 0.82 ? 90 : 70 + ((x * 7 + y * 3) % 9);
    }
  }
  for (let y = Math.floor(H * 0.82 / 2); y < H / 2; y++) for (let x = 0; x < W / 2; x++) { U[y * (W / 2) + x] = 170; V[y * (W / 2) + x] = 110; }
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\nFRAME\n`), Y, U, V]));
}
const camFile = still ? path.resolve(still) : path.join(os.tmpdir(), 'tracktime-fake-cam.y4m');
if (!still) drawnTrack(camFile);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.m4a': 'audio/mp4' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const f = p.endsWith(path.sep) ? path.join(p, 'index.html') : p;
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camFile}`, '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: scale, hasTouch: true, isMobile: true, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  // Outside scripts (Telegram) are blocked so the run works offline; only this app's failures count.
  await page.route((u) => !u.href.startsWith(base), (r) => r.abort());
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => { if (r.url().startsWith(base)) errors.push(`request failed: ${r.url()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(base)) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
  page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
  await page.goto(base + hash, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  for (const id of clicks) {
    try { await page.locator(`#${id}`).click({ timeout: 5000 }); } catch {
      errors.push(`could not tap #${id} (not visible?)`);
      break;
    }
    await page.waitForTimeout(id === 'cameraBtn' ? 1500 : 300);
  }
  await page.waitForTimeout(wait);
  await page.screenshot({ path: out });
  console.log(`saved ${out}`);
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.log(errors.join('\n')); process.exit(1); }
