import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import {
  RESEARCH_VIDEO_STATUS_TIMEOUT_MS,
  RESEARCH_VIDEO_STATUS_TIMEOUT_MESSAGE,
  researchVideoPresentationRequestSchema,
  researchVideoStatusRequestSchema,
  researchVideoStartRequestSchema,
  type ResearchVideoStartRequest,
  type ResearchVideoStatusRequest,
  type ResearchVideoPresentation,
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
  savePendingFilmOwner,
  PENDING_FILM_OWNER,
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
  readResearchFilmReceipt,
  CorruptResearchFilmReceiptError,
  hasResearchFilmOutputs,
  deleteStoredResearchFilms
} from './stored-presentation'

const filmAttempt = new AsyncLocalStorage<{
  operationId: string
  attempt: number
  invocationId: string
}>()
export const currentFilmAttempt = (): ReturnType<typeof filmAttempt.getStore> =>
  filmAttempt.getStore()

const filmPathInfo = (path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
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
  let narrationInstall: Promise<unknown> | undefined
  let removing = false
  let closed = false
  let operationRevision = 0
  const draining = new Map<
    string,
    { error: Error; status: ResearchVideoPresentationStatus; kind: 'disk' | 'build' }
  >()
  const sessionKey = (request: ResearchVideoPresentationRequest): string =>
    scopeKey({ ...request, branchId: undefined })
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
  const readinessReads = new Map<string, Promise<ResearchVideoPresentationStatus>>()
  const statusReads = new Map<string, Promise<ResearchVideoPresentationStatus>>()
  const knownFilms = new Map<string, ResearchVideoPresentation>()
  const readLocalFilm = async (
    request: ResearchVideoPresentationRequest,
    signal: AbortSignal
  ): Promise<ResearchVideoPresentation | undefined> => {
    signal.throwIfAborted()
    const key = scopeKey(request)
    const result = await readStoredResearchFilm(options.dataRoot(), request, knownFilms.get(key))
    signal.throwIfAborted()
    knownFilms.delete(key)
    if (result) {
      if (knownFilms.size >= 32) knownFilms.delete(knownFilms.keys().next().value!)
      knownFilms.set(key, result)
    }
    return result
  }
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
    signal: AbortSignal,
    checkReadiness = false
  ): Promise<ResearchVideoPresentationStatus> => {
    const key = scopeKey(request)
    const revision = operationRevision
    const state = structuredClone(states.get(key) ?? {})
    const session = await options.loadSession(request.projectId, request.sessionId)
    signal.throwIfAborted()
    const block = researchVideoGenerationBlock(session, request)
    if (block === 'unavailable') return { generationBlock: block }
    if (installingKey === key) state.narrationDownload = await options.models.getSnapshot()
    signal.throwIfAborted()
    if (block) state.generationBlock = block
    if (checkReadiness && !block && !active && !closed && !removing) {
      signal.throwIfAborted()
      const onTimeout = (): void => {
        if (revision === operationRevision) {
          states.set(key, {
            ...states.get(key),
            preflightError: new FilmReadinessTimeoutError().message
          })
        }
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
      // A newer mutation owns the status. Do not restart readiness work after disposal.
      if (revision !== operationRevision) return readStatus(request, signal)
      states.set(key, { ...states.get(key), preflightError: state.preflightError })
    }
    const branchId =
      request.branchId ??
      session?.conversationGraph?.frames.find(
        (frame) => frame.id === session?.conversationGraph?.rootFrameId
      )?.activeBranchId
    const scope = { ...request, branchId }
    const local = (
      target: ResearchVideoPresentationRequest
    ): Promise<ResearchVideoPresentation | undefined> =>
      readLocalFilm(target, signal).catch((error: unknown) => {
        if (!(error instanceof CorruptResearchFilmReceiptError)) throw error
        state.error ??= error.message
        return undefined
      })
    const result =
      (await local(scope)) ??
      (branchId !== request.branchId ? await local(request) : undefined) ??
      (session?.packageOrigin || session?.forkOrigin
        ? await options.loadImportedFilm?.(request)
        : undefined)
    signal.throwIfAborted()
    if (!active && session && !block) {
      const base = await directory(scopeKey(scope))
      signal.throwIfAborted()
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
    signal.throwIfAborted()
    return result ? { ...state, result } : state
  }

  const status = async (
    rawRequest: ResearchVideoStatusRequest
  ): Promise<ResearchVideoPresentationStatus> => {
    const { checkReadiness, ...request } = researchVideoStatusRequestSchema.parse(rawRequest)
    const key = scopeKey(request)
    const current = active?.key === key ? active : undefined
    if (current?.blockedStatus) return current.blockedStatus
    const held = draining.get(sessionKey(request))
    if (held && held.status === states.get(key))
      return { ...held.status, result: held.status.result ?? knownFilms.get(key) }
    const pending = statusReads.get(key)
    if (!checkReadiness) {
      if (pending) return pending
      const deadline = new AbortController()
      const timer = setTimeout(
        () => deadline.abort(new Error(RESEARCH_VIDEO_STATUS_TIMEOUT_MESSAGE)),
        RESEARCH_VIDEO_STATUS_TIMEOUT_MS
      )
      const read = readStatus(request, deadline.signal).finally(() => {
        clearTimeout(timer)
        statusReads.delete(key)
      })
      const bounded = waitForFilmStep(deadline.signal, () => read)
      statusReads.set(key, bounded)
      return bounded
    }
    const readiness = readinessReads.get(key)
    if (readiness) return readiness
    // A readiness retry must not bypass a stalled read of the same scope.
    if (pending) {
      await pending
      return status(rawRequest)
    }
    let started = false
    const bounded = checkFilmReadiness((signal) => {
      started = true
      return readStatus(request, signal, true).finally(() => readinessReads.delete(key))
    }).catch((error: unknown) => {
      if (!started) readinessReads.delete(key)
      if (!(error instanceof FilmReadinessTimeoutError)) throw error
      return { preflightError: error.message }
    })
    readinessReads.set(key, bounded)
    return bounded
  }

  const run = async (
    request: ResearchVideoPresentationRequest,
    key: string,
    callerSignal: AbortSignal,
    installNarration: boolean,
    resume: boolean,
    prepared: () => void,
    park: (error: Error, status: ResearchVideoPresentationStatus, kind: 'disk' | 'build') => void
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
      const status: ResearchVideoPresentationStatus = completedResult
        ? { result: completedResult }
        : {
            filmStep,
            progress: { phase: 'failed', startedAt, endedAt: Date.now() },
            error: diskFailure.message
          }
      park(diskFailure, status, 'disk')
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
    let completedResult: ResearchVideoPresentation | undefined
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
        if (!resume || installNarration) await options.checkReadiness?.(preparation)
      }, signal)
      signal.throwIfAborted()
      if (installNarration) {
        installingKey = key
        states.delete(key)
        prepared()
        measure('narration-install')
        // The model owner retains its writer while an aborted download drains. Film owns no
        // checkpoint or model lease here, so cancellation can release Film admission immediately.
        const snapshot = await waitForFilmStep(signal, () => {
          const install = options.models.installForUse(signal).finally(() => {
            narrationInstall = undefined
          })
          narrationInstall = install
          return install
        })
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
      const scope = { ...request, branchId: source.provenance.branchId }
      const conversation = filmConversationDigest(source)
      const fingerprint = digestFilmInput(JSON.stringify([conversation, checksums]))
      const existingBase = await diskStep(() => directory(scopeKey(scope)))
      const previous = existingBase
        ? await diskStep(() => readPendingFilm(existingBase))
        : undefined
      let corruptLatest = false
      const published = existingBase
        ? await diskStep(() =>
            readResearchFilmReceipt(existingBase).catch((error: unknown) => {
              if (!(error instanceof CorruptResearchFilmReceiptError)) throw error
              corruptLatest = true
              return knownFilms.get(scopeKey(scope))
            })
          )
        : undefined
      let newPending = false
      const resumable =
        resume && previous?.source === fingerprint && previous.id !== published?.id
          ? previous
          : undefined
      const pending =
        resumable?.built && (await diskStep(() => filmPathInfo(join(existingBase!, 'pending'))))
      const hasBuiltOutput =
        resumable?.built &&
        (await diskStep(() =>
          hasResearchFilmOutputs(join(existingBase!, pending ? 'pending' : resumable.id))
        ))
      // Publishing a verified checkpoint does not start a generator.
      if (resume && !hasBuiltOutput) {
        options.checkGenerationAdmission?.()
        if (!installNarration)
          await checkFilmReadiness(
            async (preparation) => options.checkReadiness?.(preparation),
            signal
          )
      }
      if (!hasBuiltOutput) {
        measure('narration-acquire')
        await checkFilmReadiness(async (preparation) => {
          const acquired = await options.models.acquireUse()
          if (preparation.aborted) {
            acquired.release()
            preparation.throwIfAborted()
          }
          lease = acquired
        }, signal)
        signal.throwIfAborted()
      }
      const model = lease?.assets.find((asset) => asset.file === 'model_quantized.onnx')
      if (!hasBuiltOutput && !model)
        throw new Error('Install the research narration model before generating.')
      installingKey = undefined
      admitted = true
      report({ phase: 'preparing' })
      prepared()
      base = existingBase ?? (await diskStep(() => directory(scopeKey(scope), true)))!
      const publishBase = base
      job = join(base, 'pending')
      if (resumable) {
        saved = { ...resumable, attempt: resumable.attempt + 1 }
        replayStep = resumable.step
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
        newPending = true
      }
      checkpointStarted = Boolean(saved.built) || (resume && previous?.id === saved.id)
      let outputJob = join(publishBase, saved.id)
      if (saved.built && !hasBuiltOutput) {
        // A crash can leave the unpublished job already renamed. Move it back to reuse units.
        if (!pending) {
          const moved = await diskStep(() => filmPathInfo(outputJob))
          if (moved && !corruptLatest) await diskStep(() => rename(outputJob, job!))
          else if (moved) {
            // The damaged index cannot prove this directory was never published.
            saved.id = randomUUID()
            outputJob = join(publishBase, saved.id)
            newPending = true
          }
        }
        delete saved.built
        saved.step = 1
        delete saved.completed
        delete saved.total
        replayStep = 0
        await diskStep(() => mkdir(job!, { recursive: true, mode: 0o700 }))
        await diskStep(() => savePendingFilm(publishBase, saved!))
      }
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
        // Resuming an older checkpoint does not opt it into startup cleanup.
        if (newPending) {
          const { projectId, sessionId, branchId } = source.provenance
          await diskStep(() => savePendingFilmOwner(job!, { id, projectId, sessionId, branchId }))
        }
        await diskStep(async () => {
          await savePendingFilm(publishBase, saved!)
          // The disk step checks cancellation again after the write. Record the durable checkpoint
          // first so that a cancellation during this write cannot remove it in finally.
          checkpointStarted = true
        })
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
            modelDirectory: dirname(model!.path),
            modelRevision: lease!.revision,
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
      const pendingDirectory = await diskStep(() => filmPathInfo(job!))
      if (!(await diskStep(() => hasResearchFilmOutputs(pendingDirectory ? job! : outputJob))))
        throw new Error('Missing or empty research presentation output.')
      if (pendingDirectory) await diskStep(() => rename(job!, outputJob))
      const receipt = JSON.stringify(saved.built)
      signal.throwIfAborted()
      await diskStep(() => writeDurableJsonFile(join(publishBase, 'latest.json'), receipt), true)
      completedResult = {
        ...saved.built!,
        playerPath: join(outputJob, 'output', 'player.html'),
        sourcePath: join(outputJob, 'output', 'sources.zip')
      }
      // Publication already committed. Do not start more I/O after a timeout.
      if (diskFailure) {
        states.delete(key)
        return
      }
      await diskStep(() => removePendingPointer(publishBase), true).catch(() =>
        log.info('film cleanup deferred', { ...context(), phase: 'publishing' })
      )
      states.delete(key)
      if (diskFailure) return
      await diskStep(async () => {
        for (const name of await readdir(outputJob)) {
          if (name.startsWith('unit-') || name === 'speech' || name === PENDING_FILM_OWNER)
            await rm(join(outputJob, name), { recursive: true, force: true })
        }
      }, true).catch(() => log.info('film cleanup deferred', { ...context(), phase: 'publishing' }))
    } catch (error) {
      const buildUnconfirmed = saved && error instanceof ResearchVideoBuildCleanupError
      const cleanupUnconfirmed =
        buildUnconfirmed || (saved && error instanceof ResearchVideoSpeechCleanupError)
      cancelled = callerSignal.aborted && !cleanupUnconfirmed && !diskFailure
      const reported = diskFailure ?? error
      if (cleanupUnconfirmed && lease) {
        const held = lease
        lease = undefined
        void error.exited.then(() => held.release())
      }
      const failureStatus: ResearchVideoPresentationStatus =
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
      if (!diskFailure) states.set(key, failureStatus)
      if (buildUnconfirmed) {
        park(error, failureStatus, 'build')
        // The thread can still touch the pending job. Keep the lifecycle reservation alive so
        // session deletion and a new attempt cannot race a late write.
        await error.exited
      }
      await writes.catch(() => {})
      if (base && saved && !diskFailure && (!cancelled || closed)) {
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
      if (installingKey === key) installingKey = undefined
      prepared()
      measure('finished')
      log.info('generation timing', {
        ...context(),
        outcome: completedResult ? 'completed' : cancelled ? 'cancelled' : 'failed',
        totalMs: Math.round(performance.now() - started),
        stagesMs: Object.fromEntries(
          Object.entries(stageMs).map(([name, ms]) => [name, Math.round(ms)])
        )
      })
      if (
        base &&
        job &&
        !completedResult &&
        !checkpointStarted &&
        cancelled &&
        !closed &&
        !diskFailure
      ) {
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
      const session = sessionKey(request)
      const held = draining.get(session)
      if (held) throw held.error
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
      if (installNarration && narrationInstall)
        throw new Error('Local model management is in progress.')
      if (!resume) options.checkGenerationAdmission?.()
      operationRevision++
      const controller = new AbortController()
      let finishPreparation!: () => void
      const prepared = new Promise<void>((resolve) => {
        finishPreparation = resolve
      })
      const released = Promise.withResolvers<void>()
      const park = (
        error: Error,
        status: ResearchVideoPresentationStatus,
        kind: 'disk' | 'build'
      ): void => {
        if (active?.controller !== controller) return
        active.blockedStatus = status
        states.set(key, status)
        // At most one stalled disk attempt can release its slot. Further stalls still throttle
        // admission, so repeated retries cannot build up hung I/O and model leases indefinitely.
        if ([...draining.values()].some((attempt) => attempt.kind === kind)) return
        draining.set(session, { error, status, kind })
        active = undefined
        finishPreparation()
        released.resolve()
      }
      const operation = options.lifecycle
        ? options.lifecycle.run(request.projectId, request.sessionId, (signal) =>
            run(
              request,
              key,
              AbortSignal.any([signal, controller.signal]),
              installNarration,
              resume,
              finishPreparation,
              park
            )
          )
        : run(request, key, controller.signal, installNarration, resume, finishPreparation, park)
      void operation
        .catch((error) => {
          log.info('film lifecycle failed', {
            sessionId: request.sessionId,
            ...diagnosticErrorFields(error)
          })
          states.set(key, { error: error instanceof Error ? error.message : String(error) })
        })
        .finally(() => {
          finishPreparation()
          draining.delete(session)
          if (active?.controller === controller) active = undefined
          released.resolve()
        })
      active = { key, controller, done: released.promise, prepared }
      await prepared
      return status(request)
    },
    async remove(rawRequest) {
      const request = researchVideoPresentationRequestSchema.parse(rawRequest)
      const held = draining.get(sessionKey(request))
      if (held) throw held.error
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
        knownFilms.delete(scopeKey(scope))
        knownFilms.delete(scopeKey({ ...scope, branchId: undefined }))
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
