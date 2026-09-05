// IPC layer for the reviewer feature. Follows the same patterns as src/main/acp/ipc.ts and
// src/main/artifacts/ipc.ts: ipcMain.handle for renderer-callable commands and the shared renderer
// broadcaster for push events to Electron windows and optional web clients.

import { ipcMainHandle } from '../ipc-handler-registry'

import type {
  ReviewWithChecks,
  ReviewRunRequest,
  ReviewRunResult,
  ReviewUpdateEvent,
  ReviewSessionRequest,
  ReviewSuppressionEvent
} from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { REVIEWER_IPC } from '../../shared/reviewer'
import { createLogger } from '../logger'
import { runReview } from './orchestrator'
import { flagStaleReviews } from './stale-reviews'
import { ReviewRepository } from './repository'
import type { ReviewerAcpRuntime } from './acp-runtime'
import type { SessionAuxiliaryTurnUsageRecord } from '../session-persistence/auxiliary-turn-usage'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { getProjectDbClient } from '../projects/prisma-client'
import { SessionRepository } from '../session-persistence/repository'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import { acquireDataRootWriter } from '../storage/migration-state'
import { ReviewerProjectRuntimeOwner, type ReviewerProjectAdmission } from './project-runtime-owner'
import {
  shouldPersistSessionAgentConfiguration,
  toSessionAgentConfiguration,
  type SessionAgentTargetResolver
} from '../acp/session-agent-target'
import type { SessionAgentConfiguration } from '../../shared/settings'
import type { ArtifactVersionContentResolver } from './host-sdk'
import { toErrorMessage } from '../error-message'
import type { ReviewerPagedContentResolver } from './host-sdk'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'

const log = createLogger('reviewer:ipc')

// Sends a review update event to every open renderer window.
const broadcastReviewUpdate = (event: ReviewUpdateEvent): void => {
  broadcastToRenderers(REVIEWER_IPC.UPDATED, event)
}

// Broadcasts the loop-guard event that tells the renderer to skip the next auto-review call for the
// given session. Called just before the [Auditor] correction prompt is sent so the correction
// turn's stop does not spawn a second review run (Phase 1 single-round invariant). When clear=true
// it instead cancels a pending suppression — used when the correction turn failed to send, so the
// one-shot flag doesn't leak into the session's next real turn.
const broadcastSuppressNextAutoReview = (
  projectId: string,
  appSessionId: string,
  clear = false
): void => {
  const event: ReviewSuppressionEvent = { projectId, appSessionId, clear }
  broadcastToRenderers(REVIEWER_IPC.SUPPRESS_NEXT_AUTO_REVIEW, event)
}

// Broadcasts a fix-loop-start event: the renderer reacts by setting fixLoopActive=true on the
// session and disabling the composer send button for the duration of the loop.
const broadcastFixLoopStart = (projectId: string, appSessionId: string): void => {
  const event: ReviewSessionRequest = { projectId, appSessionId }
  broadcastToRenderers(REVIEWER_IPC.FIX_LOOP_START, event)
}

// Broadcasts a fix-loop-end event: the renderer reacts by clearing fixLoopActive on the session
// and re-enabling the composer send button.
const broadcastFixLoopEnd = (projectId: string, appSessionId: string): void => {
  const event: ReviewSessionRequest = { projectId, appSessionId }
  broadcastToRenderers(REVIEWER_IPC.FIX_LOOP_END, event)
}

// Creates the shared ReviewRepository backed by the production SQLite client. The injected
// storageRoot (when provided) MUST be respected — registerReviewerIpcHandlers threads its
// options.storageRoot through here so reviewers can be wired against a non-default config root
// (e.g. a relocated user data dir).
const createDefaultReviewRepository = (
  storageRoot: string,
  snapshotStorageRoot?: string
): ReviewRepository => {
  return new ReviewRepository(() => getProjectDbClient(storageRoot), { snapshotStorageRoot })
}

