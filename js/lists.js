// Settings > Recordings and Settings > Sessions lists, and Send to Pacemaker.
// DOM only; app.js passes in what it owns through initLists().
import { sessionFiles, shareOrDownload, store, formatBytes } from './recorder.js';
import { sessionDuration, sendSession, apiFor } from './session.js';
import { formatLap } from './detector.js';
import { unsureLeaders } from './riders.js';
import { leaderOf, picture } from './ridersView.js';

const $ = (id) => document.getElementById(id);
const els = {
  settings: $('settings'), recordingsBtn: $('recordingsBtn'), recordings: $('recordings'), recList: $('recList'),
  recStorage: $('recStorage'), recStorageText: $('recStorageText'), recStorageFill: $('recStorageFill'),
  sessionsBtn: $('sessionsBtn'), sessions: $('sessions'), sessList: $('sessList'),
  sendBtn: $('sendBtn'), sendNote: $('sendNote'), sendLabel: $('sendLabel'), sendIcon: $('sendIcon'),
  review: $('review'), reviewBack: $('reviewBack'), reviewSub: $('reviewSub'), reviewMeta: $('reviewMeta'),
  reviewRiders: $('reviewRiders'), reviewLeaders: $('reviewLeaders'), reviewRidersBtn: $('reviewRidersBtn'), reviewRidersSave: $('reviewRidersSave'),
  reviewHint: $('reviewHint'), reviewLaps: $('reviewLaps'), reviewSend: $('reviewSend'), reviewNote: $('reviewNote'),
};

/**
 * What the lists need from app.js:
 * arm(btn, onArm, onDisarm) two-tap guard; recordingId() id of the recording
 * running now; sessionId() id of the session being timed; lastSession() the
 * last finished session; forgetLastSession(id) after it was deleted;
 * backToSettings() reopens Settings from a list's back arrow.
 * Review: decimals(); ridersWaiting(s) true while the app still matches s's
 * riders; livePictures(s) the pictures held in memory for s (Map, or null);
 * openFinish(s, key, pics) photo-finish viewer; openRiders(s) riders sheet.
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
  els.reviewBack.addEventListener('click', () => { els.review.close(); openSessions(); });
  els.reviewRidersBtn.addEventListener('click', () => { if (review) ctx.openRiders(review.s); });
  els.reviewLeaders.addEventListener('click', () => { if (review?.s.riders) ctx.openRiders(review.s); });
  els.reviewRidersSave.addEventListener('click', () => { if (review?.s.riders) saveRiderData(review.s); });
  els.reviewSend.addEventListener('click', () => { if (review) sendToPacemaker(review.s, els.reviewSend, els.reviewNote, () => renderReview()); });
  els.review.addEventListener('close', () => { review = null; });
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
  const isFinish = (f) => f.name.includes('-finish-');
  const logs = files.filter((f) => !f.type.startsWith('video/') && !isFinish(f));
  if (logs.length) box.append(fileButton('Save log, events and setup photo', formatBytes(logs.reduce((n, f) => n + f.size, 0)), logs));
  const pics = files.filter(isFinish);
  if (pics.length) box.append(fileButton(`Save photo-finish pictures (${pics.length})`, formatBytes(pics.reduce((n, f) => n + f.size, 0)), pics));
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

async function sendToPacemaker(s, btn, note, after = () => {}) {
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
    after();
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
  // The session just timed is the same object the app holds (its riders may still be coming in).
  const last = ctx.lastSession();
  list = list.map((x) => (last && x.id === last.id ? last : x));
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
  if (s.sentAt) pills.append(changedSinceSent(s) ? pill('Changed since sent') : pill('✓ Sent', 'ok'));
  const unsure = unsureLeaders(s.riders, [0, ...s.laps.map((l) => l.lap)]);
  if (unsure) pills.append(pill(`${unsure} ${unsure === 1 ? 'rider' : 'riders'} to check`));
  if (s.plan) pills.append(pill('Plan'));
  if (pills.childElementCount) box.append(pills);
  if (!s.endedAt && !active) box.append(warnP('Stopped unexpectedly. The laps up to then are here.'));
  const row = document.createElement('div');
  row.className = 'btn-row';
  const note = textP('', 'note');
  note.style.textAlign = 'left';
  note.hidden = true;
  if (!active && s.laps.length) {
    const rv = document.createElement('button');
    rv.type = 'button'; rv.className = 'btn sm';
    rv.textContent = 'Review laps, riders, photo-finish';
    rv.addEventListener('click', () => { els.sessions.close(); openReview(s); });
    row.append(rv);
  }
  if (s.sent?.web) {
    const a = document.createElement('a');
    a.className = 'btn sm ghost'; a.href = s.sent.web; a.textContent = 'Open in Pacemaker';
    row.append(a);
  }
  if (!active && s.laps.length) {
    const send = document.createElement('button');
    send.type = 'button'; send.className = s.sentAt && !changedSinceSent(s) ? 'btn sm ghost' : 'btn sm send';
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

const changedSinceSent = (s) => !!(s.sentAt && s.editedAt && s.editedAt > s.sentAt);

// ---------- Settings > Sessions > Review ----------
// One saved session in full: every lap with who led it (from the riders the
// Android app recognised) and its photo-finish picture. Corrections in the
// riders sheet go into the session, so Send to Pacemaker sends them.
let review = null; // { s, pics: Map key -> picture }

async function openReview(s) {
  review = { s, pics: new Map() };
  els.reviewSend.className = 'btn main full send';
  els.reviewNote.className = 'note'; els.reviewNote.hidden = true;
  renderReview();
  if (!els.review.open) els.review.showModal();
  let pics = new Map();
  try { pics = await store.listFinishes(s.id); } catch { /* no pictures */ }
  // Pictures still only in memory (the session just timed, storage full).
  for (const [k, f] of ctx.livePictures(s) || []) if (!pics.has(k)) pics.set(k, f);
  if (review?.s !== s) return;
  review.pics = pics;
  renderReview();
}

