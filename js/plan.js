// Pacemaker session plans: reading the plan from the link and working out
// where the riders are in it. No browser APIs (like detector.js), so it can be
// tested in Node.
//
// Pacemaker opens TrackTime as <TrackTime URL>/#pm=<base64url of JSON>:
//   { v: 1, id, name, api, blocks: [ { kind: 'ride'|'rest', min | laps,
//     where: 'red'|'blue'|'any', target | from + to }, … ] }
// The plan clock starts at the first crossing, the same moment as the lap
// clock. Time blocks ("min") end on that clock; lap blocks ("laps") end at the
// crossing that completes their last lap. A lap longer than twice the current
// target is a break (rest, or riders off on the apron): it is not scored and
// does not count towards a lap block.

export const DEFAULT_API = 'https://pacemaker-theta.vercel.app';

const WHERE_TEXT = { red: 'Under red', blue: 'Under blue', any: 'Any line' };

/**
 * Reads a plan from a location hash such as "#pm=eyJ2Ijox…".
 * Returns null when the hash has no plan, { plan } when it parsed, or
 * { error } with a short note for the person when it did not.
 */
export function planFromHash(hash) {
  if (!hash || typeof hash !== 'string') return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (!params.has('pm')) return null;
  const raw = (params.get('pm') || '').replace(/ /g, '+');
  let obj;
  try {
    obj = JSON.parse(decodeBase64Url(raw));
  } catch {
    return { error: 'The plan in this link could not be read, so timing works without a plan.' };
  }
  return parsePlan(obj);
}

/** Checks a plan object and keeps only the fields TrackTime uses. */
export function parsePlan(obj) {
  const bad = (why) => ({ error: `The plan in this link ${why}, so timing works without a plan.` });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return bad('could not be read');
  if (obj.v !== undefined && obj.v !== 1) return bad('is from a newer Pacemaker');
  if (!Array.isArray(obj.blocks) || obj.blocks.length === 0) return bad('has no blocks');
  const blocks = [];
  for (const b of obj.blocks) {
    const block = parseBlock(b);
    if (!block) return bad('has a block without a length');
    blocks.push(block);
  }
  return {
    plan: {
      v: 1,
      id: typeof obj.id === 'string' && obj.id ? obj.id.slice(0, 100) : null,
      name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 80) : 'Plan',
      api: cleanApi(obj.api) || DEFAULT_API,
      blocks,
    },
  };
}

function parseBlock(b) {
  if (!b || typeof b !== 'object') return null;
  const pos = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;
  const block = { kind: b.kind === 'rest' ? 'rest' : 'ride' };
  if (pos(b.min)) block.min = b.min;
  else if (pos(b.laps) && Number.isInteger(b.laps)) block.laps = b.laps;
  else return null;
  if (block.kind === 'ride') {
    block.where = WHERE_TEXT[b.where] ? b.where : 'any';
    if (pos(b.from) && pos(b.to)) { block.from = b.from; block.to = b.to; } else if (pos(b.target)) block.target = b.target;
  }
  return block;
}

/** Only http(s) addresses, without a trailing slash. */
export function cleanApi(api) {
  if (typeof api !== 'string') return null;
  try {
    const u = new URL(api);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.href.replace(/\/+$/, '');
  } catch { return null; }
}

