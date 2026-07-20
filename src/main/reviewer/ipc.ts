// IPC layer for the reviewer feature. Follows the same patterns as src/main/acp/ipc.ts and
// src/main/artifacts/ipc.ts: ipcMain.handle for renderer-callable commands and the shared renderer
// broadcaster for push events to Electron windows and optional web clients.

import { ipcMain } from 'electron'

import type {
  ReviewWithChecks,
  ReviewRunRequest,
  ReviewRunResult,
  ReviewUpdateEvent
} from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { REVIEWER_IPC } from '../../shared/reviewer'
import { createLogger } from '../logger'
import { runReview } from './orchestrator'
import { flagStaleReviews } from './stale-reviews'
import { ReviewRepository } from './repository'
import type { AcpRuntime } from '../acp/runtime'
import { resolveDataRoot, resolveStorageRoot } from '../storage-root'
import { getProjectDbClient } from '../projects/prisma-client'
import { SessionRepository } from '../session-persistence/repository'
import { broadcastToRenderers } from '../renderer-broadcast'

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
const broadcastSuppressNextAutoReview = (sessionId: string, clear = false): void => {
  broadcastToRenderers(REVIEWER_IPC.SUPPRESS_NEXT_AUTO_REVIEW, { sessionId, clear })
}

// Broadcasts a fix-loop-start event: the renderer reacts by setting fixLoopActive=true on the
// session and disabling the composer send button for the duration of the loop.
const broadcastFixLoopStart = (sessionId: string): void => {
  broadcastToRenderers(REVIEWER_IPC.FIX_LOOP_START, { sessionId })
}

// Broadcasts a fix-loop-end event: the renderer reacts by clearing fixLoopActive on the session
// and re-enabling the composer send button.
const broadcastFixLoopEnd = (sessionId: string): void => {
  broadcastToRenderers(REVIEWER_IPC.FIX_LOOP_END, { sessionId })
}

// Creates the shared ReviewRepository backed by the production SQLite client.
const createDefaultReviewRepository = (): ReviewRepository => {
  const storageRoot = resolveStorageRoot()

  return new ReviewRepository(() => getProjectDbClient(storageRoot))
}

type ReviewerIpcOptions = {
  // The ACP runtime used to spawn reviewer sessions.
  acpRuntime: AcpRuntime
  // Optional override for the config root (DB/sessions) (for testing).
  storageRoot?: string
  // Optional override for the data root (artifacts) (for testing).
  dataRoot?: string
}

