# Handoff: coach voice

For whoever picks up "announce lap times in the coach's voice" (and their Claude). Read `CLAUDE.md` first; this file adds only what that task needs.

## The goal

TrackTime announces each lap time over a Bluetooth speaker. Riders want to hear it in their coach's voice, the way she calls it: units + tenths, without the tens. 23.7 is "три сім", 18.0 is "вісім нуль", 21.2 is "одна дві" (feminine одна/дві). Recorded clips of her voice, not AI voice cloning.

## Where it stands (2026-11-26)

- **PR #5** ("Announce lap times in the coach's voice", branch `claude/project-thread-r9b013`) is open but **stale: about 80 commits behind `main`**, from before the UI redesign. Treat it as a reference, not something to merge. Start a fresh branch from `main` and port what's useful.
- What PR #5 has, worth porting:
  - `js/speech.js`: a `'coach'` mode. `coachDigitsFor(text)` turns "23.7" into `[3, 7]` ("1:05.2" into `[5, 2]`). `coachKeys()` prefers a whole recorded call `audio/coach/NN.m4a` (e.g. `37.m4a` for "три сім"), else joins two digit clips (`aN` = digit said first, `bN` = said second), else falls back to the English clip. Clips load with the rest in `loadClips()`.
  - `test/speech.test.mjs`: tests for the above.
  - `audio/coach/a*.m4a`, `b*.m4a` + `audio/coach/README.md`.
  - `sw.js`: a `COACH` list added to `SHELL` so the clips work offline.
- **Why it stalled:** the a/b digit clips were cut out of one recording where she slurs the two digits together, so joined pairs sound clipped and unnatural. And "шість" (6) never appears in that recording.
- **Decided fix:** the coach records all 100 whole calls from [`coach-reading-list.md`](coach-reading-list.md) (in Ukrainian, with pauses between calls), on a phone voice recorder in a quiet room. Cut at the pauses (`ffmpeg -af silencedetect` finds them well) into `audio/coach/00.m4a` … `99.m4a`, where the file name is units digit + tenths digit. Then the a/b clips and their fallback logic can go, which makes the code simpler.
- Clip format: mono AAC `.m4a`, trimmed tight, no silence before or after. Like `audio/en/*.m4a`, they're binary: Claude should never read them.

## Things that changed on `main` since PR #5 (it will conflict)

- **Voice setting is now radio buttons**, not a `<select>`: `index.html` around `<div id="voice" … role="radiogroup">`. Add `<label class="opt"><input type="radio" name="voice" value="coach"><span>Coach voice</span></label>`. `js/app.js` already reads the checked radio (`name="voice"`) and passes it to `announcer.mode`.
- **`sayLap(text, { gap, decimals, nextBlock })`** now also speaks extras (the Pacemaker gap, "next block"). Decide what coach mode does with them: simplest is coach clip for the time, then the existing English words for the extras.
- **The Android app shows hundredths** but the voice says tenths (`voiceDecimals()` in app.js), so the coach call only ever needs one decimal.
- Default voice is `'auto'` in `settings`. PR #5 switched existing users to `'coach'` once; check with Yuriy before making it the default.

## How to work in the repo

- `npm test`: quiet, prints failures + one summary line (`npm run test:verbose` for all). Run before every push.
- `node scripts/screenshot.mjs out.png --click cameraBtn,settingsBtn`: phone-size screenshot with a fake camera, to check the Settings sheet. Prints app errors.
- `js/speech.js` is the only real code file for this task, plus the radio in `index.html` and the clip list in `sw.js`.
- **Every release** (hard rules from CLAUDE.md):
  - bump `?v=N` on both `styles.css` and `js/app.js` in `index.html`, and `VERSION` in `sw.js`;
  - every new file the app loads (each clip) goes into `sw.js` `SHELL` (or a list spread into it), or it won't work offline;
  - keep storage keys starting with `'tracktime.'` so the preview copy gets its own.
- There's no build step. Pages deploys from GitHub Actions.

## Testing on the phone: the preview

- `https://yuramonastyrskyy.github.io/TrackTime/` is the live app, from `main`.
- `https://yuramonastyrskyy.github.io/TrackTime/preview/` is **the most recently updated open pull request from a branch in this repo** (not a fork). It's rebuilt on every push, shows a yellow **PREVIEW · PR #N** badge, and keeps its own settings, sessions and offline cache, so testing never touches the live app's data.
- So: push your branch, open a PR, wait for the "Pages" Action (a minute or two), open `/preview/` on the phone, check the badge shows your PR number. Settings > Voice > Coach voice > **Test voice**.
- Only one preview exists at a time. If Yuriy pushes to another open PR, the preview switches to his; push again (or ask him) to get it back. Close or leave PR #5 alone, so it doesn't grab the preview.
- **Push access:** a preview only builds for branches in this repo. Yuriy has to add you as a collaborator (repo Settings > Collaborators). A fork's PR will not get a preview.
- The service worker caches hard: if the phone shows old clips, reload twice, or clear the site data for `/preview/`.

## The Android app

- The app (`android/`, Capacitor) just loads the live site, so a merged web change like this one reaches it **with no new APK**. There's also a "TrackTime preview" app that loads `/preview/`.
- APKs are built only by GitHub Actions (`android.yml`, when `android/**` changes); Gradle doesn't work in Claude's cloud container. Coach voice shouldn't need any Android change.

## Materials

Yuriy has these and can send them:

- the reading list for the coach: [`coach-reading-list.md`](coach-reading-list.md) (copy in this folder);
- the original recording `1116.MP3` (1:58) and its word-level transcript with timestamps (`1116-words.md` / `.csv`, Whisper large-v3);
- `coach-preview.mp3`, `coach-preview-2.mp3`: what the PR #5 joined clips sound like (the "unnatural" version).

## Suggested order

1. Branch from `main`, port `coachDigitsFor` / coach mode / tests from PR #5 onto the current `speech.js`, add the Coach voice radio.
2. While waiting for the recording, keep PR #5's a/b clips as a stand-in so the preview can be tried.
3. When the 100 calls arrive: cut them to `audio/coach/NN.m4a`, list them in `sw.js`, drop the a/b clips and fallback.
4. Bump `?v=` and `VERSION`, `npm test`, push, try it on `/preview/`, then ask Yuriy to merge.
