// Photo-finish viewer: draws a picture from js/photofinish.js on a canvas with
// a time scale, and lets you pan, zoom (pinch, wheel or buttons) and drag a
// cursor onto the front wheel. Times are ms from the detected crossing (0).
//
// Pointer maths uses getBoundingClientRect, which is in the same on-screen
// pixels as the pointer events, so the --tt-ui-scale zoom on the sheet is safe.

import { tickStep } from './photofinish.js';

const AXIS = 34;          // px under the picture for the time scale
const MIN_MS_PER_PX = 0.4; // most zoomed in (one 60 fps frame ≈ 42 px)

export class PhotoFinishViewer {
  constructor(canvas, { onCursor = () => {}, colors = {} } = {}) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.onCursor = onCursor;
    this.colors = { text: '#f4f1ea', muted: '#9fb3c6', amber: '#f5c84c', blue: '#3e9bff', bg: '#050b11', ...colors };
    this.pic = null;
    this.flip = false;
    this.cursor = 0;
    this.viewStart = -300;   // ms at the left edge
    this.msPerPx = 2;
    this.pointers = new Map();
    this.drag = null;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._zoomAt(Math.exp(e.deltaY * 0.0015), this._px(e));
    }, { passive: false });
    this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.draw()) : null;
    this._ro?.observe(canvas);
  }

  /** pic: { bitmap, width, height, t0, stepMs, frames, rowInner } with t0/frames relative to the crossing. */
  show(pic) {
    this.pic = pic;
    this.cursor = 0;
    this.fit();
    this.onCursor(this.cursor);
  }
  clear() { this.pic = null; this.draw(); }

  get span() { return this.pic ? (this.pic.width - 1) * this.pic.stepMs : 3000; }
  get W() { return this.c.getBoundingClientRect().width || 300; }

  /** Default view: 1.2 s around the crossing (most of a team passing). */
  fit() {
    const W = this.W;
    this.msPerPx = Math.max(MIN_MS_PER_PX, 1200 / W);
    this.viewStart = -250;
    this._clamp();
    this.draw();
  }
  /** Zooms around the cursor when it is on screen, else around the middle. */
  zoom(f) {
    const xc = this._x(this.cursor), W = this.W;
    this._zoomAt(f, xc >= 0 && xc <= W ? xc : W / 2);
  }
  setFlip(on) { this.flip = !!on; this.draw(); }

  _zoomAt(f, px) {
    const t = this._t(px);
    const maxMs = (this.span * 1.1) / this.W;
    this.msPerPx = Math.min(maxMs, Math.max(MIN_MS_PER_PX, this.msPerPx * f));
    // keep the time under the finger where it was
    const x = this.flip ? this.W - px : px;
    this.viewStart = t - x * this.msPerPx;
    this._clamp();
    this.draw();
  }
  _clamp() {
    if (!this.pic) return;
    const W = this.W, t0 = this.pic.t0, t1 = t0 + this.span;
    const view = W * this.msPerPx;
    if (view >= t1 - t0) { this.viewStart = t0 - (view - (t1 - t0)) / 2; return; }
    this.viewStart = Math.min(t1 - view, Math.max(t0, this.viewStart));
  }
  /** Screen x (px from the canvas' left edge) of a time, and back. */
  _x(t) { const x = (t - this.viewStart) / this.msPerPx; return this.flip ? this.W - x : x; }
  _t(px) { const x = this.flip ? this.W - px : px; return this.viewStart + x * this.msPerPx; }
  _px(e) { return e.clientX - this.c.getBoundingClientRect().left; }

  _down(e) {
    this.c.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, this._px(e));
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = { mode: 'pinch', dist: Math.max(20, Math.abs(a - b)) };
      return;
    }
    const px = this._px(e);
    const near = Math.abs(px - this._x(this.cursor)) < 28;
    this.drag = { mode: near ? 'cursor' : 'pan', last: px, moved: 0 };
    if (near) this._setCursor(this._t(px));
  }
  _move(e) {
    if (!this.pointers.has(e.pointerId) || !this.drag) return;
    const px = this._px(e);
    this.pointers.set(e.pointerId, px);
    const d = this.drag;
    if (d.mode === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.max(20, Math.abs(a - b));
      this._zoomAt(d.dist / dist, (a + b) / 2);
      d.dist = dist;
      return;
    }
    if (d.mode === 'cursor') { this._setCursor(this._t(px)); return; }
    const dx = px - d.last;
    d.moved += Math.abs(dx);
    d.last = px;
    this.viewStart -= (this.flip ? -dx : dx) * this.msPerPx;
    this._clamp();
    this.draw();
  }
  _up(e) {
    const d = this.drag;
    this.pointers.delete(e.pointerId);
    if (d && d.mode === 'pan' && d.moved < 6 && e.type === 'pointerup') this._setCursor(this._t(this._px(e)));
    if (!this.pointers.size) this.drag = null;
    else if (d?.mode === 'pinch') this.drag = { mode: 'pan', last: [...this.pointers.values()][0], moved: 99 };
  }
  _setCursor(t) {
    if (!this.pic) return;
    const t0 = this.pic.t0;
    this.cursor = Math.min(t0 + this.span, Math.max(t0, t));
    this.draw();
    this.onCursor(this.cursor);
  }

  draw() {
    const c = this.c, g = this.g, dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    const W = r.width, H = r.height;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = this.colors.bg;
    g.fillRect(0, 0, W, H);
    const pic = this.pic;
    if (!pic) return;
    this._clamp();
    const plotH = H - AXIS;
    const pxPerCol = pic.stepMs / this.msPerPx;

    // picture: column k shows time t0 + k*step; its centre sits on that time
    g.save();
    if (this.flip) { g.translate(W, 0); g.scale(-1, 1); }
    g.imageSmoothingEnabled = true; // blends neighbouring columns when zoomed in
    g.imageSmoothingQuality = 'high';
    const xs = (pic.t0 - this.viewStart) / this.msPerPx - pxPerCol / 2;
    g.drawImage(pic.bitmap, 0, 0, pic.width, pic.height, xs, 0, pic.width * pxPerCol, plotH);
    g.restore();

    // inner edge of the track (start of the neutral zone): thin dashed guide
    if (pic.rowInner > 0) {
      const y = Math.round((pic.rowInner / pic.height) * plotH) + 0.5;
      g.strokeStyle = 'rgba(62,155,255,.55)'; g.lineWidth = 1; g.setLineDash([4, 6]);
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      g.setLineDash([]);
    }

    // detected crossing (0)
    const x0 = Math.round(this._x(0)) + 0.5;
    g.strokeStyle = this.colors.amber; g.lineWidth = 1.5; g.setLineDash([6, 5]);
    g.beginPath(); g.moveTo(x0, 0); g.lineTo(x0, plotH); g.stroke();
    g.setLineDash([]);

    // axis
    g.fillStyle = '#0a1622';
    g.fillRect(0, plotH, W, AXIS);
    // real frames: short ticks where each camera frame was taken
    const frameGap = pic.frames.length > 1 ? (pic.frames[1] - pic.frames[0]) / this.msPerPx : 0;
    if (frameGap >= 4) {
      g.strokeStyle = 'rgba(159,179,198,.55)'; g.lineWidth = 1;
      g.beginPath();
      for (const f of pic.frames) {
        const x = Math.round(this._x(pic.t0 + f)) + 0.5;
        if (x < -2 || x > W + 2) continue;
        g.moveTo(x, plotH); g.lineTo(x, plotH + 5);
      }
      g.stroke();
    }
    const step = tickStep(this.msPerPx);
    const dec = step < 100 ? 2 : 1;
    const tFrom = Math.min(this._t(0), this._t(W)), tTo = Math.max(this._t(0), this._t(W));
    g.font = '600 12px ui-monospace, "SF Mono", "Roboto Mono", Menlo, monospace';
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.strokeStyle = this.colors.muted; g.fillStyle = this.colors.muted; g.lineWidth = 1;
    for (let t = Math.ceil(tFrom / step) * step; t <= tTo; t += step) {
      const x = Math.round(this._x(t)) + 0.5;
      g.beginPath(); g.moveTo(x, plotH); g.lineTo(x, plotH + 10); g.stroke();
      const s = t === 0 ? '0' : `${t > 0 ? '+' : '−'}${(Math.abs(t) / 1000).toFixed(dec)}`;
      g.fillText(s, x, plotH + 13);
    }

    // cursor
    const xc = Math.round(this._x(this.cursor)) + 0.5;
    g.strokeStyle = 'rgba(5,11,17,.8)'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(xc, 0); g.lineTo(xc, plotH); g.stroke();
    g.strokeStyle = this.colors.text; g.lineWidth = 2;
    g.beginPath(); g.moveTo(xc, 0); g.lineTo(xc, plotH); g.stroke();
    g.fillStyle = this.colors.text;
    g.beginPath(); g.arc(xc, plotH - 14, 10, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0a1622';
    g.beginPath(); g.moveTo(xc - 4, plotH - 14); g.lineTo(xc - 1, plotH - 17); g.lineTo(xc - 1, plotH - 11); g.fill();
    g.beginPath(); g.moveTo(xc + 4, plotH - 14); g.lineTo(xc + 1, plotH - 17); g.lineTo(xc + 1, plotH - 11); g.fill();
  }
}
