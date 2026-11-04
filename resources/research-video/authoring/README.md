# open-science-case-demo-video (Open-Science Case Demo Video · style 01 as a skill) · Phase 1 engine

This turns an Open-Science research session into a narrated short video in style 01. The real session is the background: the camera lands on the source message and its passage is highlighted. Typed panels explain the numbers, and voice and captions run on top. It renders 16:9; the same build also plays in 9:16, rendered only on request (`--ar both`).

**The model writes the spec and the hero animations; the engine and the checks keep the look.** A run goes like this:

1. It drafts a `video.json` (scenes, voice lines, typed panels).
2. It writes the hero animations with the full web toolset (raw canvas, SVG, HTML/CSS, WebGL, local libraries) or the drawing kit.
3. The validators return precise, fixable errors.
4. It edits until the checks pass.

The engine decides the frame layout, typography, timing, captions, sound and rendering. The checks hold every animation to the same rules (the clock, named text styles, palette families, the frame), whatever it was drawn with.

## Brand reference

The **AIPOCH design system** (v3.1) is the brand source of truth: https://aipoch-design-system.vercel.app/

It covers colours, type, motifs, logo rules and assets. Check it whenever a colour, font, logo use or brand motif is in doubt, and before adding anything new to the look. The skill's styles follow it. Where a video needs something it lacks (e.g. a data-line blue), that is a documented video extension, not a replacement.

**Naming:** always "AIPOCH" (one uppercase word) for the company, "Open-Science" for the product.

## Pipeline

**The step-by-step workflow for an agent is in [SKILL.md](SKILL.md).** This README describes the spec and the tools.

```
python -m sv draft  session.json        # first draft from the session (deterministic), to edit
python -m sv check  video.json          # schema · story · cues · quotes · numbers · voice text
python -m sv make   video.json          # check → voice → build → mix → layout → anim → PREVIEW (opens the page), then stop
python -m sv make   video.json --final  # the same, ending with the final render, once the user has approved the preview
```

You can also run the steps one by one:

