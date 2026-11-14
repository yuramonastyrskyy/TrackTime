import {
  DEFAULT_LINE, DEFAULT_TUNING, buildSampler, readSamplesRGBA, LineDetector, LapCounter, formatLap,
} from './detector.js';
import { Announcer } from './speech.js';
import {
  SessionRecorder, sessionFiles, shareOrDownload, store, formatBytes,
} from './recorder.js';

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
  recordingsBtn: $('recordingsBtn'), recordings: $('recordings'), recList: $('recList'), recStorage: $('recStorage'),
};

// ---------- settings ----------
const STORE_KEY = 'tracktime.settings.v1';
const settings = Object.assign(
  { ignoreSec: 14, decimals: 1, voice: 'auto', recordSound: false, countSingles: false, line: structuredClone(DEFAULT_LINE) },
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
let proc = null, procCtx = null;
let timeSource = null;
let wakeLock = null;
let fpsFrames = 0, fpsSince = performance.now();
let recorder = null;         // SessionRecorder while "Record + time" is running
let micTrack = null;
let lastFrameT = 0;          // detection clock of the newest frame
let sec = { frames: 0, track: 0, apron: 0 }; // per-second stats for the log

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
        width: { ideal: 1920 }, height: { ideal: 1080 },
        frameRate: { ideal: 60 },
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
    els.fps.textContent = `${fps} fps`;
    fpsFrames = 0; fpsSince = now;
    if (recorder) {
      recorder.log('second', {
        fps, detFrames: sec.frames, track: +sec.track.toFixed(3), apron: +sec.apron.toFixed(3),
        learning: !!detector?.learning,
      });
      sec = { frames: 0, track: 0, apron: 0 };
      showRecInfo();
    }
  }
  if (detector && els.video.videoWidth) {
    const t = frameTime(now, meta);
    // Only the thin strip around the finish line is copied out of the video:
    // reading back the whole frame is what limits the frame rate on phones.
    const { x, y, w, h } = sampler.box;
    procCtx.drawImage(els.video, x / proc.scale, y / proc.scale, w / proc.scale, h / proc.scale, 0, 0, w, h);
    const img = procCtx.getImageData(0, 0, w, h);
    readSamplesRGBA(sampler, img.data, samples);
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
  samples = new Uint8Array(sampler.sampleCount);
  detector = new LineDetector(sampler, detectorTuning());
  if (!keepClock) timeSource = null;
  recorder?.log('detector', { detail: `${proc.width}x${proc.height}, ${sampler.sampleCount} samples, ${sampler.rowCount} rows` });
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
  renderLaps();
  try { prepareDetector(); } catch (e) { els.lapInfo.textContent = e.message; return false; }
  setState('learning');
  requestWakeLock();
  return true;
}

function stopTiming() {
  detector = null;
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
  if (r.type === 'start') {
    setState('timing');
    els.lapInfo.textContent = 'Clock started';
    announcer.sayStart();
  } else if (r.type === 'lap') {
    const text = formatLap(r.ms, settings.decimals);
    announcer.sayLap(text);
    renderLaps();
  }
}

els.undoBtn.addEventListener('click', () => {
  const undone = counter.undoLast();
  recorder?.log('undo', { lap: undone?.lap, detail: undone ? 'lap' : 'start' });
  if (counter.startTime === null && (state === 'timing')) setState('armed');
  renderLaps();
});

function renderLaps() {
  const laps = counter.laps;
  const dec = settings.decimals;
  els.undoBtn.disabled = laps.length === 0;
  if (!laps.length) {
    els.lastLap.textContent = '--.-';
    els.lapInfo.textContent = counter.startTime === null ? '' : 'Clock started';
    els.laps.replaceChildren();
    return;
  }
  const last = laps[laps.length - 1];
  const best = Math.min(...laps.map((l) => l.ms));
  els.lastLap.textContent = formatLap(last.ms, dec);
  const prev = laps[laps.length - 2];
  const delta = prev ? ` · ${last.ms <= prev.ms ? '−' : '+'}${(Math.abs(last.ms - prev.ms) / 1000).toFixed(dec)}` : '';
  els.lapInfo.textContent = `Lap ${last.lap} · best ${formatLap(best, dec)}${delta}`;
  els.laps.replaceChildren(...laps.slice().reverse().map((l) => {
    const li = document.createElement('li');
    if (l.ms === best) li.className = 'best';
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
      settings: { ignoreSec: settings.ignoreSec, decimals: settings.decimals, voice: settings.voice, recordSound: !!micTrack },
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

renderLaps();
