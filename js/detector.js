// Finish-line crossing detector and lap counter.
//
// The camera looks along the finish line (like a photo-finish camera), so the
// white line runs from the top of the picture (outer edge of the track) to the
// bottom (inner edge). We watch two thin strips of white just beside the black
// centre line. A wheel crossing covers them; the empty line never changes.
//
// Rows below the inner edge belong to the neutral zone (the blue apron). Riders
// there are ignored: a crossing only counts when the apron part of the strip
// stays clear around it.
//
// Everything here is plain math on grey values, so it runs the same in the
// browser and in Node tests.

export const DEFAULT_LINE = {
  // Normalised (0..1) picture coordinates, measured on the club's footage.
  top: { x: 272 / 540, y: 250 / 960 },    // where the finish line meets the top of the track
  inner: { x: 280 / 540, y: 808 / 960 },  // where it meets the inner edge (start of the neutral zone)
};

export const DEFAULT_TUNING = {
  procLongSide: 960,     // frames are scaled so their long side is this many pixels
  refLineLength: 558,    // line length (px) the offsets below were tuned for
  rightOffsets: [6, 7, 8, 9, 10, 11],
  leftOffsets: [-8, -9, -10, -11, -12, -13],
  apronMargin: 7,        // px below the inner edge before the neutral zone starts
  apronLengthRatio: 0.27,// neutral-zone strip length, as a share of the line length
  diffThreshold: 40,     // grey-level change that counts as "covered"
  rowFraction: 0.5,      // share of a row's samples that must be covered
  trackTrigger: 0.08,    // share of track rows covered to call it a crossing
  apronClear: 0.05,      // apron must stay below this share to count
  apronLookbackFrames: 15,
  lookaheadFrames: 3,
  passGapMs: 333,        // a new pass needs this much quiet time on the line
  learnFrames: 45,       // frames used to learn the empty line
  bgAlpha: 0.02,         // how fast the empty-line image adapts to light changes
};

/**
 * Builds the list of pixels to sample for a given picture size and line.
 * Returns pixel coordinates plus, for each sample, which row it belongs to.
 */
export function buildSampler(width, height, line = DEFAULT_LINE, tuning = DEFAULT_TUNING) {
  const p1 = { x: line.top.x * width, y: line.top.y * height };
  const p2 = { x: line.inner.x * width, y: line.inner.y * height };
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 20) throw new Error('The finish line markers are too close together.');
  const ux = dx / len, uy = dy / len;      // along the line, outer -> inner
  const nx = uy, ny = -ux;                  // perpendicular
  const scale = len / tuning.refLineLength;
  const offsets = [...tuning.rightOffsets, ...tuning.leftOffsets].map((o) => -o * scale);
  // For a line drawn downwards, n points to +x, so "right" offsets land right of the line.

  const apronStart = len + tuning.apronMargin * scale;
  const apronEnd = len + tuning.apronLengthRatio * len;
  const rows = [];
  const step = Math.max(1, scale); // about one processed pixel per row
  for (let d = 0; d <= apronEnd; d += step) {
    if (d > len && d < apronStart) continue;
    const cx = p1.x + ux * d, cy = p1.y + uy * d;
    if (cy >= height || cy < 0) break;
    rows.push({ cx, cy, apron: d >= apronStart });
  }

  const xs = [], ys = [], rowOf = [];
  rows.forEach((r, ri) => {
    for (const o of offsets) {
      const x = Math.round(r.cx - nx * o), y = Math.round(r.cy - ny * o);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      xs.push(x); ys.push(y); rowOf.push(ri);
    }
  });
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return {
    width, height,
    box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    xs: Int32Array.from(xs), ys: Int32Array.from(ys),
    rowOf: Int32Array.from(rowOf),
    rowIsApron: Uint8Array.from(rows.map((r) => (r.apron ? 1 : 0))),
    rowCount: rows.length,
    sampleCount: xs.length,
  };
}

