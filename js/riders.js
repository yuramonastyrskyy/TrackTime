// Rider identification: which rider crossed the finish line, and who led
// each lap. No tags: riders are told apart by the colours of their jersey,
// legs and bike, backed up by an appearance (re-ID) vector.
//
// The Android app (TrackCameraPlugin + RiderEngine) looks at the frames around
// each lap's crossing and reports, per frame, the riders near the line with
// their features. Here, with no browser APIs (tested in Node):
//   pickCrossings  frames -> one crossing per rider (where they were closest to the line)
//   RiderBook      the riders seen so far; matches a lap's crossings to them,
//                  learns new riders, takes corrections, and says how sure it is.

export const RIDER_TUNING = {
  bandFrac: 0.125,     // crossing: rider centre within this share of the frame width from the line
  minHeight: 0.12,     // rider box at least this share of the frame height (far or tiny: not a rider)
  trackMargin: 0.06,   // ...instead the wheels must be on the track: box bottom between line top and inner end, give or take this
  maxHeight: 0.5,      // taller than this share of the frame: someone right by the camera
  needBike: false,     // blurred bikes are often missed, so a bike is not required...
  maxGapMs: 90,        // same rider in frames at most this far apart...
  maxStepFrac: 0.4,    // ...moving at most this share of the frame width per 33 ms
  colourWeight: 1,     // weights of the two features in the similarity
  regionWeights: [1, 0.8, 1.5], // colour of the upper body, legs, bike (the bike tells riders in the same kit apart)
  reidWeight: 0.5,   // re-ID counts half as much as colour (blur hurts it more)
  newRider: 0.2,       // best similarity below this: a rider not seen before
  sure: 0.5,           // best similarity at least this...
  sureMargin: 0.08,    // ...and this far ahead of the next rider: sure
  leadBeforeMs: 400,   // lap leader: first rider at most this long before the lap's crossing time...
  leadAfterMs: 1500,   // ...or this long after it
  maxSamples: 12,      // samples kept per rider (the most recent and the confirmed ones)
};

// ---------- crossings ----------

const lineXAt = (line, w, h, y) => {
  const x1 = line.top.x * w, y1 = line.top.y * h, x2 = line.inner.x * w, y2 = line.inner.y * h;
  if (Math.abs(y2 - y1) < 1e-3) return (x1 + x2) / 2;
  return x1 + ((x2 - x1) * (y - y1)) / (y2 - y1);
};

/** Is this detection a rider on the track (not a runner, a coach on the apron, or someone by the camera)? */
export function isRider(p, frame, line, tuning = RIDER_TUNING) {
  const [x1, y1, x2, y2] = p.box;
  const h = frame.h, w = frame.w;
  if (y2 - y1 < tuning.minHeight * h || y2 - y1 > tuning.maxHeight * h) return false;
  if (tuning.needBike && !p.bike) return false;
  const bottom = Math.max(y2, p.bike ? p.bike[3] : y2) / h;
  const lo = Math.min(line.top.y, line.inner.y) - tuning.trackMargin, hi = Math.max(line.top.y, line.inner.y) + tuning.trackMargin;
  if (bottom < lo || bottom > hi) return false;
  const cx = (x1 + x2) / 2;
  return Math.abs(cx - lineXAt(line, w, h, (y1 + y2) / 2)) <= tuning.bandFrac * w;
}

/**
 * Frames ({ t, w, h, people: [{ box, bike, col, emb, thumb }] }) to crossings:
 * one per rider, from the frame where the rider was closest to the line.
 * A rider shows in a few frames in a row, moving the same way; the next rider
 * in a paceline starts again on the far side of the line.
 */
