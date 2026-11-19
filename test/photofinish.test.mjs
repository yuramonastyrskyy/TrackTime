import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStripLine, StripBuffer, unionBox, readStripRGBA, tickStep } from '../js/photofinish.js';
import { DEFAULT_LINE, buildSampler } from '../js/detector.js';

test('strip runs along the finish line, inside the picture', () => {
  const s = buildStripLine(540, 960, DEFAULT_LINE);
  assert.ok(s.count > 500 && s.count <= 720);
  assert.ok(s.rowTop > 0 && s.rowInner > s.rowTop && s.rowInner < s.count);
  for (let i = 0; i < s.count; i++) {
    assert.ok(s.xs[i] >= 0 && s.xs[i] <= 539 && s.ys[i] >= 0 && s.ys[i] <= 959);
  }
  // the top marker row sits on the marker
  assert.ok(Math.abs(s.ys[s.rowTop] - DEFAULT_LINE.top.y * 960) < 2);
  const box = unionBox(buildSampler(540, 960).box, s.box);
  const data = new Uint8ClampedArray(box.w * box.h * 4).fill(200);
  const out = readStripRGBA(s, box, data, new Uint8Array(s.count * 3));
  assert.equal(out[0], 200);
});

test('picture: even time grid, blended between frames, gaps dark', () => {
  const b = new StripBuffer(2, 50);
  const col = (v) => Uint8Array.of(v, v, v, v, v, v);
  b.push(0, col(0));
  b.push(100, col(100));
  b.push(200, col(200));
  b.push(500, col(50)); // 300 ms gap before this frame
  const p = b.picture(0, 500, 20, 150); // a column every 50 ms
  assert.equal(p.width, 11);
  assert.equal(p.height, 2);
  const px = (x) => p.rgba[x * 4];
  assert.equal(px(0), 0);
  assert.equal(px(1), 50);   // halfway between frames 0 and 100
  assert.equal(px(2), 100);
  assert.equal(px(3), 150);
  assert.equal(px(4), 200);
  assert.ok(px(6) < 40 && p.rgba[6 * 4 + 2] > px(6)); // gap colour (dark slate)
  assert.equal(px(10), 50);
  assert.deepEqual(p.frames, [0, 100, 200, 500]);
});

test('buffer keeps only the newest frames and ignores repeats', () => {
  const b = new StripBuffer(1, 3);
  for (const t of [0, 10, 10, 20, 30]) b.push(t, Uint8Array.of(t, t, t));
  assert.equal(b.n, 3);
  assert.equal(b.oldest, 10);
  assert.equal(b.newest, 30);
  assert.equal(b.picture(100, 200), null);
});

test('tick spacing grows as you zoom out', () => {
  assert.equal(tickStep(0.4), 50);
  assert.equal(tickStep(2), 200);
  assert.equal(tickStep(10), 1000);
});
