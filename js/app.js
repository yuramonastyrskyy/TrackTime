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
import { planFromHash, planProgress, stripText } from './plan.js';
import {
  newSession, sessionStart, sessionLap, sessionUndo, sessionDuration, sendSession, apiFor,
} from './session.js';

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), overlay: $('overlay'), intro: $('intro'), cameraBtn: $('cameraBtn'),
  cameraError: $('cameraError'), hud: $('hud'), panel: $('panel'), status: $('status'), fps: $('fps'),
  lastLap: $('lastLap'), lapInfo: $('lapInfo'), laps: $('laps'), startBtn: $('startBtn'),
  undoBtn: $('undoBtn'), settingsBtn: $('settingsBtn'), settings: $('settings'),
  ignoreSec: $('ignoreSec'), decimals: $('decimals'), voice: $('voice'),
  testVoiceBtn: $('testVoiceBtn'), resetMarkersBtn: $('resetMarkersBtn'),
  copyBtn: $('copyBtn'), clearBtn: $('clearBtn'), copyNote: $('copyNote'),
  recBtn: $('recBtn'), markBtn: $('markBtn'), recInfo: $('recInfo'), recordSound: $('recordSound'), countSingles: $('countSingles'),
  stopwatchCode: $('stopwatchCode'), linkStatus: $('linkStatus'), linkPill: $('linkPill'),
  restBetweenLaps: $('restBetweenLaps'),
  planStrip: $('planStrip'), planName: $('planName'), planBlock: $('planBlock'), planLeft: $('planLeft'),
  planNext: $('planNext'), planClose: $('planClose'), toast: $('toast'), sayGap: $('sayGap'),
  sendBtn: $('sendBtn'), sendNote: $('sendNote'),
  sessionsBtn: $('sessionsBtn'), sessions: $('sessions'), sessList: $('sessList'),
  recordingsBtn: $('recordingsBtn'), recordings: $('recordings'), recList: $('recList'), recStorage: $('recStorage'),
};

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
  els.linkPill.textContent = s.connected ? '· stopwatch' : '· stopwatch …';
  if (!s.code) { els.linkStatus.textContent = ''; return; }
  const up = s.links.filter((l) => l.status === 'open').length;
  let text = s.connected ? `Connected (${up} of ${s.links.length} relays).` : 'Connecting…';
  if (s.lastSent) {
    const when = new Date(s.lastSent.at).toLocaleTimeString();
    text += ` Last sent: ${s.lastSent.lap ? `lap ${s.lastSent.lap}` : 'first crossing'} at ${when}.`;
  }
  els.linkStatus.textContent = text;
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
  renderPlan();
  renderLaps();
}
function readPlanLink() {
  const r = planFromHash(location.hash);
  if (!r) return;
  // Keep the plan for this visit, but take it out of the address bar.
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignored */ }
  if (r.error) { showToast(r.error); return; }
  setPlan(r.plan);
  showToast(`Plan loaded: ${r.plan.name}`);
}
window.addEventListener('hashchange', readPlanLink);

