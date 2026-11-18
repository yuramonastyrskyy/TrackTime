// Tests for the Pacemaker plan logic (js/plan.js) and the spoken gap words.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planFromHash, planToHash, parsePlan, planProgress, gapBand, targetAt, stripText, describeBlock,
  DEFAULT_API, formatClock, boardParts, bandTag, summarize,
} from '../js/plan.js';
import { extraWords, spokenText, PAUSE } from '../js/speech.js';

const SPEC = {
  v: 1,
  id: 'trk_ab12cd',
  name: 'Corridor build',
  api: 'https://pacemaker-theta.vercel.app',
  blocks: [
    { kind: 'ride', min: 10, where: 'red', target: 23.0 },
    { kind: 'ride', min: 10, where: 'blue', target: 24.0 },
    { kind: 'rest', min: 2 },
    { kind: 'ride', min: 5, where: 'red', from: 23.0, to: 20.0 },
    { kind: 'ride', laps: 8, where: 'any', target: 22.0 },
  ],
};
const MIN = 60000;

test('reads the plan from the #pm= link', () => {
  const r = planFromHash(planToHash(SPEC));
  assert.ok(r.plan, r.error);
  assert.equal(r.plan.id, 'trk_ab12cd');
  assert.equal(r.plan.name, 'Corridor build');
  assert.equal(r.plan.api, 'https://pacemaker-theta.vercel.app');
  assert.equal(r.plan.blocks.length, 5);
  assert.deepEqual(r.plan.blocks[3], { kind: 'ride', min: 5, where: 'red', from: 23, to: 20 });
  assert.deepEqual(r.plan.blocks[4], { kind: 'ride', laps: 8, where: 'any', target: 22 });
});

test('handles non-ASCII names, other hash params and unknown fields', () => {
  const r = planFromHash(`${planToHash({ ...SPEC, name: 'Коридор', extra: { x: 1 }, blocks: [{ kind: 'ride', min: 1, target: 20, colour: 'pink' }] })}&foo=1`);
  assert.equal(r.plan.name, 'Коридор');
  assert.deepEqual(r.plan.blocks[0], { kind: 'ride', min: 1, target: 20 });
  assert.equal(r.plan.extra, undefined);
});

test('no plan in the hash is not an error', () => {
  assert.equal(planFromHash(''), null);
  assert.equal(planFromHash('#'), null);
  assert.equal(planFromHash('#foo=bar'), null);
});

test('a bad link gives a short note instead of a plan', () => {
  assert.match(planFromHash('#pm=not-base64!!').error, /could not be read/);
  assert.match(planFromHash('#pm=' + Buffer.from('{oops').toString('base64url')).error, /could not be read/);
  assert.match(planFromHash('#pm=').error, /could not be read/);
  assert.match(parsePlan({ v: 1, blocks: [] }).error, /no blocks/);
  assert.match(parsePlan({ v: 1 }).error, /no blocks/);
  assert.match(parsePlan({ v: 1, blocks: [{ kind: 'ride', target: 23 }] }).error, /without a length/);
  assert.match(parsePlan({ v: 1, blocks: [{ kind: 'ride', laps: 2.5 }] }).error, /without a length/);
  assert.match(parsePlan({ v: 2, blocks: [{ min: 1 }] }).error, /newer/);
  assert.match(parsePlan([1, 2]).error, /could not be read/);
});

test('"where" in other spellings, other field names, and unknown values', () => {
  const where = (b) => parsePlan({ blocks: [{ min: 1, target: 23, ...b }] }).plan.blocks[0].where;
  assert.equal(where({ where: 'RED' }), 'red');
  assert.equal(where({ where: 'under_blue' }), 'blue');
  assert.equal(where({ where: 'Синя' }), 'blue');
  assert.equal(where({ lane: 'red' }), 'red');
  assert.equal(where({ zone: 'blue' }), 'blue');
  assert.equal(where({ where: 'any' }), 'any');
  assert.equal(where({ where: 'black' }), 'black');
  assert.equal(where({}), undefined);
  assert.equal(where({ where: 'below_blue' }), 'blue');
  assert.equal(where({ where: 'Below-Red' }), 'red');
  assert.equal(where({ where: 'corridor' }), 'corridor');
  assert.equal(where({ where: 'above_blue' }), 'above');
  assert.equal(describeBlock({ kind: 'ride', min: 3, where: 'blue' }), 'Under blue');
  assert.equal(describeBlock({ kind: 'ride', laps: 6, where: 'corridor', target: 20 }), 'Corridor · 20.0 s');
  assert.equal(describeBlock({ kind: 'ride', min: 1, where: 'lap_zone' }), 'Lap zone');
  assert.equal(describeBlock(parsePlan({ blocks: [{ min: 1, target: 23, where: 'black' }] }).plan.blocks[0]), 'Black · 23.0 s');
});

