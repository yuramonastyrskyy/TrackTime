import {
  DEFAULT_LINE, DEFAULT_TUNING, buildSampler, readSamplesRGBA, LineDetector, LapCounter, formatLap,
  inRestWindow, RESUME_EARLY_MS,
} from './detector.js';
import { Announcer } from './speech.js';
import { GLSampler } from './glsampler.js';
import { buildStripLine, unionBox, readStripRGBA, StripBuffer, PF } from './photofinish.js';
import { PhotoFinishViewer } from './finishView.js';
import { SessionRecorder, store, formatBytes } from './recorder.js';
import { LapSender, linkOverrides, normalizeCode } from './lapLink.js';
import { LapBoard, boardSupported } from './board.js';
import { planFromHash, planToHash, planProgress, boardParts, bandTag, summarize } from './plan.js';
import {
  newSession, sessionStart, sessionLap, sessionUndo,
} from './session.js';
import { initLists, openRecordings, resetSendBtn, formatDuration, refreshReview } from './lists.js';
import { nativeApi, NativeCamera, exposureText, openInAppLink, RIDERS_MIN } from './nativeCamera.js';
import { RiderRun, RiderBook, bookFromJSON, bookToJSON } from './riders.js';
import { RidersView, leaderOf } from './ridersView.js';

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), overlay: $('overlay'), intro: $('intro'), cameraBtn: $('cameraBtn'),
  cameraError: $('cameraError'), cameraErrorTitle: $('cameraErrorTitle'), cameraErrorText: $('cameraErrorText'),
  hud: $('hud'), panel: $('panel'), fps: $('fps'),
  status: $('status'), statusLabel: $('statusLabel'), statusIcon: $('statusIcon'), statusSteps: $('statusSteps'),
  setupHint: $('setupHint'), lastLap: $('lastLap'), lapTag: $('lapTag'), lapInfo: $('lapInfo'),
  lapStrip: $('lapStrip'), laps: $('laps'), undoBtn: $('undoBtn'), undoLabel: $('undoLabel'), undoSub: $('undoSub'),
  actions: $('actions'), startBtn: $('startBtn'), settingsBtn: $('settingsBtn'), settings: $('settings'),
  ignoreSec: $('ignoreSec'), ignoreUp: $('ignoreUp'), ignoreDown: $('ignoreDown'), decimals: $('decimals'), voice: $('voice'),
  testVoiceBtn: $('testVoiceBtn'), resetMarkersBtn: $('resetMarkersBtn'),
  copyBtn: $('copyBtn'), clearBtn: $('clearBtn'), copyNote: $('copyNote'), highContrast: $('highContrast'),
  recBtn: $('recBtn'), markBtn: $('markBtn'), recInfo: $('recInfo'), recordSound: $('recordSound'), countSingles: $('countSingles'),
  stopwatchCode: $('stopwatchCode'), linkStatus: $('linkStatus'), linkStatusText: $('linkStatusText'), linkPill: $('linkPill'),
  boardBtn: $('boardBtn'), boardStatus: $('boardStatus'), boardStatusText: $('boardStatusText'), boardBright: $('boardBright'),
  restBetweenLaps: $('restBetweenLaps'), fps60: $('fps60'), finish: $('finish'),
  planStrip: $('planStrip'), planName: $('planName'), planBlock: $('planBlock'), planMain: $('planMain'),
  planSwatch: $('planSwatch'), planWhere: $('planWhere'), planTarget: $('planTarget'), planLeft: $('planLeft'),
  planSub: $('planSub'), planDone: $('planDone'), planDoneSub: $('planDoneSub'),
  planNext: $('planNext'), planClose: $('planClose'), toast: $('toast'), sayGap: $('sayGap'),
  summary: $('summary'), sumMeta: $('sumMeta'), sumBest: $('sumBest'), sumAvg: $('sumAvg'),
  sumThird: $('sumThird'), sumThirdK: $('sumThirdK'), sumBars: $('sumBars'),
  sendBtn: $('sendBtn'), sendNote: $('sendNote'),
  sessionsBtn: $('sessionsBtn'), sessions: $('sessions'), sessList: $('sessList'),
  recordingsBtn: $('recordingsBtn'), recordings: $('recordings'), recList: $('recList'),
  toastText: $('toastText'), toastIcon: $('toastIcon'), startLabel: $('startLabel'), startIcon: $('startIcon'),
  sendLabel: $('sendLabel'), sendIcon: $('sendIcon'), sumTitle: $('sumTitle'), cameraBtnLabel: $('cameraBtnLabel'),
  sessionsSub: $('sessionsSub'), recordingsSub: $('recordingsSub'),
  riders: $('riders'), ridersGroup: $('ridersGroup'), ridersOn: $('ridersOn'), ridersKnown: $('ridersKnown'), ridersForget: $('ridersForget'),
  openAppBtn: $('openAppBtn'), nativeGroup: $('nativeGroup'), camRate: $('camRate'), camExposure: $('camExposure'),
  expDarker: $('expDarker'), expBrighter: $('expBrighter'),
  recStorage: $('recStorage'), recStorageText: $('recStorageText'), recStorageFill: $('recStorageFill'),
};
// Inside the TrackTime Android app: its own camera (see js/nativeCamera.js).
const native = nativeApi();
document.documentElement.classList.toggle('native-app', !!native);
/** Sets text only when it changed, so nothing re-lays out for nothing. */
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

// ---------- settings ----------
const STORE_KEY = 'tracktime.settings.v1';
const settings = Object.assign(
  { ignoreSec: 14, decimals: native ? 2 : 1, voice: 'auto', recordSound: false, countSingles: false, stopwatchCode: '', sayGap: false, fps60: true, line: structuredClone(DEFAULT_LINE) },
  load(),
);
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

// ---------- state ----------
const announcer = new Announcer({ mode: settings.voice });
const counter = new LapCounter(settings.ignoreSec * 1000);
let state = 'off';           // off | setup | learning | armed | timing
let stream = null;
let detector = null, sampler = null, samples = null;
// Plan strip stepping aside in Set up (see keepPlanOffMarkers).
let planOverMarkers = false, planTop = 0;
const planShown = () => !!plan && els.summary.hidden && !(state === 'setup' && planOverMarkers);
let proc = null, procCtx = null, glSampler = null, readerNote = '';
let canvasBox = null;        // part of the frame the canvas path copies (detector + photo-finish pixels)
// Photo-finish (js/photofinish.js): one colour column of the finish line per frame.
let strip = null, stripCol = null, stripBuf = null;
const finishes = new Map();  // crossing number (0 = start, n = lap n) -> { blob, ... }
let finishPending = [];      // crossings still collecting the frames after them
let timeSource = null;
let wakeLock = null;
let fpsFrames = 0, fpsSince = performance.now();
// Where frames go missing: the camera's own clock (captureTime steps), the
// video frames the browser presents (presentedFrames), the screen's refresh
// (requestAnimationFrame) and the frames the app gets (fps pill).
const rates = { app: 0, presented: 0, capture: 0, screen: 0 };
let presentedAt = null, captureGaps = [], lastCapture = 0, rafCount = 0, rafSince = performance.now();
(function countRaf(t) {
  rafCount++;
  if (t - rafSince > 1000) { rates.screen = Math.round((rafCount * 1000) / (t - rafSince)); rafCount = 0; rafSince = t; }
  requestAnimationFrame(countRaf);
})(performance.now());
function noteFrameMeta(now, meta) {
  if (!meta) return;
  if (typeof meta.captureTime === 'number' && meta.captureTime > 0) {
    if (lastCapture && meta.captureTime > lastCapture) captureGaps.push(meta.captureTime - lastCapture);
    lastCapture = meta.captureTime;
  }
  if (typeof meta.presentedFrames === 'number') {
    if (!presentedAt) presentedAt = { n: meta.presentedFrames, t: now };
    else if (now - presentedAt.t > 1000) {
      rates.presented = Math.round(((meta.presentedFrames - presentedAt.n) * 1000) / (now - presentedAt.t));
      presentedAt = { n: meta.presentedFrames, t: now };
      if (captureGaps.length > 3) {
        const g = captureGaps.sort((a, b) => a - b)[captureGaps.length >> 1];
        rates.capture = Math.round(1000 / g);
      }
      captureGaps = [];
    }
  }
}
function ratesText() {
  const parts = [];
  if (rates.capture) parts.push(`camera ${rates.capture}/s`);
  if (rates.presented) parts.push(`video frames shown ${rates.presented}/s`);
  if (rates.screen) parts.push(`screen ${rates.screen} Hz`);
  parts.push(`app ${rates.app}/s`);
  return `${parts.join(', ')}.`;
}
let recorder = null;         // SessionRecorder while "Record + time" is running
let micTrack = null;
let lastFrameT = 0;          // detection clock of the newest frame
let sec = { frames: 0, track: 0, apron: 0 }; // per-second stats for the log
let mediaEpoch = null;       // wall-clock anchor when frame times come from mediaTime
let ncam = null;             // NativeCamera while the app's camera is on
let camStats = null;         // app camera: { minFps, dropped0 } since Start timing
/** Picture size in display orientation (browser video or the app's camera). */
const vidW = () => (ncam ? ncam.width : els.video.videoWidth);
const vidH = () => (ncam ? ncam.height : els.video.videoHeight);
/** The voice says tenths in the app, where the screen shows hundredths. */
const voiceDecimals = () => (ncam ? Math.min(1, settings.decimals) : settings.decimals);

