// Generates the coach's lap calls with an ElevenLabs clone of her voice.
//
// The API key comes from ELEVENLABS_API_KEY, or else from the macOS Keychain
// (never commit it). To store it there once (it asks for the key, hidden):
//   security add-generic-password -a "$USER" -s tracktime-elevenlabs -w
//
//   node scripts/coach-voice/generate.mjs --check     (test the key, show the plan and credits left)
//   node scripts/coach-voice/generate.mjs --sample ~/path/1116.MP3
//   node scripts/coach-voice/generate.mjs --only 26,37,start   (redo some clips)
//   node scripts/coach-voice/generate.mjs --install            (copy approved clips into audio/coach/)
//
// Clips go to scripts/coach-voice/out/ (not committed) first. Listen to them on
// http://localhost:8080/scripts/coach-voice/review.html, redo bad ones with
// --only, then --install. Needs Node 18+ and macOS (afconvert makes the AAC).
//
// Options: --model eleven_v4 (default; v3 also follows the tags), --stability 0.5,
// --similarity 0.85, --force (regenerate clips that already exist),
// --new-voice (clone again from --sample instead of reusing the saved voice).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allClips } from './calls.mjs';
import { RATE, shape, wav } from './audio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out');
const RAW = path.join(OUT, 'raw');
const VOICE_FILE = path.join(OUT, 'voice.json');
const API = 'https://api.elevenlabs.io/v1';
const KEYCHAIN_SERVICE = 'tracktime-elevenlabs';

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(RAW, { recursive: true });

if (args.install) install();
else if (args.check) await check();
else if (args.process) processRaw();
else await generate();

