import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrames, pointsText, nativeApi, exposureText, openInAppLink } from '../js/nativeCamera.js';
import { buildSampler } from '../js/detector.js';

test('parseFrames splits the app frames text', () => {
  const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  const b64 = Buffer.from(bytes).toString('base64');
  const f = parseFrames(`3;1000.5000,1016.6667|${b64}`);
  assert.equal(f.length, 2);
  assert.equal(f[0].t, 1000.5);
  assert.deepEqual([...f[1].samples], [4, 5, 6]);
  assert.deepEqual(parseFrames(''), []);
  assert.deepEqual(parseFrames('garbage'), []);
  // A short buffer drops the frames it cannot fill.
  assert.equal(parseFrames(`4;1,2|${b64}`).length, 1);
});

test('pointsText gives normalised pixel centres, like the GPU sampler', () => {
  const s = buildSampler(540, 960);
  const p = pointsText(s).split(',').map(Number);
  assert.equal(p.length, s.sampleCount * 2);
  assert.ok(Math.abs(p[0] - (s.xs[0] + 0.5) / 540) < 1e-5);
  assert.ok(Math.abs(p[1] - (s.ys[0] + 0.5) / 960) < 1e-5);
  assert.ok(p.every((v) => v > 0 && v < 1));
});

test('nativeApi needs a new enough app', () => {
  assert.equal(nativeApi({}), null);
  assert.equal(nativeApi({ TrackTimeNative: { version: () => 0 } }), null);
  const api = { version: () => 1 };
  assert.equal(nativeApi({ TrackTimeNative: api }), api);
  assert.equal(nativeApi({ TrackTimeNative: { version: () => { throw new Error('x'); } } }), null);
});

test('exposure text and the open-in-app link', () => {
  assert.equal(exposureText({ exposureNs: 2e6, iso: 800, locked: true, nudge: -1 }), '1/500 s · ISO 800 · locked · −0.3 EV');
  const link = openInAppLink('#pm=abc_-', 'https://example.org/TrackTime/');
  assert.ok(link.startsWith('intent://open?pm=abc_-#Intent;scheme=tracktime;package=io.github.yuramonastyrskyy.tracktime;'));
  assert.ok(link.endsWith(`S.browser_fallback_url=${encodeURIComponent('https://example.org/TrackTime/')};end`));
});

test('a loaded plan survives the hand-over to the app (planToHash of a parsed plan)', async () => {
  const { planFromHash, planToHash } = await import('../js/plan.js');
  const first = planFromHash(planToHash({ v: 1, id: 'p1', name: 'Tempo', blocks: [{ kind: 'ride', laps: 4, target: 17.5, where: 'below_red' }, { kind: 'rest', min: 2 }] })).plan;
  assert.deepEqual(planFromHash(planToHash(first)).plan, first);
});