// ---------- laptop stopwatch link ----------
const lapLink = new LapSender({ ...linkOverrides(location.search), onState: renderLink });
lapLink.setCode(settings.stopwatchCode);
function renderLink(s) {
  els.linkPill.hidden = !s.code;
  els.linkPill.textContent = s.direct === 'open' ? 'stopwatch ✓ direct' : s.connected ? 'stopwatch ✓' : 'stopwatch …';
  els.linkPill.className = s.connected ? 'ok' : '';
  els.linkStatus.hidden = !s.code;
  els.linkStatus.classList.toggle('ok', !!s.connected);
  if (!s.code) { els.linkStatusText.textContent = ''; return; }
  const up = s.links.filter((l) => l.status === 'open').length;
  let text = s.connected ? `Connected (${up} of ${s.links.length} relays).` : 'Connecting…';
  if (s.direct === 'open') text += ' Direct ✓ (works without internet).';
  else if (s.direct) text += ` Direct: setting up…${s.directDetail ? ` (${s.directDetail})` : ''}`;
  if (s.pending) text += ` Waiting to send: ${s.pending}.`;
  if (s.lastSent) {
    const when = new Date(s.lastSent.at).toLocaleTimeString();
    text += ` Last sent: ${s.lastSent.lap ? `lap ${s.lastSent.lap}` : 'first crossing'} at ${when}.`;
  }
  els.linkStatusText.textContent = text;
}
// ---------- LED time board (Bluetooth) ----------
const board = new LapBoard({ onState: renderBoard });
// With a Pacemaker plan the time takes the lap's band colour: "g|23.8".
const BOARD_BAND = { good: 'g', slow: 'o', veryslow: 'r', fast: 'p' };
function boardShowLast() {
  const laps = counter.laps;
  const last = laps[laps.length - 1];
  if (!last) { board.show('--'); return; }
  const r = currentProgress()?.results?.[laps.length - 1];
  const c = r && !r.break ? BOARD_BAND[r.band] : null;
  board.show(`${c ? `${c}|` : ''}${formatLap(last.ms, 1)}`);
}
function renderBoard(s) {
  if (!els.boardBtn) return;
  els.boardBtn.textContent = s.state === 'off' ? 'Connect time board' : 'Disconnect time board';
  els.boardStatus.hidden = s.state === 'off' && !s.detail;
  els.boardStatus.classList.toggle('ok', s.state === 'on');
  const name = s.name || 'board';
  els.boardStatusText.textContent = s.state === 'on' ? `Connected to ${name}. Showing ${s.text}.`
    : s.state === 'connecting' ? `Connecting to ${name}…`
    : s.state === 'lost' ? `Lost ${name}. ${s.detail || 'Reconnecting…'}`
    : s.detail || '';
}
if (boardSupported()) board.restore().then((ok) => { if (ok) board.brightness(settings.boardBrightness ?? 60); });
/** Wall-clock time (epoch ms) of a frame time from the detector clock. */
function frameEpoch(t) {
  if (timeSource === 'native') return ncam.epochOffset + t; // sensor clock + its offset
  // captureTime and rVFC/rAF "now" share the performance.now() timeline.
  if (timeSource !== 'media') return performance.timeOrigin + t;
  mediaEpoch ??= Date.now() - lastFrameT;
  return mediaEpoch + t;
}
let resting = false;         // true while frames are skipped inside the ignore window

// ---------- Pacemaker plan (from the #pm= link) ----------
const PLAN_KEY = 'tracktime.plan.v1';
let plan = loadSavedPlan();
let announcedBlock = 0;      // last block index "next block" was said for
function loadSavedPlan() {
  try { return JSON.parse(sessionStorage.getItem(PLAN_KEY)) || null; } catch { return null; }
}
function setPlan(p) {
  plan = p;
  try {
    if (p) sessionStorage.setItem(PLAN_KEY, JSON.stringify(p)); else sessionStorage.removeItem(PLAN_KEY);
  } catch { /* private mode */ }
  if (session && !session.laps.length) { session.plan = p; persistSession(); }
  renderOpenInApp();
  announcedBlock = 0;
  planTop = 0; planOverMarkers = false;
  renderPlan();
  renderLaps();
  if (state === 'setup') drawOverlay(); // may step the new strip aside
}
function readPlanLink() {
  const r = planFromHash(location.hash);
  if (!r) return;
  // Keep the plan for this visit, but take it out of the address bar.
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignored */ }
  if (r.error) { showToast(r.error, 'info'); return; }
  setPlan(r.plan);
  showToast(`Plan loaded: ${r.plan.name}`);
}
window.addEventListener('hashchange', readPlanLink);

let toastTimer = null;
function showToast(text, kind = 'ok') {
  els.toastText.textContent = text;
  els.toastIcon.setAttribute('href', kind === 'ok' ? '#i-tick' : '#i-info');
  els.toastIcon.parentNode.style.color = kind === 'ok' ? '' : 'var(--tt-slow)';
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 6000);
}
els.toast.addEventListener('click', () => { els.toast.hidden = true; });

/** Plan-clock ms now (since the first crossing), or null before it. */
function planNow() {
  if (counter.startTime === null) return null;
  return Math.max(0, lastFrameT - counter.startTime);
}
function currentProgress() {
  if (!plan) return null;
  const laps = counter.laps.map((l) => ({ ms: l.ms, t: l.at - counter.startTime }));
  return planProgress(plan, laps, planNow());
}
// Plan strip. Rebuilt on lap events and once a second for the time left;
// only text and a few classes change, never the layout around it.
function renderPlan() {
  els.planStrip.hidden = !planShown();
  if (!plan) return;
  const t = boardParts(plan, currentProgress());
  setText(els.planName, plan.name);
  setText(els.planBlock, t.block);
  els.planMain.hidden = t.done;
  els.planDone.hidden = !t.done;
  if (t.done) {
    setText(els.planDoneSub, t.doneSub);
    setText(els.planNext, '');
    els.planNext.hidden = true;
    return;
  }
  els.planNext.hidden = false;
  const sw = `swatch${t.swatch ? ` sw-${t.swatch}` : ''}`;
  if (els.planSwatch.className !== sw) els.planSwatch.className = sw;
  els.planSwatch.hidden = !t.swatch;
  setText(els.planWhere, t.line);
  els.planTarget.hidden = !t.target;
  els.planMain.classList.toggle('solo', !t.target);
  els.planTarget.classList.toggle('ramp', t.ramp);
  setPlanNumber(els.planTarget, t.target, t.unit);
  setPlanNumber(els.planLeft, t.left, '');
  setText(els.planSub, t.sub);
  setText(els.planNext, t.next);
}
/** "23.0" with a small unit after it; touches the DOM only when it changed. */
function setPlanNumber(el, value, unit) {
  const key = `${value}|${unit}`;
  if (el.dataset.v === key) return;
  el.dataset.v = key;
  el.textContent = value;
  if (unit) { const u = document.createElement('small'); u.textContent = ` ${unit}`; el.append(u); }
}
setInterval(() => { if (plan && !els.panel.hidden && !els.planStrip.hidden) renderPlan(); }, 1000);

// Two taps for anything that loses work: the first arms the button for 3 s
// and says what the second tap will do.
const ARM_MS = 3000;
function arm(btn, onArm, onDisarm) {
  if (btn._armTimer) { clearTimeout(btn._armTimer); btn._armTimer = null; return true; }
  onArm();
  btn._armTimer = setTimeout(() => { btn._armTimer = null; onDisarm(); }, ARM_MS);
  return false;
}
function disarm(btn, onDisarm) {
  if (!btn._armTimer) return;
  clearTimeout(btn._armTimer); btn._armTimer = null; onDisarm();
}

const planCloseIcon = els.planClose.innerHTML;
const resetPlanClose = () => { els.planClose.classList.remove('confirm'); els.planClose.innerHTML = planCloseIcon; };
els.planClose.addEventListener('click', () => {
  const second = arm(els.planClose, () => {
    els.planClose.classList.add('confirm');
    els.planClose.textContent = 'Tap again to close';
  }, resetPlanClose);
  if (!second) return;
  resetPlanClose();
  setPlan(null);
});

// ---------- timing sessions (kept in IndexedDB as they go) ----------
let session = null;          // the session being timed
let lastSession = null;      // the last finished session, for "Send to Pacemaker"
function sessionSettings() {
  return {
    ignoreSec: settings.ignoreSec, decimals: settings.decimals, voice: settings.voice,
    countSingles: !!settings.countSingles, restBetweenLaps: settings.restBetweenLaps !== false,
    sayGap: !!settings.sayGap, recorded: !!recorder,
  };
}
function persistSession(s = session) {
  if (!s || s.startedAt === null) return; // nothing worth keeping before the first crossing
  store.saveTiming(s).catch(() => { /* storage full or blocked: laps still on screen */ });
}
/** Ends the current session; keeps it when it has laps, drops it otherwise. */
function finishSession() {
  const s = session;
  session = null;
  if (!s) return;
  s.endedAt = Date.now();
  if (s.laps.length) { persistSession(s); lastSession = s; resetSendBtn(); } else {
    store.deleteTiming(s.id).catch(() => {});
  }
}

// Status band: colour + word + icon + step meter, so it reads without colour.
const STATUS = {
  setup: { label: 'Set up', cls: 'st-setup', icon: 'i-setup', step: 1 },
  learning: { label: 'Keep the line clear', cls: 'st-clear', icon: 'i-clear', step: 2 },
  armed: { label: 'Waiting for first rider', cls: 'st-waiting', icon: 'i-wait', step: 3 },
  timing: { label: 'Timing', cls: 'st-timing', icon: 'i-timing', step: 4 },
};
function setState(s) {
  state = s;
  const st = STATUS[s] || STATUS.setup;
  els.status.className = `status ${st.cls}`;
  els.status.dataset.state = s;
  els.statusLabel.textContent = st.label;
  els.statusIcon.setAttribute('href', `#${st.icon}`);
  [...els.statusSteps.children].forEach((i, k) => i.classList.toggle('on', k < st.step));
  const active = isActive();
  disarm(els.startBtn, () => {});
  els.startLabel.textContent = active ? (recorder ? 'Stop recording' : 'Stop') : 'Start timing';
  els.startIcon.setAttribute('href', active ? '#i-stop' : '#i-play');
  els.startBtn.className = active ? 'btn main stop' : 'btn main primary full';
  els.actions.classList.toggle('timing', active);
  els.recBtn.hidden = active || !!ncam; // Record + time stays in the browser for now
  els.settingsBtn.className = active ? 'btn main icon ghost' : 'btn ghost';
  els.markBtn.hidden = !(active && recorder);
  els.sendBtn.hidden = active || !lastSession?.laps.length;
  if (active) { els.sendNote.hidden = true; els.summary.hidden = true; }
  renderLaps();
  recorder?.log('state', { detail: s });
  drawOverlay();
}
const isActive = () => state === 'learning' || state === 'armed' || state === 'timing';
/** Set up with no laps: a compact top (status + marker hint) and no lap row. */
function renderLayout() {
  const setupEmpty = state === 'setup' && !counter.laps.length;
  els.hud.classList.toggle('compact', setupEmpty);
  hintWanted = setupEmpty;
  els.setupHint.hidden = !setupEmpty || hintOverMarkers;
  // The lap row (Undo + chips) appears with the first lap.
  els.lapStrip.hidden = !els.summary.hidden || !counter.laps.length;
  els.planStrip.hidden = !planShown();
}

