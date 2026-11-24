# Research film authoring

These resources describe the `video.json` and `anims/*.js` format used by the Research film feature in Open-Science. The application owns generation; these files are not a standalone command-line tool.

## Current workflow

1. The user selects **Research film** from a session action, or the research-film action in an imported session.
2. The host freezes the selected branch and supported images. If a branch-visible managed ZIP contains an offline ES-module app, the user can choose to feature that app or use a drawn illustration.
3. The configured model writes the screenplay and scores its narration against the nine criteria in [SCRIPT.md](SCRIPT.md). The screenplay format requires the closing line and its end-card cue. The preview shows the available score from 0 to 9. Any score can proceed to animation, and an unscorable response leaves the score empty.
4. Owned workers generate English narration, align captions, assemble the timeline, and build a standalone HTML player and source archive.
5. The host opens the built HTML in the desktop renderer. An unavailable embedded session app falls back to a drawn illustration.
6. The preview offers **Render video (MP4)** and **Save shareable HTML**. Saving HTML copies the self-contained player with its narration and visual assets. Rendering a video is a separate desktop action. The host captures the stage through Electron and encodes it with FFmpeg. The current export is 1280 × 720, 16:9.

The player renders frames dynamically from its timeline. It contains its own audio, fonts, scripts, styles and referenced images, so the finished HTML can play outside the application without a local server.

## Runtime and dependencies

- The generation runtime is Node.js/TypeScript; animation drawing runs in the browser stage.
- English speech uses the pinned Kokoro JS model and runtime, installed on demand through the existing local-model manager. The current voice is `af_heart` at speed `1`; changing a spec's `voice` object does not select another voice. There is no automatic silent/subtitle-only fallback when narration is unavailable.
- Desktop export uses the application's Electron runtime, not a downloaded browser. A compatible system FFmpeg/ffprobe can be reused; otherwise the export action offers managed installation of pinned companion components.
- Dynamic playback does not need FFmpeg. Generation does not use a separate interpreter, environment, package installer or shell command.
- The mixed audio currently contains narration. Music beds and generated sound effects are not part of this application pipeline.

## Authoring references

- [SKILL.md](SKILL.md): screenplay and animation authoring responsibilities.
- [KIT.md](KIT.md): drawing APIs, visual standards and examples supported by the application path.
- `src/skill-video.schema.json`: the retained source-format schema. The application prompt and runtime checks further constrain the generated subset.
- `resources/stage/`: the packaged browser stage, drawing helpers, tokens, styles and licensed assets.

## Supported generated subset

Keep the existing field names. The screenplay has `version: 1`, `title`, `case`, `session: "session.json"`, `files: "files"`, `profile: "user"`, optional `disclaimer`, and `scenes`.

Each scene uses `id`, `role`, `msg`, optional `highlight`, `layout`, `lines` and `panels`. Message indices and highlights refer to the supplied snapshot. Aim for 5–9 scenes and 130–180 spoken words, up to 360 words in total. Each new caption line can carry 220 characters, with up to 320 characters for pronunciation. The player sizes each timed caption phrase to fit the frame. Cues refer to zero-based caption lines such as `"0"`, `"0:word"`, `"0.end"`, `"1+0.4"` or `"end-1"`.

The hook starts with a `title` panel followed by an `animation` panel using `size: "band"` and `box: "plain"`. Draw the actual topic below the title from the opening frame. Reuse its drawing through a shared helper, then show meaningful changes in later scenes. Close with the result or limitation and `end_card`.

Animation panels retain `script`, `use`, `data`, `size`, `box`, `at` and `until`. Files use distinct `anims/<name>.js` paths, with at most 16 shared/helper and scene files in total. Each file is a JavaScript function body, not a module. Shared `use` files define functions; scene scripts call them with `k`. The application writes helpers before scene scripts and limits concurrent scene authoring.

Use only files explicitly supplied by the host. Session images are embedded for playback. A file reference in a message is not evidence that its contents were supplied. CSV-based panels and `k.data()` require an actual staged CSV; do not invent one.

An approved session app uses `libs: ["libs/app.js"]`. Its local modules are bundled without the original page entry. The animation can drive their exports with the film clock. If the app cannot run offline or fails the HTML review, the host switches to a drawing. Other custom libraries, animation assets and subject manifests are outside the generated subset.

## Validation and review

Runtime checks cover the supported screenplay shape and size limits, source message references, cues, required files, safe paths, speech output and JavaScript syntax. Required inputs fail generation rather than producing a placeholder result.

The desktop renderer seeks through the standalone player to check playback. It records the count of visual observations, including caption overflow, panel overlap and drawing issues. A model call has up to ten minutes. A local narration request has six minutes, and the build worker has eight minutes between progress events. Drawing errors, blank animations, text overlap and clipping share a budget of three targeted repairs. A readable caption that wraps or sits near the margin is only a diagnostic observation. The player is checked in both aspect ratios after each build. If these checks find no repairable issues the film is ready. At the limit the desktop publishes the playable version with the fewest rendering failures across both sizes, then the fewest text defects, keeping the earliest on a tie. An embedded session app that fails to run triggers the drawing fallback.

Results are saved separately from source conversation history. The source archive retains the frozen inputs and generated materials for reproducibility; it is not an executable CLI distribution.
