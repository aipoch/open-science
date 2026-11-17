import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  parseResearchVideoScreenplay,
  RESEARCH_VIDEO_ANIMATION_PROMPT,
  RESEARCH_VIDEO_SCREENPLAY_PROMPT
} from './screenplay.js'
import {
  writeResearchVideoAnimations,
  researchVideoAnimationPlan,
  type ResearchVideoAnimationInput
} from './animation-authoring.js'
import type { ResearchVideoSessionSource } from './source.js'
import { researchFilmResources } from './resources.js'
import { parseReplayCase, REPLAY_AUTHORING_PROMPT, REPLAY_RUNTIME_VERSION } from './replay-case.js'
import {
  writeWithResearchFilmCorrection,
  type FilmAuthoringCheckpoint,
  type ResearchFilmCorrection as Correction
} from './authoring-correction.js'

export type ResearchFilmAuthor = {
  writeReplay?(
    source: ResearchVideoSessionSource,
    signal: AbortSignal,
    correction?: Correction
  ): Promise<string>
  writeScreenplay(
    source: ResearchVideoSessionSource,
    signal: AbortSignal,
    correction?: Correction
  ): Promise<string>
  writeAnimation?(
    source: ResearchVideoSessionSource,
    input: ResearchVideoAnimationInput,
    signal: AbortSignal,
    correction?: Correction
  ): Promise<string>
}

/** The host selects the model and accounts for usage; prompts and authoring resources belong here. */
export function createResearchFilmAuthor(
  infer: (
    source: ResearchVideoSessionSource,
    systemPrompt: string,
    payload: unknown,
    signal: AbortSignal
  ) => Promise<string>
): ResearchFilmAuthor {
  return {
    writeReplay: (source, signal, correction) =>
      infer(
        source,
        REPLAY_AUTHORING_PROMPT,
        {
          source: {
            ...source,
            messages: [],
            replay: source.replay && {
              ...source.replay,
              events: source.replay.events.map((event, index) => ({
                ...event,
                position: index + 1
              }))
            }
          },
          correction
        },
        signal
      ),
    writeScreenplay: (source, signal, correction) =>
      infer(
        source,
        RESEARCH_VIDEO_SCREENPLAY_PROMPT,
        correction ? { source, correction } : source,
        signal
      ),
    async writeAnimation(source, input, signal, correction) {
      const kit = await readFile(join(researchFilmResources().authoringDirectory, 'KIT.md'), 'utf8')
      signal.throwIfAborted()
      const scenes = input.spec.scenes.filter((scene) =>
        scene.panels.some((panel) =>
          input.shared
            ? Array.isArray(panel.use) && panel.use.includes(input.path)
            : panel.script === input.path
        )
      )
      const references = new Set(
        scenes.flatMap((scene) => [scene.msg, ...(Array.isArray(scene.cite) ? scene.cite : [])])
      )
      // File names need not equal Artifact IDs. Keep the evidence when a cite cannot be resolved.
      const unresolvedCitation = [...references].some(
        (reference) =>
          typeof reference === 'string' &&
          !source.messages.some(
            (message) => message.id === reference || message.artifactIds.includes(reference)
          )
      )
      const helpers = new Set(
        scenes.flatMap((scene) =>
          scene.panels.flatMap((panel) =>
            panel.script === input.path ||
            (input.shared && Array.isArray(panel.use) && panel.use.includes(input.path))
              ? Array.isArray(panel.use)
                ? panel.use
                : []
              : []
          )
        )
      )
      return infer(
        source,
        RESEARCH_VIDEO_ANIMATION_PROMPT + '\n\n' + kit,
        {
          source: {
            ...source,
            messages: source.messages.filter(
              (message) =>
                unresolvedCitation ||
                references.has(message.i) ||
                references.has(message.id) ||
                message.artifactIds.some((id) => references.has(id))
            )
          },
          ...input,
          spec: { ...input.spec, scenes },
          sharedFiles: Object.fromEntries(
            Object.entries(input.sharedFiles).filter(([path]) => helpers.has(path))
          ),
          correction
        },
        signal
      )
    }
  }
}