// ---------- camera ----------
els.cameraBtn.addEventListener('click', startCamera);
async function startCamera() {
  els.cameraError.hidden = true;
  if (native) { startNativeCamera(); return; }
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraError("This browser can't use the camera", 'Open the app in Safari or Chrome over https.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: cameraConstraints(30) });
    if (wantedFps() > 30) await setCameraFps(60);
  } catch (err) {
    if (err && err.name === 'NotAllowedError') {
      showCameraError('Camera access was blocked', 'Allow the camera for this app in the phone settings, then try again.');
    } else {
      showCameraError("The camera didn't start", `${err && err.name ? err.name : 'Unknown error'}. Close other camera apps and try again.`);
    }
    return;
  }
  els.video.hidden = false;
  els.video.srcObject = stream;
  await els.video.play().catch(() => {});
  els.intro.hidden = true;
  els.hud.hidden = false;
  els.panel.hidden = false;
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    stopTiming();
    showCameraError('The camera stopped', 'Tap Turn on camera to start it again.');
    els.hud.hidden = true;
    els.panel.hidden = true;
    els.intro.hidden = false;
  });
  setState('setup');
  scheduleFrame();
}
async function startNativeCamera() {
  const cam = new NativeCamera(native);
  els.cameraBtn.disabled = true;
  try {
    await cam.start({ fps: 60 });
  } catch (err) {
    if (err?.name === 'NotAllowedError') {
      showCameraError('Camera access was blocked', err.permanent
        ? 'Allow the camera for TrackTime in the phone settings (App info > Permissions), then try again.'
        : 'Tap the button below and allow the camera.');
      if (err.permanent) cam.openSettings();
    } else {
      showCameraError("The camera didn't start", `${err?.message || 'Unknown error'}. Close other camera apps and try again.`);
    }
    return;
  } finally {
    els.cameraBtn.disabled = false;
  }
  ncam = cam;
  document.documentElement.classList.add('native-cam');
  els.intro.hidden = true;
  els.hud.hidden = false;
  els.panel.hidden = false;
  setState('setup');
  scheduleFrame();
}
// 720p: plenty for the detector (it works at 960 px). 60 fps when the phone
// offers it, for a finer photo-finish; Record + time always uses 30 fps (half
// the video size). The fps pill shows what the camera really gives.
function wantedFps() { return settings.fps60 !== false && !recorder ? 60 : 30; }
function cameraConstraints(fps) {
  return {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 }, height: { ideal: 720 },
    frameRate: fps > 30 ? { ideal: fps } : { ideal: 30, max: 30 },
  };
}
/** What the camera gives now and what it says it can do, for Settings and the log. */
let cameraNote = '';
function describeCamera() {
  const vt = stream?.getVideoTracks()[0];
  if (!vt) return 'Camera off.';
  const st = safe(() => vt.getSettings()) || {};
  const caps = safe(() => vt.getCapabilities?.()) || {};
  const max = caps.frameRate?.max;
  const now = st.frameRate ? `${Math.round(st.frameRate)} fps` : 'fps unknown';
  return `Camera now: ${st.width || '?'}×${st.height || '?'} at ${now}`
    + `${max ? `; it says up to ${Math.round(max)} fps` : ''}.${cameraNote ? ` ${cameraNote}` : ''}`;
}
/**
 * Asks the running camera for 30 or 60 fps. For 60 it tries 720p, then
 * insists (min 50 fps) at 720p and at 1080p, because some phones only offer
 * 60 fps at one size. A result smaller than 720p goes back to 720p at 30: the
 * detector needs the detail more than the frame rate.
 */
async function setCameraFps(fps) {
  const vt = stream?.getVideoTracks()[0];
  if (!vt) return;
  const fr = () => safe(() => vt.getSettings().frameRate) || 0;
  const short = () => { const st = safe(() => vt.getSettings()) || {}; return Math.min(st.width || 720, st.height || 720); };
  const apply = async (c) => { try { await vt.applyConstraints(c); return true; } catch (e) { return e?.name || 'refused'; } };
  const base = { facingMode: { ideal: 'environment' } };
  if (fps <= 30) {
    if (fr() && fr() <= 31) return;
    await apply(cameraConstraints(30));
    return;
  }
  if (fr() > 31) return;
  const tries = [
    cameraConstraints(60),
    { ...base, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { min: 50, ideal: 60 } },
    { ...base, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { min: 50, ideal: 60 } },
  ];
  const notes = [];
  for (const c of tries) {
    const r = await apply(c);
    if (r !== true) { notes.push(r); continue; }
    if (fr() > 31) break;
  }
  if (fr() > 31 && short() < 700) {
    cameraNote = `60 fps only came at ${short()}p, so it went back to 720p at 30.`;
    await apply(cameraConstraints(30));
  } else if (fr() <= 31) {
    cameraNote = `60 fps was not given${notes.length ? ` (${[...new Set(notes)].join(', ')})` : ''}.`;
    await apply(cameraConstraints(30));
  } else {
    cameraNote = '';
  }
  recorder?.log('detector', { detail: describeCamera() });
}
function showCameraError(title, msg) {
  els.cameraErrorTitle.textContent = title;
  els.cameraErrorText.textContent = msg;
  els.cameraError.hidden = false;
  els.cameraBtnLabel.textContent = 'Try the camera again';
}

// ---------- frame loop ----------
const hasVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
function scheduleFrame() {
  if (ncam) requestAnimationFrame(onNativeTick);
  else if (hasVFC) els.video.requestVideoFrameCallback(onFrame);
  else requestAnimationFrame((now) => onFrame(now, null));
}

function frameTime(now, meta) {
  // Pick one clock per session and stick to it; lap times are differences.
  if (!timeSource) {
    if (meta && typeof meta.captureTime === 'number' && meta.captureTime > 0) timeSource = 'capture';
    else if (meta && typeof meta.mediaTime === 'number' && meta.mediaTime > 0) timeSource = 'media';
    else timeSource = 'now';
  }
  if (timeSource === 'capture' && meta?.captureTime) return meta.captureTime;
  if (timeSource === 'media' && meta?.mediaTime) return meta.mediaTime * 1000;
  return now;
}

// App camera: frames arrive in batches (sensor time + the line samples, read
// natively); each one goes through the same detection as a browser frame.
let nativeSecond = 0;
function onNativeTick(now) {
  if (!ncam) return;
  const frames = ncam.pull();
  if (now - nativeSecond > 1000) {
    nativeSecond = now;
    const i = ncam.info();
    if (ncam.update(i)) {
      drawOverlay();
      if (detector) { try { prepareDetector({ keepClock: true }); setState('learning'); } catch { /* ignored */ } }
    }
    if (camStats && i.fps && !resting) camStats.minFps = Math.min(camStats.minFps, i.fps);
    if (riderRun && session) pollRiders(lastFrameT);
    els.fps.textContent = `${i.fps || 0} fps · app${resting ? ' · rest' : ''}`;
    if (els.settings.open) fillCamera(i);
  }
  if (detector && frames.length) {
    for (const f of frames) {
      if (!detector) break;
      detectFrame(f.t, () => readNative(f.samples));
    }
    drawOverlay();
  }
  scheduleFrame();
}

function onFrame(now, meta) {
  if (!stream) return;
  fpsFrames++;
  noteFrameMeta(now, meta);
  if (now - fpsSince > 1000) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
    rates.app = fps;
    // "29/60 fps": the app got 29 of the 60 frames the video showed.
    const of = rates.presented > fps + 3 ? `/${rates.presented}` : '';
    els.fps.textContent = resting ? `${fps}${of} fps · rest` : `${fps}${of} fps${glSampler && !readTimes ? ' · gpu' : ''}`;
    if ($('settings').open) $('camInfo').textContent = `${describeCamera()} Now: ${ratesText()}`;
    fpsFrames = 0; fpsSince = now;
    if (recorder) {
      recorder.log('second', {
        fps, cam: rates.capture || undefined, shown: rates.presented || undefined, screen: rates.screen || undefined, detFrames: sec.frames, track: +sec.track.toFixed(3), apron: +sec.apron.toFixed(3),
        learning: !!detector?.learning, ...(resting ? { resting: true } : {}),
      });
      sec = { frames: 0, track: 0, apron: 0 };
      showRecInfo();
    }
  }
  if (detector && els.video.videoWidth) detectFrame(frameTime(now, meta), readFrame);
  // In Set up nothing on the overlay changes between frames (no detector), so
  // it is only redrawn on a drag, a resize or a state change.
  if (detector) drawOverlay();
  scheduleFrame();
}

/** App frame: detector samples, then the photo-finish column as grey. */
function readNative(data) {
  const n = samples.length;
  samples.set(data.subarray(0, n));
  if (!stripCol) return;
  for (let i = 0, m = stripCol.length / 3; i < m; i++) {
    const g = data[n + i];
    stripCol[i * 3] = g; stripCol[i * 3 + 1] = g; stripCol[i * 3 + 2] = g;
  }
}

/** Detection for one frame at time t; read() fills `samples` (and `stripCol`). */
function detectFrame(t, read) {
  if (shouldRest(t)) {
    // Inside the ignore window nothing can count, so skip the pixel reading
    // and detection (the heavy part) to keep the phone cooler. The camera
    // and any recording keep running.
    if (!resting) {
      resting = true;
      detector.skipGap();
      recorder?.log('rest', { frameT: Math.round(t), detail: `detection paused until ${(RESUME_EARLY_MS / 1000).toFixed(1)} s before the window ends` });
      drawOverlay();
    }
    // The photo-finish still needs the frames just after a crossing: read
    // the pixels, but leave the detector alone (laps stay exactly the same).
    if (finishPending.length) { read(); stripBuf?.push(t, stripCol); }
    lastFrameT = t;
    takeFinishes(t);
    return;
  }
  if (resting) {
    resting = false;
    recorder?.log('resume', { frameT: Math.round(t) });
  }
  read();
  stripBuf?.push(t, stripCol);
  const relearnsBefore = detector.relearns, singlesBefore = detector.singles.length;
  const hit = detector.push(samples, t);
  lastFrameT = t;
  if (detector.relearns !== relearnsBefore) {
    recorder?.log('relearn', { frameT: t, detail: 'line looked covered for 4 s; re-learned the empty line' });
  }
  if (detector.singles.length !== singlesBefore) {
    recorder?.log('single', { frameT: detector.singles[detector.singles.length - 1], detail: 'one rider or passer-by, not a team: ignored' });
    if (detector.singles.length > 50) detector.singles.splice(0, 25);
  }
  if (recorder && detector && !detector.learning) {
    sec.frames++;
    sec.track = Math.max(sec.track, detector.level.track);
    sec.apron = Math.max(sec.apron, detector.level.apron);
  }
  if (state === 'learning' && !detector.learning) setState(counter.startTime === null ? 'armed' : 'timing');
  if (hit !== null) onCrossing(hit);
  takeFinishes(t);
}