type ReviewerIpcOptions = {
  // The ACP runtime used to spawn reviewer sessions.
  acpRuntime: ReviewerAcpRuntime
  mcpEntryPath?: string
  // Optional override for the config root (DB/sessions) (for testing).
  storageRoot?: string
  // Optional override for the data root (artifacts) (for testing).
  dataRoot?: string
  managedFileVersions?: Pick<ManagedFileVersionService, 'openVersion'>
  artifactCatalog?: {
    readHostArtifactCatalog(request: {
      projectId: string
      versionId: string
      finalizedArtifactsOnly: true
    }): Promise<
      Array<{
        source: 'artifact' | 'upload'
        sourceFileId: string
        sessionId: string
        versionId: string
      }>
    >
  }
  artifactProvenanceRepository?: Pick<ArtifactProvenanceRepository, 'getReviewerVersionTrace'> &
    Partial<Pick<ArtifactProvenanceRepository, 'resolveReviewerTurnFileEvidence'>>
  pagedContentResolver?: ReviewerPagedContentResolver
  withSessionMutation?: <Result>(
    projectId: string,
    sessionId: string,
    mutation: () => Promise<Result>
  ) => Promise<Result>
  modelRuntime?: Readonly<{
    admit: () => Promise<
      Readonly<{
        model: string
        reviewerAcpRuntime?: ReviewerAcpRuntime
        release: () => Promise<void>
      }>
    >
  }>
  projectRuntime?: Pick<ReviewerProjectRuntimeOwner, 'admit'>
  withProjectAvailable?: <Result>(
    projectId: string,
    operation: () => Promise<Result>
  ) => Promise<Result>
  resolveSessionAgentTarget?: SessionAgentTargetResolver
  saveSessionAgentConfiguration?: (
    session: PersistedChatSession,
    configuration: SessionAgentConfiguration
  ) => Promise<PersistedChatSession>
  recordUsage?: (record: SessionAuxiliaryTurnUsageRecord) => Promise<unknown>
}

type ReviewerCommandOwner = Readonly<{
  run: (request: ReviewRunRequest) => Promise<ReviewRunResult>
  triggerReview: (request: ReviewRunRequest) => Promise<ReviewRunResult>
  getForSession: (request: ReviewSessionRequest) => Promise<ReviewWithChecks[]>
  abort: (request: ReviewSessionRequest) => void
  abortFixLoop: (request: ReviewSessionRequest) => void
}>

type InFlightReviewStart = Readonly<{
  promise: Promise<ReviewRunResult>
  resolve: (result: ReviewRunResult) => void
  reject: (error: unknown) => void
}>