export function pickCrossings(frames, line, tuning = RIDER_TUNING) {
  const dets = [];
  for (const f of [...frames].sort((a, b) => a.t - b.t)) {
    for (const p of f.people || []) {
      if (!isRider(p, f, line, tuning)) continue;
      const cx = (p.box[0] + p.box[2]) / 2;
      const lx = lineXAt(line, f.w, f.h, (p.box[1] + p.box[3]) / 2);
      dets.push({ t: f.t, w: f.w, h: f.h, cx, off: cx - lx, p, fv: f.fv || 1 });
    }
  }
  // Riding direction: the way most riders move from frame to frame.
  let dirVotes = 0;
  for (let i = 1; i < dets.length; i++) {
    const a = dets[i - 1], b = dets[i];
    if (b.t > a.t && b.t - a.t <= tuning.maxGapMs) dirVotes += Math.sign(b.cx - a.cx);
  }
  const dir = dirVotes < 0 ? -1 : 1;
  const tracks = [];
  for (const d of dets) {
    let best = null;
    for (const tr of tracks.slice(-4)) {
      const last = tr[tr.length - 1];
      const dt = d.t - last.t;
      if (dt === 0) {
        if (Math.abs(d.cx - last.cx) < 0.06 * d.w) best = tr; // same rider twice in one frame
        continue;
      }
      if (dt < 0 || dt > tuning.maxGapMs) continue;
      const step = (d.cx - last.cx) * dir;
      if (step > 0.03 * d.w && step < tuning.maxStepFrac * d.w * (dt / 33.3)) best = tr;
    }
    if (best) best.push(d); else tracks.push([d]);
  }
  return tracks.map((tr) => {
    const c = tr.reduce((a, b) => (Math.abs(b.off) < Math.abs(a.off) ? b : a));
    return { t: c.t, box: c.p.box, bike: c.p.bike, col: c.p.col, emb: c.p.emb, thumb: c.p.thumb || null, fv: c.fv };
  });
}

// ---------- maths ----------

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (a) => { const n = Math.sqrt(dot(a, a)); return n > 0 ? a.map((v) => v / n) : a.map(() => 0); };
const meanOf = (vs) => {
  const m = new Array(vs[0].length).fill(0);
  for (const v of vs) for (let i = 0; i < m.length; i++) m[i] += v[i];
  return m.map((x) => x / vs.length);
};
const sub = (a, b) => a.map((v, i) => v - b[i]);

/**
 * Minimum-cost assignment (Hungarian algorithm) for a rows x cols cost
 * matrix with rows <= cols. Returns the column of each row.
 */
export function assign(cost) {
  const n = cost.length, m = cost[0]?.length || 0;
  if (!n) return [];
  const INF = 1e18, u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) out[p[j] - 1] = j - 1;
  return out;
}

// ---------- riders ----------

/**
 * The riders of a session. Each rider keeps a few samples (colour and re-ID
 * vectors) and a picture; matching compares a crossing with the mean of each
 * rider's samples. Features are centred on the mean of everything seen in the
 * first lap that had riders, so colours every rider shares (the track, the
 * hall's light) count for little.
 */
export class RiderBook {
  constructor(tuning = RIDER_TUNING) {
    this.tuning = tuning;
    this.riders = [];   // { id, name, samples: [{ col, emb, sure }], thumb, centroid }
    this.centre = null; // { col, emb }
    this.nextId = 1;
    this.fv = null;     // colour features version (the app's RiderVision.FEATURES); riders learnt with another are dropped
  }

  /** Comparable vector of a crossing (centred, both parts scaled to length 1, weighted). */
  vec(c) {
    const t = this.tuning;
    const rw = t.regionWeights || [1, 1, 1], n = c.col.length / 3;
    const col = norm(sub(c.col, this.centre.col).map((v, i) => v * rw[Math.min(2, Math.floor(i / n))])).map((v) => v * t.colourWeight);
    const emb = c.emb && this.centre.emb ? norm(sub(c.emb, this.centre.emb)).map((v) => v * t.reidWeight) : [];
    return norm(col.concat(emb));
  }

  addRider(c, name = null) {
    const id = `r${this.nextId++}`;
    const r = { id, name: name || `Rider ${this.riders.length + 1}`, samples: [], thumb: c.thumb || null, centroid: null };
    this.riders.push(r);
    this.learn(r, c, true);
    return r;
  }

  learn(r, c, sure) {
    r.samples.push({ col: c.col, emb: c.emb, sure });
    if (r.samples.length > this.tuning.maxSamples) {
      const drop = r.samples.findIndex((s) => !s.sure);
      r.samples.splice(drop >= 0 ? drop : 0, 1);
    }
    if (!r.thumb && c.thumb) r.thumb = c.thumb;
    r.centroid = null;
  }