// "Rest between laps": skip detection inside the ignore window (see
// inRestWindow). Worked out from the lap clock on every frame, so Undo, Clear
// and a changed ignore time take effect at once.
function shouldRest(t) {
  if (settings.restBetweenLaps === false) return false;
  if (state !== 'timing' || detector.learning) return false;
  return inRestWindow(counter, t);
}

// Reading pixels out of the video is the slow part of each frame. The GPU path
// reads back only the sample pixels; the canvas path copies a strip of the
// frame. Which is faster depends on the phone, so for the first frames both are
// timed (alternating) and the faster one is kept. Both give the same values.
const CALIBRATE_FRAMES = 40;
let readTimes = null; // { gpu: [], canvas: [] } while calibrating

function readCanvas() {
  const box = canvasBox, { x, y, w, h } = box;
  procCtx.drawImage(els.video, x / proc.scale, y / proc.scale, w / proc.scale, h / proc.scale, 0, 0, w, h);
  const img = procCtx.getImageData(0, 0, w, h);
  readSamplesRGBA({ xs: sampler.xs, ys: sampler.ys, box }, img.data, samples);
  if (strip) readStripRGBA(strip, box, img.data, stripCol);
}

function readFrame() {
  if (!glSampler) { readCanvas(); return; }
  const useGpu = !readTimes || readTimes.gpu.length <= readTimes.canvas.length;
  const t0 = performance.now();
  if (useGpu) {
    try { glSampler.read(els.video, samples, strip ? stripCol : null); } catch (err) {
      glSampler = null; readTimes = null;
      recorder?.log('detector', { detail: `GPU sampling failed (${err?.message || err}); using canvas` });
      readCanvas();
      return;
    }
  } else {
    readCanvas();
  }
  if (!readTimes) return;
  readTimes[useGpu ? 'gpu' : 'canvas'].push(performance.now() - t0);
  if (readTimes.gpu.length + readTimes.canvas.length >= CALIBRATE_FRAMES) {
    const med = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];
    const g = med(readTimes.gpu), c = med(readTimes.canvas);
    if (c < g) glSampler = null;
    readTimes = null;
    readerNote = `pixel read: gpu ${g.toFixed(1)} ms, canvas ${c.toFixed(1)} ms -> ${c < g ? 'canvas' : 'gpu'}`;
    recorder?.log('detector', { detail: readerNote });
  }
}

function prepareDetector({ keepClock = false } = {}) {
  const vw = vidW(), vh = vidH();
  const s = 960 / Math.max(vw, vh);
  // Samples are placed on a virtual frame scaled to 960 px on the long side.
  proc = { width: Math.round(vw * s), height: Math.round(vh * s), scale: s };
  sampler = buildSampler(proc.width, proc.height, settings.line);
  samples = new Uint8Array(sampler.sampleCount);
  detector = new LineDetector(sampler, detectorTuning());
  if (!keepClock) { timeSource = null; mediaEpoch = null; }
  try { strip = buildStripLine(proc.width, proc.height, settings.line); } catch { strip = null; }
  stripCol = strip ? new Uint8Array(strip.count * 3) : null;
  stripBuf = strip ? new StripBuffer(strip.count, 600) : null; // 600 frames: 10 s at 60 fps
  finishPending = [];
  canvasBox = strip ? unionBox(sampler.box, strip.box) : sampler.box;
  if (ncam) {
    // The app reads the samples itself, at the same normalised positions,
    // followed by the photo-finish column (grey: the app reads brightness only).
    glSampler = null; readTimes = null; procCtx = null;
    ncam.setSampler(sampler, strip);
    timeSource = 'native';
    recorder?.log('detector', { detail: `${proc.width}x${proc.height}, ${sampler.sampleCount} samples, ${sampler.rowCount} rows, app camera ${vw}x${vh}` });
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvasBox.w;
  canvas.height = canvasBox.h;
  procCtx = canvas.getContext('2d', { willReadFrequently: true });
  glSampler = null;
  readTimes = null;
  const forced = new URLSearchParams(location.search).get('sampler'); // 'canvas' or 'gpu' for testing
  if (forced !== 'canvas') {
    try { glSampler = new GLSampler(sampler, strip); } catch { glSampler = null; }
    if (glSampler && forced !== 'gpu') readTimes = { gpu: [], canvas: [] };
  }
  recorder?.log('detector', { detail: `${proc.width}x${proc.height}, ${sampler.sampleCount} samples, ${sampler.rowCount} rows, ${glSampler ? 'gpu' : 'canvas'}, camera ${vw}x${vh}` });
}

// ---------- timing ----------
// Stop takes two taps (same 3 s window as Undo), so a brush with a glove
// does not end an hour of timing.
els.startBtn.addEventListener('click', async () => {
  if (isActive()) {
    const label = recorder ? 'Stop recording' : 'Stop';
    const second = arm(els.startBtn, () => {
      els.startBtn.classList.add('armed');
      els.startLabel.textContent = recorder ? 'Tap again to stop recording' : 'Tap again to stop';
    }, () => { els.startBtn.classList.remove('armed'); els.startLabel.textContent = label; });
    if (second) stopTiming();
    return;
  }
  startTiming();
});

function startTiming() {
  if (!vidW()) return false;
  announcer.unlock(); // inside the tap, so phones allow sound
  counter.ignoreMs = settings.ignoreSec * 1000;
  counter.reset();
  board.show('--');
  finishes.clear();
  finishSession();
  session = newSession({ plan, settings: sessionSettings() });
  announcedBlock = 0;
  els.summary.hidden = true;
  renderLaps();
  renderPlan();
  try { prepareDetector(); } catch (e) { els.lapInfo.textContent = e.message; return false; }
  if (ncam) {
    // Meter once on the empty track (it has been metering all through Set up),
    // then hold exposure, focus and white balance for the whole session.
    ncam.lock();
    const i = ncam.info();
    camStats = { minFps: Infinity, dropped0: i.dropped || 0 };
    startRiders(i);
  }
  setState('learning');
  requestWakeLock();
  return true;
}

function stopTiming() {
  takeFinishes(lastFrameT, true);
  detector = null;
  if (ncam) ncam.unlock();
  finishSession();
  stopRiders();
  releaseWakeLock();
  if (recorder) stopRecording();
  renderSummary();
  if (stream || ncam) setState('setup');
}

// Session summary after Stop: drawn once, never during timing.
function renderSummary() {
  const laps = counter.laps;
  els.summary.hidden = !laps.length;
  if (!laps.length) return;
  const dec = settings.decimals;
  const results = plan ? currentProgress().results : [];
  const s = summarize(laps, results);
  const total = laps.reduce((n, l) => n + l.ms, 0);
  els.sumTitle.textContent = plan ? plan.name : 'This session';
  els.sumMeta.textContent = `${s.count} ${s.count === 1 ? 'lap' : 'laps'} · ${formatDuration(total)}`;
  setStat(els.sumBest, s.best === null ? '–' : formatLap(s.best, dec), '');
  setStat(els.sumAvg, s.average === null ? '–' : formatLap(s.average, dec), '');
  if (s.onTarget) {
    els.sumThirdK.textContent = 'On target';
    setStat(els.sumThird, String(s.onTarget.good), ` / ${s.onTarget.of}`);
  } else {
    els.sumThirdK.textContent = 'Laps';
    setStat(els.sumThird, String(s.count), '');
  }
  els.sumBars.replaceChildren(...s.bars.slice(-60).map((b) => {
    const i = document.createElement('i');
    i.className = `h${b.h}${b.band ? ` b-${b.band}` : ''}`;
    return i;
  }));
  ridersView.renderSummary(lastSession, riderWaiting ? 'Looking at the riders…' : null);
}
function setStat(el, value, unit) {
  el.textContent = value;
  if (unit) { const u = document.createElement('small'); u.textContent = unit; el.append(u); }
}

function onCrossing(t) {
  const r = counter.crossing(t);
  if (recorder) {
    // Session time of the crossing frame (the detector confirms it a few frames later).
    const ms = Math.round(recorder.now() - (lastFrameT - t));
    const fields = { ms, frameT: Math.round(t) };
    if (r.type === 'lap') Object.assign(fields, { lap: r.lap, lapMs: Math.round(r.ms) });
    if (r.type === 'ignored') fields.sinceMs = Math.round(r.since);
    recorder.log(r.type, fields);
  }
  if ((r.type === 'start' || r.type === 'lap') && stripBuf) {
    finishPending.push({ key: r.type === 'start' ? 0 : r.lap, at: t, ms: r.type === 'lap' ? r.ms : null, epoch: frameEpoch(t) });
  }
  if ((r.type === 'start' || r.type === 'lap') && riderRun) {
    riderRun.addCrossing(r.type === 'start' ? 0 : r.lap, t);
    ncam?.ridersLap(t);
  }
  if (r.type === 'start' || r.type === 'lap') {
    const at = frameEpoch(t);
    lapLink.sendCrossing(at, r.type === 'start' ? 0 : r.lap);
    if (r.type === 'start') board.show('--'); else boardShowLast();
    if (session) {
      if (r.type === 'start') sessionStart(session, at); else sessionLap(session, r.lap, r.ms, at);
      persistSession();
    }
  }
  if (r.type === 'start') {
    setState('timing');
    els.lapInfo.textContent = 'Clock started';
    announcer.sayStart();
    renderPlan();
  } else if (r.type === 'lap') {
    announcer.sayLap(formatLap(r.ms, voiceDecimals()), lapExtras());
    renderLaps();
    renderPlan();
  }
}

// ---------- photo-finish ----------
// Each counted crossing gets a line-scan picture from 1 s before to 2 s after
// it (js/photofinish.js). It is built once the frames after the crossing are
// in, kept as a JPEG with the timing session (IndexedDB 'finishes', so
// Settings > Sessions > Review can show it later) and with a recording. It is
// only shown: lap times never change from it.
function takeFinishes(t, force = false) {
  if (!finishPending.length || !stripBuf) return;
  const ready = finishPending.filter((p) => force || t >= p.at + PF.afterMs);
  if (!ready.length) return;
  finishPending = finishPending.filter((p) => !ready.includes(p));
  for (const p of ready) buildFinish(p);
}
function buildFinish(p) {
  const pic = stripBuf.picture(p.at - PF.beforeMs, p.at + PF.afterMs);
  if (!pic) return;
  const c = document.createElement('canvas');
  c.width = pic.width; c.height = pic.height;
  c.getContext('2d').putImageData(new ImageData(pic.rgba, pic.width, pic.height), 0, 0);
  const frames = pic.frames.map((f) => f + pic.t0 - p.at);
  const gaps = frames.slice(1).map((f, i) => f - frames[i]).sort((a, b) => a - b);
  const frameMs = gaps.length ? gaps[gaps.length >> 1] : null;
  const rec = recorder;
  const sid = session?.id; // Stop ends the session before the last pictures are encoded
  c.toBlob((blob) => {
    if (!blob) return;
    // Undo/Clear may have removed this crossing while the picture was encoded.
    const lapNow = p.key === 0 ? counter.startTime === p.at : counter.laps.some((l) => l.lap === p.key && l.at === p.at);
    if (!lapNow) return;
    const f = {
      key: p.key, ms: p.ms, at: p.at, epoch: p.epoch, blob,
      width: pic.width, height: pic.height, t0: pic.t0 - p.at, stepMs: pic.stepMs,
      frames, frameMs, rowInner: strip?.rowInner ?? 0,
    };
    finishes.set(p.key, f);
    if (sid) store.saveFinish(sid, p.key, f).catch(() => { /* storage full: still shown while the page is open */ });
    rec?.addFinish(p.key === 0 ? 'start' : `lap${String(p.key).padStart(3, '0')}`, blob);
    renderLaps();
    if (els.finish.open && finishSrc === liveFinishes && finishKey === p.key) openFinish(p.key);
  }, 'image/jpeg', 0.9);
}
function dropFinish(key) {
  finishes.delete(key);
  if (session) store.deleteFinish(session.id, key).catch(() => {});
  finishPending = finishPending.filter((p) => p.key !== key);
}

// What the viewer shows: this session's pictures (live), or a saved
// session's from Settings > Sessions > Review.
const liveFinishes = { pics: finishes, laps: () => counter.laps, session: () => (isActive() ? null : lastSession), saved: false };
let finishSrc = liveFinishes;
let finishKey = null;
const finishView = new PhotoFinishViewer($('pfCanvas'), { onCursor: renderFinishReadout });
function finishKeys() {
  // Saved sessions step through every crossing (one without a picture says so).
  const keys = finishSrc.saved ? [0, ...finishSrc.laps().map((l) => l.lap)] : [...finishSrc.pics.keys()];
  return keys.sort((a, b) => a - b);
}
/** A saved session's picture of crossing `key` (pics: Map key -> picture). */
function openSavedFinish(s, key, pics) {
  finishSrc = { pics, laps: () => s.laps, session: () => s, saved: true };
  openFinish(key, finishSrc);
}
async function openFinish(key, src = liveFinishes) {
  finishSrc = src;
  finishKey = key;
  const f = src.pics.get(key);
  const lap = src.laps().find((l) => l.lap === key);
  const lead = leaderOf(src.session(), key);
  $('pfSub').textContent = (key === 0 ? 'Start (first crossing)'
    : `Lap ${key}${lap ? ` · ${formatLap(lap.ms, 2)}` : ''}`) + (lead ? ` · first ${lead.name}${lead.sure ? '' : ' ?'}` : '');
  const keys = finishKeys(), i = keys.indexOf(key);
  $('pfPrev').disabled = i <= 0 && !(i < 0 && keys.some((k) => k < key));
  $('pfNext').disabled = i < 0 ? !keys.some((k) => k > key) : i >= keys.length - 1;
  $('pfEmpty').hidden = !!f;
  $('pfStage').hidden = !f;
  $('pfTools').hidden = !f;
  if (!els.finish.open) els.finish.showModal();
  if (!f) {
    const waiting = !src.saved && finishPending.some((p) => p.key === key);
    $('pfEmpty').textContent = waiting ? 'Building the picture… it is ready 2 s after the crossing.'
      : src.saved ? 'No photo-finish was saved for this crossing. Sessions timed before this version kept none.'
        : 'No photo-finish for this crossing. Pictures are kept from the moment timing started.';
    $('pfRead').textContent = '';
    $('pfNote').textContent = '';
    finishView.clear();
    return;
  }
  let bitmap;
  try { bitmap = await createImageBitmap(f.blob); } catch {
    bitmap = await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = URL.createObjectURL(f.blob); });
  }
  if (finishKey !== key || finishSrc !== src) return;
  finishView.show({ ...f, bitmap });
  const fps = f.frameMs ? Math.round(1000 / f.frameMs) : null;
  $('pfNote').textContent = `${fps ? `${fps} fps: one frame every ${Math.round(f.frameMs)} ms. ` : ''}`
    + 'Time runs left to right; the dashed line is where the lap was timed. '
    + 'Between frames the picture blends the two nearest frames. Moving the cursor never changes the lap time.';
}
function renderFinishReadout(ms) {
  const f = finishSrc.pics.get(finishKey);
  if (!f) { $('pfRead').textContent = ''; return; }
  const sign = ms === 0 ? '±' : ms > 0 ? '+' : '−';
  const off = `${sign}${(Math.abs(ms) / 1000).toFixed(3)} s`;
  const lap = finishSrc.laps().find((l) => l.lap === finishKey);
  const b = document.createElement('b'); b.textContent = off;
  const parts = [b, document.createTextNode(' from the timed crossing')];
  if (lap && Math.abs(ms) >= 1) {
    parts.push(document.createTextNode(` · lap to the cursor ${formatLap(lap.ms + ms, 2)}`));
  }
  $('pfRead').replaceChildren(...parts);
}
function stepFinish(d) {
  const keys = finishKeys();
  if (!keys.length) return;
  const i = keys.indexOf(finishKey);
  const next = i >= 0 ? keys[i + d] : (d > 0 ? keys.find((k) => k > finishKey) : [...keys].reverse().find((k) => k < finishKey));
  if (next !== undefined) openFinish(next, finishSrc);
}
$('pfPrev').addEventListener('click', () => stepFinish(-1));
$('pfNext').addEventListener('click', () => stepFinish(1));
$('pfZoomIn').addEventListener('click', () => finishView.zoom(0.5));
$('pfZoomOut').addEventListener('click', () => finishView.zoom(2));
$('pfFit').addEventListener('click', () => finishView.fit());
$('pfFlip').addEventListener('click', () => {
  settings.pfFlip = !settings.pfFlip; save();
  $('pfFlip').setAttribute('aria-pressed', String(!!settings.pfFlip));
  finishView.setFlip(settings.pfFlip);
});
$('pfFlip').setAttribute('aria-pressed', String(!!settings.pfFlip));
finishView.setFlip(!!settings.pfFlip);
els.laps.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-lap]');
  if (li) openFinish(Number(li.dataset.lap));
});
els.lastLap.addEventListener('click', () => {
  const last = counter.laps[counter.laps.length - 1];
  if (last) openFinish(last.lap);
});

