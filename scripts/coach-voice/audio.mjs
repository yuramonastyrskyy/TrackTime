// Plain-JS clip shaping for the generated coach calls (no ffmpeg needed).
// Input and output are 16-bit mono PCM at RATE.

export const RATE = 24000;

const WINDOW = Math.round(RATE * 0.01); // 10 ms
const THRESHOLD = 10 ** (-45 / 20); // -45 dBFS counts as sound
const MARGIN = Math.round(RATE * 0.02); // keep 20 ms around the sound
const FADE = Math.round(RATE * 0.005); // 5 ms fades, so the cut doesn't click
const LEAD_IN = Math.round(RATE * 0.06); // 60 ms of silence for a waking speaker
const TARGET_RMS = 10 ** (-18 / 20);
const MAX_PEAK = 10 ** (-1 / 20);

/** Trim silence off both ends, level the loudness, fade the edges and add the lead-in. */
export function shape(pcm) {
  const x = Float32Array.from(pcm, (v) => v / 32768);
  const loud = (i) => {
    let s = 0;
    const end = Math.min(i + WINDOW, x.length);
    for (let j = i; j < end; j++) s += x[j] * x[j];
    return Math.sqrt(s / Math.max(1, end - i)) > THRESHOLD;
  };
  let start = 0;
  while (start < x.length && !loud(start)) start += WINDOW;
  let end = x.length;
  while (end > start && !loud(Math.max(start, end - WINDOW))) end -= WINDOW;
  if (start >= end) return new Int16Array(LEAD_IN); // nothing but silence
  start = Math.max(0, start - MARGIN);
  end = Math.min(x.length, end + MARGIN);
  const y = x.slice(start, end);

  let sum = 0;
  let peak = 0;
  for (const v of y) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
  const rms = Math.sqrt(sum / y.length);
  const gain = Math.min(TARGET_RMS / Math.max(rms, 1e-6), MAX_PEAK / Math.max(peak, 1e-6));

  const out = new Int16Array(LEAD_IN + y.length);
  for (let i = 0; i < y.length; i++) {
    const fade = Math.min(1, i / FADE, (y.length - 1 - i) / FADE);
    out[LEAD_IN + i] = Math.round(Math.max(-1, Math.min(1, y[i] * gain * fade)) * 32767);
  }
  return out;
}

/** A WAV file (Buffer) for 16-bit mono PCM at RATE. */
export function wav(pcm) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
