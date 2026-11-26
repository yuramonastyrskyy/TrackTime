# TrackTime

Automatic lap timing for the velodrome, with spoken lap times.

A phone on a tripod films the finish line. The app spots the first wheel crossing the line, speaks the lap time ("17.4") through a Bluetooth speaker, and ignores the line for 14 seconds afterwards, so the team behind is not counted. Riders in the neutral zone (the blue apron below the track) are ignored.

It runs in the phone's browser on iPhone and Android, works offline after the first visit, and can be added to the home screen. It can also be opened as a Telegram mini app.

## Using it at the track

1. Put the phone on a tripod at the edge of the track, lined up with the finish line, so the white line runs down the middle of the picture. A low spot on the infield works well.
2. Open the app and tap **Turn on camera**.
3. Drag the two markers onto the black centre line: **Top of track** where the line meets the top of the track, and **Inner edge** where the track ends and the neutral zone starts. The markers are remembered.
4. Connect the Bluetooth speaker and tap **Settings → Test voice**.
5. With the line clear, tap **Start timing**. The status goes from "Keep the line clear" to "Waiting for first rider". The first crossing starts the clock, and every later crossing (after the 14-second window) is announced as a lap.

Tips:
- Keep the phone plugged into a power bank. The app keeps the screen on while timing.
- **Settings → Rest between laps** (on by default): after each lap the app stops analysing the line until 1.5 s before the ignore time ends, which saves most of the detection work and keeps the phone cooler. The camera and any recording keep running, so nothing has to restart. Turn it off if you want every crossing in the log, including the team behind.
- If a lap was wrong (for example someone stepped onto the line), tap **Undo** (left of the lap times) twice: the first tap shows which lap it will remove.
- **Stop**, **Undo**, **Clear laps**, closing a plan and deleting a session or recording all take two taps within 3 seconds, so a brush with a glove does nothing.
- After **Stop**, a summary shows the best and average lap (long rest laps left out) and a bar per lap.
- **Settings → Display → High contrast**: black background and filled lap colours, for a bright hall. It also turns on by itself when the phone asks for more contrast.
- **Settings → Copy lap times** copies the session, ready to paste into a chat.
- If you hear nothing inside Telegram, set **Voice** to **Recorded clips**.

## Record + log (for testing and tuning)

**Record + time** does everything **Start timing** does, and also films the line and keeps a log, so a session can be replayed and tuned at home.

