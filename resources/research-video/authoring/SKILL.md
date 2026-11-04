---
name: open-science-case-demo-video
description: Turn an Open-Science research session (a .science package) into a short narrated explainer video in the AIPOCH "session video" style. The real session is the background and the camera lands on the source messages; typed infographic panels and hero animations explain the result; voice, captions and sound are added; the MP4 is rendered in 16:9 (9:16 only on request). Use when someone asks for a video, explainer, short or social clip about a research session, use case or .science package.
---

# Open-Science Case Demo Video

You turn a research session into a 45–150 s video. The video is described by one JSON spec (`video.json`), plus hero animations (and, where they help, subject drawings) that you write with the full web toolset: the raw canvas, SVG, HTML/CSS, WebGL, local libraries, or the drawing kit's helpers. Hero animations are part of the style, not an extra: a video with only panels is not finished. The tools do all layout, timing, typography, sound and rendering, and their checks tell you precisely what to fix.

Run every command from this skill's folder (the one that contains `sv/`): `python -m sv <command> …`. Where there is no `python` command (macOS), use `python3`, or the Python of an environment that has the voice packages. Keep the case folder (the `cases/<case>` paths below) in **your working directory**, given as an absolute path, never inside the skill folder.

**Read when needed:**

| File                    | What it covers                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`             | the spec (`video.json`): scenes, cues, the 15 panel types, what the checks catch                                                                                                                                                             |
| `KIT.md`                | the AIPOCH style standard, the drawing kit for hero animations, and subject design (section 8)                                                                                                                                               |
| `examples/tesla-hover/` | the reference example, ported from the hand-built Tesla style 01 video: a complete spec whose hero animations (hook, rules, physics, task 1, failure, scan) share one test stand, `anims/stand.js`. Learn its habits; don't copy its content |
| AIPOCH design system    | https://aipoch-design-system.vercel.app/, the brand reference when in doubt                                                                                                                                                                  |

## Before you start

- **Check and set up the computer.** Run `python -m sv doctor` (add the case's `video.json` once you have one). It starts the browser for real, finds ffmpeg and voice, and lists the exact next steps under `todo`. Do them in order, then run `doctor` again until `ready_to_render` is true.
  - **Work folder.** Keep everything (case folders, renders) in one work folder. Inside Open-Science this must be a folder the user has authorized for the session; its sandbox can't read or write anywhere else. `python -m sv setup --dir <work folder>` creates `<work folder>/.open-science-case-demo-video/` for the downloaded tools; `sv` finds it from any case folder inside.
  - **Browser.** If the installed Chrome or Edge can't start (always the case inside Open-Science's sandbox), `python -m sv setup --dir <work folder> --browser` downloads Google's Chrome for Testing headless shell (about 100 MB, once).
  - **ffmpeg.** Inside Open-Science, install it with its package tool: `manage_packages(language="python", packages=["ffmpeg"])`. Never install from the shell. Elsewhere, ask the user to install ffmpeg. Everything up to the layout check works without it.
  - **Python.** Inside Open-Science, run `sv` with its managed Python (`doctor` prints the path as `managed_python`) so the packages it installs are found.
  - **Voice is optional.** It needs `numpy`, `onnxruntime` and `kokoro-onnx` (in Open-Science: `manage_packages(language="python", packages=["numpy", "onnxruntime"])`, then `manage_packages(language="python", packages=["kokoro-onnx"], usePip=true)`), plus the voice model: `python -m sv setup --dir <work folder> --voice` (about 120 MB). Without voice, the video is subtitles-only.
  - Downloads and installs need the user's OK; ask once for the whole setup. If they can't be asked, or a download is refused, carry on as far as you can and say what is missing.
- **Ask the user, if they haven't said:**
  - the audience: `profile` is `"marketing"` for AIPOCH's own videos, or `"user"` for a researcher's own video (ends with "Made with Open-Science")
  - the rough length
  - the format: **16:9 only**. Make the 9:16 version only when the user explicitly asks for it; then add `--ar both` to `layout`, `anim` and `render`. (The build is the same page for both formats, so it costs nothing; checking and rendering 9:16 roughly double those steps.)
- **Don't ask about resolution up front:** you ask whether to render, and in 1080p or 4K, once the preview is open (step 9). Only render without asking if the user's request already said so explicitly (e.g. "render the final in 4K straight away").

## Workflow

### 1 · Get the session and unpack it

The input should be a `.science` package. Try these in order and use the first that works:

1. **You were given a `.science` package** (a file, or its path in the message). Use it directly.
2. **Export the session with the Open-Science CLI.** Identify the session first: ask the user for its id, or for its title and project.
   ```
   open-science session export <session-id> --project "<project name>" --output <work folder>/<case>.science --json
   ```
   - If `open-science` is not on the PATH, on macOS call the app's bundled CLI: `"/Applications/Open-Science.app/Contents/Resources/node-runtime/node" "/Applications/Open-Science.app/Contents/Resources/cli/index.mjs" session export …`.
   - Open-Science only exports a session that is **idle**, so a session cannot export itself while you are working in it.
   - Inside Open-Science the agent's shell is sandboxed with no network, so the CLI can't reach the app (`daemon_unavailable`); go on to 3.
3. **Ask the user to export it.** In the app: session menu → Export session package, then paste the file's **path as text** into the chat. Inside Open-Science, ask them to save it in this session's working folder (or a folder they have authorized for it): the sandbox can't read other folders. Tell them not to drop or attach the file: Open-Science imports a dropped `.science` file as a new session instead of handing it to you.
4. **Last resort, only when 1–3 are impossible** (for example, the user can't be asked): read the session straight from Open-Science's local store on this computer.
   ```
   python -m sv package --session <session id, or part of its title> --out cases/<case>
   ```
   - This reads Open-Science's internal files, which are undocumented and may change with app updates. If it fails, report it and ask for a package.
   - It works only outside Open-Science's sandbox (for example another agent on the same computer). Inside Open-Science the store is not readable, and the command reports no matching session.
   - It sees only what the app has saved: a session's newest turn may be missing while that session is still running.
   - Tell the user you used this route.

Unpack the package (skip this for route 4, which already wrote the case folder):

```
python -m sv package <file.science> --out cases/<case>
```

Save the finished MP4s in your work folder and tell the user where they are.

This writes `cases/<case>/session.json` (every message as markdown, numbered `i`) and `cases/<case>/files/` (the session's files by name).

### 2 · Understand the research before writing anything

Read `session.json` end to end. Note, with message numbers:

- the researcher's question
- the setup and assumptions (anything hypothetical must be made clear)
- the method and how it was checked
- the key results, with their exact numbers
- failures and limits
- a moment where the researcher pushed back or asked for a check
- the final report

Open the CSVs and figures the results come from. Every number you put on screen must come from these sources.

### 3 · Draft the spec, then rewrite it

```
python -m sv draft cases/<case>/session.json        # writes cases/<case>/video.json
```

The draft is only a scaffold built from the session. Rewrite it into a story of 5–9 scenes following the template:

| Role     | The scene…                                                                           |
| -------- | ------------------------------------------------------------------------------------ |
| `hook`   | the opening: asks the question in plain words (always built the same way, see below) |
| `setup`  | shows what was assumed or given                                                      |
| `method` | shows how it was done and checked                                                    |
| `result` | shows the key finding (at least one scene)                                           |
| `limit`  | shows what failed or doesn't hold                                                    |
| `check`  | shows how it was verified, or the researcher's challenge                             |
| `outro`  | shows the report, then the `end_card`                                                |

For each scene:

- **`msg`:** the message the camera lands on.
- **`highlight`:** words copied _exactly_ from that message, within one formatting run.
- **`lines`:**
  - 1–3 voice lines
  - `caption` is what's on screen: short, plain, keeps the numbers
  - `say` is what's spoken: numbers and units written as words ("3.37" → "three point three seven", "kN" → "kilonewtons")
- **`panels`:** 1–4 typed panels that show the scene's point. Pick the panel type that fits the content (README), and time each one to the word that names it (`"at": "1:thrust"`).
- **`cite`:** extra messages or files the scene's numbers come from.
- **The top-left tag (`disclaimer`) is optional.** Use it only when the case needs a short clarification, warning or extra note that fits there (e.g. "Hypothetical vehicle · idealized model · not real Tesla hardware"), set the text once in the spec's `disclaimer` and turn it on with `disclaimer: true` only on the scenes it applies to. If nothing needs saying, leave it out: the video doesn't need a tag. Don't use it to restate limits a scene already shows.

**The opening is the same in every video, with an animation made for the case.** The `hook` scene has:

1. a `title` panel: the eyebrow (`"Use case · Open-Science"` for marketing, a short case label for a researcher's own video), the question in the big serif with its key words in gold (`**Tesla Roadster**`), line breaks with `|`, and a pill `note` on the second line (`note_at: "1"`)
2. under it, the case's own opening animation: `{ "type": "animation", "size": "band", "box": "plain" }` (no `at`: it is there from frame 0), floating on the page. It shows the research's subject in a few seconds, starting to do what the question asks (the roadster lighting its jets and lifting off; for a route, the city's landmarks appearing and a first path starting to draw). Usually it is the recurring subject of step 6.

**The first 3 seconds decide whether people stay.** The opening's visuals stay as above; its pace is fixed:

- **The first voice line is short: about 2.5 s (≈ 6 words)**, and it opens on the tension or a surprising number, not on setup or attribution ("Can a Tesla Roadster hover 5 seconds?", not "In this session, a researcher asked…"). The rest of the question goes in the next line; the Open-Science line comes after, with the title's pill `note` cued to it.
- **The engine paces it for you:** the voice starts at 0.3 s, the opening's panels appear from frame 0 (give the animation no `at`), the title is fully in by about 0.75 s, and an impact sound plays on frame 0.
- **The opening animation moves from frame 0:** start its motion at `k.t = 0` (no slow fade-in), and land its first beat within about 1.5 s.

See `examples/tesla-hover`, scene `hook`. `check` reports an error when the hook has no `title` panel, a warning when it has no animation, and a warning when the first voice line runs much over 2.5 s.

### 4 · Validate until clean

```
python -m sv check cases/<case>/video.json
```

Fix every error and run it again; the messages say exactly what and where. Take the warnings seriously. Stop after about 8 rounds; if errors remain, report them to the user rather than forcing them through.

### 5 · Subjects (when the research is about a physical thing)

A vehicle, an organism, a cell, an instrument, a landmark: design it once as `cases/<case>/subjects/<name>.json`, following KIT.md section 8 (proportions first, then silhouette, then details). Then:

```
python -m sv subject cases/<case>/video.json
```

Look at `subjects/_sheet.jpg`. At 110 px the object must be nameable in one second. Use up to about 6 rounds.

- If it still doesn't read, start from a Lucide `icon` part and add a few shapes on top.
- Skip this step for things that are really geometry: a cube, a network, a molecule, an array of trials. The kit builds those (`k.cube`, `k.network`, `k.molecule`, `k.grid`).
- Skip it also for abstract results (scores, rates, rankings); those are shown with panels or grids.

### 6 · Hero animations (required)

Hero animations are what make these videos vivid; every video has them. You decide which scenes get one and how many: it depends on the case.

**The quality bar is `examples/tesla-hover/`.** Read its spec and `anims/` before you write any animation. It is the hand-built standard turned into a spec: most of its story is carried by one subject that recurs from scene to scene (the car on its test stand), each time doing what that scene says (rising for the method, running out of gas for the failure, flying each gas load for the scan), with live readouts, a state tag and a climax.

**Find your case's recurring subject.** Ask what the research is about and draw it once in a shared file (`use`, KIT.md section 1): a vehicle or rig, an organism or cell, a map of the place (a city with its river and landmarks, a route), a population of trials, a model. Then let it carry the scenes where something happens to it, beside that scene's cards (`"layout": "side"`). A video whose animations are a single diagram in one scene is below the bar; `check` warns when only one or two scenes are animated in a longer story.

**You have the full web toolset for animations** (KIT.md, top): the raw canvas, inline SVG, HTML/CSS (3D included), WebGL, local libraries (`libs`) and assets (`assets/`), with the drawing kit as optional helpers. Only the clock, typography, colours and the frame are fixed. **Before you draw, read KIT.md section 5:** how to judge a coded graphic, the method, the camera rules and the open-licensed SVG sources. There is no fixed drawing style; the criteria are how you know it's good.

Give a scene an `animation` panel where motion shows something the panels can't. Good candidates:

- **The key result:** the finding happening, not just its number (a route drawing itself and its distance shrinking, a car lifting off, a curve crossing a threshold).
- **A mechanism or process:** how the method works, step by step (a search trying orders, a cube turning, particles flowing).
- **Change, comparison or scale:** before vs. after, A vs. B, a quantity filling up or draining away.
- **The hook:** the opening animation under the title (step 3): the subject in a few seconds, so the viewer wants to know the answer.
- **Space and physical things:** maps, routes, objects, organisms, instruments; draw them rather than describe them.

Prefer a few strong animations over many weak ones. Don't animate what a panel already says well (a list, a quote, a single number), and don't animate the end card. Every animation follows the session's data, with its key moment on the word that names it. Follow KIT.md (style standard, sections 1–7). Then:

```
python -m sv anim cases/<case>/video.json --scene <id>
```

Fix all errors, then look at the filmstrips (`build/check/anim_*`). Judge them against KIT.md section 5. If an animation still fails after about 6 rounds, simplify it (fewer moving parts, one clear motion) before giving up on it. If you do remove one, its scene's panels carry that scene, but the video must keep at least one animation: `check` reports an error when there is none.

**A new version or revision is made from the session again,** following every step of this skill as it is now. Don't patch an earlier case's spec to get past a new check: the skill may have changed in ways a patch misses.

**If more than one model is available,** use the strongest for steps 5 and 6. They are done once and reused, and they decide how designed the video looks.

### 7 · Voice

```
python -m sv voice cases/<case>/video.json
```

This records every line and measures word timings for captions and cues. Lines whose text hasn't changed are kept. If voice isn't available, skip it: line lengths are estimated and the video is subtitles-only. Say so to the user.

### 8 · Build and check the layout

```
python -m sv build  cases/<case>/video.json
python -m sv layout cases/<case>/video.json
```

`layout` seeks to every moment a panel or item is fully in (16:9; with `--ar both` also 9:16), and reports overlaps, off-frame panels and overflowing text. Look at the contact sheets (`build/check/sheet_16x9.jpg`, `sheet_9x16.jpg`): one frame per scene. Fix the spec, then rebuild.

### 9 · Sound, preview and the user's approval

**Never render the final video before the user has seen the preview and chosen to render.** This is a gate, not a suggestion. There is no rendered preview: rendering a draft wastes time, especially in batch production.

```
python -m sv mix     cases/<case>/video.json
python -m sv preview cases/<case>/video.json
```

- `mix` builds the soundtrack: voice, sound effects on what appears, and a soft music bed. Everything is synthesized; no licensed audio.
- **`preview` is the preview:** it rebuilds the page, serves it on `http://127.0.0.1:<port>/index.html` and opens that in the user's browser. Always use this address, never the file directly: opening `index.html` as a file can look different in some browsers. The server keeps running in the background; `python -m sv preview cases/<case>/video.json --stop` stops it. The page is the video itself, at full resolution, with the voice and sound, played live: space plays and pauses, the arrow keys step frame by frame, the scene buttons jump, and "→ 9:16" switches format. Every frame is identical to what the final render captures.

