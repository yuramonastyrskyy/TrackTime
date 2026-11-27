# Coach voice clips

The coach calls a lap as units + tenths, without the tens: 23.7 is "три-сім", 18.0 is "вісім-ноль", 22.5 is "дві-п'ять".

## Whole calls and words (AI clone of her voice)

- `00.m4a` … `99.m4a`: the whole call for a lap ending in that units + tenths digit. `37.m4a` is played for 13.7, 23.7 and 1:03.7. The gap to target is said the same way: "плюс" + `03` for 0.3 s slow.
- `start.m4a`, `plus.m4a`, `minus.m4a`, `nextblock.m4a`: "Оп! Поїхали!" (said at the first crossing, with the same tags as the calls), "плюс", "мінус", "Наступний блок".

These are generated with an ElevenLabs clone of the coach's voice, made with her consent from her own recording. The text of each clip, written the way she says it (her dialect, with style tags), is in `scripts/coach-voice/calls.txt`; see `scripts/coach-voice/generate.mjs` for how to regenerate or redo single clips. Current set: model `eleven_v4`, tags `[loud][fast][screaming]`, the two digits joined by a hyphen.

## Older digit clips (cut from her recording)

Only used if a whole call is missing.

- `aN.m4a`: digit N said first (the units), e.g. "три" in "три сім".
- `bN.m4a`: digit N said second (the tenths), e.g. "сім" in "три сім".

Cut from the coach's recording `1116.MP3` (2026-11-16). There is no `a6`/`b6` ("шість"). `a7`, `a8` and `a9` are copies of `b7`, `b8` and `b9`, and `b1` is a copy of `a1`.

## Adding a clip

Drop it in here with the same name and make sure its name is in `COACH_CLIPS` (`js/speech.js`) and `COACH` (`sw.js`), then bump `VERSION` in `sw.js` and `?v=` in `index.html`. Format: mono AAC in .m4a, trimmed, with a short lead-in.
