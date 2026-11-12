import {
  DEFAULT_LINE, buildSampler, readSamplesRGBA, LineDetector, LapCounter, formatLap,
} from './detector.js';
import { Announcer } from './speech.js';

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), overlay: $('overlay'), intro: $('intro'), cameraBtn: $('cameraBtn'),
  cameraError: $('cameraError'), hud: $('hud'), panel: $('panel'), status: $('status'), fps: $('fps'),
  lastLap: $('lastLap'), lapInfo: $('lapInfo'), laps: $('laps'), startBtn: $('startBtn'),
  undoBtn: $('undoBtn'), settingsBtn: $('settingsBtn'), settings: $('settings'),
  ignoreSec: $('ignoreSec'), decimals: $('decimals'), voice: $('voice'),
  testVoiceBtn: $('testVoiceBtn'), resetMarkersBtn: $('resetMarkersBtn'),
  copyBtn: $('copyBtn'), clearBtn: $('clearBtn'), copyNote: $('copyNote'),
};

// ---------- settings ----------
const STORE_KEY = 'tracktime.settings.v1';
const settings = Object.assign(
  { ignoreSec: 14, decimals: 1, voice: 'auto', line: structuredClone(DEFAULT_LINE) },
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

const STATUS_TEXT = {
  setup: 'Set up', learning: 'Keep the line clear', armed: 'Waiting for first rider', timing: 'Timing',
};
function setState(s) {
  state = s;
  els.status.textContent = STATUS_TEXT[s] || '';
  els.status.dataset.state = s;
  const active = s === 'learning' || s === 'armed' || s === 'timing';
  els.startBtn.textContent = active ? 'Stop' : 'Start timing';
  els.startBtn.classList.toggle('stop', active);
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
    els.fps.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsSince))} fps`;
    fpsFrames = 0; fpsSince = now;
  }
  if (detector && els.video.videoWidth) {
    const t = frameTime(now, meta);
    procCtx.drawImage(els.video, 0, 0, proc.width, proc.height);
    const { x, y, w, h } = sampler.box;
    const img = procCtx.getImageData(x, y, w, h);
    readSamplesRGBA(sampler, img.data, samples);
    const hit = detector.push(samples, t);
    if (state === 'learning' && !detector.learning) setState(counter.startTime === null ? 'armed' : 'timing');
    if (hit !== null) onCrossing(hit);
  }
  drawOverlay();
  scheduleFrame();
}

function prepareDetector({ keepClock = false } = {}) {
  const vw = els.video.videoWidth, vh = els.video.videoHeight;
  const s = 960 / Math.max(vw, vh);
  proc = document.createElement('canvas');
  proc.width = Math.round(vw * s);
  proc.height = Math.round(vh * s);
  procCtx = proc.getContext('2d', { willReadFrequently: true });
  sampler = buildSampler(proc.width, proc.height, settings.line);
  samples = new Uint8Array(sampler.sampleCount);
  detector = new LineDetector(sampler);
  if (!keepClock) timeSource = null;
}

// ---------- timing ----------
els.startBtn.addEventListener('click', async () => {
  if (state === 'learning' || state === 'armed' || state === 'timing') { stopTiming(); return; }
  if (!els.video.videoWidth) return;
  announcer.unlock(); // inside the tap, so phones allow sound
  counter.ignoreMs = settings.ignoreSec * 1000;
  counter.reset();
  renderLaps();
  try { prepareDetector(); } catch (e) { els.lapInfo.textContent = e.message; return; }
  setState('learning');
  requestWakeLock();
});

function stopTiming() {
  detector = null;
  releaseWakeLock();
  if (stream) setState('setup');
}

function onCrossing(t) {
  const r = counter.crossing(t);
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
  counter.undoLast();
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

// ---------- settings dialog ----------
function fillSettings() {
  els.ignoreSec.value = settings.ignoreSec;
  els.decimals.value = String(settings.decimals);
  els.voice.value = settings.voice;
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
  if (document.visibilityState !== 'visible') return;
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

renderLaps();
