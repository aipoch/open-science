import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import {
  researchVideoPresentationRequestSchema,
  researchVideoStatusRequestSchema,
  type ResearchVideoStatusRequest,
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

import {
  researchFilmScopeKey as scopeKey,
  readStoredResearchFilm,
  deleteStoredResearchFilms
} from './stored-presentation'

export type ResearchVideoPresentationOwner = {
  status(request: ResearchVideoStatusRequest): Promise<ResearchVideoPresentationStatus>
  start(request: ResearchVideoPresentationRequest): Promise<ResearchVideoPresentationStatus>
  remove(request: ResearchVideoPresentationRequest): Promise<ResearchVideoPresentationStatus>
  cancel(request: ResearchVideoPresentationRequest): void
  close(): Promise<void>
}

/** User-initiated derived presentations live separately from immutable imported conversation history. */
export function createResearchVideoPresentationOwner(options: {
  dataRoot(): string
  mutate?: <T>(request: ResearchVideoPresentationRequest, work: () => Promise<T>) => Promise<T>
  checkReadiness?: () => Promise<void>
  models: LocalModelOwner
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  writeScreenplay: ResearchFilmAuthor['writeScreenplay']
  writeAnimation?: ResearchFilmAuthor['writeAnimation']
  generate: ReturnType<typeof createResearchVideoGenerator>
  engineDirectory: string
  loadImportedFilm?: (
    request: ResearchVideoPresentationRequest,
    options?: { includeUnavailable?: boolean }
  ) => Promise<ResearchVideoPresentationStatus['result']>
  lifecycle?: ResearchFilmLifecycle
}): ResearchVideoPresentationOwner {
  let removing = false
  let closed = false
  let operationRevision = 0
  let active:
    | { key: string; controller: AbortController; done: Promise<void>; prepared: Promise<void> }
    | undefined
  const states = new Map<string, ResearchVideoPresentationStatus>()
  const preflights = new Map<string, symbol>()
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
    rawRequest: ResearchVideoStatusRequest
  ): Promise<ResearchVideoPresentationStatus> => {
    const { checkReadiness, ...request } = researchVideoStatusRequestSchema.parse(rawRequest),
      key = scopeKey(request)
    const revision = operationRevision
    const state = structuredClone(states.get(key) ?? {})
    const session = await options.loadSession(request.projectId, request.sessionId)
    const block = researchVideoGenerationBlock(session, request)
    if (block === 'unavailable') return { generationBlock: block }
    if (block) state.generationBlock = block
    if (checkReadiness && !block && !active && !closed && !removing) {
      const probe = Symbol()
      preflights.set(key, probe)
      delete state.preflightError
      try {
        const source = researchVideoSessionSource(session!, request)
        await stageResearchVideoSessionImages(
          source,
          session!,
          options.dataRoot(),
          undefined,
          new AbortController().signal
        )
        await options.checkReadiness?.()
        const snapshot = await options.models.getSnapshot()
        if (snapshot.availability === 'ready' && !snapshot.updateAvailable) {
          const lease = await options.models.acquireUse()
          lease.release()
        }
      } catch (error) {
        state.preflightError = error instanceof Error ? error.message : String(error)
      }
      const currentProbe = preflights.get(key) === probe
      if (currentProbe) preflights.delete(key)
      // A newer probe or mutation owns the status. Do not restart work after disposal.
      if (!currentProbe || revision !== operationRevision) return status(request)
      states.set(key, { ...states.get(key), preflightError: state.preflightError })
    }
    const result =
      (await readStoredResearchFilm(options.dataRoot(), request)) ??
      (session?.packageOrigin || session?.forkOrigin
        ? await options.loadImportedFilm?.(request)
        : undefined)
    return result ? { ...state, result } : state
  }

  const run = async (
    request: ResearchVideoPresentationRequest,
    key: string,
    signal: AbortSignal,
    prepared: () => void
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
    let admitted = false
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
      let source = researchVideoSessionSource(session, request)
      await stageResearchVideoSessionImages(source, session, options.dataRoot(), undefined, signal)
      await options.checkReadiness?.()
      signal.throwIfAborted()
      lease = await options.models.acquireUse()
      signal.throwIfAborted()
      const model = lease.assets.find((asset) => asset.file === 'model_quantized.onnx')
      if (!model) throw new Error('Install the research narration model before generating.')
      admitted = true
      report({ phase: 'preparing' })
      prepared()
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
      states.set(
        key,
        !admitted && !signal.aborted
          ? {
              preflightError: error instanceof Error ? error.message : String(error)
            }
          : {
              progress: {
                phase: signal.aborted ? 'cancelled' : 'failed',
                startedAt,
                endedAt: Date.now()
              },
              ...(!signal.aborted
                ? { error: error instanceof Error ? error.message : String(error) }
                : {})
            }
      )
    } finally {
      prepared()
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
      if (removing) throw new Error('Research film deletion is in progress.')
      if (closed) throw new Error('Research presentation generation is closed.')
      if (active) {
        if (active.key === key) {
          await active.prepared
          return status(request)
        }
        throw new Error('Another research explanation is being generated. Wait for it to finish.')
      }
      operationRevision++
      const controller = new AbortController()
      let finishPreparation!: () => void
      const prepared = new Promise<void>((resolve) => {
        finishPreparation = resolve
      })
      const operation = options.lifecycle
        ? options.lifecycle.run(request.projectId, request.sessionId, (signal) =>
            run(request, key, AbortSignal.any([signal, controller.signal]), finishPreparation)
          )
        : run(request, key, controller.signal, finishPreparation)
      const done = operation
        .catch((error) => {
          states.set(key, { error: error instanceof Error ? error.message : String(error) })
        })
        .finally(() => {
          finishPreparation()
          active = undefined
        })
      active = { key, controller, done, prepared }
      await prepared
      return status(request)
    },
    async remove(rawRequest) {
      const request = researchVideoPresentationRequestSchema.parse(rawRequest)
      if (closed || active || removing)
        throw new Error('Wait for the current research film operation to finish.')
      operationRevision++
      removing = true
      const work = async (): Promise<ResearchVideoPresentationStatus> => {
        const session = await options.loadSession(request.projectId, request.sessionId)
        if (!session || researchVideoGenerationBlock(session, request) === 'unavailable')
          throw new Error('Research session is unavailable.')
        const graph = session.conversationGraph
        const branchId =
          request.branchId ??
          graph?.frames.find((frame) => frame.id === graph.rootFrameId)?.activeBranchId
        const scope = { ...request, branchId }
        const imported = await options.loadImportedFilm?.(scope, { includeUnavailable: true })
        await deleteStoredResearchFilms(options.dataRoot(), scope, imported?.id)
        states.delete(scopeKey(request))
        states.delete(scopeKey(scope))
        return status(request)
      }
      try {
        return await (options.mutate ? options.mutate(request, work) : work())
      } finally {
        removing = false
      }
    },
    cancel(rawRequest: ResearchVideoPresentationRequest): void {
      const key = scopeKey(researchVideoPresentationRequestSchema.parse(rawRequest))
      if (active?.key === key) active.controller.abort(new Error('Research explanation cancelled.'))
    },
    async close(): Promise<void> {
      operationRevision++
      closed = true
      active?.controller.abort(new Error('Application is closing.'))
      await active?.done
    }
  }
}
