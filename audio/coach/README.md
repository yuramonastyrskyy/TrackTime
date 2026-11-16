# Coach voice clips

The coach calls a lap as units + tenths, without the tens: 23.7 is "три сім", 18.0 is "вісім нуль", 22.5 is "дві п'ять".

- `aN.m4a`: digit N said first (the units), e.g. "три" in "три сім".
- `bN.m4a`: digit N said second (the tenths), e.g. "сім" in "три сім".

Clips are cut from the coach's recording `1116.MP3` (2026-11-16). When a clip is missing, the app uses the same digit from the other position, and then the English clip.

Still missing: `a6.m4a` and `b6.m4a` ("шість"). Some clips are copies because the recording has no clean take for that position: `a7`, `a8` and `a9` are copies of `b7`, `b8` and `b9`, and `b1` is a copy of `a1`. To add a clip, drop it in here with the same name and add it to the `COACH` list in `sw.js`.

Format: mono AAC in .m4a, trimmed tight, with no silence before or after.
