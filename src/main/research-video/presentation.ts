import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import {
  researchVideoPresentationRequestSchema,
  researchVideoStatusRequestSchema,
  researchVideoStartRequestSchema,
  type ResearchVideoStartRequest,
  type ResearchVideoStatusRequest,
  type ResearchVideoPresentationRequest,
  type ResearchVideoPresentationStatus
} from '../../shared/research-video-presentation'
import type { ResearchVideoStep } from '@aipoch/research-film/contracts'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { LocalModelOwner, createLocalModelOwner } from '../local-models/owner'
import type { createResearchVideoGenerator } from '@aipoch/research-film'
import { researchVideoSessionSource, researchVideoGenerationBlock } from './session-source'
import {
  generateResearchFilm,
  ResearchVideoWorkerError,
  type ResearchFilmAuthor
} from '@aipoch/research-film'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
const log = createLogger('research-video')
import {
  filmConversationDigest,
  readPendingFilm,
  savePendingFilm,
  digestFilmInput,
  filmAuthoringCheckpoint,
  removePendingPointer,
  type PendingFilm
} from './checkpoint'
import { stageResearchVideoSessionImages } from './session-images'
import type { ResearchFilmLifecycle } from './lifecycle'

import {
  researchFilmScopeKey as scopeKey,
  readStoredResearchFilm,
  deleteStoredResearchFilms
} from './stored-presentation'

const filmAttempt = new AsyncLocalStorage<{
  operationId: string
  attempt: number
  invocationId: string
}>()
export const currentFilmAttempt = (): ReturnType<typeof filmAttempt.getStore> =>
  filmAttempt.getStore()

export type ResearchVideoPresentationOwner = {
  status(request: ResearchVideoStatusRequest): Promise<ResearchVideoPresentationStatus>
  start(request: ResearchVideoStartRequest): Promise<ResearchVideoPresentationStatus>
  remove(request: ResearchVideoPresentationRequest): Promise<ResearchVideoPresentationStatus>
  cancel(request: ResearchVideoPresentationRequest): void
  close(): Promise<void>
}