| Command                                  | What it does                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package x.science --out DIR`            | Unpacks a session package into `DIR/session.json` and `DIR/files/`.                                                                                                                                                                                                                                                                   |
| `package --session ID --out DIR`         | Last resort when no package can be had: reads the session from Open-Science's local store (undocumented layout; see SKILL.md step 1).                                                                                                                                                                                                 |
| `subject`                                | Checks the designed subjects (`subjects/*.json`) and writes `subjects/_sheet.jpg`.                                                                                                                                                                                                                                                    |
| `anim --scene ID`                        | Checks a scene's hero animation and writes filmstrips.                                                                                                                                                                                                                                                                                |
| `build`                                  | Writes the stage folder `build/` (the page `sv preview` opens).                                                                                                                                                                                                                                                                       |
| `voice`                                  | Records the voice lines with Kokoro and keeps lines whose text hasn't changed.                                                                                                                                                                                                                                                        |
| `mix`                                    | Mixes voice, sound effects and the music bed into `mix.wav`.                                                                                                                                                                                                                                                                          |
| `layout`                                 | Checks the layout in the browser and writes contact sheets to `build/check/`.                                                                                                                                                                                                                                                         |
| `preview`                                | **The preview:** builds, serves `build/` on `http://127.0.0.1` and opens it in the browser (`--stop` stops the server): the video at full resolution with voice and sound, played live (play, scrub, step, scene buttons, 16:9 ⇄ 9:16). Then the user is asked: render now in 1080p, in 4K, or not yet? There is no rendered preview. |
| `render --res 1080p` / `--res 4k`        | Renders the final MP4s, at the resolution the user chose.                                                                                                                                                                                                                                                                             |
| `doctor [video.json]`                    | Starts the browser for real, finds ffmpeg and voice, and lists the exact next steps (`todo`).                                                                                                                                                                                                                                         |
| `setup --dir WORK [--browser] [--voice]` | Downloads a headless browser (Chrome for Testing) and/or the voice model into `WORK/.open-science-case-demo-video/`.                                                                                                                                                                                                                  |

**Requirements:**

- Python 3.9+ standard library for `draft`, `check`, `build`, `layout` and `render`, plus Edge or Chrome and ffmpeg. Where the installed browser can't start (e.g. inside Open-Science's sandbox), `sv setup --browser` downloads Chrome for Testing's headless shell; the browser is driven over a pipe on macOS/Linux, so no network port is needed. Temporary files go into the case's `build/.tmp`.
- numpy for `mix`.
- numpy, onnxruntime and kokoro-onnx, plus the model files (about 120 MB, `sv setup --voice`), for `voice`. Without them the video is subtitles-only.

The stage folder bundles its own fonts, logos and the Open-Science UI kit, so nothing points outside it.

## The spec (`video.json`)

Get the full schema with `python -m sv schema`.

**Top level:**

- `title`, `case`
- `session` (messages `{i, role, md}`)
- `files` (the session's files folder)
- `profile`: `marketing`, or `user` for a "Made with Open-Science" end card
- `disclaimer`: the optional top-left tag
- `voice`
- `libs`: local JavaScript libraries for the animations (e.g. `libs/three.min.js`)
- `assets`: folder of SVG and image files for the animations (default `assets/`)
- 4–10 `scenes`

**Each scene has:**

- `id`
- `role`: one of hook, setup, method, result, limit, check, outro. The video starts with hook and ends with outro, and needs at least one result.
- `msg`: the message the camera lands on
- `highlight`: exact words from that message, inside one formatting run
- `veil`, `file` (the side-panel file), `disclaimer`
- `cite`: extra messages or files that the numbers come from
- `layout`: `stack`; `row` for side by side in 16:9; or `side`: the first panel (an animation) on the left, the others stacked to its right in 16:9
- 1–3 `lines` (`caption`, and `say` with numbers as words)
- 1–4 `panels`

**Cues** say when something appears:

| Cue          | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `"1"`        | when line 1 starts                                              |
| `"1+0.4"`    | 0.4 s after line 1 starts                                       |
| `"1:thrust"` | when line 1 reaches the word "thrust" (measured from the voice) |
| `"1.end"`    | when line 1 ends                                                |
| `"end-1.5"`  | 1.5 s before the scene ends                                     |

On any panel:

- `at` sets when it appears.
- `until` makes it leave, and the next panel takes its place.
- Panel lists can also cue each item with `at`. Items without one follow each other 0.35 s apart.

## Panel types

| Type         | For                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------ |
| `title`      | Hook question or section title: serif headline, eyebrow, pill note                         |
| `stats`      | Key numbers that count up; `split` draws parts of a whole as one bar                       |
| `bars`       | Comparisons and limits on one scale, optional badge (e.g. thrust ÷ weight = **1.78**)      |
| `line_chart` | Drawn from a session CSV: filter rows, scale, reference lines, shaded band, labelled marks |
| `criteria`   | Numbered rule cards with detail chips                                                      |
| `checklist`  | Checks passed, failed or open                                                              |
| `formula`    | One to three equations, key terms in gold                                                  |
| `progress`   | Reached X of Y: fills, stops short (✕) or completes (✓)                                    |
| `quote`      | The researcher's words, with the message number                                            |
| `steps`      | Method or pipeline, one step at a time                                                     |
| `compare`    | Before/after or ours/baseline cards                                                        |
| `figure`     | A session figure, framed                                                                   |
| `report`     | Final findings (pass / fail / unverified), each with its file                              |
| `verdict`    | Stamped result line under the panels                                                       |
| `end_card`   | Brand close (content fixed by profile)                                                     |

## What the checks catch

**`check`, on the spec:**

- schema errors (lengths, enums, unknown fields), each with the allowed values
- a missing story role or end card
- cues that point at missing lines or words
- highlight quotes that aren't word for word, or that cross bold/code formatting (it suggests the run to use)
- any number on screen that isn't in the cited messages or files, rounding allowed (it names the message where the number does appear)
- digits, symbols or unit abbreviations in spoken text
- missing files or CSV columns
- disclaimer use and length

**`layout`, in the real browser, at every moment a panel or item is fully in:**

- panels that overlap each other, the caption, the brand tag or the disclaimer
- panels off the frame
- overflowing text
- highlights the page couldn't mark

## Layout

| Path                    | What it holds                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `sv/`                   | Python: schema, validate, draft, timeline, build, voice, mix, check, render                                                       |
| `engine/stage/`         | Browser stage: `stage.js` runtime, `panels.js` library, CSS, UI kit, fonts, logos                                                 |
| `examples/tesla-hover/` | The reference example: the hand-built Tesla style 01 video as a spec. Six hero animations share one test stand (`anims/stand.js`) |
| `examples/kit-demo/`    | The drawing-kit examples from KIT.md: tank and race animations, a tank subject                                                    |
| (tests)                 | the Phase 0 render-test kit and all model tests live outside the skill, in `skills/open-science-case-demo-video-tests/`           |
| `dev/compare_sheet.py`  | Side-by-side frames of a hand-built stage vs a spec build                                                                         |