// The key, from the environment or the Keychain. It is never printed.
function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  try {
    return execFileSync('security', ['find-generic-password', '-a', process.env.USER, '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    fail(`No ElevenLabs key found. Store it in the Keychain (it asks for the key, hidden):\n  security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`);
  }
}

async function check() {
  const key = apiKey();
  const res = await fetch(`${API}/user/subscription`, { headers: { 'xi-api-key': key } });
  if (res.status === 401) fail('ElevenLabs rejected the key (401). Check it was copied in full, or create a new one.');
  if (!res.ok) fail(`ElevenLabs answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const s = await res.json();
  const left = s.character_limit - s.character_count;
  const need = allClips().reduce((n, c) => n + c.text.length, 0);
  console.log(`Key works. Plan: ${s.tier}. Characters left this period: ${left} of ${s.character_limit}.`);
  console.log(`Generating every clip once uses about ${need} characters.`);
  console.log(s.can_use_instant_voice_cloning ? 'Voice cloning: allowed.' : 'Voice cloning: NOT allowed on this plan. Upgrade to Starter or above before cloning.');
}

function parseArgs(list) {
  // eleven_v4 follows the [loud][fast][screaming] tags in calls.txt; eleven_multilingual_v2 would read them out.
  const out = { model: 'eleven_v4', stability: 0.5, similarity: 0.85 };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

async function generate() {
  const key = apiKey();
  checkAfconvert();

  const voiceId = await getVoice(key);
  const only = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim())) : null;
  const todo = allClips().filter((c) => (only ? only.has(c.name) : args.force || !fs.existsSync(path.join(OUT, `${c.name}.m4a`))));
  if (only) for (const n of only) if (!todo.some((c) => c.name === n)) fail(`Unknown clip "${n}". Names are 00..99, start, plus, minus, nextblock.`);
  console.log(`${todo.length} clip(s) to generate with voice ${voiceId}, model ${args.model}.`);

  let done = 0;
  const failed = [];
  await pool(todo, 3, async (clip) => {
    try {
      const pcm = await speak(key, voiceId, clip.text);
      fs.writeFileSync(path.join(RAW, `${clip.name}.wav`), wav(pcm));
      toClip(pcm, path.join(OUT, `${clip.name}.m4a`));
      done++;
      console.log(`  ${clip.name.padEnd(9)} ${clip.text}`);
    } catch (e) {
      failed.push(clip.name);
      console.error(`  ${clip.name.padEnd(9)} FAILED: ${e.message}`);
    }
  });
  writeIndex();
  console.log(`\nDone: ${done} generated${failed.length ? `, ${failed.length} failed (${failed.join(',')}): run again with --only ${failed.join(',')}` : ''}.`);
  console.log('Listen: http://localhost:8080/scripts/coach-voice/review.html');
}

async function getVoice(key) {
  if (fs.existsSync(VOICE_FILE) && !args.newVoice) return JSON.parse(fs.readFileSync(VOICE_FILE, 'utf8')).voiceId;
  if (typeof args.sample !== 'string') fail('No saved voice yet: pass --sample <recording of the coach> to clone it.');
  const sample = args.sample.replace(/^~(?=\/)/, process.env.HOME);
  if (!fs.existsSync(sample)) fail(`Sample not found: ${sample}`);

  const form = new FormData();
  form.append('name', 'TrackTime coach');
  form.append('description', 'Velodrome coach calling lap times (Ukrainian). Cloned with her consent for TrackTime.');
  form.append('remove_background_noise', 'true');
  form.append('files', new Blob([fs.readFileSync(sample)]), path.basename(sample));
  const res = await fetch(`${API}/voices/add`, { method: 'POST', headers: { 'xi-api-key': key }, body: form });
  if (!res.ok) fail(`Cloning the voice failed: ${res.status} ${await res.text()}`);
  const { voice_id: voiceId } = await res.json();
  fs.writeFileSync(VOICE_FILE, JSON.stringify({ voiceId, sample: path.basename(sample), created: new Date().toISOString() }, null, 2));
  console.log(`Cloned the coach's voice from ${path.basename(sample)} (voice ${voiceId}).`);
  return voiceId;
}

async function speak(key, voiceId, text) {
  const body = JSON.stringify({
    text,
    model_id: args.model,
    voice_settings: { stability: Number(args.stability), similarity_boost: Number(args.similarity), style: 0, use_speaker_boost: true },
  });
  for (let attempt = 1; ; attempt++) {
    // Raw 16-bit mono PCM, so the clip can be trimmed and levelled here.
    const res = await fetch(`${API}/text-to-speech/${voiceId}?output_format=pcm_${RATE}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) { const b = Buffer.from(await res.arrayBuffer()); return new Int16Array(b.buffer, b.byteOffset, b.length >> 1); }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(2000 * attempt); continue; }
    throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

// Mono AAC like the other clips: trimmed, levelled and given a short lead-in
// (see audio.mjs), then encoded by macOS's own afconvert.
function toClip(pcm, output) {
  const tmp = `${output}.tmp.wav`;
  fs.writeFileSync(tmp, wav(shape(pcm)));
  try { execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', '-c', '1', tmp, output]); } finally { fs.rmSync(tmp, { force: true }); }
}

// Clips made elsewhere (for example through the ElevenLabs connector in Claude):
// out/raw/<name>.mp3 (or .wav/.m4a) -> out/<name>.m4a, trimmed and levelled the same way.
function processRaw() {
  checkAfconvert();
  const names = new Set(allClips().map((c) => c.name));
  const files = fs.readdirSync(RAW).filter((f) => /\.(mp3|m4a)$/.test(f) && names.has(path.parse(f).name));
  if (!files.length) fail(`No raw clips in ${path.relative(ROOT, RAW)}/ (name them like 37.mp3 or start.mp3).`);
  for (const f of files) {
    const name = path.parse(f).name;
    const wavFile = path.join(RAW, `${name}.decoded.wav`);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', path.join(RAW, f), wavFile]);
    const b = fs.readFileSync(wavFile);
    fs.rmSync(wavFile);
    const dataAt = b.indexOf('data') + 8; // afconvert may add chunks before "data"
    toClip(new Int16Array(b.buffer.slice(b.byteOffset + dataAt, b.byteOffset + b.length - ((b.length - dataAt) % 2))), path.join(OUT, `${name}.m4a`));
    console.log(`  ${name}`);
  }
  writeIndex();
  console.log(`Processed ${files.length} clip(s). Listen: http://localhost:8080/scripts/coach-voice/review.html`);
}

function writeIndex() {
  const clips = allClips().filter((c) => fs.existsSync(path.join(OUT, `${c.name}.m4a`)));
  fs.writeFileSync(path.join(OUT, 'clips.json'), JSON.stringify(clips, null, 2));
}

function install() {
  const dest = path.join(ROOT, 'audio/coach');
  const names = allClips().map((c) => c.name).filter((n) => fs.existsSync(path.join(OUT, `${n}.m4a`)));
  if (!names.length) fail('Nothing to install: generate clips first.');
  for (const n of names) fs.copyFileSync(path.join(OUT, `${n}.m4a`), path.join(dest, `${n}.m4a`));
  console.log(`Copied ${names.length} clip(s) into audio/coach/: ${names.join(' ')}`);
  console.log('Next: add them to COACH in sw.js and bump VERSION and ?v= (see CLAUDE.md).');
}

function checkAfconvert() {
  try { execFileSync('which', ['afconvert'], { stdio: 'ignore' }); } catch { fail('afconvert not found: this script needs macOS.'); }
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => { while (queue.length) await fn(queue.shift()); }));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fail(msg) { console.error(msg); process.exit(1); }