test('missing optional fields get defaults', () => {
  const { plan } = parsePlan({ blocks: [{ min: 3 }] });
  assert.equal(plan.id, null);
  assert.equal(plan.name, 'Plan');
  assert.equal(plan.api, DEFAULT_API);
  assert.deepEqual(plan.blocks[0], { kind: 'ride', min: 3 });
  assert.equal(parsePlan({ api: 'javascript:alert(1)', blocks: [{ min: 1 }] }).plan.api, DEFAULT_API);
  assert.equal(parsePlan({ api: 'http://localhost:8787/', blocks: [{ min: 1 }] }).plan.api, 'http://localhost:8787');
});

// Helper: laps of the given seconds, back to back from the first crossing.
function lapsOf(...secs) {
  let t = 0;
  return secs.map((s) => { t += s * 1000; return { ms: s * 1000, t }; });
}

test('before the first crossing it shows block 1 with its full time', () => {
  const p = planProgress(parsePlan(SPEC).plan, [], null);
  assert.equal(p.index, 0);
  assert.equal(p.leftMs, 10 * MIN);
  assert.equal(p.started, false);
  const s = stripText(null, p);
  assert.equal(s.block, 'Block 1 of 5 · Under red · 23.0 s');
  assert.equal(s.left, '10:00 left · starts at the first crossing');
  assert.equal(s.next, 'Next: Under blue · 24.0 s · 10 min');
});

test('time blocks step on the plan clock', () => {
  const plan = parsePlan(SPEC).plan;
  assert.equal(planProgress(plan, [], 0).index, 0);
  assert.equal(planProgress(plan, [], 10 * MIN - 1).index, 0);
  const p = planProgress(plan, [], 10 * MIN + 30000);
  assert.equal(p.index, 1);
  assert.equal(p.leftMs, 9.5 * MIN);
  assert.equal(stripText(plan, p).block, 'Block 2 of 5 · Under blue · 24.0 s');
  assert.equal(stripText(plan, p).left, '9:30 left');
  assert.equal(planProgress(plan, [], 20 * MIN + 1000).block.kind, 'rest');
  assert.equal(stripText(plan, planProgress(plan, [], 20 * MIN + 1000)).block, 'Block 3 of 5 · Rest');
  assert.equal(planProgress(plan, [], 22 * MIN).index, 3);
  // The lap block does not end on the clock, however long it takes.
  const lapBlock = planProgress(plan, [], 60 * MIN);
  assert.equal(lapBlock.index, 4);
  assert.equal(lapBlock.leftLaps, 8);
  assert.equal(stripText(plan, lapBlock).left, '8 laps left');
  assert.equal(stripText(plan, lapBlock).next, 'Last block');
});

test('laps are scored against the block they end in', () => {
  const plan = parsePlan(SPEC).plan;
  const p = planProgress(plan, lapsOf(23.1, 23.6, 22.5), 70000);
  assert.deepEqual(p.results.map((r) => r.block), [0, 0, 0]);
  assert.deepEqual(p.results.map((r) => r.band), ['good', 'slow', 'fast']);
  assert.ok(Math.abs(p.results[1].gap - 0.6) < 1e-9);
});

test('lap blocks step by counted laps; breaks do not count', () => {
  const plan = parsePlan({ blocks: [{ laps: 3, target: 20 }, { laps: 2, target: 22 }, { min: 1, target: 21 }] }).plan;
  let p = planProgress(plan, lapsOf(20, 20.1), 40100);
  assert.equal(p.index, 0);
  assert.equal(p.leftLaps, 1);
  // A 45 s lap is more than twice 20 s: riders were off, it does not count.
  p = planProgress(plan, lapsOf(20, 20.1, 45, 19.9), 105000);
  assert.equal(p.results[2].break, true);
  assert.equal(p.results[2].band, null);
  assert.equal(p.results[2].gap, null);
  assert.equal(p.index, 1);
  assert.equal(p.blockStart, 105000);
  assert.equal(p.leftLaps, 2);
  // Two more laps finish block 2; the 1-minute block starts at that crossing.
  p = planProgress(plan, lapsOf(20, 20.1, 45, 19.9, 22, 22.2), 160000);
  assert.equal(p.index, 2);
  assert.equal(p.blockStart, 149200);
  assert.equal(p.leftMs, 60000 - (160000 - 149200));
  p = planProgress(plan, lapsOf(20, 20.1, 45, 19.9, 22, 22.2), 149200 + 60000);
  assert.equal(p.done, true);
  assert.equal(stripText(plan, p).block, 'Plan done');
});

