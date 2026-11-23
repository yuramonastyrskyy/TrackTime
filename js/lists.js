// Settings > Recordings and Settings > Sessions lists, and Send to Pacemaker.
// DOM only; app.js passes in what it owns through initLists().
import { sessionFiles, shareOrDownload, store, formatBytes } from './recorder.js';
import { sessionDuration, sendSession, apiFor } from './session.js';

const $ = (id) => document.getElementById(id);
const els = {
  settings: $('settings'), recordingsBtn: $('recordingsBtn'), recordings: $('recordings'), recList: $('recList'),
  recStorage: $('recStorage'), recStorageText: $('recStorageText'), recStorageFill: $('recStorageFill'),
  sessionsBtn: $('sessionsBtn'), sessions: $('sessions'), sessList: $('sessList'),
  sendBtn: $('sendBtn'), sendNote: $('sendNote'), sendLabel: $('sendLabel'), sendIcon: $('sendIcon'),
};

/**
 * What the lists need from app.js:
 * arm(btn, onArm, onDisarm) two-tap guard; recordingId() id of the recording
 * running now; sessionId() id of the session being timed; lastSession() the
 * last finished session; forgetLastSession(id) after it was deleted;
 * backToSettings() reopens Settings from a list's back arrow.
 */
let ctx = null;
export function initLists(c) {
  ctx = c;
  els.recordingsBtn.addEventListener('click', () => { els.settings.close(); openRecordings(); });
  els.sessionsBtn.addEventListener('click', () => { els.settings.close(); openSessions(); });
  els.sendBtn.addEventListener('click', () => {
    const s = ctx.lastSession();
    if (s) sendToPacemaker(s, els.sendBtn, els.sendNote);
  });
  // Back arrow in Sessions / Recordings returns to Settings.
  for (const d of [els.sessions, els.recordings]) {
    d.querySelector('[data-back]').addEventListener('click', () => {
      d.close();
      ctx.backToSettings();
    });
  }
}

// Recordings list. Files are built before the buttons appear, so a tap can
// open the share sheet straight away (phones need that).
export async function openRecordings(highlightId = null, memChunks = null) {
  els.recList.replaceChildren(textP('Loading…', 'meta'));
  if (!els.recordings.open) els.recordings.showModal();
  let sessions = [];
  try { sessions = await store.listSessions(); } catch (e) {
    els.recList.replaceChildren(warnP(`Could not open saved recordings (${e?.message || e}).`));
  }
  sessions = sessions.filter((x) => x.id !== ctx.recordingId()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const items = [];
  for (const rec of sessions) {
    const files = await sessionFiles(rec, rec.id === highlightId ? memChunks : null).catch(() => []);
    items.push(renderSession(rec, files));
  }
  els.recList.replaceChildren(...(items.length ? items : [emptyState('i-film-lg', 'No recordings yet', 'Tap Record + time to make one.')]));
  try {
    const est = await navigator.storage?.estimate?.();
    els.recStorage.hidden = !est?.quota;
    if (est?.quota) {
      els.recStorageText.textContent = `Using ${formatBytes(est.usage || 0)} of about ${formatBytes(est.quota)} the browser allows.`;
      els.recStorageFill.style.width = `${Math.min(100, Math.max(1, (100 * (est.usage || 0)) / est.quota)).toFixed(1)}%`;
    }
  } catch { els.recStorage.hidden = true; }
}

function textP(t, cls) { const p = document.createElement('p'); p.className = cls; p.textContent = t; return p; }
function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}
function warnP(t) {
  const p = document.createElement('p');
  p.className = 'warn';
  const span = document.createElement('span');
  span.textContent = t;
  p.append(icon('i-warn'), span);
  return p;
}
function emptyState(iconId, title, text) {
  const d = document.createElement('div');
  d.className = 'empty-state';
  const b = document.createElement('b');
  b.textContent = title;
  const t = document.createElement('span');
  t.textContent = text;
  d.append(icon(iconId), b, t);
  return d;
}
function pill(text, cls = '') {
  const s = document.createElement('span');
  s.className = `pill${cls ? ` ${cls}` : ''}`;
  s.textContent = text;
  return s;
}
function cardBox() {
  const box = document.createElement('article');
  box.className = 'card scard';
  return box;
}
/** A delete button that needs two taps; onDelete runs on the second. */
function deleteButton(label, onDelete) {
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'btn sm danger'; del.textContent = label;
  del.addEventListener('click', () => {
    const second = ctx.arm(del, () => { del.classList.add('armed'); del.textContent = 'Tap again to delete'; },
      () => { del.classList.remove('armed'); del.textContent = label; });
    if (second) onDelete(del);
  });
  return del;
}

