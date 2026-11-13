// Record + log mode: films the finish line while timing and keeps a log of
// everything the detector did, so a session at the track can be replayed and
// tuned at home.
//
// Video is cut into parts (10 minutes by default) so each file stays a
// sensible size to share. Every few seconds the recorder hands over a chunk,
// which goes straight into IndexedDB: if the page crashes or the phone locks,
// what was recorded so far is still there under Settings -> Recordings.

const DB_NAME = 'tracktime-rec';
const DB_VERSION = 1;

export const REC_DEFAULTS = {
  partMinutes: 10,
  videoBitsPerSecond: 2_500_000, // about 19 MB a minute
  chunkMs: 4000,
};

/**
 * First format the browser can record. H.264 MP4 first: it plays everywhere,
 * including Windows and the iPhone Photos app. Plain types let the browser
 * choose codecs itself.
 */
export function pickMimeType(isTypeSupported, withAudio = false) {
  const candidates = [
    withAudio ? 'video/mp4;codecs=avc1,mp4a.40.2' : 'video/mp4;codecs=avc1',
    ...(withAudio ? ['video/mp4;codecs=avc1,opus'] : []),
    'video/mp4',                         // Safari, recent Chrome
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const t of candidates) {
    try { if (isTypeSupported(t)) return t; } catch { /* ignored */ }
  }
  return '';
}

export function extensionFor(mimeType) {
  return /mp4/.test(mimeType) ? 'mp4' : 'webm';
}

