import test from 'node:test';
import assert from 'node:assert/strict';
import { coachDigitsFor, wordsFor, Announcer } from '../js/speech.js';

test('coach calls units and tenths, dropping the tens', () => {
  assert.deepEqual(coachDigitsFor('23.7'), [3, 7]);
  assert.deepEqual(coachDigitsFor('18.0'), [8, 0]);
  assert.deepEqual(coachDigitsFor('22.5'), [2, 5]);
  assert.deepEqual(coachDigitsFor('17.43'), [7, 4]);
  assert.deepEqual(coachDigitsFor('1:05.2'), [5, 2]);
  assert.deepEqual(coachDigitsFor('19'), [9, 0]);
});

test('coach keys fall back to the other position, then to English', () => {
  const a = new Announcer({ mode: 'coach' });
  a.buffers = new Map([['coach/a3', 1], ['coach/b7', 1], ['coach/b8', 1]]);
  assert.deepEqual(a.coachKeys('23.7'), ['coach/a3', 'coach/b7']);
  assert.deepEqual(a.coachKeys('18.3'), ['coach/b8', 'coach/a3']);
  assert.deepEqual(a.coachKeys('16.0'), ['6', '0']);
});

test('a whole recorded call wins over joined digits', () => {
  const a = new Announcer({ mode: 'coach' });
  a.buffers = new Map([['coach/37', 1], ['coach/a3', 1], ['coach/b7', 1]]);
  assert.deepEqual(a.coachKeys('23.7'), ['coach/37']);
  assert.deepEqual(a.coachKeys('13.7'), ['coach/37']);
});

test('english words are unchanged', () => {
  assert.deepEqual(wordsFor('17.4'), ['17', 'point', '4']);
});

test('coach extras: gap said like a lap call, words in her voice', () => {
  const a = new Announcer({ mode: 'coach' });
  a.buffers = new Map(['coach/00', 'coach/03', 'coach/12', 'coach/plus', 'coach/minus', 'coach/nextblock'].map((k) => [k, 1]));
  assert.deepEqual(a.coachExtras({ gap: 0.3 }), ['_', 'coach/plus', 'coach/03']);
  assert.deepEqual(a.coachExtras({ gap: -1.2, nextBlock: true }), ['_', 'coach/minus', 'coach/12', '_', 'coach/nextblock']);
  assert.deepEqual(a.coachExtras({ gap: -0.04 }), ['_', 'coach/plus', 'coach/00']);
  assert.deepEqual(a.coachExtras({}), []);
});

test('coach words fall back to English when not recorded', () => {
  const a = new Announcer({ mode: 'coach' });
  a.buffers = new Map([['coach/start', 1]]);
  assert.equal(a.coachWord('start'), 'coach/start');
  assert.equal(a.coachWord('nextblock'), 'nextblock');
});

test('every listed coach clip exists in audio/coach/', async () => {
  const fs = await import('node:fs');
  const { COACH_CLIPS } = await import('../js/speech.js');
  const missing = COACH_CLIPS.filter((n) => !fs.existsSync(new URL(`../audio/coach/${n}.m4a`, import.meta.url)));
  assert.deepEqual(missing, []);
});
