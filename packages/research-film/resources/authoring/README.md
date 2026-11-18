# Research film authoring

These resources describe the `video.json` and `anims/*.js` format used by the Research film feature in Open-Science. The application owns generation; these files are not a standalone command-line tool.

## Current workflow

1. The user selects **Research film** from a session action, or the research-film action in an imported session.
2. The host freezes the selected branch and supported images. If a branch-visible managed ZIP contains an offline ES-module app, the user can choose to feature that app or use a drawn illustration.
3. The configured main model writes the screenplay, then scores its narration against the nine criteria in [SCRIPT.md](SCRIPT.md). The host checks the closing line and its cue, sends failed criteria back for revision, and requests animation scripts once the narration passes.
4. Owned workers generate English narration, align captions, assemble the timeline, and build a standalone HTML player and source archive.
5. The host reviews the built HTML and repairs failed frames before showing the film and its narration score. The saved HTML can then be played or regenerated from the session.
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

Before showing a new research explanation, the desktop app seeks through the 16:9 HTML player. It measures every timed caption phrase, including word highlighting, and checks readout-card labels, panel bounds, drawing errors, blank animations and the fully revealed end card. An image-capable selected model also reviews a live HTML screenshot per scene. The app rebuilds and rechecks repairs, up to three rounds. If a defect persists, the user sees the affected scene and can continue generation.

Results are saved separately from source conversation history. The source archive retains the frozen inputs and generated materials for reproducibility; it is not an executable CLI distribution.