function decodeBase64Url(s) {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The opposite of planFromHash, for tests and for making links by hand. */
export function planToHash(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `#pm=${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** Target lap time in seconds at fraction f (0..1) through a block, or null. */
export function targetAt(block, f = 0) {
  if (!block || block.kind !== 'ride') return null;
  if (block.from !== undefined) {
    const k = Math.min(1, Math.max(0, f));
    return block.from + (block.to - block.from) * k;
  }
  return block.target ?? null;
}

const blockMs = (b) => b.min * 60000;

/**
 * Where the session is in the plan.
 *   laps: [{ ms, t }] where t is ms on the plan clock (since the first
 *         crossing) at the crossing that ends the lap.
 *   now:  plan-clock ms now, or null before the first crossing.
 * Returns the current block and, for every lap, its block, target, gap,
 * colour band and whether it was a break.
 */
export function planProgress(plan, laps = [], now = null) {
  const blocks = plan.blocks;
  let i = 0, start = 0, count = 0;
  const advanceTo = (t) => {
    while (i < blocks.length && blocks[i].min !== undefined && t >= start + blockMs(blocks[i])) {
      start += blockMs(blocks[i]);
      i++;
      count = 0;
    }
  };
  const results = [];
  for (const lap of laps) {
    advanceTo(lap.t);
    const block = blocks[i] ?? null;
    let target = null;
    if (block) {
      let f;
      if (block.min !== undefined) f = (lap.t - lap.ms / 2 - start) / blockMs(block); // middle of the lap
      else f = block.laps > 1 ? count / (block.laps - 1) : 0;
      target = targetAt(block, f);
    }
    const isBreak = !!block && (block.kind === 'rest' || (target !== null && lap.ms > 2 * target * 1000));
    const gap = target !== null && !isBreak ? lap.ms / 1000 - target : null;
    results.push({ block: block ? i : null, target, gap, band: gap === null ? null : gapBand(gap), break: isBreak });
    if (block && block.laps !== undefined && !isBreak) {
      count++;
      if (count >= block.laps) { i++; start = lap.t; count = 0; }
    }
  }
  if (now !== null) advanceTo(now);
  const block = blocks[i] ?? null;
  let target = null, leftMs = null, leftLaps = null;
  if (block) {
    if (block.min !== undefined) {
      const t = now === null ? start : Math.max(start, now);
      leftMs = start + blockMs(block) - t;
      target = targetAt(block, (t - start) / blockMs(block));
    } else {
      leftLaps = block.laps - count;
      target = targetAt(block, block.laps > 1 ? count / (block.laps - 1) : 0);
    }
  }
  return {
    index: i, total: blocks.length, done: i >= blocks.length, block, next: blocks[i + 1] ?? null,
    started: now !== null, blockStart: start, lapsInBlock: count, target, leftMs, leftLaps, results,
  };
}

/**
 * Colour band for a lap's gap to target (seconds, lap minus target):
 * within ±0.3 good, 0.3–0.8 slow, over 0.8 veryslow, over 0.3 fast fast.
 */
export function gapBand(gap) {
  const g = Math.round(gap * 1000) / 1000; // ignore float noise at the edges
  if (g < -0.3) return 'fast';
  if (g <= 0.3) return 'good';
  if (g <= 0.8) return 'slow';
  return 'veryslow';
}

/** "Under blue · 24.0 s", "Under red · 23.0 → 20.0 s", "Rest". */
export function describeBlock(block, target = null) {
  if (!block) return '';
  if (block.kind === 'rest') return 'Rest';
  const where = WHERE_TEXT[block.where] || WHERE_TEXT.any;
  if (target !== null && block.from !== undefined) return `${where} · ${target.toFixed(1)} s`;
  if (block.from !== undefined) return `${where} · ${block.from.toFixed(1)} → ${block.to.toFixed(1)} s`;
  if (block.target !== undefined) return `${where} · ${block.target.toFixed(1)} s`;
  return where;
}

/** "10 min", "8 laps". */
export function blockLength(block) {
  if (!block) return '';
  if (block.min !== undefined) return `${block.min} min`;
  return `${block.laps} ${block.laps === 1 ? 'lap' : 'laps'}`;
}

/** "9:58" for ms left. */
export function formatClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The lines shown on the plan strip. */
export function stripText(plan, p) {
  if (p.done) return { block: 'Plan done', left: '', next: '' };
  const blockLine = `Block ${p.index + 1} of ${p.total} · ${describeBlock(p.block, p.block.from !== undefined && p.started ? p.target : null)}`;
  let left;
  if (p.leftMs !== null) left = `${formatClock(p.leftMs)} left`;
  else left = `${p.leftLaps} ${p.leftLaps === 1 ? 'lap' : 'laps'} left`;
  if (!p.started) left += ' · starts at the first crossing';
  const next = p.next ? `Next: ${describeBlock(p.next)} · ${blockLength(p.next)}` : 'Last block';
  return { block: blockLine, left, next };
}
