// Runs the detector over a video file and prints what the app would announce.
// Usage: node test/run-clip.mjs path/to/clip.mp4 [ignoreSeconds]
// Needs ffmpeg on the PATH. The clip should be filmed along the finish line.
import { spawn } from 'node:child_process';
import { buildSampler, readSamplesGray, LineDetector, LapCounter, formatLap } from '../js/detector.js';

export async function runClip(file, ignoreMs = 14000) {
  const W = 540, H = 960;
  const sampler = buildSampler(W, H);
  const det = new LineDetector(sampler);
  const laps = new LapCounter(ignoreMs);
  const samples = new Uint8Array(sampler.sampleCount);
  const events = [];
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-']);
  let buf = Buffer.alloc(0), frame = 0;
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= W * H) {
      const t = (frame++ * 1000) / 60;
      const hit = det.push(readSamplesGray(sampler, buf.subarray(0, W * H), samples), t);
      buf = buf.subarray(W * H);
      if (hit !== null) events.push(laps.crossing(hit));
    }
  }
  return events;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const events = await runClip(process.argv[2], (Number(process.argv[3]) || 14) * 1000);
  for (const e of events) {
    const at = (e.at / 1000).toFixed(2).padStart(7);
    if (e.type === 'start') console.log(`${at}  start`);
    else if (e.type === 'lap') console.log(`${at}  lap ${e.lap}: ${formatLap(e.ms, 2)}`);
    else console.log(`${at}  ignored (${(e.since / 1000).toFixed(2)} s after)`);
  }
}