/** User-initiated derived presentations live separately from immutable imported conversation history. */
export function createResearchVideoPresentationOwner(options: {
  dataRoot(): string
  mutate?: <T>(request: ResearchVideoPresentationRequest, work: () => Promise<T>) => Promise<T>
  checkReadiness?: () => Promise<void>
  models: Pick<
    ReturnType<typeof createLocalModelOwner>,
    'acquireUse' | 'getSnapshot' | 'installForUse'
  >
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
  let installingKey: string | undefined
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
    if (installingKey === key) state.narrationDownload = await options.models.getSnapshot()
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
        if (state.preflightError !== states.get(key)?.preflightError)
          log.info('film preflight failed', {
            sessionId: request.sessionId,
            ...diagnosticErrorFields(error)
          })
      }
      const currentProbe = preflights.get(key) === probe
      if (currentProbe) preflights.delete(key)
      // A newer probe or mutation owns the status. Do not restart work after disposal.
      if (!currentProbe || revision !== operationRevision) return status(request)
      states.set(key, { ...states.get(key), preflightError: state.preflightError })
    }
    const branchId =
      request.branchId ??
      session?.conversationGraph?.frames.find(
        (frame) => frame.id === session?.conversationGraph?.rootFrameId
      )?.activeBranchId
    const scope = { ...request, branchId }
    const result =
      (await readStoredResearchFilm(options.dataRoot(), scope)) ??
      (branchId !== request.branchId
        ? await readStoredResearchFilm(options.dataRoot(), request)
        : undefined) ??
      (session?.packageOrigin || session?.forkOrigin
        ? await options.loadImportedFilm?.(request)
        : undefined)
    if (!active && session && !block) {
      const base = await directory(scopeKey(scope))
      const saved = base && (await readPendingFilm(base))
      if (
        saved &&
        saved.id !== result?.id &&
        saved.conversation === filmConversationDigest(researchVideoSessionSource(session, request))
      ) {
        state.canResume = true
        state.filmStep = saved.step
        state.progress ??= { phase: 'failed', startedAt: saved.startedAt, endedAt: saved.updatedAt }
        if (saved.step === 3 && saved.total)
          Object.assign(state.progress, { completed: saved.completed, total: saved.total })
      }
    }
    return result ? { ...state, result } : state
  }

  const run = async (
    request: ResearchVideoPresentationRequest,
    key: string,
    signal: AbortSignal,
    installNarration: boolean,
    resume: boolean,
    prepared: () => void
  ): Promise<void> => {
    const invocationId = randomUUID()
    const startedAt = Date.now()
    const started = performance.now()
    const stageMs: Record<string, number> = {}
    let stage = 'preparing',
      stageStarted = started
    let saved: PendingFilm | undefined
    let activeBranchId = request.branchId
    const context = (): Record<string, string | number | undefined> => ({
      invocationId,
      operationId: saved?.id ?? invocationId,
      attempt: saved?.attempt,
      sessionId: request.sessionId,
      activeBranchId
    })
    let base: string | undefined
    let writes = Promise.resolve()
    let filmStep = 1
    let replayStep = 0
    const record = (step: number, completed?: number, total?: number): void => {
      filmStep = Math.max(step, replayStep)
      if (
        step < replayStep ||
        (step === 3 && replayStep === 3 && (completed ?? 0) < (saved?.completed ?? 0))
      )
        return
      if (
        !saved ||
        !base ||
        (saved.step === step && saved.completed === completed && saved.total === total)
      )
        return
      Object.assign(saved, { step, completed, total, updatedAt: Date.now() })
      const snapshot = { ...saved },
        destination = base
      writes = writes.then(() => savePendingFilm(destination, snapshot))
      void writes.catch(() => {})
    }
    const measure = (next: string): void => {
      if (next === stage) return
      const now = performance.now()
      stageMs[stage] = (stageMs[stage] ?? 0) + now - stageStarted
      log.info('film stage finished', {
        ...context(),
        phase: stage,
        durationMs: Math.round(now - stageStarted)
      })
      stage = next
      stageStarted = now
      if (next !== 'finished') log.info('film stage started', { ...context(), phase: next })
    }
    const report = (step: ResearchVideoStep): void => {
      measure(step.phase)
      record(
        step.phase === 'preparing'
          ? 1
          : step.phase === 'writing'
            ? 2
            : ['build', 'publishing'].includes(step.phase)
              ? 5
              : 4
      )
      states.set(key, { filmStep, progress: { ...step, startedAt } })
    }
    let admitted = false
    let lease: Awaited<ReturnType<LocalModelOwner['acquireUse']>> | undefined
    let job: string | undefined
    let completed = false
    log.info('film invocation started', { ...context(), phase: stage })
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
      activeBranchId = source.provenance.branchId
      const checksums: string[] = []
      measure('images')
      await stageResearchVideoSessionImages(
        source,
        session,
        options.dataRoot(),
        undefined,
        signal,
        checksums
      )
      measure('readiness')
      await options.checkReadiness?.()
      signal.throwIfAborted()
      if (installNarration) {
        installingKey = key
        states.delete(key)
        prepared()
        measure('narration-install')
        const snapshot = await options.models.installForUse(signal)
        signal.throwIfAborted()
        if (snapshot.availability !== 'ready' || snapshot.updateAvailable) {
          log.info('film attempt stopped', {
            ...context(),
            phase: stage,
            outcome: 'failed',
            errorCategory: 'installation-incomplete'
          })
          states.set(key, { error: 'Narration installation did not finish. Retry to continue.' })
          return
        }
        const scope = { ...request, branchId: source.provenance.branchId }
        const latest = await options.loadSession(scope.projectId, scope.sessionId)
        if (researchVideoGenerationBlock(latest, scope))
          throw new Error('Research session is unavailable.')
        await options.checkReadiness?.()
        signal.throwIfAborted()
      }
      measure('narration-acquire')
      lease = await options.models.acquireUse()
      signal.throwIfAborted()
      const model = lease.assets.find((asset) => asset.file === 'model_quantized.onnx')
      if (!model) throw new Error('Install the research narration model before generating.')
      installingKey = undefined
      admitted = true
      report({ phase: 'preparing' })
      prepared()
      const scope = { ...request, branchId: source.provenance.branchId }
      base = (await directory(scopeKey(scope), true))!
      const publishBase = base
      const conversation = filmConversationDigest(source)
      const fingerprint = digestFilmInput(JSON.stringify([conversation, checksums]))
      const previous = await readPendingFilm(base)
      const published = await readStoredResearchFilm(options.dataRoot(), scope)
      job = join(base, 'pending')
      if (resume && previous?.source === fingerprint && previous.id !== published?.id) {
        saved = { ...previous, attempt: previous.attempt + 1 }
        replayStep = previous.step
      } else {
        await removePendingPointer(base)
        await rm(job, { recursive: true, force: true })
        saved = {
          version: 1,
          id: randomUUID(),
          source: fingerprint,
          conversation,
          attempt: 1,
          step: 1,
          startedAt,
          updatedAt: startedAt
        }
      }
      const id = saved.id
      log.info('film attempt started', {
        ...context(),
        step: String(saved.step),
        outcome: resume && saved.attempt > 1 ? 'resumed' : 'started'
      })

      if (!saved.built) {
        await mkdir(job, { recursive: true, mode: 0o700 })
        if (!(await lstat(job)).isDirectory())
          throw new Error('Unsafe research presentation directory.')
        await writeDurableJsonFile(join(job, 'session.json'), JSON.stringify(source))
        await savePendingFilm(base, saved)
        for (const file of ['files', 'anims', 'video.json', 'output'])
          await rm(join(job, file), { recursive: true, force: true })
        await mkdir(join(job, 'files'))
        const stagedChecksums: string[] = []
        source = await stageResearchVideoSessionImages(
          source,
          session,
          options.dataRoot(),
          join(job, 'files'),
          signal,
          stagedChecksums
        )
        if (JSON.stringify(checksums) !== JSON.stringify(stagedChecksums))
          throw new Error('Research images changed during preparation.')
        await writeDurableJsonFile(join(job, 'session.json'), JSON.stringify(source))
        const attemptContext = { operationId: id, attempt: saved.attempt, invocationId }
        const generated = await filmAttempt.run(attemptContext, () =>
          generateResearchFilm({
            source,
            directory: job!,
            author: options,
            signal,
            checkpoint: filmAuthoringCheckpoint(job!, (outcome) =>
              log.info('film authoring unit', {
                ...context(),
                phase: stage,
                outcome
              })
            ),
            onAnimations(completed, total) {
              log.info('film animation progress', {
                ...context(),
                phase: 'animations',
                index: completed,
                totalUnits: total
              })

              measure('animations')
              if (!total) return
              record(3, completed, total)
              states.set(key, {
                filmStep,
                progress: {
                  phase: 'writing',
                  startedAt,
                  completed: Math.max(completed, saved?.completed ?? 0),
                  total
                }
              })
            },
            generate: options.generate,
            modelDirectory: dirname(model.path),
            modelRevision: lease!.revision,
            engineDirectory: options.engineDirectory,
            onProgress: report
          })
        )
        await writes
        saved.built = { id, title: generated.title, duration: generated.duration }
        saved.step = 5
        await savePendingFilm(base, saved)
      }
      signal.throwIfAborted()
      // Recheck existence after the long job; deleting a session must not publish an orphan result.
      if (!(await options.loadSession(request.projectId, request.sessionId)))
        throw new Error('Research session was removed during generation.')
      report({ phase: 'publishing' })
      await writes
      const outputJob = join(publishBase, id)
      const pendingDirectory = await lstat(job).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e
      })
      if (pendingDirectory) {
        if (!pendingDirectory.isDirectory())
          throw new Error('Unsafe research presentation directory.')
        for (const name of await readdir(job)) {
          if (name.startsWith('unit-') || name === 'speech')
            await rm(join(job, name), { recursive: true, force: true })
        }
        await rename(job, outputJob)
      }
      for (const path of [outputJob, join(outputJob, 'output')])
        if (!(await lstat(path)).isDirectory())
          throw new Error('Unsafe research presentation output.')
      for (const name of ['player.html', 'sources.zip'])
        if (!(await lstat(join(outputJob, 'output', name))).isFile())
          throw new Error('Missing research presentation output.')
      await writeDurableJsonFile(join(publishBase, 'latest.json'), JSON.stringify(saved.built))
      completed = true
      states.delete(key)
      await removePendingPointer(base).catch(() =>
        log.info('film cleanup deferred', { ...context(), phase: 'publishing' })
      )
    } catch (error) {
      await writes.catch(() => {})
      if (base && saved && (!signal.aborted || closed)) {
        saved.updatedAt = Date.now()
        await savePendingFilm(base, saved).catch(() =>
          log.info('film checkpoint write failed', { ...context(), phase: stage })
        )
      }
      const failure = error instanceof ResearchVideoWorkerError ? error.cause : error
      let code: string | undefined
      try {
        code = (failure as NodeJS.ErrnoException | null)?.code
      } catch {
        // Diagnostics must tolerate errors with throwing accessors.
      }
      log.info('film attempt stopped', {
        ...context(),
        phase: stage,
        outcome: signal.aborted ? 'cancelled' : 'failed',
        ...diagnosticErrorFields(failure),
        ...([
          'ENOENT',
          'ENOTDIR',
          'EACCES',
          'EPERM',
          'ENOSPC',
          'ENOMEM',
          'ETIMEDOUT',
          'ERR_WORKER_OUT_OF_MEMORY'
        ].includes(code ?? '')
          ? { code }
          : {}),
        ...(error instanceof ResearchVideoWorkerError
          ? { workerRole: error.workerRole, lane: error.lane, exitCode: error.exitCode }
          : {})
      })
      states.set(
        key,
        !admitted && !signal.aborted
          ? {
              preflightError: error instanceof Error ? error.message : String(error)
            }
          : {
              filmStep,
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
      installingKey = undefined
      prepared()
      measure('finished')
      log.info('generation timing', {
        ...context(),
        outcome: completed ? 'completed' : signal.aborted ? 'cancelled' : 'failed',
        totalMs: Math.round(performance.now() - started),
        stagesMs: Object.fromEntries(
          Object.entries(stageMs).map(([name, ms]) => [name, Math.round(ms)])
        )
      })
      if (base && job && !completed && signal.aborted && !closed) {
        await rm(job, { recursive: true, force: true }).catch((error) =>
          log.info('film cleanup deferred', {
            ...context(),
            phase: 'cleanup',
            ...diagnosticErrorFields(error)
          })
        )
        await removePendingPointer(base).catch((error) =>
          log.info('film cleanup deferred', {
            ...context(),
            phase: 'cleanup',
            ...diagnosticErrorFields(error)
          })
        )
      }
      lease?.release()
    }
  }
  return {
    status,
    async start(rawRequest: ResearchVideoStartRequest): Promise<ResearchVideoPresentationStatus> {
      const {
          installNarration = false,
          resume = false,
          ...request
        } = researchVideoStartRequestSchema.parse(rawRequest),
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
            run(
              request,
              key,
              AbortSignal.any([signal, controller.signal]),
              installNarration,
              resume,
              finishPreparation
            )
          )
        : run(request, key, controller.signal, installNarration, resume, finishPreparation)
      const done = operation
        .catch((error) => {
          log.info('film lifecycle failed', {
            sessionId: request.sessionId,
            ...diagnosticErrorFields(error)
          })
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
        const base = await directory(scopeKey(scope))
        if (base) {
          await rm(join(base, 'pending'), { recursive: true, force: true })
          await removePendingPointer(base)
        }
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
