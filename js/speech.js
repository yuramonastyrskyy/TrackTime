// Speaks lap times. Two ways:
//  - "phone": the phone's own text-to-speech (speechSynthesis). Natural voice,
//    but missing in some in-app browsers (for example Telegram on Android).
//  - "clips": short recorded words from audio/<lang>/ played back to back with
//    Web Audio. Works everywhere once the user has tapped a button.
//  - "coach": the coach's own voice, cut from a recording (audio/coach/). She
//    calls a lap as units + tenths, dropping the tens: 23.7 -> "три сім",
//    18.0 -> "вісім нуль". aN.m4a is digit N said first, bN.m4a said second.
//    A digit with no coach clip yet falls back to the English clip.
// "auto" uses the phone voice when it has one, otherwise the clips.

export class Announcer {
  constructor({ mode = 'auto', lang = 'en-US', clipsBase = 'audio/en/', coachBase = 'audio/coach/' } = {}) {
    this.mode = mode;
    this.lang = lang;
    this.clipsBase = clipsBase;
    this.coachBase = coachBase;
    this.ctx = null;
    this.buffers = new Map();
    this.loading = null;
  }

  /** Must be called from a tap/click so phones allow sound. */
  async unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* ignored */ }
    }
    if (this.ctx) {
      // A tiny silent buffer finishes unlocking audio on iOS.
      const b = this.ctx.createBuffer(1, 1, 22050);
      const src = this.ctx.createBufferSource();
      src.buffer = b; src.connect(this.ctx.destination); src.start();
    }
    if (this.hasPhoneVoice()) {
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      } catch { /* ignored */ }
    }
    this.loading ??= this.loadClips();
    return this.loading;
  }

  hasPhoneVoice() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
  }

  usingPhoneVoice() {
    if (this.mode === 'phone') return this.hasPhoneVoice();
    if (this.mode === 'clips' || this.mode === 'coach') return false;
    if (!this.hasPhoneVoice()) return false;
    const voices = speechSynthesis.getVoices();
    // Some in-app browsers expose the API but have no voices at all.
    return voices.length === 0 ? true : voices.some((v) => v.lang && v.lang.toLowerCase().startsWith(this.lang.slice(0, 2).toLowerCase()));
  }

  async loadClips() {
    if (!this.ctx) return;
    const names = [...Array(100).keys()].map(String).concat(['point', 'minute', 'start']);
    const files = names.map((n) => [n, `${this.clipsBase}${n}.m4a`]);
    for (const n of COACH_CLIPS) files.push([`coach/${n}`, `${this.coachBase}${n}.m4a`]);
    await Promise.all(files.map(async ([key, url]) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.arrayBuffer();
        const buf = await new Promise((ok, fail) => this.ctx.decodeAudioData(data, ok, fail));
        this.buffers.set(key, buf);
      } catch { /* a missing clip is skipped */ }
    }));
  }

  sayStart() {
    this.speak('start', ['start']);
  }

  /** text is what is shown, e.g. "17.4" or "1:05.2". */
  sayLap(text) {
    if (this.mode === 'coach') { this.playClips(this.coachKeys(text)); return; }
    this.speak(text, wordsFor(text));
  }

  /** Buffer keys for the coach's call, falling back to English digits she hasn't recorded. */
  coachKeys(text) {
    const [first, second] = coachDigitsFor(text);
    const pick = (pos, d) => [`coach/${pos}${d}`, `coach/${pos === 'a' ? 'b' : 'a'}${d}`, String(d)]
      .find((k) => this.buffers.has(k)) ?? String(d);
    return [pick('a', first), pick('b', second)];
  }

  speak(text, words) {
    if (this.usingPhoneVoice()) {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = this.lang;
        u.rate = 1.1;
        speechSynthesis.speak(u);
        return;
      } catch { /* fall back to clips */ }
    }
    this.playClips(words);
  }

  playClips(words) {
    if (!this.ctx) return;
    if (this.current) this.current.forEach((s) => { try { s.stop(); } catch { /* ignored */ } });
    let t = this.ctx.currentTime + 0.03;
    this.current = [];
    for (const w of words) {
      const buf = this.buffers.get(w);
      if (!buf) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start(t);
      this.current.push(src);
      t += buf.duration + 0.02;
    }
  }
}

// Coach clip names: a0..a9 (digit said first) and b0..b9 (said second).
export const COACH_CLIPS = [...Array(10).keys()].flatMap((d) => [`a${d}`, `b${d}`]);

/** The coach's call: units digit and tenths digit. "23.7" -> [3,7]; "1:05.2" -> [5,2]; "18" -> [8,0]. */
export function coachDigitsFor(text) {
  let rest = text;
  const colon = rest.indexOf(':');
  if (colon >= 0) rest = rest.slice(colon + 1);
  const [whole, frac = ''] = rest.split('.');
  return [Number(whole) % 10, Number(frac[0] ?? 0)];
}

/** "17.4" -> ["17","point","4"]; "1:05.2" -> ["1","minute","5","point","2"]. */
export function wordsFor(text) {
  const out = [];
  let rest = text;
  const colon = rest.indexOf(':');
  if (colon >= 0) {
    out.push(String(Number(rest.slice(0, colon))), 'minute');
    rest = rest.slice(colon + 1);
  }
  const [whole, frac] = rest.split('.');
  out.push(String(Number(whole) % 100));
  if (frac) {
    out.push('point');
    for (const d of frac) out.push(d);
  }
  return out;
}
