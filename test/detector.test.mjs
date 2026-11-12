// Unit tests for the lap logic, plus regression tests on the club's footage.
// Footage tests run only when CLIPS_DIR points at a folder with trimmed_01..03.mp4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LapCounter, formatLap, buildSampler } from '../js/detector.js';
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
  'trimmed_01.mp4': [21.08, 18.25, 18.35, 20.32],
  'trimmed_02.mp4': [25.25, 22.72, 17.85, 17.13],
  'trimmed_03.mp4': [24.78, 22.93, 19.28, 18.47],
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