// "Say gap to target": the gap of the lap just finished, and "next block" when
// the plan moved on. Nothing extra without a plan or with the setting off.
function lapExtras() {
  const p = currentProgress();
  if (!p || !settings.sayGap) return {};
  const last = p.results[p.results.length - 1];
  const nextBlock = !p.done && p.index > announcedBlock;
  announcedBlock = Math.max(announcedBlock, p.index);
  return { gap: last?.gap ?? null, decimals: voiceDecimals(), nextBlock };
}

// Undo takes two taps and says which lap it will remove.
function resetUndo() {
  els.undoBtn.classList.remove('armed');
  els.undoLabel.textContent = 'Undo';
  els.undoSub.textContent = '';
}
els.undoBtn.addEventListener('click', () => {
  const last = counter.laps[counter.laps.length - 1];
  const second = arm(els.undoBtn, () => {
    els.undoBtn.classList.add('armed');
    els.undoLabel.textContent = 'Tap again';
    els.undoSub.textContent = last ? `Undo ${formatLap(last.ms, settings.decimals)}` : 'Undo start';
  }, resetUndo);
  if (!second) return;
  resetUndo();
  const undone = counter.undoLast();
  dropFinish(undone ? undone.lap : 0);
  riderRun?.dropCrossing(undone ? undone.lap : 0);
  if (session) { sessionUndo(session); persistSession(); }
  if (plan) announcedBlock = currentProgress().index;
  renderPlan();
  recorder?.log('undo', { lap: undone?.lap, detail: undone ? 'lap' : 'start' });
  if (counter.startTime === null && (state === 'timing')) setState('armed');
  boardShowLast();
  renderLaps();
  if (!els.summary.hidden) renderSummary();
});

const MAX_CHIPS = 12; // more never fit on the row
function renderLaps() {
  const laps = counter.laps;
  const dec = settings.decimals;
  els.undoBtn.disabled = laps.length === 0;
  if (!laps.length) disarm(els.undoBtn, resetUndo);
  const results = plan && laps.length ? currentProgress().results : [];
  renderLayout();
  if (!laps.length) {
    els.lastLap.className = `lastlap empty${dec === 2 ? ' dp2' : ''}`;
    els.lastLap.textContent = '--.-';
    els.lapTag.hidden = true;
    els.lapInfo.textContent = counter.startTime !== null ? 'Clock started'
      : state === 'learning' ? 'Learning the empty line…'
        : state === 'armed' ? 'The first crossing starts the clock.' : '';
    els.laps.replaceChildren();
    return;
  }
  const last = laps[laps.length - 1];
  const best = Math.min(...laps.map((l) => l.ms));
  const lastResult = results[laps.length - 1];
  els.lastLap.className = `lastlap${dec === 2 ? ' dp2' : ''}${lastResult?.band ? ` b-${lastResult.band}` : ''}`;
  els.lastLap.textContent = formatLap(last.ms, dec);
  // Tag: the band in words and a mark (plan), or "New best" without a plan.
  let tag = bandTag(lastResult, dec);
  if (!tag && !plan && laps.length > 1 && last.ms === best) tag = { band: 'best', text: 'New best' };
  els.lapTag.hidden = !tag;
  if (tag) { els.lapTag.className = `tag b-${tag.band}`; els.lapTag.textContent = tag.text; }
  const prev = laps[laps.length - 2];
  const delta = prev ? ` · ${last.ms <= prev.ms ? '−' : '+'}${(Math.abs(last.ms - prev.ms) / 1000).toFixed(dec)}` : '';
  els.lapInfo.textContent = `Lap ${last.lap} · best ${formatLap(best, dec)}${lastResult?.break ? ' · break' : delta}`;
  els.laps.replaceChildren(...laps.slice(-MAX_CHIPS).reverse().map((l, k) => {
    const li = document.createElement('li');
    const r = results[l.lap - 1];
    const t = bandTag(r, dec);
    li.className = `chip${k === 0 ? ' latest' : ''}${l.ms === best ? ' best' : ''}${r?.band ? ` c-${r.band}` : ''}`;
    li.dataset.lap = String(l.lap);
    if (finishes.has(l.lap)) li.classList.add('pf');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(l.lap);
    if (t?.mark) { const em = document.createElement('em'); em.textContent = t.mark; n.append(em); }
    const time = document.createElement('span');
    time.className = 't';
    time.textContent = formatLap(l.ms, dec);
    li.append(n, time);
    if (l.ms === best && laps.length > 1) {
      const b = document.createElement('span');
      b.className = 'bst'; b.textContent = 'best';
      li.append(b);
    }
    return li;
  }));
}

