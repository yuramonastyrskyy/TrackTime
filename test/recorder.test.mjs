// Tests for the record + log helpers that do not need a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickMimeType, extensionFor, locate, logToCsv, stamp, formatBytes } from '../js/recorder.js';

test('picks mp4 when the browser can record it (iPhone, recent Chrome)', () => {
  assert.equal(pickMimeType((t) => t.startsWith('video/mp4')), 'video/mp4;codecs=avc1');
  assert.equal(pickMimeType((t) => t.startsWith('video/mp4'), true), 'video/mp4;codecs=avc1,mp4a.40.2');
  assert.equal(pickMimeType((t) => t === 'video/mp4'), 'video/mp4');
  assert.equal(extensionFor('video/mp4'), 'mp4');
});

test('falls back to webm, then to the browser default', () => {
  assert.equal(pickMimeType((t) => t === 'video/webm;codecs=vp8'), 'video/webm;codecs=vp8');
  assert.equal(extensionFor('video/webm;codecs=vp8'), 'webm');
  assert.equal(pickMimeType(() => false), '');
  assert.equal(pickMimeType(() => { throw new Error('x'); }), '');
});

test('locates a session time inside the right video part', () => {
  const parts = [{ n: 1, startMs: 0 }, { n: 2, startMs: 600000 }];
  assert.deepEqual(locate(parts, 1500), { part: 1, partTime: 1.5 });
  assert.deepEqual(locate(parts, 601000), { part: 2, partTime: 1 });
  assert.deepEqual(locate([], 10), { part: null, partTime: null });
});

test('CSV has one row per event, skips per-second stats and quotes text', () => {
  const log = { events: [
    { ms: 1000, type: 'state', detail: 'armed' },
    { ms: 1200, type: 'second', fps: 30 },
    { ms: 5000, type: 'start', frameT: 5000 },
    { ms: 7000, type: 'ignored', sinceMs: 2000 },
    { ms: 23000, type: 'lap', lap: 1, lapMs: 18000 },
    { ms: 23100, type: 'mark', detail: 'a, "b"' },
  ] };
  const csv = logToCsv(log, [{ n: 1, startMs: 0 }]).trim().split('\n');
  assert.equal(csv[0], 'session_s,part,part_time_s,event,lap,lap_s,since_s,detail');
  assert.equal(csv.length, 6);
  assert.equal(csv[3], '7.000,1,7.000,ignored,,,2.000,');
  assert.equal(csv[4], '23.000,1,23.000,lap,1,18.000,,');
  assert.equal(csv[5], '23.100,1,23.100,mark,,,,"a, ""b"""');
});

test('file name stamp and sizes', () => {
  assert.equal(stamp(new Date(2026, 10, 14, 8, 5)), '2026-11-14_0805');
  assert.equal(formatBytes(250e6), '250 MB');
  assert.equal(formatBytes(1.2e9), '1.2 GB');
});
