// Timing sessions: what is kept for each Start timing / Record + time run, and
// the payload sent to Pacemaker. No browser APIs, so it is tested in Node.

import { DEFAULT_API, cleanApi } from './plan.js';

export const APP_VERSION = '2026-11-17';

/** A new, empty timing session. */
export function newSession({ now = Date.now(), plan = null, settings = {} } = {}) {
  return {
    id: `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdAt: now,          // when Start timing was tapped (epoch ms)
    startedAt: null,         // first crossing: the clock start (epoch ms)
    endedAt: null,
    laps: [],                // { lap, ms, at } at = phone time of the crossing that ends the lap
    plan,
    settings,
    sentAt: null,
    sent: null,              // Pacemaker's answer
  };
}

export function sessionStart(session, at) {
  session.startedAt = Math.round(at);
}

export function sessionLap(session, lap, ms, at) {
  session.laps.push({ lap, ms: Math.round(ms), at: Math.round(at) });
}

/** Undo: drops the last lap, or the clock start when there are no laps. */
export function sessionUndo(session) {
  if (session.laps.length) session.laps.pop();
  else session.startedAt = null;
}

/** Plan-clock length of the session in ms (first crossing to last lap). */
export function sessionDuration(session) {
  if (!session.laps.length || session.startedAt === null) return 0;
  return session.laps[session.laps.length - 1].at - session.startedAt;
}

/** ISO time with the phone's UTC offset, e.g. 2026-11-17T18:12:03.120+02:00. */
export function isoLocal(epochMs, offsetMin = -new Date(epochMs).getTimezoneOffset()) {
  const d = new Date(epochMs + offsetMin * 60000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return d.toISOString().replace('Z', off);
}

/** Body of POST <api>/api/rides?action=track. */
export function sessionPayload(session, { offsetMin } = {}) {
  const start = session.startedAt ?? session.createdAt;
  const body = { v: 1 };
  if (session.plan?.id) body.plan = session.plan.id;
  body.startedAt = isoLocal(start, offsetMin);
  body.laps = session.laps.map((l) => ({ lap: l.lap, ms: l.ms, at: l.at }));
  body.ignoreSec = session.settings?.ignoreSec ?? 14;
  body.app = `TrackTime ${APP_VERSION}`;
  return body;
}

/** Where a session is sent: an override (for testing), the plan's api, or the default. */
export function apiFor(session, override = null) {
  return cleanApi(override) || session.plan?.api || DEFAULT_API;
}

/**
 * Sends a session to Pacemaker. text/plain keeps it a "simple" request, so
 * the browser sends no CORS preflight. Resolves to Pacemaker's answer
 * { id, telegram, web }; throws on network errors and non-2xx answers.
 */
export async function sendSession(session, { api, fetchFn = globalThis.fetch, timeoutMs = 15000, offsetMin } = {}) {
  const base = api || apiFor(session);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchFn(`${base}/api/rides?action=track`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(sessionPayload(session, { offsetMin })),
      signal: ctrl?.signal,
    });
    if (!res.ok) throw new Error(`Pacemaker answered ${res.status}`);
    const answer = await res.json();
    if (!answer || typeof answer !== 'object') throw new Error('Pacemaker gave no answer');
    return {
      id: typeof answer.id === 'string' ? answer.id : null,
      telegram: httpsLink(answer.telegram),
      web: httpLink(answer.web),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const httpsLink = (u) => { try { return new URL(u).protocol === 'https:' ? u : null; } catch { return null; } };
const httpLink = (u) => { try { return /^https?:$/.test(new URL(u).protocol) ? u : null; } catch { return null; } };
