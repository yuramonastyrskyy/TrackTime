# TrackTime: notes for Claude

Static web app (no build step) on GitHub Pages: velodrome lap timing from the phone camera. User guide: README.md.

## Commands
- `npm test`: quiet (failures + one summary line). `npm run test:verbose` for every test.
- `node scripts/screenshot.mjs out.png --click cameraBtn,settingsBtn`: phone-size screenshot with a fake camera; prints app errors, exit 1 on any. `--hash '#pm=…'`, `--size 844x390`, `--scale 2`. Elements hidden before the camera is on need `cameraBtn` first.
- `node test/run-clip.mjs part.mp4 --log log.json [--rest]`: replay a recorded clip through the detector (needs ffmpeg).
- `bash scripts/build-pages.sh <live> <pr> <num> <out>`: the Pages build (live at /, newest open PR at /preview/).

## Every release (hard rules)
- Bump `?v=N` on both `styles.css` and `js/app.js` in index.html, and `VERSION` in sw.js.
- A new file the app loads goes into sw.js `SHELL`, or it won't work offline.
- Storage keys keep the `'tracktime.` / `'tracktime-rec'` / `'tracktime-v` prefixes: build-pages.sh rewrites them for the preview copy.
- `js/detector.js`, `js/plan.js`, `js/session.js`, `js/riders.js` use no browser APIs (tested in Node). Keep it that way.

## Where things live (read the part you need; app.js is ~50 KB, grep `// ----------` for its sections)
- `js/app.js`: wiring: state, camera, frame loop, timing, laps, overlay/markers, settings dialog, record mode.
- `js/lists.js`: Settings > Recordings and Sessions lists, Send to Pacemaker.
- `js/detector.js` line sampling + lap logic · `js/glsampler.js` GPU pixel reads · `js/speech.js` voice/clips
- `js/recorder.js` Record + time (video parts, IndexedDB, log/CSV) and session storage
- `js/plan.js` Pacemaker plans · `js/session.js` sessions + sending · `js/lapLink.js` link to the laptop stopwatch
- `styles.css` (~34 KB, tokens at the top; `--tt-ui-scale` sets UI size) · `index.html` markup + SVG icon sprite
- `js/riders.js` rider identification (crossings, matching, review data; Node-tested) · `js/ridersView.js` leaders under the summary + review sheet. App side: `RiderEngine.java`/`RiderVision.java` (plain Java + ONNX Runtime, models in `android/app/src/main/assets/riders/`); `android/tools/RiderReplay.java` replays a clip through them on a desktop.
- `js/board.js` LED time board over Web Bluetooth (service 7a1e0001-…) · `board/time_board/time_board.ino` its ESP32 firmware (HUB75 64x32 panel, Arduino IDE), `board/pin_test/` wiring check. Keep the UUIDs in both in step.
- `js/nativeCamera.js` the Android app's camera (window.TrackTimeNative) · `android/` Capacitor shell; native camera in `TrackCameraPlugin.java`. Gradle builds only in GitHub Actions (`android.yml`; Google's Maven is blocked in Claude's cloud container). Bump `TrackCameraPlugin.VERSION` + `NATIVE_MIN` when the interface changes.
- `audio/en/*.m4a`: voice clips, binary; never read them.