const createInFlightReviewStart = (): InFlightReviewStart => {
  let resolve!: (result: ReviewRunResult) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<ReviewRunResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  // The owning request also rethrows setup failures. Keep the shared outcome safe when no duplicate
  // caller has joined it yet.
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

// Owns reviewer arbitration and fix-loop cancellation independently from any command transport.
// The triggerReview alias preserves the existing direct-call result returned by IPC registration.
const createReviewerCommandOwner = (options: ReviewerIpcOptions): ReviewerCommandOwner => {
  const storageRoot = options.storageRoot ?? resolveConfigRoot()
  const dataRoot = options.dataRoot ?? resolveDataRoot()
  const artifactProvenanceRepository = options.artifactProvenanceRepository
  const reviewRepository = createDefaultReviewRepository(storageRoot, dataRoot)
  let recoveryGate: Promise<void> | undefined
  const ensureRecovery = (): Promise<void> => {
    if (recoveryGate) return recoveryGate
    const attempt = reviewRepository.recoverInterruptedReviews().then((count) => {
      if (count > 0) {
        log.warn('recovered interrupted reviews', { count })
      }
    })
    recoveryGate = attempt
    void attempt.catch((error: unknown) => {
      log.error('review recovery failed', {
        error: toErrorMessage(error)
      })
      if (recoveryGate === attempt) {
        recoveryGate = undefined
      }
    })
    return attempt
  }
  void ensureRecovery()
  const sessionRepository = new SessionRepository(storageRoot)
  const resolveArtifactVersion: ArtifactVersionContentResolver | undefined =
    options.managedFileVersions
      ? async (request) => {
          const match = options.artifactCatalog
            ? (
                await options.artifactCatalog.readHostArtifactCatalog({
                  projectId: request.projectId,
                  versionId: request.versionId,
                  finalizedArtifactsOnly: true
                })
              )[0]
            : request.fileId && request.sessionId
              ? {
                  source: 'artifact' as const,
                  sourceFileId: request.fileId,
                  sessionId: request.sessionId,
                  versionId: request.versionId
                }
              : undefined
          if (!match) throw new Error(`Managed File Version not found: ${request.versionId}`)
          const lease = await options.managedFileVersions!.openVersion(
            {
              source: match.source,
              projectId: request.projectId,
              fileId: match.sourceFileId
            },
            request.versionId
          )
          if (
            request.sessionId &&
            match.source === 'artifact' &&
            match.sessionId !== request.sessionId
          ) {
            await lease.close()
            throw new Error('Artifact Version belongs to a different Session.')
          }
          return {
            path: lease.path,
            filename: lease.version.filename,
            ...(lease.version.contentType ? { contentType: lease.version.contentType } : {}),
            checksum: lease.version.checksum,
            size: lease.size,
            readRange: lease.readRange,
            verifyUnchanged: lease.verifyUnchanged,
            close: lease.close
          }
        }
      : undefined
  const projectRuntime = options.projectRuntime ?? new ReviewerProjectRuntimeOwner()
  // Per-session abort capabilities for active and queued fix loops. Keyed by the main session id
  // (not the reviewer session id). Project deletion owns the same signal, so user cancellation and
  // Project quiescence converge on one operation without maintaining competing AbortControllers.
  const fixLoopAbortControllers = new Map<string, Set<() => void>>()
  const fixLoopLifecycles = new Map<string, Promise<void>>()
  // Task cancellation targets the whole admitted Review chain, including the initial assessment.
  // Keep this separate from the renderer's fix-loop-only affordance and allow concurrent manual
  // Reviews for different turns in one Session to be cancelled together.
  const activeReviewAbortControllers = new Map<string, Set<() => void>>()

  // Guards against concurrent reviews of the same turn — e.g. a double-clicked "Re-run review" or two
  // stale cards fired at once. Project is part of the key because Session ids are not globally owned.
  // Duplicate callers share the authoritative start outcome so they cannot release their renderer gate
  // before the owning run either broadcasts `running` or reports a pre-start failure.
  const inFlightReviewStarts = new Map<string, InFlightReviewStart>()

  // Loads persisted reviews for a session at startup, flagging any whose
  // audited turn has since changed (e.g. an artifact was edited after the review completed) so the UI
  // does not present a stale verdict as current.
  const getForSession = async (request: ReviewSessionRequest): Promise<ReviewWithChecks[]> => {
    await ensureRecovery()
    const reviews = await reviewRepository.getReviewsForProjectSession(
      request.projectId,
      request.appSessionId
    )
    let session: PersistedChatSession | undefined
    try {
      session = await sessionRepository.loadSession(request.projectId, request.appSessionId)
    } catch {
      return reviews
    }
    return flagStaleReviews(reviews, session, dataRoot, resolveArtifactVersion)
  }

  const abortFixLoop = (request: ReviewSessionRequest): void => {
    const key = `${request.projectId}\0${request.appSessionId}`
    const controllers = fixLoopAbortControllers.get(key)
    if (controllers && controllers.size > 0) {
      log.info('fix loop abort requested', request)
      for (const controller of controllers) controller()
    } else {
      log.warn('abort-fix-loop: no active fix loop found for session', request)
    }
  }

  const abort = (request: ReviewSessionRequest): void => {
    const key = `${request.projectId}\0${request.appSessionId}`
    const controllers = activeReviewAbortControllers.get(key)
    if (!controllers || controllers.size === 0) {
      log.warn('abort: no active review found for session', request)
      return
    }
    log.info('review abort requested', request)
    for (const controller of controllers) controller()
  }

  // Returns whether a review actually STARTED. The session is loaded up front (not in the background)
  // so a load failure is reported as started:false with NO Review row created. That lets a caller
  // (e.g. the ReviewerCard "Re-run") release its pending state and leave the turn retriable, instead
  // of us fabricating a non-retriable error review.
  const triggerAdmittedReview = async (
    request: ReviewRunRequest,
    projectAdmission: ReviewerProjectAdmission
  ): Promise<ReviewRunResult> => {
    const {
      sessionId,
      turnMessageId,
      scopeTurnMessageId,
      evidenceScope,
      projectId,
      mainSessionId,
      model: rendererModel
    } = request
    // Reserve the turn SYNCHRONOUSLY (before any await) so a double-click / multiple stale cards can't
    // both pass the guard before the key is set. A duplicate joins the owner's start verdict instead
    // of reporting `already-in-flight`, which would release its renderer gate before `running` exists.
    const inFlightKey = `${projectId}\0${sessionId}\0${turnMessageId}`
    const existingStart = inFlightReviewStarts.get(inFlightKey)
    if (existingStart) {
      log.info('review joined: already in flight for this turn', { sessionId, turnMessageId })
      return await existingStart.promise.then((result) => {
        projectAdmission.release()
        return result
      })
    }
    const inFlightStart = createInFlightReviewStart()
    inFlightReviewStarts.set(inFlightKey, inFlightStart)
    const finishBeforeBackground = (result: ReviewRunResult): ReviewRunResult => {
      inFlightReviewStarts.delete(inFlightKey)
      inFlightStart.resolve(result)
      projectAdmission.release()
      return result
    }

    try {
      await ensureRecovery()
    } catch (error) {
      inFlightReviewStarts.delete(inFlightKey)
      inFlightStart.reject(error)
      throw error
    }

    // Atomic per-turn idempotency for auto-review. The in-flight key (reserved synchronously above)
    // serializes concurrent starts; this DB check — running while we hold that key — covers the other
    // half: a run by another entry that has already COMPLETED and released its key. main is the single
    // process every renderer's IPC funnels through, so together they are the real mutex the renderer's
    // store check could only approximate (that check races across processes). If any review already
    // exists for this turn, an auto request is a duplicate → refuse. Manual re-runs (Request review,
    // stale/error Re-run) set origin='manual' and skip this so the user can force a fresh review.
    if (request.origin === 'auto') {
      try {
        const existing = await reviewRepository.getReviewsForProjectSession(projectId, sessionId)
        if (existing.some((review) => review.turnMessageId === turnMessageId)) {
          log.info('auto review skipped: turn already has a review', { sessionId, turnMessageId })
          return finishBeforeBackground({ started: false, reason: 'already-reviewed' })
        }
      } catch (error) {
        // Fail CLOSED: if the lookup itself threw we cannot confirm the turn is un-reviewed, and
        // proceeding could create a second review/fix-loop for a turn that already has one — exactly the
        // cross-entry duplicate this check exists to prevent. Release the lock and report a retryable
        // failure so the auto path re-runs the (now hopefully recovered) check instead of duplicating.
        log.warn('auto-review idempotency check failed; refusing to start (fail-closed)', {
          sessionId,
          turnMessageId,
          error: toErrorMessage(error)
        })
        return finishBeforeBackground({ started: false, reason: 'idempotency-check-failed' })
      }
    }

    // Direct, repeatable loader used both for the start gate and every fix-loop refresh. The previous
    // closure returned the `session` variable below forever, so a correction turn could never appear.
    const loadCurrentSession = async (): Promise<PersistedChatSession | undefined> => {
      if (projectId) return sessionRepository.loadSession(projectId, sessionId)
      const { sessions } = await sessionRepository.loadAll()
      return sessions.find((candidate) => candidate.id === sessionId)
    }

    let session: PersistedChatSession | undefined
    try {
      session = await loadCurrentSession()
    } catch (error) {
      // No Review row exists to update, so surface the failure only as started:false — the renderer
      // keeps the (stale) card and its Re-run affordance so the user can try again.
      log.error('review start failed: could not load session', {
        sessionId,
        turnMessageId,
        error: toErrorMessage(error)
      })
      // Transient store read failure — no Review row, lock released. Safe (and worth) retrying.
      return finishBeforeBackground({ started: false, reason: 'load-failed' })
    }

    // Session load succeeded but the id is gone (deleted between the card render and the click).
    // Bail out exactly like the load-failure path: release the lock and report started:false with NO
    // Review row. Falling through to runReview would create a non-retriable error card that replaces
    // the (stale) card the user was trying to re-run, and an earlier turn has no composer entry to
    // recover from — so the turn would be stuck. started:false keeps the existing card and its Re-run.
    if (!session) {
      log.warn('review start failed: session not found', { sessionId, turnMessageId })
      // The session may simply not be flushed to disk yet (async persistence queue) — a retry can
      // catch it once the write lands, so report the race-shaped reason rather than a hard failure.
      return finishBeforeBackground({ started: false, reason: 'not-found' })
    }

    let agentTarget
    try {
      agentTarget = await options.resolveSessionAgentTarget?.(session)
      if (
        agentTarget &&
        options.saveSessionAgentConfiguration &&
        shouldPersistSessionAgentConfiguration(session.agentConfiguration, agentTarget)
      ) {
        await options.saveSessionAgentConfiguration(
          session,
          toSessionAgentConfiguration(agentTarget)
        )
      }
    } catch (error) {
      log.error('review start failed: could not resolve Session agent target', {
        sessionId,
        turnMessageId,
        error: toErrorMessage(error)
      })
      return finishBeforeBackground({ started: false, reason: 'run-failed' })
    }

    log.info('review triggered', { sessionId, turnMessageId })

    let modelAdmission: Awaited<
      ReturnType<NonNullable<ReviewerIpcOptions['modelRuntime']>['admit']>
    >
    try {
      modelAdmission = options.modelRuntime
        ? await options.modelRuntime.admit()
        : {
            model: rendererModel ?? '',
            release: async () => undefined
          }
    } catch (error) {
      log.error('review start failed: model admission failed', {
        sessionId,
        turnMessageId,
        error: toErrorMessage(error)
      })
      return finishBeforeBackground({ started: false, reason: 'run-failed' })
    }

    let releaseDataRootWriter: (() => void) | undefined
    try {
      // The review can publish immutable scope snapshots after `triggerReview` has already returned
      // started:true. Hold a migration writer lease until the background review/fix loop actually
      // settles, so storage cutover cannot race that late sidecar write.
      releaseDataRootWriter = acquireDataRootWriter()
    } catch {
      await modelAdmission.release().catch((error: unknown) => {
        log.error('review start cleanup failed', {
          sessionId,
          turnMessageId,
          error: toErrorMessage(error)
        })
      })
      return finishBeforeBackground({ started: false, reason: 'run-failed' })
    }

    // Resolve `started` only once the running Review row has actually been created and pushed
    // (runReview's onStarted). If runReview fails BEFORE that (scope resolution or the DB insert), it
    // settles without onStarted → started:false, so the caller (Re-run) stays retriable. The full
    // review (reviewer session + fix loop) continues in the background regardless.
    const startBackground = (): void => {
      const effectiveMainSessionId = mainSessionId ?? sessionId
      const effectiveMainSessionKey = `${projectId}\0${effectiveMainSessionId}`
      const activeControllers =
        activeReviewAbortControllers.get(effectiveMainSessionKey) ?? new Set<() => void>()
      activeControllers.add(projectAdmission.abort)
      activeReviewAbortControllers.set(effectiveMainSessionKey, activeControllers)
      let releaseFixLoop: (() => void) | undefined
      let fixLoopBroadcastStarted = false

      void runReview({
        sessionId,
        turnMessageId,
        scopeTurnMessageId,
        evidenceScope,
        projectId,
        mainSessionId,
        model: modelAdmission.model,
        // Reload on every orchestrator request. In particular, the post-correction read must observe
        // the newly persisted [Auditor] and agent messages instead of the review-start snapshot.
        getSession: loadCurrentSession,
        reviewRepository,
        runSessionMutation: options.withSessionMutation
          ? (mutation) => options.withSessionMutation!(projectId, sessionId, mutation)
          : undefined,
        acpRuntime: options.acpRuntime,
        ...(agentTarget ? { agentTarget } : {}),
        ...(modelAdmission.reviewerAcpRuntime
          ? { reviewerAcpRuntime: modelAdmission.reviewerAcpRuntime }
          : {}),
        // Artifacts live under the relocatable data root; DB/sessions stay on the config root.
        artifactStorageRoot: dataRoot,
        artifactVersionResolvers: {
          ...(resolveArtifactVersion ? { content: resolveArtifactVersion } : {}),
          ...(artifactProvenanceRepository
            ? {
                trace: (request: { projectId: string; versionId: string }) =>
                  artifactProvenanceRepository.getReviewerVersionTrace(request)
              }
            : {}),
          ...(options.pagedContentResolver ? { pagedContent: options.pagedContentResolver } : {})
        },
        ...(artifactProvenanceRepository?.resolveReviewerTurnFileEvidence
          ? {
              reviewerFileEvidenceResolver: (request) =>
                artifactProvenanceRepository.resolveReviewerTurnFileEvidence!(request)
            }
          : {}),
        reviewerMcpEntryPath: options.mcpEntryPath,
        onStarted: () => inFlightStart.resolve({ started: true }),
        onReviewUpdate: (review: ReviewWithChecks) => {
          broadcastReviewUpdate({ review })
        },
        // Before the correction prompt is sent, suppress the next auto-review for the main
        // session so the [Auditor] correction turn's stop event does not re-trigger a review.
        onCorrectionPrompt: () => {
          if (mainSessionId) {
            broadcastSuppressNextAutoReview(projectId, mainSessionId)
          }
        },
        // If the correction turn fails to send, its stop never arrives — clear the suppression so
        // the session's next real turn still gets auto-reviewed.
        onCorrectionFailed: () => {
          if (mainSessionId) {
            broadcastSuppressNextAutoReview(projectId, mainSessionId, true)
          }
        },
        // Broadcast fix-loop lifecycle events and register/deregister the admitted abort capability.
        onFixLoopStart: async () => {
          const previous = fixLoopLifecycles.get(effectiveMainSessionKey)
          let release!: () => void
          const hold = new Promise<void>((resolve) => {
            release = resolve
          })
          const lifecycle = previous ? previous.catch(() => undefined).then(() => hold) : hold
          fixLoopLifecycles.set(effectiveMainSessionKey, lifecycle)
          const controllers =
            fixLoopAbortControllers.get(effectiveMainSessionKey) ?? new Set<() => void>()
          controllers.add(projectAdmission.abort)
          fixLoopAbortControllers.set(effectiveMainSessionKey, controllers)
          if (previous) await previous.catch(() => undefined)

          let released = false
          releaseFixLoop = () => {
            if (released) return
            released = true
            release()
            void lifecycle.then(() => {
              if (fixLoopLifecycles.get(effectiveMainSessionKey) === lifecycle) {
                fixLoopLifecycles.delete(effectiveMainSessionKey)
              }
            })
          }
          if (projectAdmission.signal.aborted) {
            releaseFixLoop()
            return
          }
          fixLoopBroadcastStarted = true
          broadcastFixLoopStart(projectId, effectiveMainSessionId)
        },
        onFixLoopEnd: () => {
          const controllers = fixLoopAbortControllers.get(effectiveMainSessionKey)
          controllers?.delete(projectAdmission.abort)
          if (controllers?.size === 0) fixLoopAbortControllers.delete(effectiveMainSessionKey)
          if (fixLoopBroadcastStarted) broadcastFixLoopEnd(projectId, effectiveMainSessionId)
          releaseFixLoop?.()
        },
        fixLoopAbortSignal: projectAdmission.signal,
        recordUsage: options.recordUsage
      })
        .catch((error: unknown) => {
          // runReview records expected failures as lifecycle='error' itself; an unexpected throw here
          // (e.g. the createReview insert failed before onStarted) is logged and reported as not-started.
          log.error('runReview threw unexpectedly', {
            sessionId,
            turnMessageId,
            error: toErrorMessage(error)
          })
        })
        .finally(async () => {
          // If the run ended without ever signalling onStarted, no review actually began — this is a
          // genuine pre-push failure (scope/insert), not a persistence race, so it is not auto-retried.
          inFlightStart.resolve({ started: false, reason: 'run-failed' })
          inFlightReviewStarts.delete(inFlightKey)
          activeControllers.delete(projectAdmission.abort)
          if (activeControllers.size === 0) {
            activeReviewAbortControllers.delete(effectiveMainSessionKey)
          }
          try {
            releaseDataRootWriter?.()
          } finally {
            await modelAdmission.release().catch((error: unknown) => {
              log.error('review runtime cleanup failed', {
                sessionId,
                turnMessageId,
                error: toErrorMessage(error)
              })
            })
            projectAdmission.release()
          }
        })
    }

    startBackground()

    return await inFlightStart.promise
  }

  const triggerReview = (request: ReviewRunRequest): Promise<ReviewRunResult> => {
    const admitReview = (): Promise<ReviewRunResult> => {
      let projectAdmission: ReviewerProjectAdmission
      try {
        // Admission is acquired synchronously before session/repository/model work begins. Once
        // Project deletion closes it, no new Reviewer operation can slip into the quiescence snapshot.
        projectAdmission = projectRuntime.admit(request.projectId)
      } catch (error) {
        return Promise.reject(error)
      }
      return triggerAdmittedReview(request, projectAdmission).catch((error: unknown) => {
        projectAdmission.release()
        throw error
      })
    }
    return options.withProjectAvailable
      ? options.withProjectAvailable(request.projectId, admitReview)
      : admitReview()
  }

  return { run: triggerReview, triggerReview, getForSession, abort, abortFixLoop }
}

// Registers the legacy Electron adapter against an injectable owner. A future Host command
// registrar can receive the same owner instance without duplicating arbitration state.
const registerReviewerIpcHandlers = (
  options: ReviewerIpcOptions,
  owner: ReviewerCommandOwner = createReviewerCommandOwner(options)
): ReviewerCommandOwner => {
  ipcMainHandle(REVIEWER_IPC.RUN, (_event, request: ReviewRunRequest) => owner.run(request))
  ipcMainHandle(REVIEWER_IPC.GET_FOR_SESSION, (_event, request: ReviewSessionRequest) =>
    owner.getForSession(request)
  )
  ipcMainHandle(REVIEWER_IPC.ABORT_FIX_LOOP, (_event, request: ReviewSessionRequest) =>
    owner.abortFixLoop(request)
  )
  return owner
}

export type { ReviewerCommandOwner, ReviewerIpcOptions }
export { registerReviewerIpcHandlers, createReviewerCommandOwner, createDefaultReviewRepository }
