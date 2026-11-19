// Builds the app's photo-finish pictures from a video file, one PNG per counted
// crossing, so the strip can be checked on a recording.
// Usage: node test/photo-finish-clip.mjs clip.mp4 --log session-log.json [--fps 60] [--out dir] [--max 5]
// Needs ffmpeg on the PATH. Detection runs as in run-clip.mjs (with --rest).
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildSampler, LineDetector, LapCounter, formatLap, inRestWindow, DEFAULT_LINE } from '../js/detector.js';
import { buildStripLine, readStripRGB, StripBuffer, PF } from '../js/photofinish.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const logPath = opt('--log', null), fps = Number(opt('--fps', 60)), out = opt('--out', 'photo-finish'), max = Number(opt('--max', 1e9));
const file = args[0];
let line = DEFAULT_LINE, ignore = 14, size = [540, 960];
if (logPath) {
  const log = JSON.parse(readFileSync(logPath, 'utf8'));
  line = log.info?.line || line;
  ignore = log.info?.settings?.ignoreSec || ignore;
  const v = log.info?.video;
  if (v?.width && v?.height) {
    const s = 960 / Math.max(v.width, v.height);
    size = [Math.round(v.width * s / 2) * 2, Math.round(v.height * s / 2) * 2];
  }
}
const [W, H] = size;
const sampler = buildSampler(W, H, line);
const strip = buildStripLine(W, H, line);
const det = new LineDetector(sampler);
const laps = new LapCounter(ignore * 1000);
const samples = new Uint8Array(sampler.sampleCount);
const col = new Uint8Array(strip.count * 3);
const buf = new StripBuffer(strip.count, 600);
const pending = [];
let written = 0;
mkdirSync(out, { recursive: true });

function writePng(pic, name) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${pic.width}x${pic.height}`, '-i', '-', join(out, name)]);
    ff.on('close', (c) => (c ? reject(new Error(`ffmpeg ${c}`)) : resolve()));
    ff.stdin.end(Buffer.from(pic.rgba.buffer));
  });
}

const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', `fps=${fps},scale=${W}:${H},format=rgb24`, '-f', 'rawvideo', '-']);
let data = Buffer.alloc(0), frame = 0, resting = false;
const FB = W * H * 3;
const jobs = [];
for await (const chunk of ff.stdout) {
  data = data.length ? Buffer.concat([data, chunk]) : chunk;
  while (data.length >= FB) {
    const rgb = data.subarray(0, FB);
    const t = (frame++ * 1000) / fps;
    const capturing = pending.some((p) => t <= p.at + PF.afterMs);
    const rest = !det.learning && inRestWindow(laps, t);
    if (rest && !resting) { resting = true; det.skipGap(); }
    if (!rest || capturing) buf.push(t, readStripRGB(strip, rgb, col));
    if (!rest) {
      resting = false;
      for (let i = 0; i < sampler.sampleCount; i++) {
        const p = (sampler.ys[i] * W + sampler.xs[i]) * 3;
        samples[i] = (rgb[p] * 77 + rgb[p + 1] * 150 + rgb[p + 2] * 29) >> 8;
      }
      const hit = det.push(samples, t);
      if (hit !== null) {
        const r = laps.crossing(hit);
        if (r.type === 'start' || r.type === 'lap') {
          pending.push({ at: hit, name: r.type === 'start' ? 'start' : `lap${String(r.lap).padStart(2, '0')}`, label: r.type === 'start' ? 'start' : `lap ${r.lap}: ${formatLap(r.ms, 2)}` });
        }
      }
    }
    for (let k = pending.length - 1; k >= 0; k--) {
      const p = pending[k];
      if (t < p.at + PF.afterMs) continue;
      pending.splice(k, 1);
      if (written >= max) continue;
      const pic = buf.picture(p.at - PF.beforeMs, p.at + PF.afterMs);
      if (!pic) continue;
      written++;
      console.log(`${(p.at / 1000).toFixed(2).padStart(7)}  ${p.label}  -> ${p.name}.png (${pic.width}x${pic.height}, ${pic.frames.length} frames)`);
      jobs.push(writePng(pic, `${p.name}.png`));
    }
    data = data.subarray(FB);
  }
}
await Promise.all(jobs);
console.log(`strip: ${strip.count} rows (top marker row ${strip.rowTop}, inner edge row ${strip.rowInner})`);
