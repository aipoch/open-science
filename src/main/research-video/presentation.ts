import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import {
  RESEARCH_VIDEO_STATUS_TIMEOUT_MS,
  RESEARCH_VIDEO_STATUS_TIMEOUT_MESSAGE,
  RESEARCH_FILM_BUSY_MESSAGE,
  researchVideoPresentationRequestSchema,
  researchVideoStatusRequestSchema,
  researchVideoOwnerStartRequestSchema,
  type ResearchFilmNarrationReview,
  type ResearchFilmRevision,
  type ResearchFilmReviewFailure as ReviewFailure,
  type ResearchVideoOwnerStartRequest,
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
  ResearchFilmReviewFailure,
  REPLAY_RUNTIME_VERSION,
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
  filmOutputFingerprint,
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
import { stageFilmSessionApp } from './session-app'
import { operationReplaySource } from './replay-source'
import { waitForFilmStep } from './wait'
import type { ResearchFilmLifecycle } from './lifecycle'

import {
  researchFilmScopeKey as scopeKey,
  readStoredResearchFilm,
  pruneStoredResearchFilms,
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

export class ResearchFilmRevisionError extends Error {
  readonly code = 'film_review_conflict'

  constructor() {
    super(
      'The film review attempt is no longer current. Read film status before sending feedback again.'
    )
  }
}

const activeFilmBranch = (session: PersistedChatSession | undefined): string | undefined =>
  session?.conversationGraph?.frames.find(
    (frame) => frame.id === session.conversationGraph?.rootFrameId
  )?.activeBranchId

const filmSourceFingerprint = (
  conversation: string,
  checksums: string[],
  mode: ResearchVideoPresentationRequest['mode']
): string =>
  digestFilmInput(
    JSON.stringify([
      conversation,
      checksums,
      ...(mode === 'operation-replay' ? [REPLAY_RUNTIME_VERSION] : [])
    ])
  )

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
  start(request: ResearchVideoOwnerStartRequest): Promise<ResearchVideoPresentationStatus>
  remove(request: ResearchVideoPresentationRequest): Promise<ResearchVideoPresentationStatus>
  cancel(request: ResearchVideoPresentationRequest): void
  close(): Promise<void>
}

/** User-initiated derived presentations live separately from immutable imported conversation history. */
export function createResearchVideoPresentationOwner(options: {
  dataRoot(): string
  withUnusedFilmFiles?: (paths: string[], remove: () => Promise<void>) => Promise<boolean>
  mutate?: <T>(request: ResearchVideoPresentationRequest, work: () => Promise<T>) => Promise<T>
  checkReadiness?: (signal?: AbortSignal) => Promise<void>
  models: Pick<
    ReturnType<typeof createLocalModelOwner>,
    'acquireUse' | 'getSnapshot' | 'installForUse'
  >
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  writeScreenplay: ResearchFilmAuthor['writeScreenplay']
  reviewScript?: ResearchFilmAuthor['reviewScript']
  confirmSessionApp?: Parameters<typeof stageFilmSessionApp>[6]
  writeAnimation?: ResearchFilmAuthor['writeAnimation']
  writeReplay?: ResearchFilmAuthor['writeReplay']
  loadReplayRecords?: (
    session: PersistedChatSession
  ) => Promise<import('@aipoch/research-film').ReplayRecords>
  generate: ResearchVideoGenerate
  reviewPlayer?: Parameters<typeof generateResearchFilm>[0]['reviewPlayer']
  reviewPlayerHeadless?: Parameters<typeof generateResearchFilm>[0]['reviewPlayer']
  checkHeadlessReadiness?: (signal: AbortSignal) => Promise<void>
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
  // A parked attempt releases the generation slot, but still owns resources until it settles.
  const attempts = new Set<Promise<void>>()
  const draining = new Map<
    string,
    { error: Error; status: ResearchVideoPresentationStatus; kind: 'disk' | 'build' }
  >()
  const sessionKey = (request: ResearchVideoPresentationRequest): string =>
    scopeKey({ ...request, branchId: undefined, mode: undefined })
  let active:
    | {
        key: string
        alias: string
        branchId?: string
        revision?: ResearchFilmRevision
        controller: AbortController
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
    const requestedKey = scopeKey(request)
    const current =
      active?.alias === requestedKey || active?.key === requestedKey ? active : undefined
    if (current?.branchId) request = { ...request, branchId: current.branchId }
    const revision = operationRevision
    const session = await options.loadSession(request.projectId, request.sessionId)
    signal.throwIfAborted()
    const block = researchVideoGenerationBlock(session, request)
    if (block === 'unavailable') return { generationBlock: block }
    const branchId = request.branchId ?? activeFilmBranch(session)
    const scope = { ...request, branchId }
    const resolvedKey = scopeKey(scope)
    const key = current?.key ?? (states.has(requestedKey) ? requestedKey : resolvedKey)
    const state = structuredClone(states.get(key) ?? {})
    if (branchId) state.branchId = branchId
    if (active && active.key !== key) state.preflightError = RESEARCH_FILM_BUSY_MESSAGE
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
      (request.mode !== 'operation-replay' && branchId !== request.branchId
        ? await local(request)
        : undefined) ??
      (session?.packageOrigin || session?.forkOrigin
        ? await options.loadImportedFilm?.(request)
        : undefined)
    signal.throwIfAborted()
    if ((!active || state.progress?.phase === 'failed') && session && !block) {
      const base = await directory(scopeKey(scope))
      signal.throwIfAborted()
      const saved = base && (await readPendingFilm(base))
      if (
        saved &&
        (saved.mode ?? 'research-explanation') === (request.mode ?? 'research-explanation') &&
        saved.id !== result?.id
      ) {
        const source =
          request.mode === 'operation-replay'
            ? operationReplaySource(session, request, await options.loadReplayRecords?.(session))
            : researchVideoSessionSource(session, request)
        let matches = saved.conversation === filmConversationDigest(source)
        if (matches && saved.reviewFailure) {
          const checksums: string[] = []
          matches = await stageResearchVideoSessionImages(
            source,
            session,
            options.dataRoot(),
            undefined,
            signal,
            checksums
          ).then(
            () =>
              saved.source === filmSourceFingerprint(saved.conversation, checksums, request.mode),
            () => false
          )
        }
        if (matches) {
          state.canResume = true
          if (saved.reviewFailure) state.reviewFailure = saved.reviewFailure
          if (saved.narrationReview) state.narrationReview = saved.narrationReview
          state.filmStep = saved.step
          state.progress ??= {
            phase: 'failed',
            startedAt: saved.startedAt,
            endedAt: saved.updatedAt
          }
          if (saved.step === 3 && saved.total)
            Object.assign(state.progress, { completed: saved.completed, total: saved.total })
        }
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
    const current = active?.key === key || active?.alias === key ? active : undefined
    if (current?.blockedStatus)
      return {
        ...current.blockedStatus,
        ...(current.branchId ? { branchId: current.branchId } : {})
      }
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
    {
      installNarration,
      resume,
      headless,
      revision,
      narrationReview: requestedNarrationReview
    }: {
      installNarration: boolean
      resume: boolean
      headless: boolean
      revision?: ResearchFilmRevision
      narrationReview?: ResearchFilmNarrationReview
    },
    prepared: (error?: ResearchFilmRevisionError) => void,
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
    let narrationReview = requestedNarrationReview
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
            : ['build', 'verifying', 'repairing', 'publishing'].includes(step.phase)
              ? 5
              : 4
      )
      states.set(key, { filmStep, progress: { ...step, startedAt }, narrationReview })
    }
    let admitted = false
    let lease: Awaited<ReturnType<LocalModelOwner['acquireUse']>> | undefined
    let job: string | undefined
    let checkpointStarted = false
    let completedResult: ResearchVideoPresentation | undefined
    let cancelled = false
    const headlessReview = headless && request.mode !== 'operation-replay'
    const reviewPlayer = headlessReview ? options.reviewPlayerHeadless : options.reviewPlayer
    log.info('film invocation started', { ...context(), phase: stage })
    try {
      const session = await checkFilmReadiness(
        () => options.loadSession(request.projectId, request.sessionId),
        signal
      )
      signal.throwIfAborted()
      if (!session) {
        if (revision) throw new ResearchFilmRevisionError()
        throw new Error('Research session is unavailable.')
      }
      const block = researchVideoGenerationBlock(session, request)
      if (revision && (block || (activeFilmBranch(session) && !request.branchId)))
        throw new ResearchFilmRevisionError()
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
      let source =
        request.mode === 'operation-replay'
          ? operationReplaySource(
              session,
              request,
              await checkFilmReadiness(
                () =>
                  options.loadReplayRecords?.(session) ??
                  Promise.resolve({ reviews: [], jobs: [] }),
                signal
              )
            )
          : researchVideoSessionSource(session, request)
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
      const fingerprint = filmSourceFingerprint(conversation, checksums, request.mode)
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
        resume &&
        previous?.source === fingerprint &&
        previous.id !== published?.id &&
        (previous.mode ?? 'research-explanation') === (request.mode ?? 'research-explanation')
          ? previous
          : undefined
      const failedReview = resumable?.reviewFailure
      if (revision && failedReview?.attemptId !== revision.attemptId)
        throw new ResearchFilmRevisionError()
      if (headless && failedReview && !revision) return
      narrationReview ??= resumable?.narrationReview
      const pending =
        resumable?.built && (await diskStep(() => filmPathInfo(join(existingBase!, 'pending'))))
      const hasBuiltOutput =
        !revision &&
        resumable?.built &&
        (!headlessReview || resumable.built.sessionAppMode !== 'live') &&
        (request.mode === 'operation-replay' ||
          (!headlessReview && !reviewPlayer) ||
          resumable.visualChecked) &&
        resumable.outputFingerprint &&
        resumable.outputFingerprint ===
          (await diskStep(() =>
            filmOutputFingerprint(join(existingBase!, pending ? 'pending' : resumable.id), signal)
          ))
      if (headlessReview && !hasBuiltOutput) {
        if (!reviewPlayer)
          throw new Error(
            'Headless film verification is unavailable. Use Open-Science Desktop or configure the headless browser.'
          )
        if (options.checkHeadlessReadiness)
          await checkFilmReadiness(options.checkHeadlessReadiness, signal)
      }
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
      if (!revision) prepared()
      base = existingBase ?? (await diskStep(() => directory(scopeKey(scope), true)))!
      const publishBase = base
      job = join(base, 'pending')
      if (resumable) {
        saved = { ...resumable, attempt: resumable.attempt + 1, narrationReview }
        replayStep = resumable.step
        if (revision && failedReview) {
          saved.revision = {
            ...revision,
            findings: failedReview.findings,
            baseAttemptId: resumable.revision?.attemptId
          }
          saved.step = 1
          delete saved.completed
          delete saved.total
          replayStep = 0
        }
        delete saved.reviewFailure
      } else {
        await diskStep(() => removePendingPointer(publishBase))
        await diskStep(() => rm(job!, { recursive: true, force: true }))
        saved = {
          version: 2,
          mode: request.mode ?? 'research-explanation',
          id: randomUUID(),
          source: fingerprint,
          conversation,
          narrationReview,
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
        delete saved.visualChecked
        delete saved.outputFingerprint
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
        if (newPending || (revision && narrationReview !== resumable?.narrationReview)) {
          const { projectId, sessionId, branchId } = source.provenance
          await diskStep(() =>
            savePendingFilmOwner(job!, {
              id,
              projectId,
              sessionId,
              branchId,
              mode: request.mode,
              narrationReview
            })
          )
        }
        await diskStep(async () => {
          await savePendingFilm(publishBase, saved!)
          // The disk step checks cancellation again after the write. Record the durable checkpoint
          // first so that a cancellation during this write cannot remove it in finally.
          checkpointStarted = true
        })
        if (revision) prepared()
        for (const file of ['files', 'anims', 'libs', 'video.json', 'output', 'best-layout'])
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
        const attemptContext = { operationId: id, attempt: saved.attempt, invocationId }
        const checkpoint = filmAuthoringCheckpoint(job, (outcome) =>
          log.info('film authoring unit', { ...context(), phase: stage, outcome })
        )
        let sessionAppMode: 'drawn' | 'live' | undefined
        const confirmSessionApp = headless ? async () => false : options.confirmSessionApp
        if (confirmSessionApp && request.mode !== 'operation-replay')
          sessionAppMode = await stageFilmSessionApp(
            source,
            session,
            options.dataRoot(),
            job!,
            headless ? { ...checkpoint, read: async () => 'no' } : checkpoint,
            signal,
            confirmSessionApp
          )
        await diskStep(() =>
          writeDurableJsonFile(join(job!, 'session.json'), JSON.stringify(source))
        )
        const confirmedRevision = saved.revision
        const checkpointKey = (key: string, attemptId?: string): string =>
          attemptId ? `review-revision:${attemptId}:${key}` : key
        const generated = await filmAttempt.run(attemptContext, () =>
          generateResearchFilm({
            source,
            drawnSessionApp: sessionAppMode === 'drawn',
            directory: job!,
            author: options,
            signal,
            revisionGuidance: confirmedRevision && {
              feedback: confirmedRevision.feedback,
              findings: confirmedRevision.findings,
              readPreviousDraft: (key) =>
                diskStep(() => checkpoint.read(checkpointKey(key, confirmedRevision.baseAttemptId)))
            },
            checkpoint: {
              read: (key) =>
                diskStep(() => checkpoint.read(checkpointKey(key, confirmedRevision?.attemptId))),
              save: (key, value) =>
                diskStep(() =>
                  checkpoint.save(checkpointKey(key, confirmedRevision?.attemptId), value)
                )
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
                narrationReview,
                progress: {
                  phase: 'writing',
                  startedAt,
                  completed: Math.max(completed, saved?.completed ?? 0),
                  total
                }
              })
            },
            generate: options.generate,
            reviewPlayer,
            modelDirectory: dirname(model!.path),
            modelRevision: lease!.revision,
            engineDirectory: options.engineDirectory,
            onProgress: report
          })
        )
        if (source.sessionApp) sessionAppMode = generated.usedSessionApp ? 'live' : 'drawn'
        if (source.sessionApp && !generated.usedSessionApp)
          await diskStep(() => rm(join(job!, 'libs'), { recursive: true, force: true }))
        saved.built = {
          id,
          title: generated.title,
          duration: generated.duration,
          scriptScore: generated.scriptScore,
          narrationReview,
          sessionAppMode
        }
        saved.outputFingerprint = await diskStep(() => filmOutputFingerprint(job!, signal))
        if (!saved.outputFingerprint)
          throw new Error('Missing or empty research presentation output.')
        if (reviewPlayer && request.mode !== 'operation-replay') saved.visualChecked = true
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
      const receipt = JSON.stringify(saved.built!)
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
      if (diskFailure) {
        states.delete(key)
        return
      }
      await diskStep(async () => {
        for (const name of await readdir(outputJob)) {
          if (name.startsWith('unit-') || name === 'speech' || name === PENDING_FILM_OWNER)
            await rm(join(outputJob, name), { recursive: true, force: true })
        }
      }, true).catch(() => log.info('film cleanup deferred', { ...context(), phase: 'publishing' }))
      if (published && options.withUnusedFilmFiles && !diskFailure) {
        await diskStep(
          () =>
            pruneStoredResearchFilms(
              options.dataRoot(),
              scope,
              id,
              published.id,
              options.withUnusedFilmFiles!
            ),
          true
        ).catch(() => log.info('film retention deferred', { ...context(), phase: 'publishing' }))
      }
    } catch (error) {
      if (error instanceof ResearchFilmRevisionError) {
        prepared(error)
        return
      }
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
      const reviewFailure: ReviewFailure | undefined =
        !cancelled && !diskFailure && saved && error instanceof ResearchFilmReviewFailure
          ? {
              attemptId: invocationId,
              stage: error.stage,
              findings: error.findings
                .slice(0, 12)
                .map(
                  (finding) =>
                    finding.replace(/\s+/gu, ' ').trim().slice(0, 500) ||
                    'The film did not pass review.'
                )
            }
          : undefined
      if (saved && reviewFailure) saved.reviewFailure = reviewFailure
      const failureStatus: ResearchVideoPresentationStatus =
        !admitted && !cancelled
          ? {
              preflightError: reported instanceof Error ? reported.message : String(reported)
            }
          : {
              filmStep,
              narrationReview,
              progress: {
                phase: cancelled ? 'cancelled' : 'failed',
                startedAt,
                endedAt: Date.now()
              },
              ...(!cancelled
                ? {
                    error:
                      headless && reviewFailure
                        ? `Research film ${reviewFailure.stage} review failed. Read the findings before sending feedback.`
                        : reported instanceof Error
                          ? reported.message
                          : String(reported)
                  }
                : {})
            }
      if (!diskFailure && !reviewFailure) states.set(key, failureStatus)
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
      if (!diskFailure && reviewFailure) states.set(key, failureStatus)
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
      if (completedResult && !diskFailure) states.delete(key)
    }
  }
  return {
    status,
    async start(
      rawRequest: ResearchVideoOwnerStartRequest
    ): Promise<ResearchVideoPresentationStatus> {
      const {
        installNarration = false,
        resume = false,
        headless = false,
        revision,
        narrationReview,
        ...requestedScope
      } = researchVideoOwnerStartRequestSchema.parse(rawRequest)
      if (revision && (!headless || installNarration)) throw new ResearchFilmRevisionError()
      if (narrationReview && (!headless || requestedScope.mode === 'operation-replay'))
        throw new TypeError(
          'Advisory narration review is available only for headless Research explanation.'
        )
      const request = { ...requestedScope }
      if (headless && !request.branchId) {
        const session = await checkFilmReadiness(() =>
          options.loadSession(request.projectId, request.sessionId)
        )
        request.branchId = activeFilmBranch(session)
      }
      const key = scopeKey(request)
      const alias = scopeKey(requestedScope)
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
          if (
            revision &&
            (revision.attemptId !== active.revision?.attemptId ||
              revision.feedback !== active.revision.feedback)
          )
            throw new ResearchFilmRevisionError()
          await active.prepared
          return status(request)
        }
        throw new Error(RESEARCH_FILM_BUSY_MESSAGE)
      }
      if (installNarration && narrationInstall)
        throw new Error('Local model management is in progress.')
      const runOptions = {
        installNarration,
        resume: resume || Boolean(revision),
        headless,
        revision,
        narrationReview
      }
      if (!runOptions.resume) options.checkGenerationAdmission?.()
      if (alias !== key) states.delete(alias)
      operationRevision++
      const controller = new AbortController()
      let finishPreparation!: (error?: ResearchFilmRevisionError) => void
      const prepared = new Promise<void>((resolve, reject) => {
        finishPreparation = (error) => (error ? reject(error) : resolve())
      })
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
      }
      const operation = options.lifecycle
        ? options.lifecycle.run(request.projectId, request.sessionId, (signal) =>
            run(
              request,
              key,
              AbortSignal.any([signal, controller.signal]),
              runOptions,
              finishPreparation,
              park
            )
          )
        : run(request, key, controller.signal, runOptions, finishPreparation, park)
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
          draining.delete(session)
          if (active?.controller === controller) active = undefined
          attempts.delete(done)
        })
      attempts.add(done)
      active = {
        key,
        alias,
        branchId: request.branchId,
        revision,
        controller,
        prepared
      }
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
      if (active?.key === key || active?.alias === key)
        active.controller.abort(new Error('Research explanation cancelled.'))
    },
    async close(): Promise<void> {
      operationRevision++
      closed = true
      active?.controller.abort(new Error('Application is closing.'))
      await Promise.all(attempts)
    }
  }
}
