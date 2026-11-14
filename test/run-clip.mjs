// Runs the detector over a video file and prints what the app would announce.
// Usage: node test/run-clip.mjs path/to/clip.mp4 [ignoreSeconds] [--log session-log.json] [--fps 12]
// Needs ffmpeg on the PATH. The clip should be filmed along the finish line.
// With --log (a log saved by "Record + time"), the markers and ignore time from
// that session are used, so a recording replays exactly as it was set up.
// Phone recordings have a variable frame rate; frames are resampled to 60 fps,
// or to --fps N to mimic a phone that could only process N frames a second live.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildSampler, readSamplesGray, LineDetector, LapCounter, formatLap } from '../js/detector.js';

export async function runClip(file, ignoreMs = 14000, line = undefined, size = [540, 960], fps = 60) {
  const [W, H] = size;
  const sampler = buildSampler(W, H, line);
  const det = new LineDetector(sampler);
  const laps = new LapCounter(ignoreMs);
  const samples = new Uint8Array(sampler.sampleCount);
  const events = [];
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', `fps=${fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-']);
  let buf = Buffer.alloc(0), frame = 0;
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= W * H) {
      const t = (frame++ * 1000) / fps;
      const singles = det.singles.length;
      const hit = det.push(readSamplesGray(sampler, buf.subarray(0, W * H), samples), t);
      buf = buf.subarray(W * H);
      if (det.singles.length !== singles) events.push({ type: 'single', at: det.singles[det.singles.length - 1] });
      if (hit !== null) events.push(laps.crossing(hit));
    }
  }
  return events;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--fps');
  let fps = 60;
  if (fi >= 0) { fps = Number(args[fi + 1]) || 60; args.splice(fi, 2); }
  const li = args.indexOf('--log');
  let ignore = Number(args[1]) || 14, line, size;
  if (li >= 0) {
    const log = JSON.parse(readFileSync(args[li + 1], 'utf8'));
    line = log.info?.line;
    if (!(Number(args[1]) > 0)) ignore = log.info?.settings?.ignoreSec || ignore;
    const v = log.info?.video;
    if (v?.width && v?.height) {
      const s = 960 / Math.max(v.width, v.height);
      size = [Math.round(v.width * s / 2) * 2, Math.round(v.height * s / 2) * 2];
    }
    args.splice(li, 2);
  }
  const events = await runClip(args[0], ignore * 1000, line, size, fps);
  for (const e of events) {
    const at = (e.at / 1000).toFixed(2).padStart(7);
    if (e.type === 'start') console.log(`${at}  start`);
    else if (e.type === 'lap') console.log(`${at}  lap ${e.lap}: ${formatLap(e.ms, 2)}`);
    else if (e.type === 'single') console.log(`${at}  single rider, not a team (ignored)`);
    else console.log(`${at}  ignored (${(e.since / 1000).toFixed(2)} s after)`);
  }
}
