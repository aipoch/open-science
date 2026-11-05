import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseResearchVideoScreenplay,
  RESEARCH_VIDEO_ANIMATION_PROMPT,
  RESEARCH_VIDEO_SCREENPLAY_PROMPT
} from './screenplay.js'
import {
  writeResearchVideoAnimations,
  type ResearchVideoAnimationInput
} from './animation-authoring.js'
import type { ResearchVideoSessionSource } from './source.js'
import { researchFilmResources } from './resources.js'

type Correction = { draft: string; error: string }
export type ResearchFilmAuthor = {
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
      return infer(
        source,
        RESEARCH_VIDEO_ANIMATION_PROMPT + '\n\n' + kit,
        { source, ...input, correction },
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
  onAnimations?: () => void
}): Promise<{ specPath: string; title: string }> {
  const { source, directory, author, signal } = options
  signal.throwIfAborted()
  const output = await author.writeScreenplay(source, signal)
  signal.throwIfAborted()
  let spec: ReturnType<typeof parseResearchVideoScreenplay>
  try {
    spec = parseResearchVideoScreenplay(output, source.messages.length)
  } catch (error) {
    signal.throwIfAborted()
    const corrected = await author.writeScreenplay(source, signal, {
      draft: output,
      error: error instanceof Error ? error.message : String(error)
    })
    signal.throwIfAborted()
    spec = parseResearchVideoScreenplay(corrected, source.messages.length)
  }
  options.onAnimations?.()
  await writeResearchVideoAnimations(
    spec,
    directory,
    author.writeAnimation
      ? (input, signal, correction) => author.writeAnimation!(source, input, signal, correction)
      : undefined,
    signal
  )
  signal.throwIfAborted()
  const specPath = join(directory, 'video.json')
  await writeFile(specPath, JSON.stringify(spec), { flag: 'wx', mode: 0o600, signal })
  return { specPath, title: spec.title }
}

/** Complete source-to-player pipeline. Storage publication and model leases remain host-owned. */
export async function generateResearchFilm(
  options: Parameters<typeof authorResearchFilmSource>[0] & {
    generate: ReturnType<typeof import('./generation.js').createResearchVideoGenerator>
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