// ---------- overlay: markers and live line state ----------
const octx = els.overlay.getContext('2d');
function contentRect() {
  const W = els.overlay.clientWidth, H = els.overlay.clientHeight;
  const vw = vidW() || 1080, vh = vidH() || 1920;
  const s = Math.min(W / vw, H / vh);
  return { x: (W - vw * s) / 2, y: (H - vh * s) / 2, w: vw * s, h: vh * s };
}
const toScreen = (p, r) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h });

function drawOverlay() {
  const c = els.overlay, dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, W, H);
  if (state === 'off') return;
  const r = contentRect();
  const a = toScreen(settings.line.top, r), b = toScreen(settings.line.inner, r);
  const dx = b.x - a.x, dy = b.y - a.y;
  const apronEnd = { x: b.x + dx * 0.27, y: b.y + dy * 0.27 };
  const lvl = detector && !detector.learning ? detector.level : { track: 0, apron: 0 };
  const covered = lvl.track > 0.08;

  octx.lineCap = 'round';
  // neutral zone part
  octx.setLineDash([7, 7]);
  octx.globalAlpha = lvl.apron > 0.05 ? 1 : 0.65;
  octx.strokeStyle = colors.amber;
  octx.lineWidth = 3;
  octx.beginPath(); octx.moveTo(b.x, b.y); octx.lineTo(apronEnd.x, apronEnd.y); octx.stroke();
  octx.setLineDash([]);
  octx.globalAlpha = 1;
  // track part: blue when clear, red while something covers it
  octx.strokeStyle = covered ? colors.red : colors.blue;
  octx.lineWidth = covered ? 4 : 3;
  octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();

  const editable = state === 'setup';
  let free = null;
  if (editable) {
    keepHintOffMarkers(Math.min(a.y, b.y));
    keepPlanOffMarkers(Math.max(a.y, b.y));
    free = freeBand();
  }
  chips.top = drawHandle(a, 1, 'Top of track', editable, W, free);
  chips.inner = drawHandle(b, 2, 'Inner edge', editable, W, free);
}

// Same for the plan strip at the bottom: in Set up it steps aside while a
// ring is under it (there is nothing to read on it before timing anyway) and
// comes back when both rings are above it. It always shows while timing.
function keepPlanOffMarkers(bottomY) {
  if (!plan || !els.summary.hidden) return;
  if (!els.planStrip.hidden) planTop = edges(els.planStrip).top;
  if (!planTop) return;
  const over = bottomY + 34 * mk > planTop - 6;
  if (over !== planOverMarkers) {
    planOverMarkers = over;
    els.planStrip.hidden = !planShown();
  }
}
/**
 * The picture band between the top card and the bottom buttons. Label chips
 * are kept inside it, so even a ring that sits under a card or a button has a
 * handle you can reach. Read only on Set up draws (drags, state changes).
 */
function freeBand() {
  // The HUD and the panel include their faded edges, which also dim the picture.
  return { top: edges(els.hud).bottom + 2, bottom: edges(els.panel).top - 2 };
}

// The Set up hint card sits under the status card. When a ring (or its label)
// would be underneath it, the card steps aside so the ring stays visible; it
// comes back once both rings are below it. Its bottom edge is measured only
// when it is showing and cached, so drawing never forces a layout.
let hintWanted = false, hintOverMarkers = false, hintBottom = 0;
function keepHintOffMarkers(topY) {
  if (!hintWanted) return;
  if (!els.setupHint.hidden) hintBottom = edges(els.setupHint).bottom;
  if (!hintBottom) return;
  const over = topY - 34 * mk < hintBottom + 6;
  if (over !== hintOverMarkers) {
    hintOverMarkers = over;
    els.setupHint.hidden = over;
  }
}

// Overlay colours come from the CSS tokens, read once (and again when the
// high-contrast setting changes), never per frame.
const colors = {};
// Ring and label size: follows the UI size, never below 0.7 so they stay easy to grab.
let mk = 1;
function readColors() {
  const cs = getComputedStyle(document.body);
  for (const k of ['blue', 'red', 'amber', 'text', 'bg']) colors[k] = cs.getPropertyValue(`--tt-${k}`).trim();
  mk = Math.min(1, Math.max(0.7, parseFloat(cs.getPropertyValue('--tt-ui-scale')) || 1));
}
/** An element's top and bottom in overlay pixels. Measured on screen, so it is
 *  right whatever the UI zoom (--tt-ui-scale) is. Only read on Set up draws. */
function edges(el) {
  const r = el.getBoundingClientRect(), o = els.overlay.getBoundingClientRect();
  return { top: r.top - o.top, bottom: r.bottom - o.top };
}
readColors();

function drawHandle(p, n, label, editable, W, free) {
  if (!editable) {
    // Locked while timing: a small dot, so the line stays visible.
    octx.beginPath(); octx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    octx.fillStyle = '#fff'; octx.fill();
    octx.lineWidth = 2; octx.strokeStyle = '#0a1622'; octx.stroke();
    return null;
  }
  // Halo marks the drag target; the ring is hollow-ish so the black line shows through.
  const k = mk;
  octx.globalAlpha = 0.7;
  octx.beginPath(); octx.arc(p.x, p.y, 30 * k, 0, Math.PI * 2);
  octx.lineWidth = 2; octx.strokeStyle = colors.blue; octx.stroke();
  octx.globalAlpha = 1;
  octx.beginPath(); octx.arc(p.x, p.y, 22 * k, 0, Math.PI * 2);
  octx.fillStyle = 'rgba(10,22,34,0.45)'; octx.fill();
  octx.lineWidth = 3 * k; octx.strokeStyle = '#fff'; octx.stroke();
  octx.fillStyle = '#fff';
  octx.textAlign = 'center'; octx.textBaseline = 'middle';
  octx.font = `800 ${Math.round(17 * k)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  octx.fillText(String(n), p.x, p.y + 1);
  // Label chip beside the marker (on the left when it would run off screen).
  octx.font = `700 ${Math.round(14 * k)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const w = octx.measureText(label).width + 33 * k, h = 28 * k, gap = 38 * k;
  const x = p.x + gap + w > W - 4 ? p.x - gap - w : p.x + gap;
  let y = p.y - h / 2;
  if (free && free.bottom - free.top > h) y = Math.min(Math.max(y, free.top), free.bottom - h);
  const cy = y + h / 2;
  if (Math.abs(cy - p.y) > 4) {
    // The chip was pulled into view: a thin tether shows which ring it moves.
    octx.beginPath(); octx.moveTo(p.x + Math.sign(x - p.x) * 22 * k, p.y); octx.lineTo(x < p.x ? x + w : x, cy);
    octx.lineWidth = 2; octx.strokeStyle = 'rgba(255,255,255,0.6)'; octx.stroke();
  }
  octx.beginPath();
  if (octx.roundRect) octx.roundRect(x, y, w, h, 8 * k); else octx.rect(x, y, w, h);
  octx.fillStyle = 'rgba(10,22,34,0.92)'; octx.fill();
  octx.lineWidth = 1; octx.strokeStyle = 'rgba(255,255,255,0.25)'; octx.stroke();
  // Grip dots: the label is a handle too, so a finger on it leaves the ring in view.
  octx.fillStyle = 'rgba(255,255,255,0.55)';
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) octx.fillRect(x + (9 + j * 5) * k, cy + (-6 + i * 5) * k, 2.5 * k, 2.5 * k);
  octx.fillStyle = '#fff';
  octx.textAlign = 'left';
  octx.fillText(label, x + 23 * k, cy + 1);
  return { x, y, w, h };
}

// A ring can be dragged by the ring itself or by its label chip. The grab
// offset is kept, so the ring moves with the finger without jumping under it.
const chips = { top: null, inner: null };
let dragging = null, grab = { x: 0, y: 0 };
const onChip = (c, pt) => c && pt.x > c.x - 8 && pt.x < c.x + c.w + 8 && pt.y > c.y - 10 && pt.y < c.y + c.h + 10;
els.overlay.addEventListener('pointerdown', (e) => {
  if (state !== 'setup') return;
  const r = contentRect();
  const pt = { x: e.offsetX, y: e.offsetY };
  // Rings first (closest wins), then the labels.
  let key = null, best = 36;
  for (const k of ['top', 'inner']) {
    const s = toScreen(settings.line[k], r);
    const d = Math.hypot(s.x - pt.x, s.y - pt.y);
    if (d < best) { best = d; key = k; }
  }
  if (!key) key = ['top', 'inner'].find((k) => onChip(chips[k], pt)) || null;
  if (!key) return;
  const s = toScreen(settings.line[key], r);
  grab = { x: pt.x - s.x, y: pt.y - s.y };
  dragging = key;
  els.overlay.setPointerCapture(e.pointerId);
});
els.overlay.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const r = contentRect();
  settings.line[dragging] = {
    x: Math.min(1, Math.max(0, (e.offsetX - grab.x - r.x) / r.w)),
    y: Math.min(1, Math.max(0, (e.offsetY - grab.y - r.y) / r.h)),
  };
  drawOverlay();
});
const endDrag = () => { if (dragging) { dragging = null; save(); } };
els.overlay.addEventListener('pointerup', endDrag);
els.overlay.addEventListener('pointercancel', endDrag);
window.addEventListener('resize', () => {
  // Measure the hint again at the new size.
  hintBottom = 0; hintOverMarkers = false; els.setupHint.hidden = !hintWanted;
  planTop = 0; planOverMarkers = false; els.planStrip.hidden = !planShown();
  drawOverlay();
});
els.video.addEventListener('resize', drawOverlay);
els.video.addEventListener('loadedmetadata', drawOverlay);

