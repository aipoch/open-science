# Research film authoring

These resources describe the `video.json` and `anims/*.js` format used by the Research film feature in Open-Science. The application owns generation; these files are not a standalone command-line tool.

## Current workflow

1. The user selects **Research film** from a session action, or the research-film action in an imported session.
2. The host freezes the selected branch and supported session images. It uses the configured main model to write the screenplay and animation scripts without adding conversation messages.
3. The host validates the screenplay and compiles animation bodies without executing them in Node. A malformed model response can receive one correction attempt.
4. Owned workers generate English narration, align captions, assemble the timeline, and build a standalone HTML player and source archive.
5. The user plays the saved HTML immediately. Opening an existing result does not regenerate it; regeneration requires confirmation.
6. **Export MP4** is a separate desktop action. The host captures the stage through Electron and encodes it with FFmpeg. The current export is 1280 × 720, 16:9.

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

Each scene uses `id`, `role`, `msg`, optional `highlight`, `layout`, `lines` and `panels`. Message indices and highlights refer to the supplied snapshot. Aim for 5–8 scenes and 130–180 spoken words; the application's limit is 360 words. Long speech lines are split automatically. Cues refer to zero-based caption lines: `"0"`, `"0:word"`, `"0.end"`, `"1+0.4"`, `"end-1"`.

The hook starts with a `title` panel followed by an `animation` panel using `size: "band"` and `box: "plain"`. Draw the actual topic below the title from the opening frame. Reuse its drawing through a shared helper, then show meaningful changes in later scenes. Close with the result or limitation and `end_card`.

Animation panels retain `script`, `use`, `data`, `size`, `box`, `at` and `until`. Files use distinct `anims/<name>.js` paths, with at most 16 shared/helper and scene files in total. Each file is a JavaScript function body, not a module. Shared `use` files define functions; scene scripts call them with `k`. The application writes helpers before scene scripts and limits concurrent scene authoring.

Use only files explicitly supplied by the host. Session images are embedded for playback. A file reference in a message is not evidence that its contents were supplied. CSV-based panels and `k.data()` require an actual staged CSV; do not invent one.

The retained schema has fields beyond the generated subset. In particular, the current application path does not load custom `libs`, an animation `assets` directory, or `subjects/*.json`. Do not request these or use `k.svg`, `k.image`, `k.asset`, `k.subject` or `k.anchor` to access unstaged resources. Draw reusable subjects in shared JavaScript using the kit, Canvas or inline SVG instead.

## Validation and review

Runtime checks cover the supported screenplay shape and size limits, source message references, cues, required files, safe paths, speech output and JavaScript syntax. Required inputs fail generation rather than producing a placeholder result.

These checks do not establish scientific correctness or automatically certify every rendered frame. Inspect the actual player for readable text, overlaps, subject quality, backward seeking and narration synchronization. The application does not provide a filmstrip generator, a subject-sheet command, or an automatic visual-quality approval loop.

Results are saved separately from source conversation history. The source archive retains the frozen inputs and generated materials for reproducibility; it is not an executable CLI distribution.
