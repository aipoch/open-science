import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { readFileWithinLimit, writeDurableJsonFile } from '@aipoch/durable-files'
import {
  researchVideoPresentationRequestSchema,
  type ResearchVideoPresentationRequest,
  type ResearchVideoPresentationStatus
} from '../../shared/research-video-presentation'
import type { ResearchVideoStep } from '@aipoch/research-film/contracts'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { LocalModelOwner } from '../local-models/owner'
import type { createResearchVideoGenerator } from '@aipoch/research-film'
import { researchVideoSessionSource, researchVideoGenerationBlock } from './session-source'
import { generateResearchFilm, type ResearchFilmAuthor } from '@aipoch/research-film'
import { createLogger } from '@aipoch/diagnostics/node'
const log = createLogger('research-video')
import { stageResearchVideoSessionImages } from './session-images'
import type { ResearchFilmLifecycle } from './lifecycle'

const receiptSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(160),
    duration: z.number().positive()
  })
  .strict()
const scopeKey = (request: ResearchVideoPresentationRequest): string =>
  createHash('sha256')
    .update(JSON.stringify([request.projectId, request.sessionId, request.branchId ?? null]))
    .digest('hex')

export type ResearchVideoPresentationOwner = {
  status(request: ResearchVideoPresentationRequest): Promise<ResearchVideoPresentationStatus>
  start(request: ResearchVideoPresentationRequest): Promise<ResearchVideoPresentationStatus>
  cancel(request: ResearchVideoPresentationRequest): void
  close(): Promise<void>
}