function renderSession(rec, files) {
  const box = cardBox();
  const h = document.createElement('h3');
  const d = new Date(rec.startedAt);
  h.textContent = d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const lastMs = rec.log.events.length ? rec.log.events[rec.log.events.length - 1].ms : 0;
  const laps = rec.log.events.filter((e) => e.type === 'lap').length;
  const marks = rec.log.events.filter((e) => e.type === 'mark').length;
  const videos = files.filter((f) => f.type.startsWith('video/'));
  const total = videos.reduce((n, f) => n + f.size, 0);
  const meta = textP(`${videos.length} ${videos.length === 1 ? 'part' : 'parts'} · ${formatDuration(lastMs)} · ${formatBytes(total)} · ${marks} ${marks === 1 ? 'mark' : 'marks'}${laps ? ` · ${laps} laps` : ''}`, 'meta');
  box.append(h, meta);
  if (!rec.endedAt) box.append(warnP('Stopped unexpectedly. Everything up to then is saved.'));
  for (const p of rec.problems || []) box.append(warnP(p.msg));
  for (const f of videos) {
    const part = f.name.match(/part(\d+)/)?.[1];
    box.append(fileButton(`Save video${part ? ` part ${part}` : ''}`, formatBytes(f.size), [f]));
  }
  const logs = files.filter((f) => !f.type.startsWith('video/'));
  if (logs.length) box.append(fileButton('Save log, events and setup photo', formatBytes(logs.reduce((n, f) => n + f.size, 0)), logs));
  box.append(deleteButton('Delete this recording', async (del) => {
    del.disabled = true;
    try { await store.deleteSession(rec.id); box.remove(); } catch (e) { del.textContent = `Delete failed (${e?.message || e})`; del.disabled = false; }
  }));
  return box;
}

function fileButton(label, size, files) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn sm part';
  const name = document.createElement('span');
  name.textContent = label;
  const sz = document.createElement('span');
  sz.className = 'sz';
  sz.textContent = size;
  b.append(name, sz);
  b.addEventListener('click', () => {
    shareOrDownload(files).then((how) => {
      if (how === 'shared' || how === 'downloaded') { b.classList.add('saved'); sz.textContent = size ? `${size} ✓` : 'Saved ✓'; }
    });
  });
  return b;
}

// ---------- Send to Pacemaker ----------
// Only ever on a tap. No keys or logins: Pacemaker asks the person to check
// and save the ride.
const API_OVERRIDE = new URLSearchParams(location.search).get('pmapi'); // e.g. ?pmapi=http://localhost:8787 for testing
const SEND_FAILED = "Couldn't send. It's saved in Settings › Sessions; try again with signal.";

// Button states: idle → .busy "Sending…" → .done "Sent ✓"; on failure the
// label says "Try sending again" and the note explains.
const SEND_NOTE_IDLE = 'Checks the laps against the plan and saves them in Pacemaker.';
const SEND_NOTE_BUSY = 'Keep this screen open for a moment.';

/**
 * Button states from the design board: idle (icon + "Send to Pacemaker"),
 * .busy "Sending…" (can't be tapped twice), .done "✓ Sent to Pacemaker" with
 * a link back, failed = "Try sending again" with the note saying where the
 * session is kept. The main button has its own label/icon; Sessions cards
 * use plain text.
 */
function setSendBtn(btn, mode, label) {
  const main = btn === els.sendBtn;
  btn.classList.toggle('busy', mode === 'busy');
  btn.classList.toggle('done', mode === 'done');
  if (main) {
    els.sendLabel.textContent = label;
    els.sendIcon.parentNode.style.display = mode === 'busy' ? 'none' : '';
    els.sendIcon.setAttribute('href', mode === 'done' ? '#i-tick' : '#i-send');
  } else {
    btn.textContent = label;
  }
}
function setNote(note, text, kind = '', link = null) {
  note.className = `note${kind ? ` ${kind}` : ''}`;
  note.textContent = text;
  if (link) {
    const a = document.createElement('a');
    a.href = link; a.textContent = 'Open in Pacemaker';
    note.append(' ', a);
  }
  note.hidden = false;
}

