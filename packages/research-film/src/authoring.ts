import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  parseResearchVideoScreenplay,
  RESEARCH_VIDEO_ANIMATION_PROMPT,
  RESEARCH_VIDEO_SCREENPLAY_PROMPT,
  type ResearchVideoScreenplay
} from './screenplay.js'
import {
  writeResearchVideoAnimations,
  researchVideoAnimationPlan,
  type ResearchVideoAnimationInput
} from './animation-authoring.js'
import type { ResearchVideoSessionSource } from './source.js'
import type { FilmVisualIssue } from './visual-review.js'
import type { VideoSpec } from './timeline.js'
import { researchFilmResources } from './resources.js'
import {
  checkFilmScript,
  FILM_SCRIPT_REVIEW_PROMPT,
  scoreFilmScript,
  type FilmNarration
} from './script-review.js'
import { parseReplayCase, REPLAY_AUTHORING_PROMPT, REPLAY_RUNTIME_VERSION } from './replay-case.js'
import {
  writeWithResearchFilmCorrection,
  type FilmAuthoringCheckpoint,
  type ResearchFilmCorrection as Correction
} from './authoring-correction.js'

export type ResearchFilmAuthor = {
  reviewScript?(
    source: ResearchVideoSessionSource,
    narration: FilmNarration,
    warnings: string[],
    signal: AbortSignal,
    correction?: Correction
  ): Promise<string>
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
  const standard = (): Promise<string> =>
    readFile(join(researchFilmResources().authoringDirectory, 'SCRIPT.md'), 'utf8')
  return {
    reviewScript: async (source, narration, warnings, signal, correction) =>
      infer(
        source,
        FILM_SCRIPT_REVIEW_PROMPT + '\n\n' + (await standard()),
        { source, narration, warnings, correction },
        signal
      ),
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
    writeScreenplay: async (source, signal, correction) =>
      infer(
        source,
        RESEARCH_VIDEO_SCREENPLAY_PROMPT + '\n\n' + (await standard()),
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
  visualIssues?: FilmVisualIssue[]
  reviewedScripts?: ReadonlyMap<string, string>
  drawSessionApp?: 'switch' | 'continue'
  onAnimations?: (completed: number, total: number) => void
}): Promise<{ specPath: string; title: string; spec?: VideoSpec; scriptScore?: number }> {
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
  const layoutIssues = options.visualIssues?.filter((issue) => !issue.script)
  let previous = layoutIssues?.length ? await options.checkpoint?.read('screenplay') : undefined
  // Layout repairs preserve approved narration. Later script repairs preserve the
  // latest visual fields and change only narration and its existing timing cues.
  const mergeRepair = (output: string, narration: boolean): string => {
    if (!previous || !layoutIssues?.length) return output
    const parse = (
      raw: string
    ): {
      scenes: {
        id?: string
        panels: VideoSpec['scenes'][number]['panels']
        layout?: unknown
        highlight?: unknown
        lines: VideoSpec['scenes'][number]['lines']
      }[]
    } => JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, '$1'))
    const original = parse(previous)
    const revised = parse(output)
    for (const [i, scene] of original.scenes.entries()) {
      if (
        !narration &&
        !layoutIssues.some((issue) => issue.scene === (scene.id ?? `scene-${i + 1}`))
      )
        continue
      const replacement = scene.id
        ? revised.scenes.find((item) => item.id === scene.id)
        : revised.scenes[i]
      if (!replacement) throw new Error('Return the affected scene with its original id.')
      if (narration) {
        scene.lines = replacement.lines
        const cueError = 'Keep the existing panels and items when rewriting narration and cues.'
        if (scene.panels.length !== replacement.panels.length) throw new Error(cueError)
        for (const [index, panel] of scene.panels.entries()) {
          const revisedPanel = replacement.panels[index]
          if (panel.type !== revisedPanel.type) throw new Error(cueError)
          panel.at = revisedPanel.at
          panel.until = revisedPanel.until
          for (const field of ['note_at', 'badge_at', 'total_at', 'foot_at'])
            panel[field] = revisedPanel[field]
          for (const field of ['items', 'rows', 'marks', 'elements'] as const) {
            const items = panel[field]
            if (!items) continue
            const revisedItems = revisedPanel[field]
            if (items.length !== revisedItems?.length) throw new Error(cueError)
            for (const [itemIndex, item] of items.entries()) item.at = revisedItems[itemIndex].at
          }
          for (const field of ['left', 'right', 'band'] as const) {
            const item = panel[field]
            if (!item) continue
            if (!revisedPanel[field]) throw new Error(cueError)
            item.at = revisedPanel[field].at
          }
        }
        continue
      }
      scene.panels = replacement.panels
      for (const field of ['layout', 'highlight'] as const) scene[field] = replacement[field]
      for (const issue of layoutIssues)
        if (issue.scene === scene.id && issue.line !== undefined && replacement.lines[issue.line])
          scene.lines[issue.line] = replacement.lines[issue.line]
    }
    return JSON.stringify(original)
  }
  const writeSpec = async (
    feedback?: string,
    narration = false
  ): Promise<ResearchVideoScreenplay> => {
    const result = await writeWithResearchFilmCorrection(
      (correction) => author.writeScreenplay(source, signal, correction),
      (output) => {
        const parsed = parseResearchVideoScreenplay(
          mergeRepair(output, narration),
          source.messages.length
        )
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
        if (author.reviewScript) checkFilmScript(parsed)
        researchVideoAnimationPlan(parsed)
        const libs = parsed.libs
        if (
          (libs !== undefined &&
            !(
              source.sessionApp &&
              !options.drawSessionApp &&
              Array.isArray(libs) &&
              libs.length === 1 &&
              libs[0] === 'libs/app.js'
            )) ||
          parsed.assets ||
          parsed.subjects
        )
          throw new Error(
            'Use only the approved session app, when supplied, as libs:["libs/app.js"]. External libraries and asset bundles are not supported.'
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
      previous && options.checkpoint
        ? {
            read: options.checkpoint.read,
            save: (key, value) => options.checkpoint!.save(key, mergeRepair(value, narration))
          }
        : options.checkpoint,
      'screenplay',
      feedback
    )
    if (previous) previous = JSON.stringify(result)
    return result
  }
  const layoutFeedback = layoutIssues
    ?.map((issue) => `Scene ${issue.scene}: ${issue.message}`)
    .join('\n')
  let spec = await writeSpec(
    layoutFeedback ||
      (options.drawSessionApp === 'switch'
        ? 'The session app could not run. Omit libs and use a self-contained drawing of the subject. Keep the source facts and approved narration.'
        : undefined)
  )
  let scriptScore: number | undefined
  if (author.reviewScript) {
    for (let pass = 0; ; pass++) {
      const review = await scoreFilmScript(
        spec,
        (lines, warnings, correction) =>
          author.reviewScript!(source, lines, warnings, signal, correction),
        signal,
        options.checkpoint
      )
      if (!review.findings.length) {
        scriptScore = review.score
        break
      }
      const feedback = `Narration review (${review.score}/9). Rewrite the failing lines and adjust their cues.\n${review.findings.join('\n')}`
      if (pass >= 3) throw new Error(feedback)
      spec = await writeSpec(
        previous
          ? `${feedback}\nKeep the existing scenes, panels, and visual layout. Change only narration and timing cues.`
          : feedback,
        true
      )
    }
  }
  await writeResearchVideoAnimations(
    spec,
    directory,
    author.writeAnimation
      ? (input, signal, correction) => author.writeAnimation!(source, input, signal, correction)
      : undefined,
    signal,
    options.checkpoint,
    options.onAnimations,
    options.visualIssues,
    options.reviewedScripts
  )
  signal.throwIfAborted()
  const specPath = join(directory, 'video.json')
  await writeFile(specPath, JSON.stringify(spec), { flag: 'wx', mode: 0o600, signal })
  return { specPath, title: spec.title, spec, scriptScore }
}

/** Complete source-to-player pipeline. Storage publication and model leases remain host-owned. */
export async function generateResearchFilm(
  options: Parameters<typeof authorResearchFilmSource>[0] & {
    generate: import('./generation.js').ResearchVideoGenerate
    modelDirectory: string
    modelRevision: string
    drawnSessionApp?: boolean
    engineDirectory: string
    onProgress?: (progress: import('./progress.js').ResearchVideoStep) => void
    reviewPlayer?: (
      source: ResearchVideoSessionSource,
      playerPath: string,
      spec: VideoSpec,
      signal: AbortSignal
    ) => Promise<FilmVisualIssue[]>
  }
): Promise<
  import('./generation.js').ResearchVideoGenerationResult & {
    title: string
    scriptScore?: number
    usedSessionApp?: boolean
  }
> {
  options.onProgress?.({ phase: 'writing' })
  // A checked draft may need a second build. Keep authoring units available between passes,
  // including for callers without persistent recovery storage.
  const memory = new Map<string, string>()
  const checkpoint = options.checkpoint ?? {
    read: async (key: string) => memory.get(key),
    save: async (key: string, value: string) => {
      memory.set(key, value)
    }
  }
  const review = options.source.provenance.mode !== 'operation-replay' && options.reviewPlayer
  let visualIssues: FilmVisualIssue[] = []
  let drawSessionApp = false
  const reviewedScripts = new Map<string, string>()
  for (let pass = 0; ; pass++) {
    const { specPath, title, spec, scriptScore } = await authorResearchFilmSource({
      ...options,
      checkpoint,
      visualIssues,
      reviewedScripts,
      drawSessionApp: drawSessionApp ? (pass === 0 ? 'switch' : 'continue') : undefined,
      onAnimations: pass ? undefined : options.onAnimations
    })
    options.signal.throwIfAborted()
    if (pass === 0) options.onProgress?.({ phase: 'loading' })
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
          ...(scriptScore !== undefined && { scriptScore }),
          ...(options.drawnSessionApp && { sessionAppMode: 'drawn' }),
          modelRevision: options.modelRevision
        }
      },
      options.signal,
      pass === 0 ? options.onProgress : undefined
    )
    const usedSessionApp = Boolean(
      spec && 'libs' in spec && Array.isArray(spec.libs) && spec.libs.includes('libs/app.js')
    )
    if (!review || !spec) return { ...result, title, scriptScore, usedSessionApp }
    options.onProgress?.({ phase: 'verifying' })
    visualIssues = await review(options.source, result.playerPath, spec, options.signal)
    options.signal.throwIfAborted()
    if (!visualIssues.length) return { ...result, title, scriptScore, usedSessionApp }
    const useDrawing = usedSessionApp && (visualIssues.some((i) => i.app) || pass >= 3)
    if (pass >= 3 && !useDrawing)
      throw new Error(
        'The HTML film still needs visual repairs. ' +
          visualIssues
            .slice(0, 6)
            .map((issue) => `${issue.scene}: ${issue.message}`)
            .join(' ')
      )
    options.onProgress?.({ phase: 'repairing' })
    const { shared, scripts } = researchVideoAnimationPlan(spec)
    reviewedScripts.clear()
    if (useDrawing) {
      drawSessionApp = true
      visualIssues = []
      pass = -1
    } else
      for (const name of [...shared, ...scripts])
        reviewedScripts.set(
          name,
          await readFile(join(options.directory, name), {
            encoding: 'utf8',
            signal: options.signal
          })
        )

    // These are private staging files. Narration and authoring checkpoints survive rebuilding.
    for (const name of ['output', 'video.json', 'anims']) {
      options.signal.throwIfAborted()
      await rm(join(options.directory, name), { recursive: true, force: true })
    }
  }
}
