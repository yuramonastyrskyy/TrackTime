import test from 'node:test';
import assert from 'node:assert/strict';
import { assign, pickCrossings, isRider, RiderBook, RiderRun, lapLeader, IGNORED, bookToJSON, bookFromJSON, ridersPayload, correctSaved, renameSaved, unsureLeaders } from '../js/riders.js';
import { newSession, sessionPayload } from '../js/session.js';

const line = { top: { x: 0.5, y: 0.2 }, inner: { x: 0.5, y: 0.8 } };
const W = 360, H = 640;

// A rider's features: a colour histogram with one strong bin per region, and a re-ID vector.
function feat(k, noise = 0, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * noise;
  const col = new Array(486).fill(0).map(() => Math.abs(rnd()));
  col[k * 7] += 1; col[162 + k * 5] += 1; col[324 + k * 3] += 1;
  const emb = new Array(512).fill(0).map(() => rnd());
  emb[k * 11] += 1;
  return { col, emb };
}
// A rider passing the line from right to left over frames at 33 ms.
function pass(k, t0, { seed = 1, noise = 0.05 } = {}) {
  const frames = [];
  for (let i = 0; i < 5; i++) {
    const cx = 260 - i * 40;
    frames.push({ t: t0 + i * 33, w: W, h: H, people: [{ box: [cx - 60, 200, cx + 60, 460], bike: [cx - 90, 330, cx + 90, 480], ...feat(k, noise, seed + i) }] });
  }
  return frames;
}

test('assign finds the cheapest one-to-one matching', () => {
  assert.deepEqual(assign([[4, 1, 3], [2, 0, 5], [3, 2, 2]]), [1, 0, 2]);
  assert.deepEqual(assign([[1, 2]]), [0]);
  assert.deepEqual(assign([]), []);
});

test('isRider keeps riders on the track and drops people by the camera or far from the line', () => {
  const f = { w: W, h: H };
  assert.ok(isRider({ box: [120, 200, 240, 460], bike: null }, f, line));
  assert.ok(!isRider({ box: [120, 100, 240, 630], bike: null }, f, line), 'too tall: right by the camera');
  assert.ok(!isRider({ box: [120, 400, 240, 620], bike: null }, f, line), 'feet below the inner edge');
  assert.ok(!isRider({ box: [0, 200, 60, 460], bike: null }, f, line), 'far from the line');
  assert.ok(!isRider({ box: [120, 400, 240, 440], bike: null }, f, line), 'too small');
});

test('pickCrossings gives one crossing per rider, from the frame closest to the line', () => {
  const frames = [...pass(0, 1000), ...pass(1, 1170), ...pass(2, 1330)];
  const c = pickCrossings(frames, line);
  assert.equal(c.length, 3);
  // Closest to the line (x = 180): the third frame of each pass (cx = 180).
  assert.deepEqual(c.map((x) => x.t), [1066, 1236, 1396]);
});

test('RiderBook learns riders in the first lap and finds them again', () => {
  const book = new RiderBook();
  const lap = (seed) => [0, 1, 2, 3].map((k) => ({ t: k * 200, ...feat(k, 0.1, seed + k * 13) }));
  const first = book.addLap(lap(1));
  assert.equal(book.riders.length, 4);
  assert.ok(first.every((r) => r.isNew));
  const second = book.addLap(lap(99).reverse());
  assert.deepEqual(second.map((r) => r.rider), ['r4', 'r3', 'r2', 'r1']);
  assert.ok(second.every((r) => r.sure && !r.isNew));
  // A rider not seen before becomes a new rider.
  const third = book.addLap([{ t: 0, ...feat(9, 0.1, 5) }, { t: 200, ...feat(1, 0.1, 7) }]);
  assert.equal(third[0].isNew, true);
  assert.equal(third[1].rider, 'r2');
});