function detectorTuning() {
  // "Count single riders" turns off the team check (for solo efforts). The
  // app's exact frame times make placing a crossing between frames worth it.
  const t = { ...DEFAULT_TUNING, subFrame: !!ncam };
  if (settings.countSingles) t.groupMinCoverMs = 0;
  return t;
}

// ---------- settings dialog ----------
/** "24 saved" and "2 · 1.2 GB" under the Sessions and Recordings tiles. */
async function fillTiles() {
  try {
    const list = await store.listTimings();
    els.sessionsSub.textContent = `${list.length} saved`;
  } catch { els.sessionsSub.textContent = 'Saved laps'; }
  try {
    const recs = (await store.listSessions()).filter((x) => x.id !== recorder?.id);
    const est = await navigator.storage?.estimate?.();
    els.recordingsSub.textContent = recs.length
      ? `${recs.length}${est?.usage ? ` · ${formatBytes(est.usage)}` : ''}` : 'None yet';
  } catch { els.recordingsSub.textContent = 'Videos and logs'; }
}
function fillSettings() {
  els.ignoreSec.value = settings.ignoreSec;
  renderDecimals();
  for (const r of els.voice.querySelectorAll('input[name="voice"]')) r.checked = r.value === settings.voice;
  els.highContrast.checked = document.body.classList.contains('hc');
  els.recordSound.checked = !!settings.recordSound;
  els.countSingles.checked = !!settings.countSingles;
  els.stopwatchCode.value = settings.stopwatchCode;
  els.boardBright.value = settings.boardBrightness ?? 60;
  renderBoard({ state: board.state, name: board.device?.name || '', detail: '', text: board.last });
  els.restBetweenLaps.checked = settings.restBetweenLaps !== false;
  els.sayGap.checked = !!settings.sayGap;
  els.fps60.checked = settings.fps60 !== false;
  fillRidersSettings();
  if (!native) $('camInfo').textContent = `${describeCamera()} Now: ${ratesText()}`;
}
els.settingsBtn.addEventListener('click', () => {
  fillSettings();
  if (native) fillCamera();
  fillTiles();
  els.copyNote.hidden = true;
  els.settings.showModal();
  els.settingsBtn.setAttribute('aria-expanded', 'true');
});
els.settings.addEventListener('close', () => els.settingsBtn.setAttribute('aria-expanded', 'false'));
els.ignoreSec.addEventListener('change', () => {
  const v = Math.round(Number(els.ignoreSec.value));
  settings.ignoreSec = Number.isFinite(v) ? Math.min(60, Math.max(3, v)) : 14;
  els.ignoreSec.value = settings.ignoreSec;
  counter.ignoreMs = settings.ignoreSec * 1000;
  save();
});
els.stopwatchCode.addEventListener('change', () => {
  settings.stopwatchCode = normalizeCode(els.stopwatchCode.value);
  els.stopwatchCode.value = settings.stopwatchCode;
  lapLink.setCode(settings.stopwatchCode);
  save();
});
els.boardBtn.addEventListener('click', async () => {
  if (board.state !== 'off') { board.disconnect(); return; }
  els.boardStatus.hidden = false;
  els.boardStatusText.textContent = 'Opening the Bluetooth list…';
  if (!boardSupported()) {
    els.boardStatus.hidden = false;
    els.boardStatusText.textContent = native
      ? 'This version of the app has no Bluetooth yet. Install the newest TrackTime app.'
      : 'No Bluetooth in this browser. Use Chrome on Android, or in Brave turn on brave://flags/#brave-web-bluetooth-api.';
    return;
  }
  try {
    await board.connect();
    board.brightness(settings.boardBrightness ?? 60);
  } catch (e) {
    if (e?.name === 'NotFoundError' && /cancel/i.test(e.message || '')) return; // picker closed
    els.boardStatus.hidden = false;
    els.boardStatusText.textContent = /adapter|not available|disabled/i.test(e?.message || '')
      ? 'Bluetooth is off or not allowed. Turn on Bluetooth (and Location on Android), give Chrome the Nearby devices permission, then try again.'
      : `Could not connect: ${e?.name || ''} ${e?.message || e}`;
  }
});
els.boardBright.addEventListener('change', () => {
  settings.boardBrightness = Math.min(255, Math.max(10, Math.round(Number(els.boardBright.value)) || 60));
  board.brightness(settings.boardBrightness);
  save();
});
// Number stepper: −/+ around the same number field.
function stepIgnore(d) {
  els.ignoreSec.value = String((Number(els.ignoreSec.value) || settings.ignoreSec) + d);
  els.ignoreSec.dispatchEvent(new Event('change'));
}
els.ignoreDown.addEventListener('click', () => stepIgnore(-1));
els.ignoreUp.addEventListener('click', () => stepIgnore(1));
// Decimals: two-button segmented control.
function renderDecimals() {
  for (const b of els.decimals.querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.dec) === settings.decimals));
}
els.decimals.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-dec]');
  if (!b) return;
  settings.decimals = Number(b.dataset.dec);
  save(); renderDecimals(); renderLaps();
  if (!els.summary.hidden) renderSummary();
});
els.voice.addEventListener('change', (e) => {
  if (e.target.name !== 'voice') return;
  settings.voice = e.target.value; announcer.mode = settings.voice; save();
});
// High contrast: the setting when set, otherwise the system's "more contrast".
const moreContrast = window.matchMedia?.('(prefers-contrast: more)');
function applyContrast() {
  const on = typeof settings.highContrast === 'boolean' ? settings.highContrast : !!moreContrast?.matches;
  document.body.classList.toggle('hc', on);
  readColors();
  drawOverlay();
}
moreContrast?.addEventListener?.('change', applyContrast);
els.highContrast.addEventListener('change', () => { settings.highContrast = els.highContrast.checked; save(); applyContrast(); });
applyContrast();
els.testVoiceBtn.addEventListener('click', async () => {
  await announcer.unlock();
  announcer.sayLap(formatLap(17430, voiceDecimals()));
});
els.resetMarkersBtn.addEventListener('click', () => {
  settings.line = structuredClone(DEFAULT_LINE); save(); drawOverlay();
});
const resetClear = () => { els.clearBtn.classList.remove('armed'); els.clearBtn.textContent = 'Clear laps'; };
els.clearBtn.addEventListener('click', () => {
  const second = arm(els.clearBtn, () => {
    els.clearBtn.classList.add('armed');
    els.clearBtn.textContent = 'Tap again to clear';
  }, resetClear);
  if (!second) return;
  resetClear();
  recorder?.log('clear');
  counter.reset();
  board.show('--');
  finishes.clear(); finishPending = [];
  // Laps timed so far stay in Settings > Sessions; timing carries on as a new session.
  if (session) { finishSession(); session = newSession({ plan, settings: sessionSettings() }); }
  announcedBlock = 0;
  renderPlan();
  els.summary.hidden = true;
  if (state === 'timing') setState('armed');
  renderLaps();
});
els.copyBtn.addEventListener('click', async () => {
  const dec = settings.decimals;
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const text = [`TrackTime, ${date}`, ...counter.laps.map((l) => `Lap ${l.lap}: ${formatLap(l.ms, dec)}`)].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    els.copyNote.textContent = counter.laps.length ? 'Lap times copied.' : 'No laps yet.';
    els.copyNote.className = counter.laps.length ? 'note ok' : 'note';
  } catch {
    els.copyNote.textContent = text;
  }
  els.copyNote.hidden = false;
});

// ---------- keep the screen on ----------
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* ignored */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  recorder?.log('visibility', { detail: document.visibilityState });
  if (document.visibilityState !== 'visible') { recorder?.flush(); return; }
  if (detector) {
    requestWakeLock();
    // Frames were missed while hidden; re-learn the empty line, keep the clock.
    try { prepareDetector({ keepClock: true }); setState('learning'); } catch { /* ignored */ }
  }
});

// ---------- Android app ----------
function setupNative() {
  if (!native) { renderOpenInApp(); return; }
  // A Pacemaker plan handed over by the "Open in app" button (at launch, or
  // while the app is already open).
  const take = () => {
    let h = '';
    try { h = native.takeLaunchHash() || ''; } catch { /* ignored */ }
    if (h) location.hash = h;
  };
  window.__ttNativeIntent = take;
  take();
  els.nativeGroup.hidden = false;
  // Photo-finish: the app camera is always 60 fps, so only say how to see it.
  els.fps60.closest('label').hidden = true;
  $('camInfo').textContent = 'Always on in the app: tap a lap time (or the big last lap) to see the picture of that crossing.';
}
// In Chrome on Android, with a plan: a button that hands the plan to the app.
function renderOpenInApp() {
  const show = !native && !!plan && /Android/i.test(navigator.userAgent);
  els.openAppBtn.hidden = !show;
  if (show) els.openAppBtn.href = openInAppLink(planToHash(plan), location.origin + location.pathname);
}
function fillCamera(i = ncam?.info()) {
  if (!i) return;
  if (!ncam) { els.camRate.textContent = 'Turn on the camera to see it.'; return; }
  let rate = `${i.fps || 0} fps now, target ${i.fpsTarget ?? '?'}`;
  if (camStats) {
    const low = Number.isFinite(camStats.minFps) ? camStats.minFps : i.fps;
    rate += ` · since Start: lowest ${low}, ${Math.max(0, (i.dropped || 0) - camStats.dropped0)} frames dropped`;
  }
  if (!i.manualSensor) rate += ' · this camera has no manual exposure';
  setText(els.camRate, rate);
  setText(els.camExposure, exposureText(i));
}
function nudgeExposure(d) {
  if (!ncam) return;
  ncam.nudge(d);
  // The picture of the empty line changes with the exposure: learn it again
  // (the lap clock keeps running).
  if (detector) { try { prepareDetector({ keepClock: true }); setState('learning'); } catch { /* ignored */ } }
  setTimeout(() => fillCamera(), 300);
}
els.expDarker.addEventListener('click', () => nudgeExposure(-1));
els.expBrighter.addEventListener('click', () => nudgeExposure(1));