- The video is saved in 10-minute parts (about 190 MB each), straight into the browser's storage as it records. If the page crashes, what was recorded so far is kept.
- **Mark**: tap it whenever the lead rider really crosses the line. The marks are the "true" crossings the detector is compared against.
- **Stop recording** opens **Recordings**: save or share each video part, and the log (JSON), an events table (CSV) and a setup photo with the markers. Recordings stay in the app (Settings → Recordings) until you delete them.
- Settings → **Record sound with the video** also records the microphone (handy for the coach's calls). On iPhone this can make the Bluetooth speaker quieter, so try it before relying on it.
- The log has every crossing the detector saw (counted, ignored by the 14-second rule), every lap, mark, undo, the markers and settings, and once a second the frame rate and how covered the line was. Times are given both from the start of the session and as the time inside each video part.

Replaying a recording with the same markers and settings:

```sh
node test/run-clip.mjs tracktime-2026-11-14_0812-part1.mp4 --log tracktime-2026-11-14_0812-log.json
```

## With Pacemaker

Pacemaker (the coach's training app) holds track session plans and checks the laps against them. TrackTime only times the laps.

- **Plan from a link.** Pacemaker opens TrackTime as `https://<TrackTime address>/#pm=<plan>`. The plan stays for the visit (also across a reload) and is removed from the address bar. A plan strip above the lap list shows the block ("Block 2 of 5"), the plan name, the line and target in large type ("Under blue · 24.0 s"), the time or laps left in the block, and the next block. Tap **×** twice to close the plan. A link that can't be read shows a short note and the app carries on without a plan.
- **Plan clock.** It starts at the first crossing, like the lap clock. Time blocks end on that clock, lap blocks after their last lap. A lap longer than twice the target is a break (rest, or riders off on the apron) and is not scored. A ramp's target moves evenly from `from` to `to` over the block.
- **Lap colours** (with a plan): within ±0.3 s of the target green, 0.3–0.8 s slow orange, more than 0.8 s slow red, more than 0.3 s fast violet.
- **Settings → Say gap to target** (off by default): after the lap time, says the gap, for example "24.3 … plus 0.3", and "next block" on the first lap after the plan moves on.
- **Sessions.** Every timing session (Start timing and Record + time) is saved on the phone as it goes, so a reload or crash loses nothing: start time, each lap with its phone time, the plan and the settings. **Settings → Sessions** lists them, newest first, with **Review**, **Send to Pacemaker** and **Delete**. **Review** shows the whole session: every lap with who led it (Android app) and its photo-finish picture (tap a lap). **Check riders** there fixes unsure riders, and the fixes go with the next Send (a sent session says "Changed since sent"). Photo-finish pictures are saved with the session from this version on (IndexedDB store `finishes`), and deleted with it.
- **Send to Pacemaker.** After **Stop**, and from Sessions. Nothing is ever sent without that tap, and there are no keys or logins: Pacemaker asks the person to check and save the ride. It POSTs the laps as JSON (`Content-Type: text/plain`, so the browser sends no CORS preflight) to `<api>/api/rides?action=track`, where `<api>` is the plan's `api` or, without a plan, `https://pacemaker-theta.vercel.app` (`DEFAULT_API` in `js/plan.js`). Pacemaker's answer opens in Telegram when TrackTime runs inside Telegram, otherwise in the same tab. Without signal the session stays saved; try again later.
- For testing, `?pmapi=http://localhost:8787` sends to another address. `test/session.test.mjs` sends to a small local stub server.

## Android app

The Android app (`android/`, a [Capacitor](https://capacitorjs.com) shell) opens the same live site, so every merge reaches it without a new APK, and it keeps working offline like the website. What it adds is its own camera:

- **Locked 60 fps.** The camera runs at a fixed 60 frames a second. In Set up exposure and focus are automatic; **Start timing** takes what they metered on the empty line and locks exposure, focus and white balance for the session, so a dim hall can't slow the camera down. **Stop** goes back to automatic.
- **Settings → Camera (app)** shows the frame rate (now, and since Start: the lowest second and frames dropped) and the exposure. **Darker** / **Brighter** change it in 1/3 stops (the line is re-learned; the lap clock keeps running).
- **Hundredths.** Each frame carries the camera sensor's own time, and a crossing is placed between two frames from how much of the line each one covered. The screen, sessions and Pacemaker get 17.43; the voice still says 17.4.
- Only the finish-line pixels are read from each frame (natively, from the camera's brightness plane) and handed to the same `js/detector.js`. The preview is drawn natively behind the transparent page.
- **Who crossed first (rider recognition).** No tags: in the first lap the app learns each rider's jersey, helmet and bike colours (plus an appearance model) from the frames around the crossing, then names who crossed first at the end of every lap. Nothing is said or asked during timing. After **Stop**, the session card shows each lap's leader; **Check riders** opens the review: laps the app was unsure about are marked **?**, tap a rider to say who it really was (or *New rider* / *Not a team rider*), tap a name to change it. The riders and names are kept for the next session (**Settings → Riders (app) → Forget** clears them). **Send to Pacemaker** includes the leader of each lap and the riders' names. Works best when riders' kit or bikes differ in colour.
- No **Record + time** in the app yet (use the browser for that), no LED board yet.
- **Pacemaker plans:** a plan link opens in the phone's browser; on Android it shows **Open the plan in the TrackTime app**, which hands the plan over.

Install: download `TrackTime.apk` from the newest **Release** (`https://github.com/yuramonastyrskyy/TrackTime/releases/latest/download/TrackTime.apk`) on the phone and open it (allow installs from the browser when asked). The **Android app** workflow builds it when `android/` changes. A pull request that touches the app gets a separate **TrackTime preview** app (pre-release `app-preview`) that loads `/preview/` and installs next to the real one.

The page finds the app through `window.TrackTimeNative` (`js/nativeCamera.js`; version checked, `NATIVE_MIN`). Without it, or in an older app, everything works as in the browser. Native code: `android/app/src/main/java/.../TrackCameraPlugin.java`.

## Hosting on GitHub Pages

In the repository on GitHub: **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**. Every push to `main` then publishes the app at `https://<your-user>.github.io/TrackTime/` (see "Preview of a pull request" below).

To open it from a Telegram bot, set that address as the bot's menu button or mini app URL in BotFather.

## How the detection works

The camera looks along the finish line, so the line runs from the top of the picture (outer edge of the track) to the bottom (inner edge). The app watches two thin strips of white just beside the black centre line. It learns what the empty line looks like when timing starts, and a crossing is any frame where enough of the strip is covered. The strip continues a little past the inner edge into the neutral zone. If that part is covered around a crossing, the rider is in the neutral zone and is ignored.

Lap times use the camera's frame timestamps, so they are accurate to one frame (about 0.02 s at 60 fps). The Bluetooth speaker's delay does not affect the times.

Code:
- `js/detector.js`: line sampling, crossing detection and lap logic (no browser APIs, tested in Node).
- `js/speech.js`: announcements, using the coach's voice (`audio/coach/`), the phone's voice or the recorded clips in `audio/en/`.
- `js/app.js`: camera, markers, screens and settings.
- `js/lists.js`: Settings → Recordings and Sessions lists, and Send to Pacemaker.
- `js/recorder.js`: Record + log mode (video parts, IndexedDB storage, log and CSV, sharing), and storage for timing sessions.
- `js/plan.js`: Pacemaker plans: reading the link, the plan clock, targets, breaks and lap colours (no browser APIs, tested in Node).
- `js/session.js`: timing sessions and sending them to Pacemaker (tested in Node).
- `sw.js`, `manifest.webmanifest`: offline use and "Add to Home Screen".

**Coach voice** (the default) calls lap times the way the coach does: units + tenths, so 23.7 is "три-сім", in an AI clone of her voice (made with her consent), dialect included. With a plan, the gap is said the same way ("плюс" + "ноль-три") and "Наступний блок" too. All 100 calls are stored clips, so it works offline. See `audio/coach/README.md`; to change how a call sounds, edit `scripts/coach-voice/calls.txt` and regenerate it.

The clips in `audio/en/` are generated with espeak-ng. You can replace any of them with your own recordings (for example the coach's voice) as long as the file names stay the same.

## Tests

```sh
npm test                                   # lap logic, sampling, plans and sessions (prints failures + a summary)
npm run test:verbose                       # every test by name
node scripts/screenshot.mjs shot.png --click cameraBtn   # phone screenshot with a fake camera (needs Playwright)
CLIPS_DIR=path/to/video_footage npm test   # also replays trimmed_01..03.mp4 (needs ffmpeg)
node test/run-clip.mjs clip.mp4            # print what the app would announce for a video
```

## Preview of a pull request

GitHub Pages is published by `.github/workflows/pages.yml` (Settings › Pages › Source must be **GitHub Actions**):

- `https://yuramonastyrskyy.github.io/TrackTime/`: the live app, from `main`.
- `https://yuramonastyrskyy.github.io/TrackTime/preview/`: the newest open pull request, rebuilt on every push to a branch. It shows a yellow **PREVIEW · PR #N** badge and keeps its own settings, sessions, recordings and offline cache, so trying it never touches the live app's data. With no open pull request it says so.

`scripts/build-pages.sh` builds the site; run it locally to check a preview build.