test('RiderRun: windows, leader, corrections, summary and payload', () => {
  const run = new RiderRun(line, new RiderBook());
  run.addCrossing(0, 1000);
  run.addCrossing(1, 26000);
  run.addFrames([...pass(0, 1000), ...pass(1, 1200), ...pass(2, 1400)]);
  run.addFrames([...pass(1, 26000, { seed: 50 }), ...pass(0, 26200, { seed: 60 }), ...pass(2, 26400, { seed: 70 })]);
  assert.deepEqual(run.finishUpTo(20000), [0]);
  assert.deepEqual(run.finishAll(), [1]);
  assert.equal(run.leader(0).rider, 'r1');
  assert.equal(run.leader(1).rider, 'r2', 'rider 2 led lap 1');
  // The leader of lap 1 was really a passer-by: the next rider leads.
  run.correct(1, 0, IGNORED);
  assert.equal(run.leader(1).rider, 'r1');
  const sum = run.summary([0, 1]);
  assert.equal(sum.riders.length, 3);
  assert.equal(sum.laps[1].leader, 'r1');
  assert.equal(sum.laps[1].order[0].id, IGNORED);
  run.book.rename('r1', 'Olena');
  const s = newSession({ now: 0 });
  s.startedAt = 0;
  s.laps = [{ lap: 1, ms: 25000, at: 25000 }];
  s.riders = run.summary([0, 1]);
  const body = sessionPayload(s, { offsetMin: 0 });
  assert.deepEqual(body.riders.find((r) => r.id === 'r1'), { id: 'r1', name: 'Olena', led: 1 });
  assert.equal(body.laps[0].leader, 'r1');
  assert.equal(body.laps[0].leaderSure, true);
  assert.deepEqual(body.laps[0].order, ['r1', 'r3']);
  assert.equal(body.startLeader, 'r1');
  // Without riders the payload is as before.
  const plain = sessionPayload({ ...s, riders: null }, { offsetMin: 0 });
  assert.equal(plain.riders, undefined);
  assert.equal(plain.laps[0].leader, undefined);
});

test('lapLeader only counts riders near the lap time', () => {
  const r = [{ t: 500, rider: 'a' }, { t: 1100, rider: 'b' }, { t: 3000, rider: 'c' }];
  assert.equal(lapLeader(r, 1000).rider, 'b');
  assert.equal(lapLeader(r, -5000), null);
});

test('the book survives a round trip through JSON', () => {
  const book = new RiderBook();
  book.addLap([0, 1].map((k) => ({ t: k * 200, ...feat(k, 0.1, k + 3) })));
  book.rename('r2', 'Taras');
  const back = bookFromJSON(JSON.parse(JSON.stringify(bookToJSON(book))));
  assert.equal(back.riders.length, 2);
  assert.equal(back.byId('r2').name, 'Taras');
  assert.equal(back.nextId, 3);
  const again = back.addLap([{ t: 0, ...feat(1, 0.1, 42) }]);
  assert.equal(again[0].rider, 'r2');
  assert.equal(bookFromJSON(null).riders.length, 0);
  assert.equal(ridersPayload(null, [1]), null);
});

test('correctSaved fixes a saved session, moves the leader and teaches the book', () => {
  const run = new RiderRun(line, new RiderBook());
  run.addCrossing(0, 1000);
  run.addCrossing(1, 26000);
  run.addFrames([...pass(0, 1000), ...pass(1, 1200), ...pass(2, 1400)]);
  run.addFrames([...pass(1, 26000, { seed: 50 }), ...pass(0, 26200, { seed: 60 }), ...pass(2, 26400, { seed: 70 })]);
  run.finishAll();
  // What a session keeps, after a trip through storage (structured clone keeps the Float32Arrays).
  const saved = structuredClone(run.summary([0, 1]));
  assert.ok(saved.laps[1].order[0].f.col instanceof Float32Array);
  assert.equal(saved.laps[1].leader, 'r2');
  // Later, the book has moved on (it is the same book here, as in the app).
  const book = run.book;
  const before = book.byId('r3').samples.length;
  // The first crossing of lap 1 was really rider 3.
  assert.equal(correctSaved(saved, book, 1, 0, 'r3'), true);
  assert.equal(saved.laps[1].order[0].id, 'r3');
  assert.equal(saved.laps[1].leader, 'r3');
  assert.equal(saved.laps[1].sure, true);
  assert.equal(book.byId('r3').samples.length, before + 1, 'the book learnt from the correction');
  // Not a team rider: the next one leads.
  correctSaved(saved, book, 1, 0, IGNORED);
  assert.equal(saved.laps[1].leader, 'r1');
  // A new rider gets a new id from the book.
  correctSaved(saved, book, 0, 2, null);
  const nid = saved.laps[0].order[2].id;
  assert.ok(!['r1', 'r2', 'r3'].includes(nid));
  assert.ok(saved.riders.some((r) => r.id === nid));
  assert.ok(book.byId(nid));
  // Renames reach the session and the book; the payload follows the corrections.
  renameSaved(saved, book, 'r1', 'Olena');
  assert.equal(book.byId('r1').name, 'Olena');
  const s = newSession({ now: 0 });
  s.startedAt = 0;
  s.laps = [{ lap: 1, ms: 25000, at: 25000 }];
  s.riders = saved;
  const body = sessionPayload(s, { offsetMin: 0 });
  assert.equal(body.laps[0].leader, 'r1');
  assert.equal(body.riders.find((r) => r.id === 'r1').name, 'Olena');
  assert.ok(!JSON.stringify(body).includes('"f"'), 'features stay out of the payload');
  assert.equal(unsureLeaders(saved, [0, 1]), 0);
});

