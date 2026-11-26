// What the coach says for each clip comes from calls.txt (one line per clip,
// "37 = три сім"), written the way she pronounces it, dialect included.
//
// She calls a lap as units + tenths, without the tens: 23.7 is "три сім".
// Clip "37" is the whole call for any lap ending in 3.7 (13.7, 23.7, 1:03.7).

import fs from 'node:fs';

export const NAMES = [...Array(100).keys()].map((n) => String(n).padStart(2, '0'))
  .concat(['start', 'plus', 'minus', 'nextblock']);

const FILE = new URL('./calls.txt', import.meta.url);

/** Parse calls.txt text into [{ name, text }] in NAMES order. Throws on a missing, unknown or doubled name. */
export function parseCalls(source) {
  const texts = new Map();
  source.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error(`calls.txt line ${i + 1}: expected "name = text", got "${line}"`);
    const name = line.slice(0, eq).trim();
    const text = line.slice(eq + 1).trim();
    if (!NAMES.includes(name)) throw new Error(`calls.txt line ${i + 1}: unknown clip "${name}"`);
    if (texts.has(name)) throw new Error(`calls.txt line ${i + 1}: "${name}" is there twice`);
    if (!text) throw new Error(`calls.txt line ${i + 1}: "${name}" has no text`);
    texts.set(name, text);
  });
  const missing = NAMES.filter((n) => !texts.has(n));
  if (missing.length) throw new Error(`calls.txt is missing: ${missing.join(' ')}`);
  return NAMES.map((name) => ({ name, text: texts.get(name) }));
}

/** Every clip to generate, from calls.txt: 00..99, then the words. */
export function allClips() {
  return parseCalls(fs.readFileSync(FILE, 'utf8'));
}

/** One clip: 37 -> { name: "37", text: <its line in calls.txt> }. */
export function call(n) {
  const name = String(n).padStart(2, '0');
  return allClips().find((c) => c.name === name);
}