**Then send one follow-up message and stop.** Tell the user the preview is open (with its address, `http://127.0.0.1:<port>/index.html`, and `?ar=9x16` for vertical), give a short summary (length, scenes, what each animation shows, voice or not, anything you couldn't verify), and ask **"Render the final video?"**:

- **If your environment can show clickable choices** (a question tool with options, quick-reply buttons), offer exactly two buttons: **Render 1080p** and **Render 4K**. The user types any edits instead of clicking.
- **Otherwise** ask in text: "Render the final video in 1080p, or 4K (about 4× slower)? Or tell me what to change."

Wait for the answer.

- **Render 1080p / Render 4K:** go to step 10 with that resolution (16:9; both formats only if the user asked for 9:16).
- **Edits:** make them (wording, timing, a scene, an animation), rerun the cheap steps (`check`, `anim --scene`, `layout`, `voice` and `mix` if lines changed), run `preview` again, and ask the same question again.

**If the user can't be asked** (an unattended run, or they said they're away), stop here: leave the page built and served, say its address, and say the final is waiting for their choice. Render in the same run only if their request explicitly asked for a final render (and which resolution) without review.

### 10 · Final render (after approval)

```
python -m sv render cases/<case>/video.json --res 1080p     # or --res 4k, as the user chose; --ar both only if they asked for 9:16
```