test('correctSaved works on sessions saved without features', () => {
  const riders = {
    v: 1,
    riders: [{ id: 'r1', name: 'A', thumb: null }, { id: 'r2', name: 'B', thumb: null }],
    laps: { 1: { leader: 'r2', sure: false, order: [{ id: 'r2', t: -100, sure: false, thumb: null }, { id: 'r1', t: 300, sure: true, thumb: null }] } },
  };
  const book = new RiderBook();
  book.nextId = 7;
  assert.equal(unsureLeaders(riders, [1]), 1);
  correctSaved(riders, book, 1, 0, 'r1');
  assert.equal(riders.laps[1].leader, 'r1');
  assert.deepEqual(riders.riders.map((r) => r.id), ['r1'], 'r2 is no longer in this session');
  correctSaved(riders, book, 1, 1, null);
  assert.equal(riders.laps[1].order[1].id, 'r7');
  assert.equal(book.nextId, 8);
  assert.equal(correctSaved(riders, book, 5, 0, 'r1'), false);
});

test('riders in the same kit are told apart by the bike', () => {
  const kit = (bike, seed) => {
    const f = feat(0, 0.15, seed);
    f.col[324] -= 1; f.col[324 + 30 + bike * 9] += 1; // same jersey and legs, only the bike differs
    return f;
  };
  const book = new RiderBook();
  const lap = (seed) => [{ t: 0, ...kit(0, seed) }, { t: 200, ...kit(1, seed + 5) }, { t: 400, ...feat(3, 0.15, seed + 9) }];
  book.addLap(lap(1));
  assert.equal(book.riders.length, 3);
  for (const seed of [40, 70, 110]) {
    const r = book.addLap(lap(seed).reverse());
    assert.deepEqual(r.map((x) => x.rider), ['r3', 'r2', 'r1']);
  }
});

test('riders learnt with older colour features are dropped', () => {
  const book = bookFromJSON(bookToJSON((() => { const b = new RiderBook(); b.addLap([{ t: 0, ...feat(1) }]); return b; })()));
  assert.equal(book.riders.length, 1);
  assert.equal(book.fv, 1);
  const r = book.addLap([{ t: 0, fv: 2, ...feat(2) }, { t: 200, fv: 2, ...feat(4) }]);
  assert.equal(book.fv, 2);
  assert.equal(book.riders.length, 2);
  assert.ok(r.every((x) => x.isNew));
  assert.equal(bookFromJSON(bookToJSON(book)).fv, 2);
});

test('one rider crossing alone is the same rider every lap', () => {
  const book = new RiderBook();
  const ids = [1, 2, 3, 4].map((seed) => book.addLap([{ t: 0, ...feat(2, 0.15, seed * 31) }])[0]);
  assert.equal(book.riders.length, 1);
  assert.ok(ids.every((r) => r.rider === 'r1'));
  assert.ok(ids.slice(1).every((r) => r.sure));
  // A second, different rider joining later is still told apart.
  const r = book.addLap([{ t: 0, ...feat(2, 0.15, 500) }, { t: 300, ...feat(6, 0.15, 501) }]);
  assert.deepEqual(r.map((x) => x.rider), ['r1', 'r2']);
});