  centroid(r) {
    if (!r.centroid) r.centroid = norm(meanOf(r.samples.map((s) => this.vec(s))));
    return r.centroid;
  }

  /** Similarity of a crossing to every rider (same order as this.riders). */
  scores(c) {
    const v = this.vec(c);
    return this.riders.map((r) => dot(v, this.centroid(r)));
  }

  /**
   * Names the crossings of one lap. Each rider at most once per lap (a
   * rider cannot cross twice within a few seconds); a crossing too unlike
   * everyone becomes a new rider. Returns, per crossing, { rider, sim,
   * margin, sure, isNew }.
   */
  addLap(crossings) {
    if (!crossings.length) return [];
    const fv = crossings[0].fv || 1;
    if (this.fv !== fv) {
      if (this.fv !== null || this.riders.length) { this.riders = []; this.centre = null; }
      this.fv = fv;
    }
    if (!this.centre) {
      this.centre = { col: meanOf(crossings.map((c) => c.col)), emb: crossings[0].emb ? meanOf(crossings.map((c) => c.emb)) : null };
    }
    const t = this.tuning, R = this.riders.length;
    const S = crossings.map((c) => this.scores(c));
    // Columns: the known riders, then one "new rider" slot per crossing.
    const cost = S.map((row, i) => {
      const r = row.map((s) => -s);
      for (let k = 0; k < crossings.length; k++) r.push(k === i ? -t.newRider : 1e6);
      return r;
    });
    const cols = R + crossings.length;
    const pad = cost.map((r) => (r.length < cols ? r.concat(new Array(cols - r.length).fill(1e6)) : r));
    const pick = assign(pad);
    const out = crossings.map((c, i) => {
      const row = S[i];
      const sorted = [...row].sort((a, b) => b - a);
      const j = pick[i];
      if (j < R) {
        const sim = row[j];
        const others = row.filter((_, k) => k !== j);
        const margin = sim - (others.length ? Math.max(...others) : -1);
        const best = sorted[0] === sim;
        return { rider: this.riders[j], sim, margin, sure: best && sim >= t.sure && margin >= t.sureMargin, isNew: false };
      }
      return { rider: null, sim: sorted[0] ?? -1, margin: 0, sure: !R || (sorted[0] ?? -1) < t.newRider - 0.1, isNew: true };
    });
    // Learn: new riders first, then add the sure matches as samples.
    out.forEach((o, i) => {
      if (o.isNew) o.rider = this.addRider(crossings[i]);
      else if (o.sure) this.learn(o.rider, crossings[i], false);
    });
    return out.map((o) => ({ ...o, rider: o.rider.id }));
  }

  /** A correction: this crossing is rider id (or a new rider when id is null). Returns the rider. */
  correct(crossing, id) {
    let r = id ? this.riders.find((x) => x.id === id) : null;
    if (!r) r = this.addRider(crossing);
    else this.learn(r, crossing, true);
    return r;
  }

  rename(id, name) {
    const r = this.riders.find((x) => x.id === id);
    if (r) r.name = String(name || '').trim().slice(0, 30) || r.name;
  }

  byId(id) { return this.riders.find((x) => x.id === id) || null; }
}

/** Lap leader: the first rider to cross near the lap's crossing time (ms). */
export function lapLeader(lapRiders, lapT, tuning = RIDER_TUNING) {
  let best = null;
  for (const r of lapRiders) {
    if (r.t < lapT - tuning.leadBeforeMs || r.t > lapT + tuning.leadAfterMs) continue;
    if (!best || r.t < best.t) best = r;
  }
  return best;
}

// ---------- one timing session ----------

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Rider identification for one timing session. The app reports frames
 * (addFrames); each counted crossing (start = key 0, lap n = key n) has a
 * window from just before it to WINDOW_AFTER_MS after it. Once a window is
 * complete (finish), its crossings are matched to the riders in the book.
 * Corrections and names come from the review after Stop.
 */
export const WINDOW_BEFORE_MS = 500, WINDOW_AFTER_MS = 8000;

export class RiderRun {
  constructor(line, book = new RiderBook()) {
    this.line = line;
    this.book = book;
    this.windows = [];   // { key, T, frames: [], done: false, crossings: [] }
  }