- `render` writes `cases/<case>/renders/<title> · 16×9 1080p.mp4` (or `4k`), and the 9×16 version only with `--ar both`.
- 4K takes about 4× longer than 1080p.

`python -m sv make cases/<case>/video.json` runs check → voice → build → mix → layout → anim → **preview** (opens the page) in one go and stops at the first failing step. Once the user has approved the preview, `python -m sv make cases/<case>/video.json --final` runs the same steps and ends with the final render instead.

### 11 · Deliver

Tell the user:

- where the MP4s are
- the length
- which scenes have animations, and what each one shows
- whether there is voice
- anything you couldn't verify or had to drop (an animation simplified or removed, a warning left)

Quote nothing as fact that the session doesn't state.

## Rules that always hold

- **Truth:** every number on screen is in the cited messages or files (rounding is fine). Quotes are word for word. Hypothetical setups are made clear (in the scene, or with the top-left tag).
- **Brand:** write "AIPOCH" (one uppercase word) and "Open-Science" (with a hyphen). Use only the palette and named text styles of the style standard (KIT.md), and never redraw or recolour the logo. The end card is fixed by `profile`.
- **Checked, not trusted:**
  - The spec, subjects and animations go through the checks.
  - Don't edit the engine (`engine/`, `sv/`) to make a video pass. Fix the content.
  - If the engine really blocks something, report it.
- **Preview first:** no final render before the user has seen the preview page and chosen to render (step 9), unless their request explicitly asked for a final render without review. Never render a draft or preview video.
- **Cost of a mistake:** you can always rerun cheap steps (check, subject, anim, layout, preview). Run the final render once, at the end, after approval.