async function sendToPacemaker(s, btn, note) {
  btn.disabled = true;
  setSendBtn(btn, 'busy', 'Sending…');
  setNote(note, SEND_NOTE_BUSY);
  try {
    const answer = await sendSession(s, { api: apiFor(s, API_OVERRIDE) });
    s.sentAt = Date.now();
    s.sent = answer;
    await store.saveTiming(s).catch(() => {});
    setSendBtn(btn, 'done', 'Sent to Pacemaker');
    setNote(note, 'Saved there too.', 'ok', answer.web || null);
    openPacemaker(answer);
  } catch {
    setSendBtn(btn, 'failed', 'Try sending again');
    setNote(note, SEND_FAILED, 'err');
  } finally {
    btn.disabled = false;
  }
}
/** Back to "Send to Pacemaker" when a new session finishes. */
export function resetSendBtn() {
  els.sendBtn.className = 'btn main send full';
  setSendBtn(els.sendBtn, 'idle', 'Send to Pacemaker');
  setNote(els.sendNote, SEND_NOTE_IDLE);
}

function openPacemaker(answer) {
  const tg = window.Telegram?.WebApp;
  if (tg?.initData && answer.telegram && typeof tg.openTelegramLink === 'function') {
    try { tg.openTelegramLink(answer.telegram); return; } catch { /* fall back to the web page */ }
  }
  if (answer.web) location.href = answer.web;
}

// ---------- Settings > Sessions ----------
async function openSessions() {
  els.sessList.replaceChildren(textP('Loading…', 'meta'));
  if (!els.sessions.open) els.sessions.showModal();
  let list = [];
  try { list = await store.listTimings(); } catch (e) {
    els.sessList.replaceChildren(warnP(`Could not open saved sessions (${e?.message || e}).`));
    return;
  }
  list.sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
  els.sessList.replaceChildren(...(list.length ? list.map(renderTiming) : [emptyState('i-list-lg', 'No sessions yet', 'Every Start timing is kept here.')]));
}

function renderTiming(s) {
  const box = cardBox();
  const h = document.createElement('h3');
  h.textContent = new Date(s.startedAt ?? s.createdAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const active = s.id === ctx.sessionId();
  box.append(h, textP(`${s.laps.length} ${s.laps.length === 1 ? 'lap' : 'laps'} · ${formatDuration(sessionDuration(s))}${s.plan?.name ? ` · ${s.plan.name}` : ''}`, 'meta'));
  const pills = document.createElement('div');
  pills.className = 'pills';
  if (active) pills.append(pill('● Timing now', 'live'));
  if (s.sentAt) pills.append(pill('✓ Sent', 'ok'));
  if (s.plan) pills.append(pill('Plan'));
  if (pills.childElementCount) box.append(pills);
  if (!s.endedAt && !active) box.append(warnP('Stopped unexpectedly. The laps up to then are here.'));
  const row = document.createElement('div');
  row.className = 'btn-row';
  const note = textP('', 'note');
  note.style.textAlign = 'left';
  note.hidden = true;
  if (s.sent?.web) {
    const a = document.createElement('a');
    a.className = 'btn sm ghost'; a.href = s.sent.web; a.textContent = 'Open in Pacemaker';
    row.append(a);
  }
  if (!active && s.laps.length) {
    const send = document.createElement('button');
    send.type = 'button'; send.className = s.sentAt ? 'btn sm ghost' : 'btn sm send';
    send.textContent = s.sentAt ? 'Send again' : 'Send to Pacemaker';
    send.addEventListener('click', () => sendToPacemaker(s, send, note));
    row.append(send);
  }
  if (!active) {
    row.append(deleteButton('Delete', async (del) => {
      del.disabled = true;
      try {
        await store.deleteTiming(s.id);
        ctx.forgetLastSession(s.id);
        box.remove();
      } catch (e) { del.textContent = `Delete failed (${e?.message || e})`; del.disabled = false; }
    }));
  }
  if (row.childElementCount) box.append(row);
  box.append(note);
  return box;
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
