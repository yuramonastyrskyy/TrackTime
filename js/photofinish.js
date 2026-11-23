// Photo-finish: a line-scan picture of the finish line over time.
//
// Real photo-finish cameras look at a single line of pixels and stack it up as
// time passes, so the picture's x axis is time, not space. Here every camera
// frame adds one column: the colour pixels along the finish line (from a bit
// above the top marker down through the neutral zone). Around each counted
// crossing the columns are laid out on an even time grid, blending the two
// nearest frames for columns that fall between frames, so the time scale under
// the picture is exact even when frames arrive unevenly.
//
// Plain math on byte arrays, so it runs the same in the browser and in Node.

export const PF = {
  beforeMs: 1000,     // picture starts this long before the detected crossing
  afterMs: 2000,      // ...and ends this long after it
  colsPerSec: 240,    // even time grid of the picture (4 columns per frame at 60 fps)
  gapMs: 150,         // frames further apart than this are a gap, drawn dark
  topMarginRatio: 0.2, // share of the line length added above the top marker
  apronRatio: 0.27,   // neutral-zone length, as in the detector
  maxRows: 720,
};

/**
 * Points along the finish line, one per row of the photo-finish picture, in a
 * frame of width x height (the detector's processing frame).
 * rowTop / rowInner: picture rows of the top marker and the inner edge.
 */