/** User-initiated derived presentations live separately from immutable imported conversation history. */
export function createResearchVideoPresentationOwner(options: {
  dataRoot(): string
  models: LocalModelOwner
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  writeScreenplay: ResearchFilmAuthor['writeScreenplay']
  writeAnimation?: ResearchFilmAuthor['writeAnimation']
  generate: ReturnType<typeof createResearchVideoGenerator>
  engineDirectory: string
  lifecycle?: ResearchFilmLifecycle
}): ResearchVideoPresentationOwner {
  let closed = false
  let active: { key: string; controller: AbortController; done: Promise<void> } | undefined
  const states = new Map<string, ResearchVideoPresentationStatus>()
  const directory = async (key: string, create = false): Promise<string | undefined> => {
    let current = options.dataRoot()
    for (const part of ['research-video-presentations', key]) {
      current = join(current, part)
      if (create)
        await mkdir(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        })
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (!info) return undefined
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Unsafe research presentation directory.')
    }
    return current
  }
  const status = async (
    rawRequest: ResearchVideoPresentationRequest
  ): Promise<ResearchVideoPresentationStatus> => {
    const request = researchVideoPresentationRequestSchema.parse(rawRequest),
      key = scopeKey(request)
    const state = structuredClone(states.get(key) ?? {})
    const block = researchVideoGenerationBlock(
      await options.loadSession(request.projectId, request.sessionId),
      request
    )
    if (block === 'unavailable') return { generationBlock: block }
    if (block) state.generationBlock = block
    const base = await directory(key)
    if (!base) return state
    const path = join(base, 'latest.json')
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!info) return state
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Unsafe research presentation receipt.')
    const receipt = receiptSchema.parse(JSON.parse(await readFileWithinLimit(path, 4096)))
    const output = join(base, receipt.id, 'output')
    for (const path of [join(base, receipt.id), output]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Unsafe research presentation directory.')
    }
    for (const name of ['player.html', 'sources.zip']) {
      const file = await lstat(join(output, name))
      if (!file.isFile() || file.isSymbolicLink())
        throw new Error('Research presentation is unavailable.')
    }
    return {
      ...state,
      result: {
        ...receipt,
        playerPath: join(output, 'player.html'),
        sourcePath: join(output, 'sources.zip')
      }
    }
  }
  const run = async (
    request: ResearchVideoPresentationRequest,
    key: string,
    signal: AbortSignal
  ): Promise<void> => {
    const startedAt = Date.now()
    const started = performance.now()
    const stageMs: Record<string, number> = {}
    let stage = 'preparing',
      stageStarted = started
    const measure = (next: string): void => {
      if (next === stage) return
      const now = performance.now()
      stageMs[stage] = (stageMs[stage] ?? 0) + now - stageStarted
      stage = next
      stageStarted = now
    }
    const report = (step: ResearchVideoStep): void => {
      measure(step.phase)
      states.set(key, { progress: { ...step, startedAt } })
    }
    report({ phase: 'preparing' })
    let lease: Awaited<ReturnType<LocalModelOwner['acquireUse']>> | undefined
    let job: string | undefined
    let completed = false
    try {
      const session = await options.loadSession(request.projectId, request.sessionId)
      signal.throwIfAborted()
      if (!session) throw new Error('Research session is unavailable.')
      const block = researchVideoGenerationBlock(session, request)
      if (block)
        throw new Error(
          block === 'busy'
            ? 'Wait for the current response to finish before generating.'
            : block === 'awaiting-reply'
              ? 'Wait for a completed response before generating.'
              : block === 'empty'
                ? 'Add conversation content before generating.'
                : 'Research session is unavailable.'
        )
      lease = await options.models.acquireUse()
      signal.throwIfAborted()
      let source = researchVideoSessionSource(session, request)
      const base = (await directory(key, true))!
      const id = randomUUID()
      job = join(base, id)
      await mkdir(job)
      await mkdir(join(job, 'files'))
      await writeFile(join(job, 'session.json'), JSON.stringify(source), {
        flag: 'wx',
        mode: 0o600
      })
      source = await stageResearchVideoSessionImages(
        source,
        session,
        options.dataRoot(),
        join(job, 'files'),
        signal
      )
      await writeDurableJsonFile(join(job, 'session.json'), JSON.stringify(source))
      const model = lease.assets.find((asset) => asset.file === 'model_quantized.onnx')
      if (!model) throw new Error('Install the research narration model before generating.')
      const generated = await generateResearchFilm({
        source,
        directory: job,
        author: options,
        signal,
        onAnimations: () => measure('animations'),
        generate: options.generate,
        modelDirectory: dirname(model.path),
        modelRevision: lease.revision,
        engineDirectory: options.engineDirectory,
        onProgress: report
      })
      signal.throwIfAborted()
      // Recheck existence after the long job; deleting a session must not publish an orphan result.
      if (!(await options.loadSession(request.projectId, request.sessionId)))
        throw new Error('Research session was removed during generation.')
      report({ phase: 'publishing' })
      await writeDurableJsonFile(
        join(base, 'latest.json'),
        JSON.stringify({ id, title: generated.title, duration: generated.duration })
      )
      completed = true
      states.delete(key)
    } catch (error) {
      states.set(key, {
        progress: { phase: signal.aborted ? 'cancelled' : 'failed', startedAt },
        ...(!signal.aborted
          ? { error: error instanceof Error ? error.message : String(error) }
          : {})
      })
    } finally {
      measure('finished')
      log.info('generation timing', {
        outcome: completed ? 'completed' : signal.aborted ? 'cancelled' : 'failed',
        totalMs: Math.round(performance.now() - started),
        stagesMs: Object.fromEntries(
          Object.entries(stageMs).map(([name, ms]) => [name, Math.round(ms)])
        )
      })
      if (job && !completed) await rm(job, { recursive: true, force: true }).catch(() => {})
      lease?.release()
    }
  }
  return {
    status,
    async start(
      rawRequest: ResearchVideoPresentationRequest
    ): Promise<ResearchVideoPresentationStatus> {
      const request = researchVideoPresentationRequestSchema.parse(rawRequest),
        key = scopeKey(request)
      if (closed) throw new Error('Research presentation generation is closed.')
      if (active) {
        if (active.key === key) return status(request)
        throw new Error('Another research explanation is being generated. Wait for it to finish.')
      }
      const controller = new AbortController()
      const operation = options.lifecycle
        ? options.lifecycle.run(request.projectId, request.sessionId, (signal) =>
            run(request, key, AbortSignal.any([signal, controller.signal]))
          )
        : run(request, key, controller.signal)
      const done = operation
        .catch((error) => {
          states.set(key, { error: error instanceof Error ? error.message : String(error) })
        })
        .finally(() => {
          active = undefined
        })
      active = { key, controller, done }
      return status(request)
    },
    cancel(rawRequest: ResearchVideoPresentationRequest): void {
      const key = scopeKey(researchVideoPresentationRequestSchema.parse(rawRequest))
      if (active?.key === key) active.controller.abort(new Error('Research explanation cancelled.'))
    },
    async close(): Promise<void> {
      closed = true
      active?.controller.abort(new Error('Application is closing.'))
      await active?.done
    }
  }
}