/** Author one frozen source, with one bounded correction and drained parallel animation requests. */
export async function authorResearchFilmSource(options: {
  source: ResearchVideoSessionSource
  directory: string
  author: ResearchFilmAuthor
  signal: AbortSignal
  checkpoint?: FilmAuthoringCheckpoint
  onAnimations?: (completed: number, total: number) => void
}): Promise<{ specPath: string; title: string }> {
  const { source, directory, author, signal } = options
  signal.throwIfAborted()
  if (source.provenance.mode === 'operation-replay') {
    if (!author.writeReplay) throw new Error('Operation replay authoring is unavailable.')
    const spec = await writeWithResearchFilmCorrection(
      (correction) => author.writeReplay!(source, signal, correction),
      (output) => parseReplayCase(output, source),
      signal,
      options.checkpoint,
      `${REPLAY_RUNTIME_VERSION}:case`
    )
    const specPath = join(directory, 'video.json')
    await writeFile(specPath, JSON.stringify(spec), { flag: 'wx', mode: 0o600, signal })
    return { specPath, title: spec.title }
  }
  const filesDirectory = join(directory, 'files')
  // Inspect host storage outside model correction. Only staged, portable asset names reach prompts.
  const entries = await readdir(filesDirectory, { recursive: true, withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    }
  )
  const stagedFiles = new Set(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(filesDirectory, join(entry.parentPath, entry.name)).split(sep).join('/')
      )
  )
  const spec = await writeWithResearchFilmCorrection(
    (correction) => author.writeScreenplay(source, signal, correction),
    (output) => {
      const parsed = parseResearchVideoScreenplay(output, source.messages.length)
      const lastScene = parsed.scenes.at(-1)!
      // Older illustration screenplays have no scene roles. Supply the fixed
      // user-profile sign-off when resuming one through the generation path.
      if (lastScene.role === undefined) {
        if (lastScene.panels.at(-1)?.type === 'end_card') lastScene.role = 'outro'
        else
          parsed.scenes.push({
            id: 'outro',
            role: 'outro',
            msg: lastScene.msg,
            lines: [{ caption: 'Made with Open-Science.' }],
            panels: [{ type: 'end_card' }]
          })
      } else if (lastScene.role !== 'outro' || lastScene.panels.at(-1)?.type !== 'end_card')
        throw new Error('Finish with an outro scene whose final panel is an end_card.')
      researchVideoAnimationPlan(parsed)
      if (parsed.libs || parsed.assets || parsed.subjects)
        throw new Error(
          'External libraries and asset bundles are not supported by this authoring surface yet'
        )
      const voice = parsed.voice as { voice?: unknown; speed?: unknown } | undefined
      if (
        voice &&
        ((voice.voice !== undefined && voice.voice !== 'af_heart') ||
          (voice.speed !== undefined && voice.speed !== 1))
      )
        throw new Error('This version supports af_heart English narration at speed 1 only')
      const assets = new Set<unknown>([parsed.start_file])
      for (const scene of parsed.scenes) {
        assets.add(scene.file)
        for (const panel of scene.panels) {
          assets.add(panel.file)
          assets.add(panel.csv)
          if (Array.isArray(panel.data)) for (const file of panel.data) assets.add(file)
        }
      }
      for (const file of assets) {
        signal.throwIfAborted()
        if (file === undefined) continue
        if (typeof file !== 'string' || !stagedFiles.has(file))
          throw new Error(
            'Reference only files staged in the supplied session; omit unavailable assets.'
          )
      }
      return parsed
    },
    signal,
    options.checkpoint
  )
  await writeResearchVideoAnimations(
    spec,
    directory,
    author.writeAnimation
      ? (input, signal, correction) => author.writeAnimation!(source, input, signal, correction)
      : undefined,
    signal,
    options.checkpoint,
    options.onAnimations
  )
  signal.throwIfAborted()
  const specPath = join(directory, 'video.json')
  await writeFile(specPath, JSON.stringify(spec), { flag: 'wx', mode: 0o600, signal })
  return { specPath, title: spec.title }
}

/** Complete source-to-player pipeline. Storage publication and model leases remain host-owned. */
export async function generateResearchFilm(
  options: Parameters<typeof authorResearchFilmSource>[0] & {
    generate: import('./generation.js').ResearchVideoGenerate
    modelDirectory: string
    modelRevision: string
    engineDirectory: string
    onProgress?: (progress: import('./progress.js').ResearchVideoStep) => void
  }
): Promise<import('./generation.js').ResearchVideoGenerationResult & { title: string }> {
  options.onProgress?.({ phase: 'writing' })
  const { specPath, title } = await authorResearchFilmSource(options)
  options.signal.throwIfAborted()
  options.onProgress?.({ phase: 'loading' })
  const result = await options.generate(
    {
      specPath,
      mode: options.source.provenance.mode,
      retainNarration: Boolean(options.checkpoint),
      modelDirectory: options.modelDirectory,
      engineDirectory: options.engineDirectory,
      outputDirectory: join(options.directory, 'output'),
      provenance: {
        ...options.source.provenance,
        kind: 'session-source-snapshot',
        modelRevision: options.modelRevision
      }
    },
    options.signal,
    options.onProgress
  )
  return { ...result, title }
}