export function buildStripLine(width, height, line, opts = PF) {
  const p1 = { x: line.top.x * width, y: line.top.y * height };
  const p2 = { x: line.inner.x * width, y: line.inner.y * height };
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 20) throw new Error('The finish line markers are too close together.');
  const ux = dx / len, uy = dy / len;
  let from = -opts.topMarginRatio * len;
  const to = len * (1 + opts.apronRatio);
  const step = Math.max(1, (to - from) / opts.maxRows);
  const xs = [], ys = [];
  let rowTop = 0, rowInner = 0;
  for (let d = from; d <= to; d += step) {
    const x = p1.x + ux * d, y = p1.y + uy * d;
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) {
      if (!xs.length) { from = d; continue; } // still above the picture
      break;
    }
    if (d <= 0) rowTop = xs.length;
    if (d <= len) rowInner = xs.length;
    xs.push(x); ys.push(y);
  }
  if (xs.length < 10) throw new Error('The finish line is outside the picture.');
  const ix = xs.map(Math.round), iy = ys.map(Math.round);
  const minX = Math.min(...ix), maxX = Math.max(...ix), minY = Math.min(...iy), maxY = Math.max(...iy);
  return {
    width, height,
    xs: Float32Array.from(xs), ys: Float32Array.from(ys),
    count: xs.length, rowTop, rowInner,
    box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

/** Smallest box holding two boxes. */
export function unionBox(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Reads the strip's RGB from an RGBA buffer that covers `box` (nearest pixel). */
export function readStripRGBA(strip, box, data, out) {
  const { xs, ys, count } = strip;
  for (let i = 0; i < count; i++) {
    const p = ((Math.round(ys[i]) - box.y) * box.w + (Math.round(xs[i]) - box.x)) * 4;
    out[i * 3] = data[p]; out[i * 3 + 1] = data[p + 1]; out[i * 3 + 2] = data[p + 2];
  }
  return out;
}

/** Reads the strip's RGB from a full-frame RGB24 buffer (used by Node tools). */
export function readStripRGB(strip, rgb, out) {
  const { xs, ys, count, width } = strip;
  for (let i = 0; i < count; i++) {
    const p = (Math.round(ys[i]) * width + Math.round(xs[i])) * 3;
    out[i * 3] = rgb[p]; out[i * 3 + 1] = rgb[p + 1]; out[i * 3 + 2] = rgb[p + 2];
  }
  return out;
}

/** The last few seconds of strip columns, oldest first. */
export class StripBuffer {
  constructor(rows, capacity = 600) {
    this.rows = rows;
    this.cap = capacity;
    this.cols = new Uint8Array(capacity * rows * 3);
    this.times = new Float64Array(capacity);
    this.n = 0;       // columns held
    this.head = 0;    // next slot to write
  }
  clear() { this.n = 0; this.head = 0; }
  /** Adds one frame's column (RGB, rows*3 bytes) taken at time t (ms). */
  push(t, col) {
    if (this.n && t <= this.times[(this.head - 1 + this.cap) % this.cap]) return; // same or older frame
    this.cols.set(col.subarray(0, this.rows * 3), this.head * this.rows * 3);
    this.times[this.head] = t;
    this.head = (this.head + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }
  get newest() { return this.n ? this.times[(this.head - 1 + this.cap) % this.cap] : -Infinity; }
  get oldest() { return this.n ? this.times[(this.head - this.n + this.cap) % this.cap] : Infinity; }

  /**
   * Builds the photo-finish picture for [from, to] (ms, buffer clock).
   * Returns { width, height, rgba, t0, stepMs, frames } where column x shows
   * time t0 + x * stepMs and frames lists the real frame times (ms after t0),
   * or null when no frames fall in the window.
   */
  picture(from, to, colsPerSec = PF.colsPerSec, gapMs = PF.gapMs) {
    const rows = this.rows, stepMs = 1000 / colsPerSec;
    const idx = [];
    for (let k = 0; k < this.n; k++) {
      const i = (this.head - this.n + k + this.cap) % this.cap;
      const t = this.times[i];
      if (t >= from - gapMs && t <= to + gapMs) idx.push(i);
    }
    if (!idx.some((i) => this.times[i] >= from && this.times[i] <= to)) return null;
    const width = Math.max(1, Math.round((to - from) / stepMs) + 1);
    const rgba = new Uint8ClampedArray(width * rows * 4);
    const cols = this.cols, times = this.times;
    let j = 0;
    for (let x = 0; x < width; x++) {
      const t = from + x * stepMs;
      while (j + 1 < idx.length && times[idx[j + 1]] <= t) j++;
      const a = idx[j], b = idx[j + 1];
      const ta = times[a];
      let w = -1; // blend weight of frame b; -1 = gap
      if (Math.abs(t - ta) < 1e-6) w = 0;
      else if (b !== undefined && ta < t && times[b] - ta <= gapMs) w = (t - ta) / (times[b] - ta);
      for (let r = 0; r < rows; r++) {
        const o = (r * width + x) * 4;
        if (w < 0) {
          // gap: dark slate with a faint stripe, so it never looks like real picture
          const v = (r >> 3) & 1 ? 34 : 28;
          rgba[o] = v; rgba[o + 1] = v + 6; rgba[o + 2] = v + 14; rgba[o + 3] = 255;
          continue;
        }
        const pa = (a * rows + r) * 3;
        if (w === 0) {
          rgba[o] = cols[pa]; rgba[o + 1] = cols[pa + 1]; rgba[o + 2] = cols[pa + 2];
        } else {
          const pb = (b * rows + r) * 3, v = 1 - w;
          rgba[o] = cols[pa] * v + cols[pb] * w;
          rgba[o + 1] = cols[pa + 1] * v + cols[pb + 1] * w;
          rgba[o + 2] = cols[pa + 2] * v + cols[pb + 2] * w;
        }
        rgba[o + 3] = 255;
      }
    }
    const frames = idx.map((i) => times[i] - from).filter((t) => t >= 0 && t <= to - from);
    return { width, height: rows, rgba, t0: from, stepMs, frames };
  }
}

/** Median gap between frames (ms), for "1 frame = 17 ms". */
export function frameInterval(frames) {
  if (frames.length < 3) return null;
  const d = [];
  for (let i = 1; i < frames.length; i++) d.push(frames[i] - frames[i - 1]);
  d.sort((p, q) => p - q);
  return d[d.length >> 1];
}

/** Tick spacing (ms) so labels sit at least minPx apart at msPerPx. */
export function tickStep(msPerPx, minPx = 64) {
  for (const s of [10, 20, 50, 100, 200, 500, 1000]) if (s / msPerPx >= minPx) return s;
  return 1000;
}
