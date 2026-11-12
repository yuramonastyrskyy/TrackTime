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
- If a lap was wrong (for example someone stepped onto the line), tap **Undo lap**.
- **Settings → Copy lap times** copies the session, ready to paste into a chat.
- If you hear nothing inside Telegram, set **Voice** to **Recorded clips**.

## Hosting on GitHub Pages

In the repository on GitHub: **Settings → Pages → Build and deployment**, set **Source** to "Deploy from a branch", choose `main` and `/ (root)`, then **Save**. After a minute the app is live at `https://<your-user>.github.io/TrackTime/`.

To open it from a Telegram bot, set that address as the bot's menu button or mini app URL in BotFather.

## How the detection works

The camera looks along the finish line, so the line runs from the top of the picture (outer edge of the track) to the bottom (inner edge). The app watches two thin strips of white just beside the black centre line. It learns what the empty line looks like when timing starts, and a crossing is any frame where enough of the strip is covered. The strip continues a little past the inner edge into the neutral zone. If that part is covered around a crossing, the rider is in the neutral zone and is ignored.

Lap times use the camera's frame timestamps, so they are accurate to one frame (about 0.02 s at 60 fps). The Bluetooth speaker's delay does not affect the times.

Code:
- `js/detector.js`: line sampling, crossing detection and lap logic (no browser APIs, tested in Node).
- `js/speech.js`: announcements, using the phone's voice or the recorded clips in `audio/en/`.
- `js/app.js`: camera, markers, screens and settings.
- `sw.js`, `manifest.webmanifest`: offline use and "Add to Home Screen".

The clips in `audio/en/` are generated with espeak-ng. You can replace any of them with your own recordings (for example the coach's voice) as long as the file names stay the same.

## Tests

```sh
npm test                                   # lap logic and sampling
CLIPS_DIR=path/to/video_footage npm test   # also replays trimmed_01..03.mp4 (needs ffmpeg)
node test/run-clip.mjs clip.mp4            # print what the app would announce for a video
```