/** Reads the sample grey values from an RGBA ImageData-like buffer of the sampler's box. */
export function readSamplesRGBA(sampler, data, out) {
  const { box, xs, ys } = sampler;
  for (let i = 0; i < xs.length; i++) {
    const p = ((ys[i] - box.y) * box.w + (xs[i] - box.x)) * 4;
    out[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return out;
}

/** Reads the sample grey values from a full-frame 8-bit grey buffer (used by tests). */
export function readSamplesGray(sampler, gray, out) {
  const { xs, ys, width } = sampler;
  for (let i = 0; i < xs.length; i++) out[i] = gray[ys[i] * width + xs[i]];
  return out;
}

/**
 * Turns per-frame samples into finish-line crossings.
 * push(samples, timeMs) returns a crossing time (ms) when one is confirmed,
 * a few frames later than the crossing itself, or null.
 */
export class LineDetector {
  constructor(sampler, tuning = DEFAULT_TUNING) {
    this.s = sampler;
    this.t = tuning;
    this.bg = null;
    this.learn = [];
    this.history = []; // {time, track, apron}
    this.lastOkTime = -Infinity;
    this.covered = new Uint8Array(sampler.sampleCount);
    this.rowHits = new Uint16Array(sampler.rowCount);
    this.rowSize = new Uint16Array(sampler.rowCount);
    for (let i = 0; i < sampler.sampleCount; i++) this.rowSize[sampler.rowOf[i]]++;
    this.trackRows = 0;
    this.apronRows = 0;
    for (let r = 0; r < sampler.rowCount; r++) {
      if (this.rowSize[r] === 0) continue;
      if (sampler.rowIsApron[r]) this.apronRows++; else this.trackRows++;
    }
    this.level = { track: 0, apron: 0 }; // last frame's coverage, for the on-screen meter
  }

  get learning() { return this.bg === null; }

  push(samples, time) {
    const t = this.t;
    if (this.bg === null) {
      this.learn.push(Uint8Array.from(samples));
      if (this.learn.length >= t.learnFrames) this._finishLearning();
      return null;
    }

    const n = samples.length, bg = this.bg;
    // Compensate for whole-picture brightness changes (phone auto-exposure).
    const diffs = new Int16Array(n);
    for (let i = 0; i < n; i++) diffs[i] = samples[i] - bg[i];
    const shift = median(diffs);
    const offset = Math.abs(shift) < 30 ? shift : 0;

    this.rowHits.fill(0);
    for (let i = 0; i < n; i++) {
      const c = Math.abs(diffs[i] - offset) > t.diffThreshold ? 1 : 0;
      this.covered[i] = c;
      if (c) this.rowHits[this.s.rowOf[i]]++;
    }
    let trackCov = 0, apronCov = 0;
    for (let r = 0; r < this.s.rowCount; r++) {
      const size = this.rowSize[r];
      if (!size) continue;
      if (this.rowHits[r] / size > t.rowFraction) {
        if (this.s.rowIsApron[r]) apronCov++; else trackCov++;
      }
    }
    const track = this.trackRows ? trackCov / this.trackRows : 0;
    const apron = this.apronRows ? apronCov / this.apronRows : 0;
    this.level = { track, apron };

    // Slowly adapt the empty-line image where nothing is covering it.
    if (track < t.trackTrigger && apron < t.apronClear) {
      const a = t.bgAlpha;
      for (let i = 0; i < n; i++) if (!this.covered[i]) bg[i] += a * (samples[i] - offset - bg[i]);
    }

    const h = this.history;
    h.push({ time, track, apron });
    const keep = t.apronLookbackFrames + t.lookaheadFrames + 1;
    if (h.length > keep) h.shift();
    if (h.length < keep) return null;

    const c = h.length - 1 - t.lookaheadFrames; // candidate frame
    const cand = h[c];
    if (cand.track <= t.trackTrigger) return null;
    for (let i = 0; i < h.length; i++) if (h[i].apron >= t.apronClear) return null;
    const isNewPass = cand.time - this.lastOkTime > t.passGapMs;
    this.lastOkTime = cand.time;
    return isNewPass ? cand.time : null;
  }

  _finishLearning() {
    const frames = this.learn, n = frames[0].length, m = frames.length;
    const bg = new Float32Array(n), col = new Uint8Array(m);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < m; k++) col[k] = frames[k][i];
      col.sort();
      bg[i] = col[m >> 1];
    }
    this.bg = bg;
    this.learn = [];
  }
}

function median(arr) {
  // Histogram median for values in -255..255.
  const hist = new Uint32Array(511);
  for (let i = 0; i < arr.length; i++) hist[arr[i] + 255]++;
  let acc = 0;
  const half = arr.length / 2;
  for (let v = 0; v < 511; v++) {
    acc += hist[v];
    if (acc >= half) return v - 255;
  }
  return 0;
}

/**
 * Lap logic: the first crossing starts the clock; after each counted crossing
 * the line is ignored for `ignoreMs` so the following team is not counted.
 */
export class LapCounter {
  constructor(ignoreMs = 14000) {
    this.ignoreMs = ignoreMs;
    this.reset();
  }
  reset() {
    this.startTime = null;
    this.lastTime = null;
    this.laps = []; // {lap, ms, at}
  }
  crossing(time) {
    if (this.lastTime === null) {
      this.startTime = this.lastTime = time;
      return { type: 'start', at: time };
    }
    const since = time - this.lastTime;
    if (since < this.ignoreMs) return { type: 'ignored', at: time, since };
    const lap = { lap: this.laps.length + 1, ms: since, at: time };
    this.laps.push(lap);
    this.lastTime = time;
    return { type: 'lap', ...lap };
  }
  undoLast() {
    // Removes the most recent lap, as if that crossing never happened.
    const last = this.laps.pop();
    if (!last) {
      if (this.startTime !== null) this.reset();
      return null;
    }
    this.lastTime = last.at - last.ms;
    return last;
  }
}

/** "17.4" style text for a lap in milliseconds. */
export function formatLap(ms, decimals = 1) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(decimals);
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0');
  return `${m}:${rest}`;
}
