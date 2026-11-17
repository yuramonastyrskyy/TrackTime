// Tests for timing sessions and sending them to Pacemaker (against a local stub).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  newSession, sessionStart, sessionLap, sessionUndo, sessionDuration, sessionPayload, isoLocal, sendSession, apiFor,
  APP_VERSION,
} from '../js/session.js';
import { parsePlan, DEFAULT_API } from '../js/plan.js';

const plan = parsePlan({ v: 1, id: 'trk_ab12cd', name: 'Corridor build', api: 'https://pacemaker-theta.vercel.app', blocks: [{ min: 10, target: 23 }] }).plan;

function sample(withPlan = true) {
  const s = newSession({ now: 1763395900000, plan: withPlan ? plan : null, settings: { ignoreSec: 14, decimals: 1 } });
  sessionStart(s, 1763395923120);
  sessionLap(s, 1, 23040, 1763395946160);
  sessionLap(s, 2, 22987.4, 1763395969147.6);
  return s;
}

test('isoLocal keeps the phone offset', () => {
  assert.equal(isoLocal(Date.UTC(2026, 10, 17, 16, 12, 3, 120), 120), '2026-11-17T18:12:03.120+02:00');
  assert.equal(isoLocal(Date.UTC(2026, 10, 17, 16, 12, 3, 120), -330), '2026-11-17T10:42:03.120-05:30');
  assert.equal(isoLocal(Date.UTC(2026, 10, 17, 16, 12, 3, 120), 0), '2026-11-17T16:12:03.120+00:00');
});

test('a session is built in the shape Pacemaker expects', () => {
  const s = sample();
  assert.deepEqual(s.laps, [{ lap: 1, ms: 23040, at: 1763395946160 }, { lap: 2, ms: 22987, at: 1763395969148 }]);
  assert.equal(sessionDuration(s), 1763395969148 - 1763395923120);
  const body = sessionPayload(s, { offsetMin: 120 });
  assert.deepEqual(Object.keys(body), ['v', 'plan', 'startedAt', 'laps', 'ignoreSec', 'app']);
  assert.equal(body.v, 1);
  assert.equal(body.plan, 'trk_ab12cd');
  assert.equal(body.startedAt, isoLocal(1763395923120, 120));
  assert.match(body.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
  assert.deepEqual(body.laps[0], { lap: 1, ms: 23040, at: 1763395946160 });
  assert.equal(body.ignoreSec, 14);
  assert.equal(body.app, `TrackTime ${APP_VERSION}`);
});

test('no plan: "plan" is left out and the default api is used', () => {
  const s = sample(false);
  assert.equal('plan' in sessionPayload(s), false);
  assert.equal(apiFor(s), DEFAULT_API);
  assert.equal(apiFor(sample()), 'https://pacemaker-theta.vercel.app');
  assert.equal(apiFor(s, 'http://localhost:9999/'), 'http://localhost:9999');
});

test('undo drops the last lap, then the clock start', () => {
  const s = sample();
  sessionUndo(s); sessionUndo(s);
  assert.equal(s.laps.length, 0);
  assert.equal(s.startedAt, 1763395923120);
  sessionUndo(s);
  assert.equal(s.startedAt, null);
});

function stub(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body }); handler(req, res); });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, api: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('sends to <api>/api/rides?action=track as text/plain and returns the links', async () => {
  const { server, seen, api } = await stub((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ id: 'r1', telegram: 'https://t.me/pacemaker_bot?startapp=track_r1', web: 'https://pacemaker-theta.vercel.app/app?track=r1' }));
  });
  try {
    const answer = await sendSession(sample(), { api, offsetMin: 120 });
    assert.deepEqual(answer, { id: 'r1', telegram: 'https://t.me/pacemaker_bot?startapp=track_r1', web: 'https://pacemaker-theta.vercel.app/app?track=r1' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, '/api/rides?action=track');
    assert.equal(seen[0].type, 'text/plain');
    assert.deepEqual(JSON.parse(seen[0].body), sessionPayload(sample(), { offsetMin: 120 }));
  } finally { server.close(); }
});

test('an error answer or no network throws, so the app can say "Couldn\'t send"', async () => {
  const { server, api } = await stub((req, res) => { res.writeHead(500); res.end('nope'); });
  try {
    await assert.rejects(sendSession(sample(), { api }), /500/);
  } finally { server.close(); }
  await assert.rejects(sendSession(sample(), { api: 'http://127.0.0.1:1' }));
});

test('links that are not web links are dropped', async () => {
  const { server, api } = await stub((req, res) => { res.writeHead(200); res.end(JSON.stringify({ id: 'x', telegram: 'javascript:alert(1)', web: 'data:text/html,hi' })); });
  try {
    assert.deepEqual(await sendSession(sample(), { api }), { id: 'x', telegram: null, web: null });
  } finally { server.close(); }
});
