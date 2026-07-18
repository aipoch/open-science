// IPC layer for the reviewer feature. Follows the same patterns as src/main/acp/ipc.ts and
// src/main/artifacts/ipc.ts: ipcMain.handle for renderer-callable commands, BrowserWindow.send
// for push events from main to renderer.

import { BrowserWindow, ipcMain } from 'electron'

import type { ReviewWithChecks, ReviewRunRequest, ReviewUpdateEvent } from '../../shared/reviewer'
import { REVIEWER_IPC } from '../../shared/reviewer'
import { createLogger } from '../logger'
import { runReview } from './orchestrator'
import { ReviewRepository } from './repository'
import type { AcpRuntime } from '../acp/runtime'
import { resolveDataRoot, resolveStorageRoot } from '../storage-root'
import { getProjectDbClient } from '../projects/prisma-client'
import { SessionRepository } from '../session-persistence/repository'

const log = createLogger('reviewer:ipc')

// Sends a review update event to every open renderer window.
const broadcastReviewUpdate = (event: ReviewUpdateEvent): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(REVIEWER_IPC.UPDATED, event)
    }
  }
}

// Broadcasts the loop-guard event that tells the renderer to skip the next auto-review call for the
// given session. Called just before the [Auditor] correction prompt is sent so the correction
// turn's stop does not spawn a second review run (Phase 1 single-round invariant). When clear=true
// it instead cancels a pending suppression — used when the correction turn failed to send, so the
// one-shot flag doesn't leak into the session's next real turn.
const broadcastSuppressNextAutoReview = (sessionId: string, clear = false): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(REVIEWER_IPC.SUPPRESS_NEXT_AUTO_REVIEW, { sessionId, clear })
    }
  }
}

// Broadcasts a fix-loop-start event: the renderer reacts by setting fixLoopActive=true on the
// session and disabling the composer send button for the duration of the loop.
const broadcastFixLoopStart = (sessionId: string): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(REVIEWER_IPC.FIX_LOOP_START, { sessionId })
    }
  }
}

// Broadcasts a fix-loop-end event: the renderer reacts by clearing fixLoopActive on the session
// and re-enabling the composer send button.
const broadcastFixLoopEnd = (sessionId: string): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(REVIEWER_IPC.FIX_LOOP_END, { sessionId })
    }
  }
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
  triggerReview: (request: ReviewRunRequest) => void
} => {
  const storageRoot = options.storageRoot ?? resolveStorageRoot()
  const dataRoot = options.dataRoot ?? resolveDataRoot()
  const reviewRepository = createDefaultReviewRepository()
  const sessionRepository = new SessionRepository(storageRoot)

  // Per-session AbortControllers for active fix loops. Keyed by the main session id (not the
  // reviewer session id). Entries are created when a fix loop starts and deleted when it ends.
  const fixLoopAbortControllers = new Map<string, AbortController>()

  // reviewer:run — trigger a review for a completed turn. Fire-and-forget: the renderer does
  // not await this; it receives reviewer:updated events as the lifecycle progresses.
  ipcMain.handle(REVIEWER_IPC.RUN, (_event, request: ReviewRunRequest) => {
    triggerReview(request)
  })

  // reviewer:get-for-session — load persisted reviews for a session at startup.
  ipcMain.handle(REVIEWER_IPC.GET_FOR_SESSION, async (_event, sessionId: string) => {
    return reviewRepository.getReviewsForSession(sessionId)
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

  const triggerReview = (request: ReviewRunRequest): void => {
    const { sessionId, turnMessageId, projectId, mainSessionId, model } = request

    log.info('review triggered', { sessionId, turnMessageId })

    // Load the session from disk in the background so the orchestrator has the full session JSON.
    void (async () => {
      try {
        const { sessions } = await sessionRepository.loadAll()
        const session = sessions.find((s) => s.id === sessionId)

        // Create an AbortController for this review's fix loop. The controller is registered
        // before runReview starts so the abort-fix-loop handler can find it immediately.
        const abortController = new AbortController()
        const effectiveMainSessionId = mainSessionId ?? sessionId

        await runReview({
          sessionId,
          turnMessageId,
          projectId,
          mainSessionId,
          model: model ?? '',
          getSession: () => session,
          reviewRepository,
          acpRuntime: options.acpRuntime,
          // Artifacts live under the relocatable data root; DB/sessions stay on the config root.
          artifactStorageRoot: dataRoot,
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
      } catch (error) {
        log.error('runReview threw unexpectedly', {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })()
  }

  return { triggerReview }
}

export { registerReviewerIpcHandlers, createDefaultReviewRepository }