  /** A counted crossing at sensor time T (ms). A repeated key (after Undo) replaces the old one. */
  addCrossing(key, T) {
    this.windows = this.windows.filter((w) => w.key !== key || w.done);
    this.windows.push({ key, T, frames: [], done: false, crossings: [] });
  }

  /** Drops a crossing (Undo). */
  dropCrossing(key) { this.windows = this.windows.filter((w) => w.key !== key); }

  addFrames(frames) {
    for (const f of frames) {
      const w = this.windows.find((x) => !x.done && f.t >= x.T - WINDOW_BEFORE_MS && f.t <= x.T + WINDOW_AFTER_MS);
      if (w) w.frames.push(f);
    }
  }

  /** Windows that ended before time `now` (ms) can be finished; returns the finished keys. */
  finishUpTo(now) {
    const keys = [];
    for (const w of [...this.windows].sort((a, b) => a.T - b.T)) {
      if (w.done || w.T + WINDOW_AFTER_MS > now) continue;
      const cr = pickCrossings(w.frames, this.line, this.book.tuning);
      const res = this.book.addLap(cr);
      w.crossings = cr.map((c, i) => ({ ...c, rider: res[i].rider, sure: res[i].sure, sim: r3(res[i].sim) }));
      w.frames = [];
      w.done = true;
      keys.push(w.key);
    }
    return keys;
  }

  finishAll() { return this.finishUpTo(Infinity); }

  window(key) { return this.windows.find((w) => w.key === key) || null; }

  /** The leader crossing of a key (not counting crossings marked "not a team rider"). */
  leader(key) {
    const w = this.window(key);
    if (!w || !w.done) return null;
    return lapLeader(w.crossings.filter((c) => c.rider !== IGNORED), w.T, this.book.tuning);
  }

  /** Review: crossing i of key is rider id, a new rider (null) or IGNORED. */
  correct(key, i, id) {
    const c = this.window(key)?.crossings[i];
    if (!c) return;
    if (id === IGNORED) { c.rider = IGNORED; c.sure = true; return; }
    c.rider = this.book.correct(c, id).id;
    c.sure = true;
  }

  /** Crossings still marked unsure, over the keys given (the laps kept). */
  unsure(keys) {
    let n = 0;
    for (const k of keys) {
      const l = this.leader(k);
      if (l && !l.sure) n++;
    }
    return n;
  }

  /**
   * What a session keeps: the riders (names, pictures) and per crossing key
   * the riders in crossing order (id, time, sure, picture, and the features
   * as Float32Arrays so a saved session can still be corrected and teach the
   * book later; see correctSaved). The payload leaves the features out.
   */
  summary(keys) {
    const laps = {};
    const used = new Set();
    for (const k of keys) {
      const w = this.window(k);
      if (!w || !w.done) continue;
      const lead = this.leader(k);
      laps[k] = {
        leader: lead ? lead.rider : null,
        sure: lead ? !!lead.sure : true,
        order: [...w.crossings].sort((a, b) => a.t - b.t).map((c) => ({ id: c.rider, t: Math.round(c.t - w.T), sure: !!c.sure, thumb: c.thumb || null, f: features(c) })),
      };
      for (const c of w.crossings) if (c.rider !== IGNORED) used.add(c.rider);
    }
    const riders = this.book.riders.filter((r) => used.has(r.id)).map((r) => ({ id: r.id, name: r.name, thumb: r.thumb }));
    return { v: 1, riders, laps };
  }
}

/** Rider id for "not a team rider" (a passer-by, a coach). */
export const IGNORED = 'x';

function features(c) {
  if (!c.col) return null;
  return { col: Float32Array.from(c.col), emb: c.emb ? Float32Array.from(c.emb) : null };
}

/**
 * Review of a session (session.riders, from RiderRun.summary): crossing i
 * (in crossing order) of `key` is rider id, a new
 * rider (null) or IGNORED. Fixes the order and the lap's leader in place, and
 * teaches the book when the crossing kept its features (sessions saved before
 * features were kept are still fixed, just not learnt from). Returns true when
 * something changed.
 */