// Registers the reviewer IPC handlers on the Electron main process. Returns a function that can
// be called directly to trigger a review (e.g., from the finishRun hook path).
const registerReviewerIpcHandlers = (
  options: ReviewerIpcOptions
): {
  triggerReview: (request: ReviewRunRequest) => Promise<ReviewRunResult>
} => {
  const storageRoot = options.storageRoot ?? resolveStorageRoot()
  const dataRoot = options.dataRoot ?? resolveDataRoot()
  const reviewRepository = createDefaultReviewRepository()
  const sessionRepository = new SessionRepository(storageRoot)

  // Per-session AbortControllers for active fix loops. Keyed by the main session id (not the
  // reviewer session id). Entries are created when a fix loop starts and deleted when it ends.
  const fixLoopAbortControllers = new Map<string, AbortController>()

  // Guards against concurrent reviews of the same turn — e.g. a double-clicked "Re-run review" or two
  // stale cards fired at once. Keyed by `${sessionId}:${turnMessageId}` (the grouping turn), cleared
  // when the run settles. The renderer also disables its button, but this is the authoritative guard.
  const inFlightReviewKeys = new Set<string>()

  // reviewer:run — trigger a review for a completed turn. Fire-and-forget: the renderer does
  // not await this; it receives reviewer:updated events as the lifecycle progresses.
  ipcMain.handle(REVIEWER_IPC.RUN, (_event, request: ReviewRunRequest) => triggerReview(request))

  // reviewer:get-for-session — load persisted reviews for a session at startup, flagging any whose
  // audited turn has since changed (e.g. an artifact was edited after the review completed) so the UI
  // does not present a stale verdict as current.
  ipcMain.handle(REVIEWER_IPC.GET_FOR_SESSION, async (_event, sessionId: string) => {
    const reviews = await reviewRepository.getReviewsForSession(sessionId)
    let session: PersistedChatSession | undefined
    try {
      const { sessions } = await sessionRepository.loadAll()
      session = sessions.find((candidate) => candidate.id === sessionId)
    } catch {
      return reviews
    }
    return flagStaleReviews(reviews, session, dataRoot)
  })

  // reviewer:abort-fix-loop — renderer requests that the active fix loop for a session be aborted.
  // This is triggered when the user presses the cancel button during a fix loop.
  ipcMain.handle(REVIEWER_IPC.ABORT_FIX_LOOP, (_event, sessionId: string) => {
    const controller = fixLoopAbortControllers.get(sessionId)
    if (controller) {
      log.info('fix loop abort requested', { sessionId })
      controller.abort()
    } else {
      log.warn('abort-fix-loop: no active fix loop found for session', { sessionId })
    }
  })

  // Returns whether a review actually STARTED. The session is loaded up front (not in the background)
  // so a load failure — or an already-in-flight run for this turn — is reported as started:false with
  // NO Review row created. That lets a caller (e.g. the ReviewerCard "Re-run") release its pending
  // state and leave the turn retriable, instead of us fabricating a non-retriable error review.
  const triggerReview = async (request: ReviewRunRequest): Promise<ReviewRunResult> => {
    const { sessionId, turnMessageId, scopeTurnMessageId, projectId, mainSessionId, model } =
      request

    // Reserve the turn SYNCHRONOUSLY (before any await) so a double-click / multiple stale cards can't
    // both pass the guard before the key is set. Released on the start-failure paths and, on success,
    // in the background run's finally.
    const inFlightKey = `${sessionId}:${turnMessageId}`
    if (inFlightReviewKeys.has(inFlightKey)) {
      log.info('review skipped: already in flight for this turn', { sessionId, turnMessageId })
      // The turn IS being handled by the in-flight run — this is NOT a retry candidate. Retrying
      // after the lock releases would launch a duplicate review (and possibly a second fix loop).
      return { started: false, reason: 'already-in-flight' }
    }
    inFlightReviewKeys.add(inFlightKey)

    // Atomic per-turn idempotency for auto-review. The in-flight key (reserved synchronously above)
    // serializes concurrent starts; this DB check — running while we hold that key — covers the other
    // half: a run by another entry that has already COMPLETED and released its key. main is the single
    // process every renderer's IPC funnels through, so together they are the real mutex the renderer's
    // store check could only approximate (that check races across processes). If any review already
    // exists for this turn, an auto request is a duplicate → refuse. Manual re-runs (Request review,
    // stale/error Re-run) set origin='manual' and skip this so the user can force a fresh review.
    if (request.origin === 'auto') {
      try {
        const existing = await reviewRepository.getReviewsForSession(sessionId)
        if (existing.some((review) => review.turnMessageId === turnMessageId)) {
          inFlightReviewKeys.delete(inFlightKey)
          log.info('auto review skipped: turn already has a review', { sessionId, turnMessageId })
          return { started: false, reason: 'already-reviewed' }
        }
      } catch (error) {
        // A review-store read failure is non-fatal here: fall through and let the normal session
        // load + run guard correctness. Worst case is the duplicate this check would have prevented.
        log.warn('auto-review idempotency check failed; proceeding', {
          sessionId,
          turnMessageId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    let session: PersistedChatSession | undefined
    try {
      const { sessions } = await sessionRepository.loadAll()
      session = sessions.find((s) => s.id === sessionId)
    } catch (error) {
      // No Review row exists to update, so surface the failure only as started:false — the renderer
      // keeps the (stale) card and its Re-run affordance so the user can try again.
      inFlightReviewKeys.delete(inFlightKey)
      log.error('review start failed: could not load session', {
        sessionId,
        turnMessageId,
        error: error instanceof Error ? error.message : String(error)
      })
      // Transient store read failure — no Review row, lock released. Safe (and worth) retrying.
      return { started: false, reason: 'load-failed' }
    }

    // Session load succeeded but the id is gone (deleted between the card render and the click).
    // Bail out exactly like the load-failure path: release the lock and report started:false with NO
    // Review row. Falling through to runReview would create a non-retriable error card that replaces
    // the (stale) card the user was trying to re-run, and an earlier turn has no composer entry to
    // recover from — so the turn would be stuck. started:false keeps the existing card and its Re-run.
    if (!session) {
      inFlightReviewKeys.delete(inFlightKey)
      log.warn('review start failed: session not found', { sessionId, turnMessageId })
      // The session may simply not be flushed to disk yet (async persistence queue) — a retry can
      // catch it once the write lands, so report the race-shaped reason rather than a hard failure.
      return { started: false, reason: 'not-found' }
    }

    log.info('review triggered', { sessionId, turnMessageId })

    // Resolve `started` only once the running Review row has actually been created and pushed
    // (runReview's onStarted). If runReview fails BEFORE that (scope resolution or the DB insert), it
    // settles without onStarted → started:false, so the caller (Re-run) stays retriable. The full
    // review (reviewer session + fix loop) continues in the background regardless.
    return await new Promise<ReviewRunResult>((resolveStart) => {
      let settled = false
      const settle = (result: ReviewRunResult): void => {
        if (settled) return
        settled = true
        resolveStart(result)
      }

      // Create an AbortController for this review's fix loop. The controller is registered
      // before runReview starts so the abort-fix-loop handler can find it immediately.
      const abortController = new AbortController()
      const effectiveMainSessionId = mainSessionId ?? sessionId

      void runReview({
        sessionId,
        turnMessageId,
        scopeTurnMessageId,
        projectId,
        mainSessionId,
        model: model ?? '',
        getSession: () => session,
        reviewRepository,
        acpRuntime: options.acpRuntime,
        // Artifacts live under the relocatable data root; DB/sessions stay on the config root.
        artifactStorageRoot: dataRoot,
        onStarted: () => settle({ started: true }),
        onReviewUpdate: (review: ReviewWithChecks) => {
          broadcastReviewUpdate({ review })
        },
        // Before the correction prompt is sent, suppress the next auto-review for the main
        // session so the [Auditor] correction turn's stop event does not re-trigger a review.
        onCorrectionPrompt: () => {
          if (mainSessionId) {
            broadcastSuppressNextAutoReview(mainSessionId)
          }
        },
        // If the correction turn fails to send, its stop never arrives — clear the suppression so
        // the session's next real turn still gets auto-reviewed.
        onCorrectionFailed: () => {
          if (mainSessionId) {
            broadcastSuppressNextAutoReview(mainSessionId, true)
          }
        },
        // Broadcast fix-loop lifecycle events and register/deregister the abort controller.
        onFixLoopStart: () => {
          fixLoopAbortControllers.set(effectiveMainSessionId, abortController)
          broadcastFixLoopStart(effectiveMainSessionId)
        },
        onFixLoopEnd: () => {
          fixLoopAbortControllers.delete(effectiveMainSessionId)
          broadcastFixLoopEnd(effectiveMainSessionId)
        },
        fixLoopAbortSignal: abortController.signal
      })
        .catch((error: unknown) => {
          // runReview records expected failures as lifecycle='error' itself; an unexpected throw here
          // (e.g. the createReview insert failed before onStarted) is logged and reported as not-started.
          log.error('runReview threw unexpectedly', {
            sessionId,
            turnMessageId,
            error: error instanceof Error ? error.message : String(error)
          })
        })
        .finally(() => {
          // If the run ended without ever signalling onStarted, no review actually began — this is a
          // genuine pre-push failure (scope/insert), not a persistence race, so it is not auto-retried.
          settle({ started: false, reason: 'run-failed' })
          inFlightReviewKeys.delete(inFlightKey)
        })
    })
  }

  return { triggerReview }
}

export { registerReviewerIpcHandlers, createDefaultReviewRepository }