let toastTimer = null;
function showToast(text) {
  els.toast.textContent = text;
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
function renderPlan() {
  els.planStrip.hidden = !plan;
  if (!plan) return;
  const text = stripText(plan, currentProgress());
  els.planName.textContent = plan.name;
  els.planBlock.textContent = text.block;
  els.planLeft.textContent = text.left;
  els.planNext.textContent = text.next;
}
setInterval(() => { if (plan && !els.panel.hidden) renderPlan(); }, 250);
els.planClose.addEventListener('click', () => {
  if (els.planClose.dataset.armed !== '1') {
    els.planClose.dataset.armed = '1';
    els.planClose.textContent = 'Tap again to close plan';
    setTimeout(() => { els.planClose.dataset.armed = ''; els.planClose.textContent = '×'; }, 3000);
    return;
  }
  els.planClose.dataset.armed = '';
  els.planClose.textContent = '×';
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
  if (s.laps.length) { persistSession(s); lastSession = s; } else {
    store.deleteTiming(s.id).catch(() => {});
  }
}

const STATUS_TEXT = {
  setup: 'Set up', learning: 'Keep the line clear', armed: 'Waiting for first rider', timing: 'Timing',
};
function setState(s) {
  state = s;
  els.status.textContent = STATUS_TEXT[s] || '';
  els.status.dataset.state = s;
  const active = s === 'learning' || s === 'armed' || s === 'timing';
  els.startBtn.textContent = active ? (recorder ? 'Stop recording' : 'Stop') : 'Start timing';
  els.startBtn.classList.toggle('stop', active);
  els.recBtn.hidden = active;
  els.markBtn.hidden = !(active && recorder);
  els.startBtn.classList.toggle('wide', active && !recorder);
  els.sendBtn.hidden = active || !lastSession?.laps.length;
  if (active) els.sendNote.hidden = true;
  recorder?.log('state', { detail: s });
  drawOverlay();
}

// ---------- camera ----------
els.cameraBtn.addEventListener('click', startCamera);
async function startCamera() {
  els.cameraError.hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraError('This browser cannot use the camera. Open the app in Safari or Chrome over https.');
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
    showCameraError(err && err.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow the camera for this app in the phone settings, then try again.'
      : `The camera did not start (${err && err.name ? err.name : 'unknown error'}). Close other camera apps and try again.`);
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
    showCameraError('The camera stopped. Tap to turn it on again.');
    els.intro.hidden = false;
  });
  setState('setup');
  scheduleFrame();
}
function showCameraError(msg) {
  els.cameraError.textContent = msg;
  els.cameraError.hidden = false;
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
  drawOverlay();
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
els.startBtn.addEventListener('click', async () => {
  if (state === 'learning' || state === 'armed' || state === 'timing') { stopTiming(); return; }
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
  if (stream) setState('setup');
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

els.undoBtn.addEventListener('click', () => {
  const undone = counter.undoLast();
  if (session) { sessionUndo(session); persistSession(); }
  if (plan) announcedBlock = currentProgress().index;
  renderPlan();
  recorder?.log('undo', { lap: undone?.lap, detail: undone ? 'lap' : 'start' });
  if (counter.startTime === null && (state === 'timing')) setState('armed');
  renderLaps();
});

function renderLaps() {
  const laps = counter.laps;
  const dec = settings.decimals;
  els.undoBtn.disabled = laps.length === 0;
  const results = plan && laps.length ? currentProgress().results : [];
  els.lastLap.className = 'big';
  if (!laps.length) {
    els.lastLap.textContent = '--.-';
    els.lapInfo.textContent = counter.startTime === null ? '' : 'Clock started';
    els.laps.replaceChildren();
    return;
  }
  const last = laps[laps.length - 1];
  const best = Math.min(...laps.map((l) => l.ms));
  els.lastLap.textContent = formatLap(last.ms, dec);
  const lastResult = results[laps.length - 1];
  if (lastResult?.band) els.lastLap.classList.add(`band-${lastResult.band}`);
  const prev = laps[laps.length - 2];
  const delta = prev ? ` · ${last.ms <= prev.ms ? '−' : '+'}${(Math.abs(last.ms - prev.ms) / 1000).toFixed(dec)}` : '';
  let target = '';
  if (lastResult?.break) target = ' · break';
  else if (lastResult?.target != null) target = ` · target ${lastResult.target.toFixed(1)}`;
  els.lapInfo.textContent = `Lap ${last.lap} · best ${formatLap(best, dec)}${delta}${target}`;
  els.laps.replaceChildren(...laps.slice().reverse().map((l) => {
    const li = document.createElement('li');
    if (l.ms === best) li.className = 'best';
    const band = results[l.lap - 1]?.band;
    if (band) li.classList.add(`band-${band}`);
    const small = document.createElement('small');
    small.textContent = String(l.lap);
    li.append(small, formatLap(l.ms, dec));
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
  octx.setLineDash([6, 6]);
  octx.strokeStyle = lvl.apron > 0.05 ? 'rgba(217,163,95,0.95)' : 'rgba(217,163,95,0.6)';
  octx.lineWidth = 3;
  octx.beginPath(); octx.moveTo(b.x, b.y); octx.lineTo(apronEnd.x, apronEnd.y); octx.stroke();
  octx.setLineDash([]);
  // track part
  octx.strokeStyle = covered ? 'rgba(229,72,77,0.95)' : 'rgba(62,155,255,0.75)';
  octx.lineWidth = 2;
  octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();

  const editable = state === 'setup';
  drawHandle(a, 'Top of track', editable);
  drawHandle(b, 'Inner edge', editable);
}
function drawHandle(p, label, editable) {
  // Hollow ring, so the black line stays visible for lining up.
  octx.beginPath();
  octx.arc(p.x, p.y, editable ? 14 : 6, 0, Math.PI * 2);
  octx.lineWidth = 5; octx.strokeStyle = 'rgba(10,22,34,0.8)'; octx.stroke();
  octx.lineWidth = 3; octx.strokeStyle = editable ? '#f4f1ea' : 'rgba(244,241,234,0.6)'; octx.stroke();
  if (editable) {
    octx.font = '600 13px system-ui, sans-serif';
    octx.fillStyle = '#f4f1ea';
    octx.strokeStyle = 'rgba(10,22,34,0.85)'; octx.lineWidth = 4;
    octx.strokeText(label, p.x + 20, p.y + 5);
    octx.fillText(label, p.x + 20, p.y + 5);
  }
}

let dragging = null;
els.overlay.addEventListener('pointerdown', (e) => {
  if (state !== 'setup') return;
  const r = contentRect();
  const pt = { x: e.offsetX, y: e.offsetY };
  for (const key of ['top', 'inner']) {
    const s = toScreen(settings.line[key], r);
    if (Math.hypot(s.x - pt.x, s.y - pt.y) < 36) {
      dragging = key;
      els.overlay.setPointerCapture(e.pointerId);
      return;
    }
  }
});
els.overlay.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const r = contentRect();
  settings.line[dragging] = {
    x: Math.min(1, Math.max(0, (e.offsetX - r.x) / r.w)),
    y: Math.min(1, Math.max(0, (e.offsetY - r.y) / r.h)),
  };
  drawOverlay();
});
const endDrag = () => { if (dragging) { dragging = null; save(); } };
els.overlay.addEventListener('pointerup', endDrag);
els.overlay.addEventListener('pointercancel', endDrag);
window.addEventListener('resize', drawOverlay);

function detectorTuning() {
  // "Count single riders" turns off the team check (for solo efforts).
  return settings.countSingles ? { ...DEFAULT_TUNING, groupMinCoverMs: 0 } : DEFAULT_TUNING;
}

// ---------- settings dialog ----------
function fillSettings() {
  els.ignoreSec.value = settings.ignoreSec;
  els.decimals.value = String(settings.decimals);
  els.voice.value = settings.voice;
  els.recordSound.checked = !!settings.recordSound;
  els.countSingles.checked = !!settings.countSingles;
  els.stopwatchCode.value = settings.stopwatchCode;
  els.restBetweenLaps.checked = settings.restBetweenLaps !== false;
  els.sayGap.checked = !!settings.sayGap;
}
els.settingsBtn.addEventListener('click', () => {
  fillSettings();
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
els.decimals.addEventListener('change', () => { settings.decimals = Number(els.decimals.value); save(); renderLaps(); });
els.voice.addEventListener('change', () => { settings.voice = els.voice.value; announcer.mode = settings.voice; save(); });
els.testVoiceBtn.addEventListener('click', async () => {
  await announcer.unlock();
  announcer.sayLap(formatLap(17430, settings.decimals));
});
els.resetMarkersBtn.addEventListener('click', () => {
  settings.line = structuredClone(DEFAULT_LINE); save(); drawOverlay();
});
els.clearBtn.addEventListener('click', () => {
  recorder?.log('clear');
  counter.reset();
  // Laps timed so far stay in Settings > Sessions; timing carries on as a new session.
  if (session) { finishSession(); session = newSession({ plan, settings: sessionSettings() }); }
  announcedBlock = 0;
  renderPlan();
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
  setTimeout(() => els.markBtn.classList.remove('flash'), 150);
  showRecInfo();
});

function showRecInfo() {
  if (!recorder) { els.recInfo.hidden = true; return; }
  const s = Math.floor(recorder.now() / 1000);
  const marks = recorder.rec.log.events.filter((e) => e.type === 'mark').length;
  const mm = String(Math.floor(s / 60)).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
  const warn = recorder.rec.problems.length ? ' · !' : '';
  els.recInfo.textContent = `REC ${mm}:${ss} · ${formatBytes(recorder.bytes)}${marks ? ` · ${marks} marks` : ''}${warn}`;
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
    els.recList.replaceChildren(textP(`Could not open saved recordings (${e?.message || e}).`, 'warn'));
  }
  sessions = sessions.filter((x) => x.id !== recorder?.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const items = [];
  for (const rec of sessions) {
    const files = await sessionFiles(rec, rec.id === highlightId ? memChunks : null).catch(() => []);
    items.push(renderSession(rec, files));
  }
  els.recList.replaceChildren(...(items.length ? items : [textP('No recordings yet. Tap Record + time to make one.', 'meta')]));
  try {
    const est = await navigator.storage?.estimate?.();
    els.recStorage.textContent = est?.quota ? `Using ${formatBytes(est.usage || 0)} of about ${formatBytes(est.quota)} the browser allows.` : '';
  } catch { els.recStorage.textContent = ''; }
}

function textP(t, cls) { const p = document.createElement('p'); p.className = cls; p.textContent = t; return p; }

function renderSession(rec, files) {
  const box = document.createElement('div');
  box.className = 'recitem';
  const h = document.createElement('h3');
  const d = new Date(rec.startedAt);
  h.textContent = d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const lastMs = rec.log.events.length ? rec.log.events[rec.log.events.length - 1].ms : 0;
  const laps = rec.log.events.filter((e) => e.type === 'lap').length;
  const marks = rec.log.events.filter((e) => e.type === 'mark').length;
  const videos = files.filter((f) => f.type.startsWith('video/'));
  const total = videos.reduce((n, f) => n + f.size, 0);
  const meta = textP(`${Math.round(lastMs / 60000)} min · ${laps} laps · ${marks} marks · ${formatBytes(total)} video`, 'meta');
  box.append(h, meta);
  if (!rec.endedAt) box.append(textP('Stopped unexpectedly. What was saved before that is here.', 'warn'));
  for (const p of rec.problems || []) box.append(textP(p.msg, 'warn'));
  const list = document.createElement('div');
  list.className = 'files';
  for (const f of videos) list.append(fileButton(`Save video ${f.name.match(/part\d+/)?.[0].replace('part', 'part ') || ''} (${formatBytes(f.size)})`, [f]));
  const logs = files.filter((f) => !f.type.startsWith('video/'));
  if (logs.length) list.append(fileButton('Save log, events and setup photo', logs));
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'btn danger'; del.textContent = 'Delete this recording';
  del.addEventListener('click', async () => {
    if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; return; }
    del.disabled = true;
    try { await store.deleteSession(rec.id); box.remove(); } catch (e) { del.textContent = `Delete failed (${e?.message || e})`; }
  });
  list.append(del);
  box.append(list);
  return box;
}

function fileButton(label, files) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn'; b.textContent = label;
  b.addEventListener('click', () => {
    shareOrDownload(files).then((how) => {
      if (how === 'shared' || how === 'downloaded') b.textContent = `${label} ✓`;
    });
  });
  return b;
}

// ---------- Send to Pacemaker ----------
// Only ever on a tap. No keys or logins: Pacemaker asks the person to check
// and save the ride.
const API_OVERRIDE = new URLSearchParams(location.search).get('pmapi'); // e.g. ?pmapi=http://localhost:8787 for testing
const SEND_FAILED = "Couldn't send. It's saved in Settings > Sessions; try again with signal.";

els.sendBtn.addEventListener('click', () => {
  if (lastSession) sendToPacemaker(lastSession, els.sendBtn, els.sendNote);
});

async function sendToPacemaker(s, btn, note) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  note.hidden = true;
  try {
    const answer = await sendSession(s, { api: apiFor(s, API_OVERRIDE) });
    s.sentAt = Date.now();
    s.sent = answer;
    await store.saveTiming(s).catch(() => {});
    btn.textContent = 'Sent ✓';
    note.textContent = 'Sent to Pacemaker.';
    note.className = 'note';
    note.hidden = false;
    openPacemaker(answer);
  } catch {
    btn.textContent = label;
    note.textContent = SEND_FAILED;
    note.className = 'warn';
    note.hidden = false;
  } finally {
    btn.disabled = false;
  }
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
    els.sessList.replaceChildren(textP(`Could not open saved sessions (${e?.message || e}).`, 'warn'));
    return;
  }
  list.sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
  els.sessList.replaceChildren(...(list.length ? list.map(renderTiming) : [textP('No sessions yet. Every Start timing is kept here.', 'meta')]));
}

function renderTiming(s) {
  const box = document.createElement('div');
  box.className = 'recitem';
  const h = document.createElement('h3');
  h.textContent = new Date(s.startedAt ?? s.createdAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const active = s.id === session?.id;
  const bits = [`${s.laps.length} ${s.laps.length === 1 ? 'lap' : 'laps'}`, formatDuration(sessionDuration(s))];
  if (s.plan?.name) bits.push(s.plan.name);
  if (s.sentAt) bits.push('Sent');
  if (active) bits.push('timing now');
  box.append(h, textP(bits.join(' · '), 'meta'));
  if (!s.endedAt && !active) box.append(textP('Stopped unexpectedly. The laps up to then are here.', 'warn'));
  const row = document.createElement('div');
  row.className = 'files';
  const note = textP('', 'warn');
  note.hidden = true;
  if (!active && s.laps.length) {
    const send = document.createElement('button');
    send.type = 'button'; send.className = 'btn';
    send.textContent = s.sentAt ? 'Send to Pacemaker again' : 'Send to Pacemaker';
    send.addEventListener('click', () => sendToPacemaker(s, send, note));
    row.append(send);
  }
  if (s.sent?.web) {
    const a = document.createElement('a');
    a.className = 'btn link'; a.href = s.sent.web; a.textContent = 'Open in Pacemaker';
    row.append(a);
  }
  if (!active) {
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'btn danger'; del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; return; }
      del.disabled = true;
      try {
        await store.deleteTiming(s.id);
        if (lastSession?.id === s.id) { lastSession = null; els.sendBtn.hidden = true; }
        box.remove();
      } catch (e) { del.textContent = `Delete failed (${e?.message || e})`; }
    });
    row.append(del);
  }
  box.append(row, note);
  return box;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

readPlanLink();
renderPlan();
renderLaps();
