import {
  DEFAULT_LINE, DEFAULT_TUNING, buildSampler, readSamplesRGBA, LineDetector, LapCounter, formatLap,
  inRestWindow, RESUME_EARLY_MS,
} from './detector.js';
import { Announcer } from './speech.js';
import { GLSampler } from './glsampler.js';
import {
  SessionRecorder, sessionFiles, shareOrDownload, store, formatBytes,
} from './recorder.js';
import { LapSender, linkOverrides, normalizeCode } from './lapLink.js';
import { planFromHash, planProgress, boardParts, bandTag, summarize } from './plan.js';
import {
  newSession, sessionStart, sessionLap, sessionUndo, sessionDuration, sendSession, apiFor,
} from './session.js';

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
  restBetweenLaps: $('restBetweenLaps'),
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
  recStorage: $('recStorage'), recStorageText: $('recStorageText'), recStorageFill: $('recStorageFill'),
};
/** Sets text only when it changed, so nothing re-lays out for nothing. */
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

// ---------- settings ----------
const STORE_KEY = 'tracktime.settings.v1';
const settings = Object.assign(
  { ignoreSec: 14, decimals: 1, voice: 'auto', recordSound: false, countSingles: false, stopwatchCode: '', sayGap: false, line: structuredClone(DEFAULT_LINE) },
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
let timeSource = null;
let wakeLock = null;
let fpsFrames = 0, fpsSince = performance.now();
let recorder = null;         // SessionRecorder while "Record + time" is running
let micTrack = null;
let lastFrameT = 0;          // detection clock of the newest frame
let sec = { frames: 0, track: 0, apron: 0 }; // per-second stats for the log
let mediaEpoch = null;       // wall-clock anchor when frame times come from mediaTime

// ---------- laptop stopwatch link ----------
const lapLink = new LapSender({ ...linkOverrides(location.search), onState: renderLink });
lapLink.setCode(settings.stopwatchCode);
function renderLink(s) {
  els.linkPill.hidden = !s.code;
  els.linkPill.textContent = s.connected ? 'stopwatch ✓' : 'stopwatch …';
  els.linkPill.className = s.connected ? 'ok' : '';
  els.linkStatus.hidden = !s.code;
  els.linkStatus.classList.toggle('ok', !!s.connected);
  if (!s.code) { els.linkStatusText.textContent = ''; return; }
  const up = s.links.filter((l) => l.status === 'open').length;
  let text = s.connected ? `Connected (${up} of ${s.links.length} relays).` : 'Connecting…';
  if (s.lastSent) {
    const when = new Date(s.lastSent.at).toLocaleTimeString();
    text += ` Last sent: ${s.lastSent.lap ? `lap ${s.lastSent.lap}` : 'first crossing'} at ${when}.`;
  }
  els.linkStatusText.textContent = text;
}
/** Wall-clock time (epoch ms) of a frame time from the detector clock. */
function frameEpoch(t) {
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
  els.recBtn.hidden = active;
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
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraError("This browser can't use the camera", 'Open the app in Safari or Chrome over https.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        // 720p at 30 fps: plenty for the detector (it works at 960 px) and much
        // lighter for the phone than 1080p/60 while it is also recording.
        width: { ideal: 1280 }, height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
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
function showCameraError(title, msg) {
  els.cameraErrorTitle.textContent = title;
  els.cameraErrorText.textContent = msg;
  els.cameraError.hidden = false;
  els.cameraBtnLabel.textContent = 'Try the camera again';
}

// ---------- frame loop ----------
const hasVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
function scheduleFrame() {
  if (hasVFC) els.video.requestVideoFrameCallback(onFrame);
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

function onFrame(now, meta) {
  if (!stream) return;
  fpsFrames++;
  if (now - fpsSince > 1000) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
    els.fps.textContent = resting ? `${fps} fps · rest` : `${fps} fps${glSampler && !readTimes ? ' · gpu' : ''}`;
    fpsFrames = 0; fpsSince = now;
    if (recorder) {
      recorder.log('second', {
        fps, detFrames: sec.frames, track: +sec.track.toFixed(3), apron: +sec.apron.toFixed(3),
        learning: !!detector?.learning, ...(resting ? { resting: true } : {}),
      });
      sec = { frames: 0, track: 0, apron: 0 };
      showRecInfo();
    }
  }
  if (detector && els.video.videoWidth) {
    const t = frameTime(now, meta);
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
      lastFrameT = t;
      scheduleFrame();
      return;
    }
    if (resting) {
      resting = false;
      recorder?.log('resume', { frameT: Math.round(t) });
    }
    readFrame();
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
  }
  // In Set up nothing on the overlay changes between frames (no detector), so
  // it is only redrawn on a drag, a resize or a state change.
  if (detector) drawOverlay();
  scheduleFrame();
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
  const { x, y, w, h } = sampler.box;
  procCtx.drawImage(els.video, x / proc.scale, y / proc.scale, w / proc.scale, h / proc.scale, 0, 0, w, h);
  const img = procCtx.getImageData(0, 0, w, h);
  readSamplesRGBA(sampler, img.data, samples);
}

function readFrame() {
  if (!glSampler) { readCanvas(); return; }
  const useGpu = !readTimes || readTimes.gpu.length <= readTimes.canvas.length;
  const t0 = performance.now();
  if (useGpu) {
    try { glSampler.read(els.video, samples); } catch (err) {
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
  const vw = els.video.videoWidth, vh = els.video.videoHeight;
  const s = 960 / Math.max(vw, vh);
  // Samples are placed on a virtual frame scaled to 960 px on the long side.
  proc = { width: Math.round(vw * s), height: Math.round(vh * s), scale: s };
  sampler = buildSampler(proc.width, proc.height, settings.line);
  const canvas = document.createElement('canvas');
  canvas.width = sampler.box.w;
  canvas.height = sampler.box.h;
  procCtx = canvas.getContext('2d', { willReadFrequently: true });
  glSampler = null;
  readTimes = null;
  const forced = new URLSearchParams(location.search).get('sampler'); // 'canvas' or 'gpu' for testing
  if (forced !== 'canvas') {
    try { glSampler = new GLSampler(sampler); } catch { glSampler = null; }
    if (glSampler && forced !== 'gpu') readTimes = { gpu: [], canvas: [] };
  }
  samples = new Uint8Array(sampler.sampleCount);
  detector = new LineDetector(sampler, detectorTuning());
  if (!keepClock) { timeSource = null; mediaEpoch = null; }
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
  if (!els.video.videoWidth) return false;
  announcer.unlock(); // inside the tap, so phones allow sound
  counter.ignoreMs = settings.ignoreSec * 1000;
  counter.reset();
  finishSession();
  session = newSession({ plan, settings: sessionSettings() });
  announcedBlock = 0;
  els.summary.hidden = true;
  renderLaps();
  renderPlan();
  try { prepareDetector(); } catch (e) { els.lapInfo.textContent = e.message; return false; }
  setState('learning');
  requestWakeLock();
  return true;
}

function stopTiming() {
  detector = null;
  finishSession();
  releaseWakeLock();
  if (recorder) stopRecording();
  renderSummary();
  if (stream) setState('setup');
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
  if (r.type === 'start' || r.type === 'lap') {
    const at = frameEpoch(t);
    lapLink.sendCrossing(at, r.type === 'start' ? 0 : r.lap);
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
    const text = formatLap(r.ms, settings.decimals);
    announcer.sayLap(text, lapExtras());
    renderLaps();
    renderPlan();
  }
}

// "Say gap to target": the gap of the lap just finished, and "next block" when
// the plan moved on. Nothing extra without a plan or with the setting off.
function lapExtras() {
  const p = currentProgress();
  if (!p || !settings.sayGap) return {};
  const last = p.results[p.results.length - 1];
  const nextBlock = !p.done && p.index > announcedBlock;
  announcedBlock = Math.max(announcedBlock, p.index);
  return { gap: last?.gap ?? null, decimals: settings.decimals, nextBlock };
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
  if (session) { sessionUndo(session); persistSession(); }
  if (plan) announcedBlock = currentProgress().index;
  renderPlan();
  recorder?.log('undo', { lap: undone?.lap, detail: undone ? 'lap' : 'start' });
  if (counter.startTime === null && (state === 'timing')) setState('armed');
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
  const vw = els.video.videoWidth || 1080, vh = els.video.videoHeight || 1920;
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
  if (!els.planStrip.hidden) planTop = els.panel.offsetTop + els.planStrip.offsetTop;
  if (!planTop) return;
  const over = bottomY + 34 > planTop - 6;
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
  return { top: els.hud.offsetTop + els.hud.offsetHeight + 2, bottom: els.panel.offsetTop - 2 };
}

// The Set up hint card sits under the status card. When a ring (or its label)
// would be underneath it, the card steps aside so the ring stays visible; it
// comes back once both rings are below it. Its bottom edge is measured only
// when it is showing and cached, so drawing never forces a layout.
let hintWanted = false, hintOverMarkers = false, hintBottom = 0;
function keepHintOffMarkers(topY) {
  if (!hintWanted) return;
  if (!els.setupHint.hidden) hintBottom = els.setupHint.offsetTop + els.setupHint.offsetHeight;
  if (!hintBottom) return;
  const over = topY - 34 < hintBottom + 6;
  if (over !== hintOverMarkers) {
    hintOverMarkers = over;
    els.setupHint.hidden = over;
  }
}

// Overlay colours come from the CSS tokens, read once (and again when the
// high-contrast setting changes), never per frame.
const colors = {};
function readColors() {
  const cs = getComputedStyle(document.body);
  for (const k of ['blue', 'red', 'amber', 'text', 'bg']) colors[k] = cs.getPropertyValue(`--tt-${k}`).trim();
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
  // Halo r=30 marks the drag target; the ring is hollow-ish so the black line shows through.
  octx.globalAlpha = 0.7;
  octx.beginPath(); octx.arc(p.x, p.y, 30, 0, Math.PI * 2);
  octx.lineWidth = 2; octx.strokeStyle = colors.blue; octx.stroke();
  octx.globalAlpha = 1;
  octx.beginPath(); octx.arc(p.x, p.y, 22, 0, Math.PI * 2);
  octx.fillStyle = 'rgba(10,22,34,0.45)'; octx.fill();
  octx.lineWidth = 3; octx.strokeStyle = '#fff'; octx.stroke();
  octx.fillStyle = '#fff';
  octx.textAlign = 'center'; octx.textBaseline = 'middle';
  octx.font = '800 17px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  octx.fillText(String(n), p.x, p.y + 1);
  // Label chip beside the marker (on the left when it would run off screen).
  octx.font = '700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const w = octx.measureText(label).width + 33, h = 28;
  const x = p.x + 38 + w > W - 4 ? p.x - 38 - w : p.x + 38;
  let y = p.y - h / 2;
  if (free && free.bottom - free.top > h) y = Math.min(Math.max(y, free.top), free.bottom - h);
  const cy = y + h / 2;
  if (Math.abs(cy - p.y) > 4) {
    // The chip was pulled into view: a thin tether shows which ring it moves.
    octx.beginPath(); octx.moveTo(p.x + Math.sign(x - p.x) * 22, p.y); octx.lineTo(x < p.x ? x + w : x, cy);
    octx.lineWidth = 2; octx.strokeStyle = 'rgba(255,255,255,0.6)'; octx.stroke();
  }
  octx.beginPath();
  if (octx.roundRect) octx.roundRect(x, y, w, h, 8); else octx.rect(x, y, w, h);
  octx.fillStyle = 'rgba(10,22,34,0.92)'; octx.fill();
  octx.lineWidth = 1; octx.strokeStyle = 'rgba(255,255,255,0.25)'; octx.stroke();
  // Grip dots: the label is a handle too, so a finger on it leaves the ring in view.
  octx.fillStyle = 'rgba(255,255,255,0.55)';
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) octx.fillRect(x + 9 + j * 5, cy - 6 + i * 5, 2.5, 2.5);
  octx.fillStyle = '#fff';
  octx.textAlign = 'left';
  octx.fillText(label, x + 23, cy + 1);
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
  // "Count single riders" turns off the team check (for solo efforts).
  return settings.countSingles ? { ...DEFAULT_TUNING, groupMinCoverMs: 0 } : DEFAULT_TUNING;
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
  els.restBetweenLaps.checked = settings.restBetweenLaps !== false;
  els.sayGap.checked = !!settings.sayGap;
}
els.settingsBtn.addEventListener('click', () => {
  fillSettings();
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
  announcer.sayLap(formatLap(17430, settings.decimals));
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

// Recordings list. Files are built before the buttons appear, so a tap can
// open the share sheet straight away (phones need that).
els.recordingsBtn.addEventListener('click', () => { els.settings.close(); openRecordings(); });

async function openRecordings(highlightId = null, memChunks = null) {
  els.recList.replaceChildren(textP('Loading…', 'meta'));
  if (!els.recordings.open) els.recordings.showModal();
  let sessions = [];
  try { sessions = await store.listSessions(); } catch (e) {
    els.recList.replaceChildren(warnP(`Could not open saved recordings (${e?.message || e}).`));
  }
  sessions = sessions.filter((x) => x.id !== recorder?.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
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
    const second = arm(del, () => { del.classList.add('armed'); del.textContent = 'Tap again to delete'; },
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

els.sendBtn.addEventListener('click', () => {
  if (lastSession) sendToPacemaker(lastSession, els.sendBtn, els.sendNote);
});

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
function resetSendBtn() {
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
els.sessionsBtn.addEventListener('click', () => { els.settings.close(); openSessions(); });

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
  const active = s.id === session?.id;
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
        if (lastSession?.id === s.id) { lastSession = null; els.sendBtn.hidden = true; els.sendNote.hidden = true; }
        box.remove();
      } catch (e) { del.textContent = `Delete failed (${e?.message || e})`; del.disabled = false; }
    }));
  }
  if (row.childElementCount) box.append(row);
  box.append(note);
  return box;
}

// Back arrow in Sessions / Recordings returns to Settings.
for (const d of [els.sessions, els.recordings]) {
  d.querySelector('[data-back]').addEventListener('click', () => {
    d.close();
    fillSettings();
    fillTiles();
    els.copyNote.hidden = true;
    els.settings.showModal();
  });
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

readPlanLink();
renderPlan();
renderLaps();