/** Redraws the review sheet when it shows session s (or any, without s). */
export function refreshReview(s = null) {
  if (review && els.review.open && (!s || review.s === s)) renderReview();
}

function renderReview() {
  if (!review) return;
  const { s, pics } = review;
  const dec = ctx.decimals();
  const keys = [0, ...s.laps.map((l) => l.lap)];
  els.reviewSub.textContent = ` · ${new Date(s.startedAt ?? s.createdAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  const best = s.laps.length ? Math.min(...s.laps.map((l) => l.ms)) : null;
  const avg = s.laps.length ? s.laps.reduce((n, l) => n + l.ms, 0) / s.laps.length : null;
  els.reviewMeta.textContent = `${s.laps.length} ${s.laps.length === 1 ? 'lap' : 'laps'} · ${formatDuration(sessionDuration(s))}`
    + `${best !== null ? ` · best ${formatLap(best, dec)} · average ${formatLap(avg, dec)}` : ''}${s.plan?.name ? ` · ${s.plan.name}` : ''}`;

  // Riders: the leaders' pictures and the sheet that fixes them.
  const waiting = ctx.ridersWaiting(s);
  els.reviewRiders.hidden = !s.riders && !waiting;
  const unsure = unsureLeaders(s.riders, keys);
  els.reviewRidersBtn.disabled = !s.riders;
  els.reviewRidersBtn.textContent = !s.riders ? 'Looking at the riders…' : unsure ? `Check riders (${unsure} ?)` : 'Riders';
  els.reviewRidersBtn.classList.toggle('send', unsure > 0);
  els.reviewRidersSave.hidden = !s.riders;
  els.reviewLeaders.replaceChildren(...s.laps.map((l) => leaderOf(s, l.lap)).filter((x) => x && x.thumb).map((x) => {
    const img = document.createElement('img');
    img.src = x.thumb; img.alt = x.name;
    if (!x.sure) img.className = 'unsure';
    return img;
  }));

  const n = keys.filter((k) => pics.has(k)).length;
  els.reviewHint.textContent = n ? `Tap a lap to see its photo-finish (${n} of ${keys.length} crossings have one).`
    : 'No photo-finish pictures were saved with this session. Sessions timed from this version on keep them.';

  els.reviewLaps.replaceChildren(...keys.map((k) => {
    const lap = s.laps.find((l) => l.lap === k);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `rv-lap${lap && lap.ms === best && s.laps.length > 1 ? ' best' : ''}`;
    const num = document.createElement('span');
    num.className = 'n'; num.textContent = k === 0 ? 'Start' : String(k);
    const time = document.createElement('span');
    time.className = 't'; time.textContent = lap ? formatLap(lap.ms, dec) : '';
    const who = document.createElement('span');
    who.className = 'who';
    const lead = leaderOf(s, k);
    if (lead) {
      if (lead.thumb) who.append(picture(lead.thumb, ''));
      const nm = document.createElement('span');
      nm.textContent = lead.name;
      who.append(nm);
      if (!lead.sure) { who.classList.add('unsure'); const q = document.createElement('em'); q.textContent = '?'; who.append(q); }
    }
    const pf = document.createElement('span');
    pf.className = `pf${pics.has(k) ? ' on' : ''}`;
    pf.textContent = pics.has(k) ? 'Photo' : '';
    b.append(num, time, who, pf);
    b.setAttribute('aria-label', `${k === 0 ? 'Start' : `Lap ${k}, ${time.textContent}`}${lead ? `, first ${lead.name}${lead.sure ? '' : ' (unsure)'}` : ''}${pics.has(k) ? ', open photo-finish' : ''}`);
    b.addEventListener('click', () => ctx.openFinish(s, k, pics));
    li.append(b);
    return li;
  }));

  // Send: the corrected riders go with it.
  els.reviewSend.hidden = !s.laps.length;
  const changed = changedSinceSent(s);
  const btn = els.reviewSend;
  if (btn.classList.contains('busy') || (btn.classList.contains('done') && !changed)) return;
  btn.className = `btn main full${s.sentAt && !changed ? ' ghost' : ' send'}`;
  btn.textContent = !s.sentAt ? 'Send to Pacemaker' : changed ? 'Send the changes to Pacemaker' : 'Send again';
  if (changed) setNote(els.reviewNote, 'Riders changed since this was sent.');
  else if (!els.reviewNote.classList.contains('err')) els.reviewNote.hidden = true;
}

// What the app saw for one session's riders (each crossing's picture, colour
// and re-ID features, the app's guesses and the riders it knows), as a file
// to check and re-tune the matching on a computer.
function saveRiderData(s) {
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const text = JSON.stringify({
    kind: 'tracktime-riders', v: 1, savedAt: new Date().toISOString(),
    session: s, book: ctx.riderBook?.() ?? null,
  }, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v, r3) : v));
  const d = new Date(s.startedAt ?? s.createdAt ?? Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const name = `tracktime-riders-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`;
  shareOrDownload(new File([text], name, { type: 'application/json' }));
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
