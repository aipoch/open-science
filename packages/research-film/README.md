# @aipoch/research-film

Generate English narrated research films from frozen session snapshots or an existing `video.json`. The default result is a self-contained HTML player plus a source ZIP. MP4 encoding is optional.

The package owns screenplay validation and correction, shared and per-scene animation authoring, narration chunking and synthesis, caption alignment, audio mixing, timeline construction, the player and its bundled stage, source archives, encoding, and worker lifetimes. It preserves the original `video.json` / `anims/*.js` format.

In Open-Science, generation starts only from the user's research-film button and runs independently of conversation turns. The host uses tool-less model inference for authoring; generation is not exposed as an Agent/MCP tool. Players and source bundles are stored as session-derived film files, not published as conversation Artifacts.

The host owns session/branch authorization, frozen source and approved image staging, model selection and usage accounting, model downloads and leases, data-root admission, storage/publication, UI, and Electron capture/save dialogs. No host imports or Electron dependency are used here.

```ts
import {
  createResearchFilmAuthor,
  createResearchVideoGenerator,
  generateResearchFilm
} from '@aipoch/research-film'
import { researchFilmResources } from '@aipoch/research-film/resources'

const generate = createResearchVideoGenerator({ temporaryRoot })
const author = createResearchFilmAuthor(infer) // (source, systemPrompt, payload, signal) => text
const result = await generateResearchFilm({
  source,
  directory,
  author,
  generate,
  signal,
  modelDirectory,
  modelRevision,
  engineDirectory: researchFilmResources().stageDirectory,
  onProgress
})
// Publish result.playerPath and result.sourcePath only after the host rechecks source authority.
```

Stage the approved `session.json` and `files/` into a fresh job directory before calling. Retain the model lease until generation settles, including cancellation cleanup. Reuse one generator for all entry points sharing a concurrency budget. It admits one generation at a time, owns its workers, and drains native speech requests before terminating them. On hosts with at least four CPUs and 16 GiB RAM it uses two speech workers, with at most four ONNX threads in total.

`createResearchVideoGenerator` also accepts an existing source `specPath` directly. `exportResearchVideoMp4` from `@aipoch/research-film/export` accepts encoder paths and a frame-capture port. This separate entry can be bundled into Electron without shipping the speech pipeline there. `@aipoch/research-film/contracts` is browser-safe.

Resources and workers resolve relative to the installed package, not the application's working directory. Keep `dist` and `resources` together. Run the Node pipeline outside an ASAR; desktop hosts can stage this package into their ordinary Node backend. The package contains no downloaded narration weights, ONNX engine, voice binary, or FFmpeg executable. Catalogs pin downloads for the host's model manager. Existing `sharp` is reused through normal package dependency resolution.

Authoring documentation: [format and constraints](resources/authoring/SKILL.md), [drawing API](resources/authoring/KIT.md). Syntax validation does not certify scientific accuracy or visual quality; review generated playback.

```sh
npm run build
npm test
```

From the repository, `npm run check:packages -- --packages=research-film` also builds and tests a fresh isolated copy, installs its tarball in a separate consumer, exercises the packaged worker/player, checks CommonJS and ESM imports, browser contracts, declarations and private-import rejection. Native voice quality, hardware performance and Electron frame capture require the host acceptance checks.