test('ramps move the target evenly over the block', () => {
  const ramp = { kind: 'ride', min: 5, where: 'red', from: 23, to: 20 };
  assert.equal(targetAt(ramp, 0), 23);
  assert.equal(targetAt(ramp, 0.5), 21.5);
  assert.equal(targetAt(ramp, 1), 20);
  assert.equal(targetAt(ramp, 2), 20);
  assert.equal(targetAt({ kind: 'rest', min: 2 }), null);
  const plan = parsePlan({ blocks: [ramp] }).plan;
  // A lap ending at 2:40 whose middle is at 2:30 is scored against 21.5.
  const p = planProgress(plan, [{ ms: 20000, t: 160000 }], 160000);
  assert.equal(p.results[0].target, 21.5);
  assert.equal(stripText(plan, planProgress(plan, [], 150000)).block, 'Block 1 of 1 · Under red · 21.5 s');
  assert.equal(stripText(plan, planProgress(plan, [], null)).block, 'Block 1 of 1 · Under red · 23.0 → 20.0 s');
  // A lap ramp steps per lap.
  const lp = parsePlan({ blocks: [{ laps: 4, from: 24, to: 21 }] }).plan;
  assert.deepEqual(planProgress(lp, lapsOf(24, 23, 22, 21), 90000).results.map((r) => r.target), [24, 23, 22, 21]);
});

test('a rest block and the long lap over it are breaks', () => {
  const plan = parsePlan(SPEC).plan;
  // Riding laps of 23 s for 10 min, 24 s for 10 min, then a lap across the rest.
  const secs = [...Array(26).fill(23), ...Array(25).fill(24)];
  const laps = lapsOf(...secs);
  const end = laps[laps.length - 1].t; // 19:58
  laps.push({ ms: 21 * 1000, t: end + 21000 }); // ends at 20:19, inside the rest
  laps.push({ ms: 125 * 1000, t: end + 146000 }); // ends at 22:24, in the ramp: over 2x target
  laps.push({ ms: 22600, t: end + 168600 }); // ramp target here is about 22.65
  const p = planProgress(plan, laps, end + 170000);
  const r = p.results;
  assert.equal(r[25].block, 0);
  assert.equal(r[26].block, 1);
  assert.equal(r[51].block, 2);
  assert.equal(r[51].break, true);
  assert.equal(r[52].block, 3);
  assert.equal(r[52].break, true);
  assert.equal(r[53].break, false);
  assert.equal(r[53].band, 'good');
});

test('lap colour bands', () => {
  assert.equal(gapBand(0), 'good');
  assert.equal(gapBand(0.3), 'good');
  assert.equal(gapBand(-0.3), 'good');
  assert.equal(gapBand(0.31), 'slow');
  assert.equal(gapBand(0.8), 'slow');
  assert.equal(gapBand(0.81), 'veryslow');
  assert.equal(gapBand(-0.31), 'fast');
  assert.equal(gapBand(24.3 - 24.0), 'good'); // float noise
  assert.equal(gapBand(24.8 - 24.0), 'slow');
});

test('block text and clock', () => {
  assert.equal(describeBlock({ kind: 'ride', where: 'any', laps: 8, target: 22 }), 'Anywhere · 22.0 s');
  assert.equal(describeBlock({ kind: 'ride', laps: 8, target: 22 }), '22.0 s');
  assert.equal(describeBlock({ kind: 'ride', min: 1 }), 'Ride');
  assert.equal(describeBlock({ kind: 'ride', where: 'blue', min: 1 }), 'Under blue');
  assert.equal(formatClock(61001), '1:02');
  assert.equal(formatClock(-5), '0:00');
});

test('spoken gap words', () => {
  assert.deepEqual(extraWords({ gap: 0.3 }), [PAUSE, 'plus', '0', 'point', '3']);
  assert.deepEqual(extraWords({ gap: -0.24 }), [PAUSE, 'minus', '0', 'point', '2']);
  assert.deepEqual(extraWords({ gap: -0.04 }), [PAUSE, 'plus', '0', 'point', '0']);
  assert.deepEqual(extraWords({ gap: 1.27, decimals: 2 }), [PAUSE, 'plus', '1', 'point', '2', '7']);
  assert.deepEqual(extraWords({ gap: null, nextBlock: true }), [PAUSE, 'nextblock']);
  assert.deepEqual(extraWords({}), []);
  assert.equal(spokenText('24.3', { gap: 0.3 }), '24.3. plus 0.3');
  assert.equal(spokenText('23.8', { gap: -0.2, nextBlock: true }), '23.8. minus 0.2. next block');
  assert.equal(spokenText('23.8'), '23.8');
});

