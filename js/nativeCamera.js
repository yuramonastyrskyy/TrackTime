// The native camera of the TrackTime Android app.
//
// The app (android/, a Capacitor shell) loads this same site and adds
// window.TrackTimeNative. Its camera runs at a fixed 60 fps with exposure and
// focus that can be locked, draws its preview behind the transparent page, and
// for each frame reads only the finish-line sample pixels the detector needs,
// with the sensor's own frame time. The page pulls those frames here and feeds
// them to the same detector.js as in the browser.
//
// Without the app (or with an older app) nativeApi() returns null and the page
// uses the browser camera as before. parseFrames is plain code, tested in Node.

/** Lowest app interface version this page works with. */
export const NATIVE_MIN = 1;
/** App interface version with rider identification. */
export const RIDERS_MIN = 2;

/** The app's interface, or null in a browser or an app that is too old. */
export function nativeApi(w = globalThis) {
  const n = w?.TrackTimeNative;
  try {
    if (n && typeof n.version === 'function' && n.version() >= NATIVE_MIN) return n;
  } catch { /* not the app */ }
  return null;
}

/**
 * Splits the app's frames() text, "n;t1,t2|base64", into
 * [{ t, samples }] (t in ms on the sensor clock, samples a Uint8Array of n).
 */
export function parseFrames(text) {
  if (!text) return [];
  const bar = text.indexOf('|'), semi = text.indexOf(';');
  if (bar < 0 || semi < 0 || semi > bar) return [];
  const n = Number(text.slice(0, semi));
  const times = text.slice(semi + 1, bar).split(',').map(Number);
  const bin = atob(text.slice(bar + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const out = [];
  for (let k = 0; k < times.length; k++) {
    if ((k + 1) * n > bytes.length) break;
    out.push({ t: times[k], samples: bytes.subarray(k * n, (k + 1) * n) });
  }
  return out;
}

/**
 * Points as the app wants them, "u,v,u,v" (0..1): the detector samples of a
 * buildSampler() result, then (optionally) the photo-finish column of a
 * buildStripLine() result (fractional pixel positions, rounded like the browser).
 */
export function pointsText(sampler, strip = null) {
  const parts = [];
  for (let i = 0; i < sampler.sampleCount; i++) {
    parts.push(((sampler.xs[i] + 0.5) / sampler.width).toFixed(5), ((sampler.ys[i] + 0.5) / sampler.height).toFixed(5));
  }
  if (strip) {
    for (let i = 0; i < strip.count; i++) {
      parts.push(((Math.round(strip.xs[i]) + 0.5) / sampler.width).toFixed(5), ((Math.round(strip.ys[i]) + 0.5) / sampler.height).toFixed(5));
    }
  }
  return parts.join(',');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NativeCamera {
  constructor(api) {
    this.api = api;
    this.width = 0;
    this.height = 0;
    this.epochOffset = 0;
    this.n = 0;
  }

  info() {
    try { return JSON.parse(this.api.info()); } catch { return {}; }
  }

  async waitFor(pred, ms) {
    const end = Date.now() + ms;
    let i = this.info();
    while (!pred(i) && Date.now() < end) {
      await sleep(100);
      i = this.info();
    }
    return i;
  }

  /** Asks for the camera permission if needed, starts the camera, resolves to info(). */
  async start({ fps = 60, slowmo = false } = {}) {
    let i = this.info();
    if (i.permission !== 'granted') {
      this.api.requestPermission();
      i = await this.waitFor((x) => x.permission !== 'asking' && x.permission !== 'prompt', 120000);
      if (i.permission !== 'granted') {
        const err = new Error('Camera access was blocked');
        err.name = 'NotAllowedError';
        err.permanent = i.permission === 'denied';
        throw err;
      }
    }
    this.api.start(JSON.stringify({ fps, slowmo }));
    i = await this.waitFor((x) => (x.running && x.width > 0) || x.error, 10000);
    if (!i.running || !i.width) throw new Error(i.error || 'The camera did not start');
    this.update(i);
    return i;
  }

  /** Keeps size and clock offset current; returns true when the picture size changed. */
  update(i = this.info()) {
    if (typeof i.epochOffsetMs === 'number') this.epochOffset = i.epochOffsetMs;
    if (!i.width || !i.height) return false;
    const changed = i.width !== this.width || i.height !== this.height;
    this.width = i.width;
    this.height = i.height;
    return changed;
  }

  stop() { try { this.api.stop(); } catch { /* ignored */ } }

  /** Detector samples plus the photo-finish column; frames then carry both. */
  setSampler(sampler, strip = null) {
    this.n = this.api.setPoints(pointsText(sampler, strip));
    return this.n;
  }

  /** Frames since the last call, oldest first; only those with the current sample count. */
  pull() {
    let text = '';
    try { text = this.api.frames(); } catch { return []; }
    return parseFrames(text).filter((f) => f.samples.length === this.n);
  }

  // Rider identification (app interface 2): see TrackCameraPlugin and js/riders.js.
  get hasRiders() { try { return this.api.version() >= RIDERS_MIN; } catch { return false; } }
  ridersStart(line, every = 2) {
    try { return this.api.ridersStart(JSON.stringify({ line: [line.top.x, line.top.y, line.inner.x, line.inner.y], every })); } catch { return false; }
  }
  ridersLap(t) { try { this.api.ridersLap(t); } catch { /* ignored */ } }
  ridersStop() { try { this.api.ridersStop(); } catch { /* ignored */ } }
  /** Frames described since the last call: [{ t, w, h, cov, people: [...] }]. */
  ridersPull() { try { return JSON.parse(this.api.ridersPull() || '[]'); } catch { return []; } }
  ridersInfo() { try { return JSON.parse(this.api.ridersInfo()); } catch { return {}; } }

  lock() { try { return this.api.lock(); } catch { return false; } }
  unlock() { try { this.api.unlock(); } catch { /* ignored */ } }
  nudge(thirds) { try { return this.api.nudge(thirds); } catch { return 0; } }
  takeLaunchHash() { try { return this.api.takeLaunchHash() || ''; } catch { return ''; } }
  openSettings() { try { this.api.openSettings(); } catch { /* ignored */ } }
}

/** "1/500 s · ISO 800 · locked · +0.3 EV" for Settings. */
export function exposureText(i) {
  if (!i || !i.exposureNs) return i?.locked ? 'Locked' : 'Automatic until you tap Start timing.';
  const parts = [`1/${Math.round(1e9 / i.exposureNs)} s`, `ISO ${i.iso}`, i.locked ? 'locked' : 'automatic'];
  if (i.nudge) parts.push(`${i.nudge > 0 ? '+' : '−'}${(Math.abs(i.nudge) / 3).toFixed(1)} EV`);
  return parts.join(' · ');
}

/** Android intent link that opens the app with a Pacemaker plan (#pm=...). */
export function openInAppLink(pmHash, fallbackUrl, pkg = 'io.github.yuramonastyrskyy.tracktime') {
  const pm = String(pmHash).replace(/^#?pm=/, '');
  return `intent://open?pm=${encodeURIComponent(pm)}#Intent;scheme=tracktime;package=${pkg};`
    + `S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end`;
}