/** "2026-11-14_0812" in local time, for file names. */
export function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`;
}

/** Works out which video part (and where in it) a session time falls. */
export function locate(parts, ms) {
  let found = null;
  for (const p of parts) if (p.startMs <= ms) found = p;
  if (!found) return { part: null, partTime: null };
  return { part: found.n, partTime: (ms - found.startMs) / 1000 };
}

/** CSV of the log's events, one row each, with the video part and time inside it. */
export function logToCsv(log, parts) {
  const cols = ['session_s', 'part', 'part_time_s', 'event', 'lap', 'lap_s', 'since_s', 'detail'];
  const rows = [cols.join(',')];
  const q = (v) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  for (const e of log.events) {
    if (e.type === 'second') continue; // per-second stats stay in the JSON
    const { part, partTime } = locate(parts, e.ms);
    rows.push([
      (e.ms / 1000).toFixed(3), part ?? '', partTime === null ? '' : partTime.toFixed(3), e.type,
      e.lap ?? '', e.lapMs === undefined ? '' : (e.lapMs / 1000).toFixed(3),
      e.sinceMs === undefined ? '' : (e.sinceMs / 1000).toFixed(3), e.detail ?? '',
    ].map(q).join(','));
  }
  return rows.join('\n') + '\n';
}

// ---------- IndexedDB ----------
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('No IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}
function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  saveSession: (rec) => tx('sessions', 'readwrite', (s) => { s.put(rec); }),
  putChunk: (id, part, idx, blob) => tx('chunks', 'readwrite', (s) => { s.put(blob, [id, part, idx]); }),
  listSessions: () => tx('sessions', 'readonly', (s) => reqP(s.getAll())),
  partBlob: (id, part, type) => tx('chunks', 'readonly', (s) => reqP(
    s.getAll(IDBKeyRange.bound([id, part, 0], [id, part, Number.MAX_SAFE_INTEGER])),
  )).then((blobs) => new Blob(blobs, { type })),
  deleteSession: (id) => openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(['sessions', 'chunks'], 'readwrite');
    t.objectStore('sessions').delete(id);
    t.objectStore('chunks').delete(IDBKeyRange.bound([id, 0, 0], [id, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  })),
};

// ---------- the recorder ----------
export class SessionRecorder {
  /**
   * @param {MediaStream} stream camera (and optional microphone) stream
   * @param {object} info anything worth keeping about the setup (settings, camera, device)
   */
  constructor(stream, info = {}, opts = {}) {
    this.stream = stream;
    this.opts = { ...REC_DEFAULTS, ...opts };
    this.mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t), stream.getAudioTracks().length > 0);
    const started = new Date();
    this.id = `rec-${started.getTime()}`;
    this.rec = {
      id: this.id,
      name: `tracktime-${stamp(started)}`,
      startedAt: started.toISOString(),
      endedAt: null,
      mimeType: this.mimeType,
      ext: extensionFor(this.mimeType),
      parts: [],        // {n, startMs, endMs, bytes, chunks}
      setupJpeg: null,  // Blob
      log: { app: 'TrackTime', version: 1, info, events: [] },
      problems: [],
    };
    this.t0 = performance.now();
    this.active = null;   // current MediaRecorder
    this.partN = 0;
    this.stopping = false;
    this.bytes = 0;
    this.saveTimer = null;
    this.pending = Promise.resolve(); // keeps chunk writes in order
    this.memoryOnly = false;
    this.memChunks = new Map();       // fallback when IndexedDB fails: "part" -> Blob[]
    this.onchange = null;
  }

  /** Milliseconds since the session (and the first video part) started. */
  now() { return performance.now() - this.t0; }

  async start() {
    try { await navigator.storage?.persist?.(); } catch { /* ignored */ }
    try { await store.saveSession(this.rec); } catch (e) { this._problem(`storage: ${e?.message || e}`); this.memoryOnly = true; }
    this.t0 = performance.now();
    this._startPart();
    this.partTimer = setInterval(() => this._rotate(), this.opts.partMinutes * 60_000);
  }

  log(type, fields = {}) {
    this.rec.log.events.push({ ms: Math.round(this.now()), type, ...fields });
    this._scheduleSave();
  }

  setSetupImage(blob) { this.rec.setupJpeg = blob; this._scheduleSave(); }

  _startPart() {
    const n = ++this.partN;
    let mr;
    try {
      mr = new MediaRecorder(this.stream, {
        ...(this.mimeType ? { mimeType: this.mimeType } : {}),
        videoBitsPerSecond: this.opts.videoBitsPerSecond,
      });
    } catch (e) {
      this._problem(`recorder: ${e?.message || e}`);
      return null;
    }
    if (!this.mimeType && mr.mimeType) {
      this.mimeType = this.rec.mimeType = mr.mimeType;
      this.rec.ext = extensionFor(mr.mimeType);
    }
    const part = { n, startMs: Math.round(this.now()), endMs: null, bytes: 0, chunks: 0 };
    this.rec.parts.push(part);
    let idx = 0;
    mr.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      const i = idx++;
      part.bytes += ev.data.size; part.chunks = idx; this.bytes += ev.data.size;
      this._writeChunk(n, i, ev.data);
      this.onchange?.();
    };
    mr.onstart = () => { part.startMs = Math.round(this.now()); };
    mr.onerror = (ev) => this._problem(`part ${n}: ${ev?.error?.name || 'recorder error'}`);
    mr.onstop = () => {
      part.endMs = Math.round(this.now());
      this._scheduleSave(0);
      // Stopped by the browser (camera lost, app in background): carry on if we can.
      if (this.active === mr && !this.stopping) {
        this.active = null;
        this.log('video-interrupted', { detail: `part ${n}` });
        if (this.stream.getVideoTracks().some((t) => t.readyState === 'live')) this._startPart();
      }
      mr._done?.();
    };
    mr._stopped = new Promise((r) => { mr._done = r; });
    try { mr.start(this.opts.chunkMs); } catch (e) { this._problem(`start: ${e?.message || e}`); this.rec.parts.pop(); return null; }
    this.active = mr;
    this._scheduleSave();
    return mr;
  }

  /** Starts the next part before stopping this one, so no frames are lost in between. */
  _rotate() {
    const old = this.active;
    if (!old || this.stopping) return;
    this.active = null;
    const next = this._startPart();
    if (!next) { this.active = old; return; }
    try { old.stop(); } catch { /* ignored */ }
  }

  _writeChunk(part, idx, blob) {
    if (this.memoryOnly) { this._memKeep(part, blob); return; }
    this.pending = this.pending
      .then(() => store.putChunk(this.id, part, idx, blob))
      .catch((e) => {
        this._problem(`saving video failed (${e?.name || e}); keeping the rest in memory`);
        this.memoryOnly = true;
        this._memKeep(part, blob);
      });
  }
  _memKeep(part, blob) {
    if (!this.memChunks.has(part)) this.memChunks.set(part, []);
    this.memChunks.get(part).push(blob);
  }

  _problem(msg) {
    this.rec.problems.push({ ms: Math.round(this.now()), msg });
    this.rec.log.events.push({ ms: Math.round(this.now()), type: 'problem', detail: msg });
    this.onchange?.();
    this._scheduleSave();
  }

  _scheduleSave(delay = 2000) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), delay);
  }
  flush() {
    clearTimeout(this.saveTimer);
    if (this.memoryOnly && !this.rec.parts.length) return Promise.resolve();
    return store.saveSession(this.rec).catch(() => {});
  }

  /** Stops recording and resolves with the finished session record. */
  async stop() {
    this.stopping = true;
    clearInterval(this.partTimer);
    const mr = this.active;
    this.active = null;
    if (mr && mr.state !== 'inactive') {
      try { mr.stop(); } catch { /* ignored */ }
      await Promise.race([mr._stopped, new Promise((r) => setTimeout(r, 4000))]);
    }
    await this.pending;
    this.rec.endedAt = new Date().toISOString();
    this.log('end');
    await this.flush();
    return this.rec;
  }

  get recording() { return !!this.active; }
}

// ---------- turning a stored session into files ----------
/** Builds File objects for a session: video parts, JSON log, CSV, setup photo. */
export async function sessionFiles(rec, memChunks = null) {
  const files = [];
  const type = rec.mimeType || 'video/mp4';
  for (const p of rec.parts) {
    let blob;
    const mem = memChunks?.get(p.n);
    try {
      blob = await store.partBlob(rec.id, p.n, type);
      if (mem?.length) blob = new Blob([blob, ...mem], { type });
    } catch {
      blob = new Blob(mem || [], { type });
    }
    if (!blob.size) continue;
    files.push(new File([blob], `${rec.name}-part${p.n}.${rec.ext}`, { type }));
  }
  const json = JSON.stringify({ ...rec.log, id: rec.id, startedAt: rec.startedAt, endedAt: rec.endedAt, mimeType: rec.mimeType, parts: rec.parts, problems: rec.problems }, null, 1);
  files.push(new File([json], `${rec.name}-log.json`, { type: 'application/json' }));
  files.push(new File([logToCsv(rec.log, rec.parts)], `${rec.name}-events.csv`, { type: 'text/csv' }));
  if (rec.setupJpeg) files.push(new File([rec.setupJpeg], `${rec.name}-setup.jpg`, { type: 'image/jpeg' }));
  return files;
}

/** Shares files with the phone's share sheet, or downloads them. Call straight from a tap. */
export function shareOrDownload(files) {
  const list = Array.isArray(files) ? files : [files];
  if (navigator.canShare && navigator.share) {
    let ok = false;
    try { ok = navigator.canShare({ files: list }); } catch { ok = false; }
    if (ok) {
      return navigator.share({ files: list }).then(() => 'shared', (e) => {
        if (e && e.name === 'AbortError') return 'cancelled';
        list.forEach(download);
        return 'downloaded';
      });
    }
  }
  list.forEach(download);
  return Promise.resolve('downloaded');
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function formatBytes(n) {
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} KB`;
  if (n < 1e9) return `${Math.round(n / 1e6)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}