export function correctSaved(riders, book, key, i, id) {
  const lap = riders?.laps?.[key];
  const o = lap?.order[i];
  if (!o) return false;
  if (id === IGNORED) {
    o.id = IGNORED;
  } else {
    let r;
    if (id && !book.byId(id)) {
      // A rider only this session still knows (Forget riders since): fix the session only.
      r = riders.riders.find((x) => x.id === id) || { id, name: id, thumb: o.thumb || null };
    } else if (o.f) {
      r = book.correct({ col: Array.from(o.f.col), emb: o.f.emb ? Array.from(o.f.emb) : null, thumb: o.thumb }, id);
    } else if (id) {
      r = book.byId(id);
    } else {
      // New rider without features (saved before they were kept): an id the book never gives out again.
      r = { id: `r${book.nextId++}`, name: `Rider ${riders.riders.length + 1}`, thumb: o.thumb || null };
    }
    o.id = r.id;
    if (!riders.riders.some((x) => x.id === r.id)) riders.riders.push({ id: r.id, name: r.name, thumb: r.thumb || o.thumb || null });
  }
  o.sure = true;
  const lead = lapLeader(lap.order.filter((q) => q.id !== IGNORED), 0, book.tuning);
  lap.leader = lead ? lead.id : null;
  lap.sure = lead ? !!lead.sure : true;
  // Riders nobody is left on drop out of the session's list.
  const used = new Set();
  for (const l of Object.values(riders.laps)) for (const q of l.order) used.add(q.id);
  riders.riders = riders.riders.filter((x) => used.has(x.id));
  return true;
}

/** A new name for a rider, in the session and the book. */
export function renameSaved(riders, book, id, name) {
  const clean = String(name || '').trim().slice(0, 30);
  if (!clean) return false;
  book.rename(id, clean);
  const r = riders?.riders.find((x) => x.id === id);
  if (r) r.name = clean;
  return !!r;
}

/** Laps (keys given) whose leader is still a guess. */
export function unsureLeaders(riders, keys) {
  if (!riders?.laps) return 0;
  return keys.filter((k) => riders.laps[k]?.leader && !riders.laps[k].sure).length;
}

/** The book as plain data (rounded), to keep between sessions. */
export function bookToJSON(book) {
  return {
    v: 1, nextId: book.nextId, fv: book.fv,
    centre: book.centre && { col: book.centre.col.map(r3), emb: book.centre.emb ? book.centre.emb.map(r3) : null },
    riders: book.riders.map((r) => ({
      id: r.id, name: r.name, thumb: r.thumb,
      samples: r.samples.map((s) => ({ col: s.col.map(r3), emb: s.emb ? s.emb.map(r3) : null, sure: !!s.sure })),
    })),
  };
}

export function bookFromJSON(o, tuning = RIDER_TUNING) {
  const b = new RiderBook(tuning);
  if (!o || o.v !== 1 || !Array.isArray(o.riders)) return b;
  b.nextId = Number(o.nextId) || o.riders.length + 1;
  b.fv = Number(o.fv) || 1;
  b.centre = o.centre && Array.isArray(o.centre.col) ? { col: o.centre.col, emb: o.centre.emb || null } : null;
  b.riders = o.riders.filter((r) => r && r.id && Array.isArray(r.samples) && r.samples.length).map((r) => ({
    id: String(r.id), name: String(r.name || r.id), thumb: typeof r.thumb === 'string' ? r.thumb : null, centroid: null,
    samples: r.samples.map((s) => ({ col: s.col, emb: s.emb || null, sure: !!s.sure })),
  }));
  return b;
}

/** Rider fields for the Pacemaker payload (see sessionPayload). */
export function ridersPayload(riders, keys) {
  if (!riders || !riders.laps) return null;
  const name = new Map(riders.riders.map((r) => [r.id, r.name]));
  const led = new Map();
  const laps = {};
  for (const k of keys) {
    const l = riders.laps[k];
    if (!l) continue;
    const order = l.order.filter((o) => o.id !== IGNORED).map((o) => o.id);
    laps[k] = { leader: l.leader, sure: !!l.sure, order };
    if (k > 0 && l.leader) led.set(l.leader, (led.get(l.leader) || 0) + 1);
  }
  return {
    riders: riders.riders.map((r) => ({ id: r.id, name: name.get(r.id), led: led.get(r.id) || 0 })),
    laps,
  };
}