// ---------- riders (app) ----------
// The app describes the riders near the line around each counted crossing
// (TrackCameraPlugin); js/riders.js decides who is who. Nothing is said or
// asked during timing: after Stop the summary shows each lap's leader and the
// review sheet takes corrections before Send to Pacemaker. The riders (their
// colours and names) are kept for the next session.
const RIDERS_KEY = 'tracktime.riders.v1';
let riderBook = loadRiderBook();
let riderRun = null;        // this session's (or, after Stop, the last session's) rider matching
let riderWaiting = false;   // after Stop, until the app has described the last frames
let riderWaitTimer = null;
const ridersAvailable = () => !!native && (() => { try { return native.version() >= RIDERS_MIN; } catch { return false; } })();

function loadRiderBook() {
  try { return bookFromJSON(JSON.parse(localStorage.getItem(RIDERS_KEY))); } catch { return new RiderBook(); }
}
function saveRiderBook() {
  try { localStorage.setItem(RIDERS_KEY, JSON.stringify(bookToJSON(riderBook))); } catch { /* full or private: kept for this run only */ }
}

function startRiders(info) {
  clearTimeout(riderWaitTimer);
  riderWaiting = false;
  riderRun = null;
  if (!ncam?.hasRiders || settings.riders === false) return;
  // At 60 fps every other frame is enough (the models then see 30 a second).
  const every = (info?.fpsTarget || 60) >= 50 ? 2 : 1;
  if (ncam.ridersStart(settings.line, every)) {
    riderRun = new RiderRun(settings.line, riderBook);
    riderRun.sessionId = session?.id;
  }
}

/** Frames the app has described: into their crossing windows; windows that are complete get matched. */
function pollRiders(now) {
  if (!riderRun || !ncam) return true;
  const info = ncam.ridersInfo();             // first: idle now means every frame so far is in the pull below
  riderRun.addFrames(ncam.ridersPull());
  const idle = !info.queued && !info.working;
  if (idle) riderRun.finishUpTo(now);
  return idle;
}

function stopRiders() {
  if (!riderRun || !ncam) return;
  ncam.ridersStop();
  const s = lastSession;
  if (!s || s.id !== riderRun.sessionId) { riderRun = null; return; }
  riderWaiting = true;
  const started = Date.now();
  const step = () => {
    const idle = pollRiders(-Infinity);
    if (!idle && Date.now() - started < 120000) { riderWaitTimer = setTimeout(step, 500); return; }
    riderRun.finishAll();
    riderWaiting = false;
    attachRiders(s);
    riderRun = null; // from here on corrections go to s.riders (js/riders.js correctSaved)
    if (!els.summary.hidden) ridersView.renderSummary(lastSession);
    if (els.riders.open && ridersView.session === s) ridersView.render();
    refreshReview(s);
  };
  step();
}

/** The last session's riders, from the run: into the session (saved) and the book (kept). */
function attachRiders(s) {
  if (!riderRun || !s) return;
  s.riders = riderRun.summary([0, ...s.laps.map((l) => l.lap)]);
  persistSession(s);
  saveRiderBook();
}

const ridersView = new RidersView({
  book: () => riderBook,
  decimals: () => settings.decimals,
  changed: (s) => {
    s.editedAt = Date.now(); // a sent session says it changed since
    persistSession(s);
    saveRiderBook();
    if (s === lastSession && !els.summary.hidden) ridersView.renderSummary(lastSession, riderWaiting ? 'Looking at the riders…' : null);
  },
  closed: (s) => refreshReview(s),
});

function fillRidersSettings() {
  els.ridersGroup.hidden = !ridersAvailable();
  els.ridersOn.checked = settings.riders !== false;
  const n = riderBook.riders.length;
  els.ridersKnown.textContent = n ? `${n} kept from earlier sessions: ${riderBook.riders.slice(0, 6).map((r) => r.name).join(', ')}${n > 6 ? '…' : ''}` : 'None yet';
  els.ridersForget.disabled = !n;
}
els.ridersOn.addEventListener('change', () => { settings.riders = els.ridersOn.checked; save(); });
els.ridersForget.addEventListener('click', () => {
  riderBook = new RiderBook();
  try { localStorage.removeItem(RIDERS_KEY); } catch { /* ignored */ }
  fillRidersSettings();
});

// ---------- Telegram mini app ----------
function setupTelegram() {
  const tg = window.Telegram?.WebApp;
  if (!tg || !tg.initData) return;
  try {
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.();
    tg.setHeaderColor?.('#0a1622');
    tg.setBackgroundColor?.('#0a1622');
  } catch { /* older Telegram versions */ }
}
window.addEventListener('load', setupTelegram);

// ---------- offline ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------- record + log ----------
els.recordSound.addEventListener('change', () => { settings.recordSound = els.recordSound.checked; save(); });
els.restBetweenLaps.addEventListener('change', () => { settings.restBetweenLaps = els.restBetweenLaps.checked; save(); });
els.sayGap.addEventListener('change', () => { settings.sayGap = els.sayGap.checked; save(); });
els.fps60.addEventListener('change', async () => {
  settings.fps60 = els.fps60.checked; save();
  if (stream && !isActive()) await setCameraFps(wantedFps());
  $('camInfo').textContent = `${describeCamera()} Now: ${ratesText()}`;
});
els.countSingles.addEventListener('change', () => {
  settings.countSingles = els.countSingles.checked;
  save();
  if (detector) detector.t = detectorTuning();
});

els.recBtn.addEventListener('click', async () => {
  if (!stream || !els.video.videoWidth || recorder) return;
  if (!('MediaRecorder' in window)) {
    els.lapInfo.textContent = 'This browser cannot record video. Update the phone, or use Start timing.';
    return;
  }
  announcer.unlock(); // keep this inside the tap
  els.recBtn.disabled = true;
  try {
    const tracks = [...stream.getVideoTracks()];
    if (settings.recordSound) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
        });
        micTrack = mic.getAudioTracks()[0] || null;
        if (micTrack) tracks.push(micTrack);
      } catch { micTrack = null; }
    }
    await setCameraFps(30); // recordings stay at 30 fps (half the size)
    const vt = stream.getVideoTracks()[0];
    recorder = new SessionRecorder(new MediaStream(tracks), {
      settings: { ignoreSec: settings.ignoreSec, decimals: settings.decimals, voice: settings.voice, recordSound: !!micTrack, restBetweenLaps: settings.restBetweenLaps !== false },
      line: settings.line,
      tuning: detectorTuning(),
      camera: safe(() => vt.getSettings()),
      cameraLabel: vt.label,
      video: { width: els.video.videoWidth, height: els.video.videoHeight },
      screen: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      userAgent: navigator.userAgent,
      timeNote: 'ms = milliseconds since the first video part started (approximate to ~0.1 s). '
        + 'part_time_s = seconds into that video part. frameT = detector clock; lap times are differences of frameT.',
    }, partMinutesOverride());
    recorder.onchange = showRecInfo;
    await recorder.start();
    if (!recorder.recording) throw new Error(recorder.rec.problems.map((p) => p.msg).join('; ') || 'recorder did not start');
    snapshotSetup().then((b) => b && recorder?.setSetupImage(b));
    if (!startTiming()) { await stopRecording({ show: false }); return; }
    showRecInfo();
  } catch (e) {
    els.lapInfo.textContent = `Recording did not start (${e?.message || e}). You can still use Start timing.`;
    if (recorder) { try { await recorder.stop(); } catch { /* ignored */ } }
    recorder = null;
    stopMic();
    setCameraFps(wantedFps());
  } finally {
    els.recBtn.disabled = false;
  }
});

// ?part=0.5 makes video parts 30 s long, for testing the switch between parts.
function partMinutesOverride() {
  const v = Number(new URLSearchParams(location.search).get('part'));
  return v > 0 ? { partMinutes: v } : {};
}

function safe(fn) { try { return fn(); } catch { return null; } }
function stopMic() { try { micTrack?.stop(); } catch { /* ignored */ } micTrack = null; }

els.markBtn.addEventListener('click', () => {
  if (!recorder) return;
  recorder.log('mark', { detail: `mark ${recorder.rec.log.events.filter((e) => e.type === 'mark').length + 1}` });
  try { navigator.vibrate?.(40); } catch { /* ignored */ }
  els.markBtn.classList.add('flash');
  setTimeout(() => els.markBtn.classList.remove('flash'), 120);
  showRecInfo();
});

function showRecInfo() {
  if (!recorder) { els.recInfo.hidden = true; return; }
  const s = Math.floor(recorder.now() / 1000);
  const marks = recorder.rec.log.events.filter((e) => e.type === 'mark').length;
  const mm = String(Math.floor(s / 60)).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
  const warn = recorder.rec.problems.length ? ' · !' : '';
  els.recInfo.textContent = `● REC ${mm}:${ss} · ${formatBytes(recorder.bytes)}${marks ? ` · ${marks} marks` : ''}${warn}`;
  els.recInfo.hidden = false;
}

async function stopRecording({ show = true } = {}) {
  const r = recorder;
  recorder = null;
  els.recInfo.hidden = true;
  els.markBtn.hidden = true;
  if (!r) return;
  r.log('laps', { detail: counter.laps.map((l) => (l.ms / 1000).toFixed(2)).join(' ') });
  const rec = await r.stop();
  stopMic();
  if (show) openRecordings(rec.id, r.memChunks);
  setCameraFps(wantedFps());
}

async function snapshotSetup() {
  try {
    const v = els.video, s = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    const g = c.getContext('2d');
    g.drawImage(v, 0, 0, c.width, c.height);
    const a = { x: settings.line.top.x * c.width, y: settings.line.top.y * c.height };
    const b = { x: settings.line.inner.x * c.width, y: settings.line.inner.y * c.height };
    g.lineWidth = 2; g.strokeStyle = 'rgba(62,155,255,0.9)';
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    for (const p of [a, b]) { g.beginPath(); g.arc(p.x, p.y, 8, 0, Math.PI * 2); g.stroke(); }
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
  } catch { return null; }
}

initLists({
  arm,
  recordingId: () => recorder?.id,
  sessionId: () => session?.id,
  lastSession: () => lastSession,
  forgetLastSession: (id) => {
    if (lastSession?.id === id) { lastSession = null; els.sendBtn.hidden = true; els.sendNote.hidden = true; }
  },
  decimals: () => settings.decimals,
  ridersWaiting: (s) => riderWaiting && s === lastSession,
  livePictures: (s) => (s === lastSession && !session && finishes.size ? finishes : null),
  openFinish: openSavedFinish,
  openRiders: (s) => ridersView.open(s),
  backToSettings: () => {
    fillSettings();
    fillTiles();
    els.copyNote.hidden = true;
    els.settings.showModal();
  },
});


readPlanLink();
setupNative();
renderPlan();
renderLaps();