test('plan strip pieces for the trackside board', () => {
  const plan = parsePlan(SPEC).plan;
  const before = boardParts(plan, planProgress(plan, [], null));
  assert.equal(before.block, 'Block 1 of 5');
  assert.equal(before.line, 'Under red');
  assert.equal(before.swatch, 'red');
  assert.equal(before.target, '23.0');
  assert.equal(before.left, '10:00');
  assert.equal(before.sub, 'starts at first crossing');
  assert.equal(before.next, 'Next: Under blue · 24.0 s · 10 min');
  const rest = boardParts(plan, planProgress(plan, [], 20 * MIN + 1000));
  assert.equal(rest.swatch, 'rest');
  assert.equal(rest.rest, true);
  assert.equal(rest.target, '');
  assert.equal(rest.sub, 'left in block');
  const ramp = parsePlan({ blocks: [{ kind: 'ride', min: 5, where: 'red', from: 23, to: 20 }] }).plan;
  assert.equal(boardParts(ramp, planProgress(ramp, [], null)).target, '23.0 → 20.0');
  assert.equal(boardParts(ramp, planProgress(ramp, [], null)).ramp, true);
  assert.equal(boardParts(ramp, planProgress(ramp, [], 150000)).target, '21.5');
  const laps = boardParts(plan, planProgress(plan, [], 60 * MIN));
  assert.deepEqual([laps.left, laps.leftUnit, laps.swatch, laps.next], ['8', 'laps', 'any', 'Last block']);
  const one = parsePlan({ blocks: [{ laps: 1, target: 20 }] }).plan;
  assert.equal(boardParts(one, planProgress(one, [], 0)).swatch, null);
  assert.equal(boardParts(one, planProgress(one, [], 0)).line, 'Ride');
  const noTarget = parsePlan({ blocks: [{ kind: 'ride', min: 3, where: 'below_blue' }] }).plan;
  const nt = boardParts(noTarget, planProgress(noTarget, [], null));
  assert.deepEqual([nt.line, nt.swatch, nt.target, nt.left], ['Under blue', 'blue', '', '3:00']);
  const odd = parsePlan({ blocks: [{ kind: 'ride', min: 3, where: 'track_stand' }] }).plan;
  assert.deepEqual([boardParts(odd, planProgress(odd, [], null)).line, boardParts(odd, planProgress(odd, [], null)).swatch], ['Track stand', 'none']);
  assert.equal(boardParts(one, planProgress(one, lapsOf(20), 20000)).done, true);
});

test('band tags carry a word and a mark, not colour alone', () => {
  assert.deepEqual(bandTag({ band: 'good', gap: 0.1 }), { band: 'good', text: '✓ On target', mark: '✓' });
  assert.equal(bandTag({ band: 'slow', gap: 0.5 }).text, '▲ Slow +0.5');
  assert.equal(bandTag({ band: 'veryslow', gap: 1.24 }, 2).text, '▲▲ Very slow +1.24');
  assert.equal(bandTag({ band: 'fast', gap: -0.4 }).text, '▼ Fast −0.4');
  assert.equal(bandTag({ break: true, band: null }).text, 'Break');
  assert.equal(bandTag({ band: null, gap: null }), null);
  assert.equal(bandTag(undefined), null);
});

test('summary after Stop: best, average and bars leave out breaks', () => {
  const s = summarize([20000, 22000, 21000, 60000].map((ms) => ({ ms })));
  assert.equal(s.count, 4);
  assert.equal(s.best, 20000);
  assert.equal(s.average, 21000);
  assert.equal(s.onTarget, null);
  assert.deepEqual(s.bars.map((b) => b.h), [2, 10, 6, 10]);
  assert.equal(s.bars[3].band, 'break');
  const withPlan = summarize([{ ms: 23100 }, { ms: 23600 }, { ms: 50000 }], [
    { band: 'good', gap: 0.1 }, { band: 'slow', gap: 0.6 }, { break: true, band: null },
  ]);
  assert.deepEqual(withPlan.onTarget, { good: 1, of: 2 });
  assert.equal(withPlan.bars[1].band, 'slow');
  assert.equal(withPlan.bars[2].band, 'break');
  assert.equal(summarize([]).best, null);
});
