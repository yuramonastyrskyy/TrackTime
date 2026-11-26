import test from 'node:test';
import assert from 'node:assert/strict';
import { RATE, shape, wav } from '../scripts/coach-voice/audio.mjs';

// 0.3 s silence, 0.4 s quiet tone, 0.3 s silence.
function sample() {
  const pcm = new Int16Array(RATE);
  const from = Math.round(RATE * 0.3);
  const to = Math.round(RATE * 0.7);
  for (let i = from; i < to; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * 1000);
  return pcm;
}

test('shape trims the silence and adds a 60 ms lead-in', () => {
  const out = shape(sample());
  const ms = (out.length / RATE) * 1000;
  // 60 lead-in + 400 sound + up to 2 x 20 margin (+ one 10 ms window of slack).
  assert.ok(ms > 455 && ms < 515, `length ${ms} ms`);
  const lead = out.subarray(0, Math.round(RATE * 0.06));
  assert.ok(lead.every((v) => v === 0), 'lead-in is silent');
});

test('shape levels a quiet clip up without clipping', () => {
  const out = shape(sample());
  let peak = 0;
  let sum = 0;
  for (const v of out) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  assert.ok(peak > 1000 * 3, 'louder than the input');
  assert.ok(peak <= 32767 * 10 ** (-1 / 20) + 1, 'peak at most -1 dBFS');
});

test('silence stays silence', () => {
  const out = shape(new Int16Array(RATE));
  assert.ok(out.every((v) => v === 0));
});

test('wav header describes 16-bit mono at RATE', () => {
  const w = wav(new Int16Array(10));
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt16LE(22), 1);
  assert.equal(w.readUInt32LE(24), RATE);
  assert.equal(w.readUInt32LE(40), 20);
});

test('calls.txt has a text for every clip', async () => {
  const { allClips, NAMES } = await import('../scripts/coach-voice/calls.mjs');
  const clips = allClips();
  assert.deepEqual(clips.map((c) => c.name), NAMES);
  assert.equal(clips.length, 104);
});

test('calls.txt lines: comments skipped, dialect text kept as written', async () => {
  const { parseCalls, NAMES } = await import('../scripts/coach-voice/calls.mjs');
  const full = NAMES.map((n) => `${n} = x`);
  full[37] = '37 = трі сєм';
  const clips = parseCalls(['# comment', '', ...full].join('\n'));
  assert.equal(clips[37].text, 'трі сєм');
  assert.throws(() => parseCalls(full.slice(1).join('\n')), /missing: 00/);
  assert.throws(() => parseCalls([...full, '37 = again'].join('\n')), /twice/);
  assert.throws(() => parseCalls([...full, '123 = x'].join('\n')), /unknown clip/);
});
