// Unit tests for the lap logic, plus regression tests on the club's footage.
// Footage tests run only when CLIPS_DIR points at a folder with trimmed_01..03.mp4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LapCounter, formatLap, buildSampler, LineDetector, DEFAULT_TUNING } from '../js/detector.js';
import { runClip } from './run-clip.mjs';

test('first crossing starts, then laps, with the following team ignored', () => {
  const c = new LapCounter(14000);
  assert.equal(c.crossing(1000).type, 'start');
  assert.equal(c.crossing(2500).type, 'ignored');
  const lap = c.crossing(19000);
  assert.equal(lap.type, 'lap');
  assert.equal(lap.ms, 18000);
  assert.equal(c.crossing(20500).type, 'ignored');
});

test('undo removes the last lap and restores the clock', () => {
  const c = new LapCounter(14000);
  c.crossing(0); c.crossing(18000);
  c.undoLast();
  assert.equal(c.laps.length, 0);
  assert.equal(c.crossing(17500).type, 'lap');
});

test('lap formatting', () => {
  assert.equal(formatLap(17430), '17.4');
  assert.equal(formatLap(17430, 2), '17.43');
  assert.equal(formatLap(65200), '1:05.2');
});

test('sampler covers the track and the neutral zone', () => {
  const s = buildSampler(540, 960);
  assert.ok(s.rowCount > 600);
  const apronRows = s.rowIsApron.reduce((a, b) => a + b, 0);
  assert.ok(apronRows > 100 && apronRows < 200);
});

const dir = process.env.CLIPS_DIR;
const expected = {
  // trimmed_01 laps 3-4 and trimmed_03 lap 4 used to be lone riders or a pair
  // crossing first; checked frame by frame, they are ignored now.
  'trimmed_01.mp4': [21.08, 18.25],
  'trimmed_02.mp4': [25.25, 22.72, 17.85, 17.13],
  'trimmed_03.mp4': [24.78, 22.93, 19.28, 23.35],
};
for (const [name, laps] of Object.entries(expected)) {
  const file = dir && join(dir, name);
  test(`footage: ${name}`, { skip: !file || !existsSync(file) ? 'set CLIPS_DIR to run' : false }, async () => {
    const events = await runClip(file);
    const got = events.filter((e) => e.type === 'lap').map((e) => e.ms / 1000);
    assert.equal(got.length, laps.length, `laps: ${got.map((x) => x.toFixed(2))}`);
    got.forEach((g, i) => assert.ok(Math.abs(g - laps[i]) < 0.05, `lap ${i + 1}: ${g.toFixed(2)} vs ${laps[i]}`));
  });
}

// Synthetic frames: a flat grey line, optionally with a dark "rider" over some rows.
function frame(sampler, base, { trackRows = 0, apron = false } = {}) {
  const out = new Uint8Array(sampler.sampleCount).fill(base);
  for (let i = 0; i < sampler.sampleCount; i++) {
    const r = sampler.rowOf[i];
    if (sampler.rowIsApron[r] ? apron : r < trackRows) out[i] = 20;
  }
  return out;
}

const ANYONE = { ...DEFAULT_TUNING, groupMinCoverMs: 0 };

test('recovers when the camera shifts after learning (07:03 session)', () => {
  const s = buildSampler(540, 960);
  const det = new LineDetector(s, ANYONE);
  let t = 0;
  const step = 1000 / 13; // the phone processed ~13 frames a second while recording
  for (let i = 0; i < 45; i++, t += step) det.push(frame(s, 200), t);
  // The picture changes for good: every sample now differs from the learned line.
  const moved = new Uint8Array(s.sampleCount).map((_, i) => (i % 2 ? 120 : 250));
  let hits = 0;
  for (let i = 0; i < 13 * 6; i++, t += step) if (det.push(moved, t) !== null) hits++;
  assert.equal(det.relearns, 1);
  assert.equal(hits, 0, 'a moved camera must not count as crossings');
  // After relearning, a rider on the track is seen again.
  let hit = null;
  for (let i = 0; i < 13; i++, t += step) {
    const f = Uint8Array.from(moved);
    if (i === 5) for (let k = 0; k < s.sampleCount; k++) if (!s.rowIsApron[s.rowOf[k]] && s.rowOf[k] < 200) f[k] = 20;
    hit = det.push(f, t) ?? hit;
  }
  assert.ok(hit !== null);
});

test('apron check spans the same time at 12 fps as at 60 fps', () => {
  const s = buildSampler(540, 960);
  for (const fps of [12, 60]) {
    const det = new LineDetector(s, ANYONE);
    const step = 1000 / fps;
    let t = 0;
    for (let i = 0; i < 45; i++, t += step) det.push(frame(s, 200), t);
    for (let i = 0; i < fps; i++, t += step) det.push(frame(s, 200), t);
    // Someone on the apron 0.6 s before the lead rider: that must not block the lead rider.
    const apronAt = t;
    det.push(frame(s, 200, { apron: true }), t); t += step;
    while (t < apronAt + 600) { det.push(frame(s, 200), t); t += step; }
    const at = t;
    let hit = null;
    hit = det.push(frame(s, 200, { trackRows: 300 }), t) ?? hit; t += step;
    for (let i = 0; i < fps; i++, t += step) hit = det.push(frame(s, 200), t) ?? hit;
    assert.equal(hit, at, `${fps} fps`);
  }
});

test('a lone rider is ignored, a team is counted at its first wheel', () => {
  const s = buildSampler(540, 960);
  for (const fps of [12, 60]) {
    const det = new LineDetector(s);
    const step = 1000 / fps;
    let t = 0;
    const run = (ms, f) => { let hit = null; const end = t + ms; for (; t < end; t += step) hit = det.push(f(t), t) ?? hit; return hit; };
    run(5000, () => frame(s, 200));
    // One rider: line covered for 0.2 s.
    const lone = t;
    const h1 = run(3000, (x) => frame(s, 200, { trackRows: x - lone < 200 ? 300 : 0 }));
    assert.equal(h1, null, `${fps} fps: lone rider`);
    // Four riders in a line: 0.15 s covered, 0.1 s clear, four times.
    const team = t;
    const h2 = run(3000, (x) => frame(s, 200, { trackRows: (x - team) % 250 < 150 && x - team < 1000 ? 300 : 0 }));
    assert.ok(h2 !== null && Math.abs(h2 - team) < step + 1, `${fps} fps: team at ${h2} vs ${team}`);
  }
});
