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
import { researchVideoSessionSource, researchVideoGenerationBlock } from './session-source'
import {
  generateResearchFilm,
  ResearchVideoWorkerError,
  ResearchVideoSpeechCleanupError,
  ResearchVideoBuildCleanupError,
  type ResearchFilmAuthor,
  type ResearchVideoGenerate
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
import { waitForFilmStep } from './wait'
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

const FILM_READINESS_TIMEOUT_MS = 30_000
const FILM_DISK_TIMEOUT_MS = 2 * 60_000
const FILM_DISK_CANCEL_GRACE_MS = 5_000
class FilmReadinessTimeoutError extends Error {
  constructor() {
    super('Research film readiness check timed out. Try again.')
  }
}

async function checkFilmReadiness<T>(
  work: (signal: AbortSignal) => Promise<T>,
  caller?: AbortSignal
): Promise<T> {
  const deadline = AbortSignal.timeout(FILM_READINESS_TIMEOUT_MS)
  const signal = caller ? AbortSignal.any([caller, deadline]) : deadline
  try {
    return await waitForFilmStep(signal, () => work(signal))
  } catch (error) {
    if (deadline.aborted && signal.reason === deadline.reason) throw new FilmReadinessTimeoutError()
    throw error
  }
}

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
  checkReadiness?: (signal?: AbortSignal) => Promise<void>
  models: Pick<
    ReturnType<typeof createLocalModelOwner>,
    'acquireUse' | 'getSnapshot' | 'installForUse'
  >
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  writeScreenplay: ResearchFilmAuthor['writeScreenplay']
  writeAnimation?: ResearchFilmAuthor['writeAnimation']
  generate: ResearchVideoGenerate
  checkGenerationAdmission?: () => void
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
    | {
        key: string
        controller: AbortController
        done: Promise<void>
        prepared: Promise<void>
        blockedStatus?: ResearchVideoPresentationStatus
      }
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
  const readStatus = async (
    request: ResearchVideoPresentationRequest,
    readinessSignal?: AbortSignal
  ): Promise<ResearchVideoPresentationStatus> => {
    const key = scopeKey(request)
    const revision = operationRevision
    const state = structuredClone(states.get(key) ?? {})
    const session = await options.loadSession(request.projectId, request.sessionId)
    readinessSignal?.throwIfAborted()
    const block = researchVideoGenerationBlock(session, request)
    if (block === 'unavailable') return { generationBlock: block }
    if (installingKey === key) state.narrationDownload = await options.models.getSnapshot()
    if (block) state.generationBlock = block
    if (readinessSignal && !block && !active && !closed && !removing) {
      const signal = readinessSignal
      signal.throwIfAborted()
      const probe = Symbol()
      preflights.set(key, probe)
      const clearProbe = (): void => {
        if (preflights.get(key) === probe) preflights.delete(key)
      }
      const onTimeout = (): void => {
        if (preflights.get(key) === probe && revision === operationRevision) {
          states.set(key, {
            ...states.get(key),
            preflightError: new FilmReadinessTimeoutError().message
          })
        }
        clearProbe()
      }
      signal.addEventListener('abort', onTimeout, { once: true })
      delete state.preflightError
      try {
        const source = researchVideoSessionSource(session!, request)
        await stageResearchVideoSessionImages(
          source,
          session!,
          options.dataRoot(),
          undefined,
          signal
        )
        signal.throwIfAborted()
        await options.checkReadiness?.(signal)
        signal.throwIfAborted()
        const snapshot = await options.models.getSnapshot()
        signal.throwIfAborted()
        if (snapshot.availability === 'ready' && !snapshot.updateAvailable) {
          const lease = await options.models.acquireUse()
          lease.release()
        }
      } catch (error) {
        signal.throwIfAborted()
        state.preflightError = error instanceof Error ? error.message : String(error)
        if (state.preflightError !== states.get(key)?.preflightError)
          log.info('film preflight failed', {
            sessionId: request.sessionId,
            ...diagnosticErrorFields(error)
          })
      } finally {
        signal.removeEventListener('abort', onTimeout)
      }
      signal.throwIfAborted()
      const currentProbe = preflights.get(key) === probe
      clearProbe()
      // A newer probe or mutation owns the status. Do not restart work after disposal.
      if (!currentProbe || revision !== operationRevision) return readStatus(request)
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

  const status = async (
    rawRequest: ResearchVideoStatusRequest
  ): Promise<ResearchVideoPresentationStatus> => {
    const { checkReadiness, ...request } = researchVideoStatusRequestSchema.parse(rawRequest)
    const current = active?.key === scopeKey(request) ? active : undefined
    if (current?.blockedStatus) return current.blockedStatus
    if (!checkReadiness) return readStatus(request)
    try {
      return await checkFilmReadiness((signal) => readStatus(request, signal))
    } catch (error) {
      if (!(error instanceof FilmReadinessTimeoutError)) throw error
      return { preflightError: error.message }
    }
  }

  const run = async (
    request: ResearchVideoPresentationRequest,
    key: string,
    callerSignal: AbortSignal,
    installNarration: boolean,
    resume: boolean,
    prepared: () => void
  ): Promise<void> => {
    const diskController = new AbortController()
    const signal = AbortSignal.any([callerSignal, diskController.signal])
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
    let diskFailure: Error | undefined
    const markDiskStalled = (): void => {
      if (diskFailure) return
      diskFailure = new Error(
        'Film is still waiting for the disk. Try again after the disk responds.'
      )
      const failure: ResearchVideoPresentationStatus = {
        filmStep,
        progress: { phase: 'failed', startedAt, endedAt: Date.now() },
        error: diskFailure.message
      }
      if (active?.key === key) active.blockedStatus = failure
      states.set(key, failure)
      log.info('film disk operation stalled', { ...context(), phase: stage })
      diskController.abort(diskFailure)
    }
    const diskStep = async <T>(work: () => Promise<T>, finishing = false): Promise<T> => {
      if (!finishing) signal.throwIfAborted()
      const timer = setTimeout(markDiskStalled, FILM_DISK_TIMEOUT_MS)
      let cancelTimer: ReturnType<typeof setTimeout> | undefined
      const onCancel = (): void => {
        cancelTimer = setTimeout(markDiskStalled, FILM_DISK_CANCEL_GRACE_MS)
      }
      signal.addEventListener('abort', onCancel, { once: true })
      if (signal.aborted) onCancel()
      try {
        // A timeout ends visible progress, but the attempt keeps its file ownership.
        const value = await work()
        if (!finishing) signal.throwIfAborted()
        return value
      } finally {
        clearTimeout(timer)
        clearTimeout(cancelTimer)
        signal.removeEventListener('abort', onCancel)
      }
    }
    const record = (step: number, completed?: number, total?: number): void => {
      if (signal.aborted) return
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
      writes = writes.then(() =>
        signal.aborted ? undefined : diskStep(() => savePendingFilm(destination, snapshot))
      )
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
      if (signal.aborted) return
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
    let checkpointStarted = false
    let completed = false
    let cancelled = false
    log.info('film invocation started', { ...context(), phase: stage })
    try {
      const session = await checkFilmReadiness(
        () => options.loadSession(request.projectId, request.sessionId),
        signal
      )
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
      await checkFilmReadiness(async (preparation) => {
        await stageResearchVideoSessionImages(
          source,
          session,
          options.dataRoot(),
          undefined,
          preparation,
          checksums
        )
        preparation.throwIfAborted()
        measure('readiness')
        await options.checkReadiness?.(preparation)
      }, signal)
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
        await checkFilmReadiness(async (preparation) => {
          const latest = await options.loadSession(scope.projectId, scope.sessionId)
          preparation.throwIfAborted()
          if (researchVideoGenerationBlock(latest, scope))
            throw new Error('Research session is unavailable.')
          await options.checkReadiness?.(preparation)
        }, signal)
        signal.throwIfAborted()
      }
      measure('narration-acquire')
      const narration = await checkFilmReadiness(async (preparation) => {
        const acquired = await options.models.acquireUse()
        if (preparation.aborted) {
          acquired.release()
          preparation.throwIfAborted()
        }
        lease = acquired
        return acquired
      }, signal)
      signal.throwIfAborted()
      const model = narration.assets.find((asset) => asset.file === 'model_quantized.onnx')
      if (!model) throw new Error('Install the research narration model before generating.')
      installingKey = undefined
      admitted = true
      report({ phase: 'preparing' })
      prepared()
      const scope = { ...request, branchId: source.provenance.branchId }
      base = (await diskStep(() => directory(scopeKey(scope), true)))!
      const publishBase = base
      const conversation = filmConversationDigest(source)
      const fingerprint = digestFilmInput(JSON.stringify([conversation, checksums]))
      const previous = await diskStep(() => readPendingFilm(publishBase))
      const published = await diskStep(() => readStoredResearchFilm(options.dataRoot(), scope))
      job = join(base, 'pending')
      if (resume && previous?.source === fingerprint && previous.id !== published?.id) {
        saved = { ...previous, attempt: previous.attempt + 1 }
        replayStep = previous.step
      } else {
        await diskStep(() => removePendingPointer(publishBase))
        await diskStep(() => rm(job!, { recursive: true, force: true }))
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
      checkpointStarted = Boolean(saved.built) || (resume && previous?.id === saved.id)
      const id = saved.id
      log.info('film attempt started', {
        ...context(),
        step: String(saved.step),
        outcome: resume && saved.attempt > 1 ? 'resumed' : 'started'
      })

      if (!saved.built) {
        await diskStep(() => mkdir(job!, { recursive: true, mode: 0o700 }))
        if (!(await diskStep(() => lstat(job!))).isDirectory())
          throw new Error('Unsafe research presentation directory.')
        await diskStep(() =>
          writeDurableJsonFile(join(job!, 'session.json'), JSON.stringify(source))
        )
        await diskStep(() => savePendingFilm(publishBase, saved!))
        checkpointStarted = true
        for (const file of ['files', 'anims', 'video.json', 'output'])
          await diskStep(() => rm(join(job!, file), { recursive: true, force: true }))
        await diskStep(() => mkdir(join(job!, 'files')))
        const stagedChecksums: string[] = []
        source = await diskStep(() =>
          stageResearchVideoSessionImages(
            source,
            session,
            options.dataRoot(),
            join(job!, 'files'),
            signal,
            stagedChecksums
          )
        )
        if (JSON.stringify(checksums) !== JSON.stringify(stagedChecksums))
          throw new Error('Research images changed during preparation.')
        await diskStep(() =>
          writeDurableJsonFile(join(job!, 'session.json'), JSON.stringify(source))
        )
        const attemptContext = { operationId: id, attempt: saved.attempt, invocationId }
        const checkpoint = filmAuthoringCheckpoint(job, (outcome) =>
          log.info('film authoring unit', { ...context(), phase: stage, outcome })
        )
        const generated = await filmAttempt.run(attemptContext, () =>
          generateResearchFilm({
            source,
            directory: job!,
            author: options,
            signal,
            checkpoint: {
              read: (key) => diskStep(() => checkpoint.read(key)),
              save: (key, value) => diskStep(() => checkpoint.save(key, value))
            },
            onAnimations(completed, total) {
              if (signal.aborted) return
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
            modelRevision: narration.revision,
            engineDirectory: options.engineDirectory,
            onProgress: report
          })
        )
        saved.built = { id, title: generated.title, duration: generated.duration }
        saved.step = 5
        await writes
        await diskStep(() => savePendingFilm(publishBase, saved!))
      }
      signal.throwIfAborted()
      // Recheck existence after the long job; deleting a session must not publish an orphan result.
      const currentSession = await checkFilmReadiness(
        () => options.loadSession(request.projectId, request.sessionId),
        signal
      )
      signal.throwIfAborted()
      if (!currentSession) throw new Error('Research session was removed during generation.')
      report({ phase: 'publishing' })
      await writes
      const outputJob = join(publishBase, id)
      const pendingDirectory = await diskStep(() => lstat(job!)).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e
        }
      )
      if (pendingDirectory) {
        if (!pendingDirectory.isDirectory())
          throw new Error('Unsafe research presentation directory.')
        for (const name of await diskStep(() => readdir(job!))) {
          if (name.startsWith('unit-') || name === 'speech')
            await diskStep(() => rm(join(job!, name), { recursive: true, force: true }))
        }
        await diskStep(() => rename(job!, outputJob))
      }
      for (const path of [outputJob, join(outputJob, 'output')])
        if (!(await diskStep(() => lstat(path))).isDirectory())
          throw new Error('Unsafe research presentation output.')
      for (const name of ['player.html', 'sources.zip'])
        if (!(await diskStep(() => lstat(join(outputJob, 'output', name)))).isFile())
          throw new Error('Missing research presentation output.')
      const receipt = JSON.stringify(saved.built)
      signal.throwIfAborted()
      await diskStep(() => writeDurableJsonFile(join(publishBase, 'latest.json'), receipt), true)
      completed = true
      await diskStep(() => removePendingPointer(publishBase), true).catch(() =>
        log.info('film cleanup deferred', { ...context(), phase: 'publishing' })
      )
      states.delete(key)
    } catch (error) {
      const buildUnconfirmed = error instanceof ResearchVideoBuildCleanupError
      const cleanupUnconfirmed =
        buildUnconfirmed || error instanceof ResearchVideoSpeechCleanupError
      cancelled = callerSignal.aborted && !cleanupUnconfirmed && !diskFailure
      const reported = diskFailure ?? error
      if (cleanupUnconfirmed && lease) {
        const held = lease
        lease = undefined
        void error.exited.then(() => held.release())
      }
      states.set(
        key,
        !admitted && !cancelled
          ? {
              preflightError: reported instanceof Error ? reported.message : String(reported)
            }
          : {
              filmStep,
              progress: {
                phase: cancelled ? 'cancelled' : 'failed',
                startedAt,
                endedAt: Date.now()
              },
              ...(!cancelled
                ? { error: reported instanceof Error ? reported.message : String(reported) }
                : {})
            }
      )
      if (buildUnconfirmed) {
        if (active?.key === key) active.blockedStatus = states.get(key)
        // The thread can still touch the pending job. Keep the lifecycle reservation alive so
        // session deletion and a new attempt cannot race a late write.
        await error.exited
      }
      await writes.catch(() => {})
      if (base && saved && (!cancelled || closed)) {
        saved.updatedAt = Date.now()
        await diskStep(() => savePendingFilm(base!, saved!), true).catch(() =>
          log.info('film checkpoint write failed', { ...context(), phase: stage })
        )
      }
      const failure = reported instanceof ResearchVideoWorkerError ? reported.cause : reported
      let code: string | undefined
      try {
        code = (failure as NodeJS.ErrnoException | null)?.code
      } catch {
        // Diagnostics must tolerate errors with throwing accessors.
      }
      log.info('film attempt stopped', {
        ...context(),
        phase: stage,
        outcome: cancelled ? 'cancelled' : 'failed',
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
          : cleanupUnconfirmed
            ? {
                workerRole: buildUnconfirmed ? 'generation' : 'speech',
                errorCategory: 'exit-unconfirmed'
              }
            : {})
      })
    } finally {
      installingKey = undefined
      prepared()
      measure('finished')
      log.info('generation timing', {
        ...context(),
        outcome: completed ? 'completed' : cancelled ? 'cancelled' : 'failed',
        totalMs: Math.round(performance.now() - started),
        stagesMs: Object.fromEntries(
          Object.entries(stageMs).map(([name, ms]) => [name, Math.round(ms)])
        )
      })
      if (base && job && !completed && !checkpointStarted && cancelled && !closed) {
        await diskStep(() => rm(job!, { recursive: true, force: true }), true).catch((error) =>
          log.info('film cleanup deferred', {
            ...context(),
            phase: 'cleanup',
            ...diagnosticErrorFields(error)
          })
        )
        await diskStep(() => removePendingPointer(base!), true).catch((error) =>
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
        const previousFailure = states.get(active.key)
        if (previousFailure?.progress?.phase === 'failed' && previousFailure.error)
          throw new Error(previousFailure.error)
        if (active.key === key) {
          await active.prepared
          return status(request)
        }
        throw new Error('Another research explanation is being generated. Wait for it to finish.')
      }
      options.checkGenerationAdmission?.()
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
