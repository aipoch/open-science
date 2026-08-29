import { useEffect } from 'react'

import type {
  SessionPersistenceFlushRequest,
  SessionPersistenceFlushResponse
} from '../../../shared/session-persistence-flush'
import { isSessionRevisionConflictError } from '../../../shared/session-persistence'
import {
  resumeAutoReviewsAfterQuitAbort,
  suppressAutoReviewsForQuit
} from '../lib/acp/workspace-events'
import { drainWorkspaceRuntimeEventsForPersistence } from '../lib/acp/useWorkspaceAgentRuntime'
import { flushPreviewPersistence } from '../lib/preview-persistence/preview-persistence'
import { flushSessionPersistence } from '../lib/session-persistence/session-persistence'

type QuitPersistenceFlushDeps = {
  suppressAutoReviews: () => void
  drainRuntimeEvents: () => Promise<void>
  flushPersistence: () => Promise<void>
  flushPreviewPersistence: () => Promise<void>
  acknowledge: (response: SessionPersistenceFlushResponse) => void
}

export const completeQuitPersistenceFlush = async (
  request: SessionPersistenceFlushRequest,
  deps: QuitPersistenceFlushDeps
): Promise<void> => {
  let failure: unknown
  let status: SessionPersistenceFlushResponse['status'] = 'completed'
  try {
    deps.suppressAutoReviews()
    await deps.drainRuntimeEvents()
    await deps.flushPersistence()
    await deps.flushPreviewPersistence()
  } catch (error) {
    failure = error
    status = isSessionRevisionConflictError(error) ? 'conflict' : 'failed'
  } finally {
    deps.acknowledge({ requestId: request.requestId, status })
  }
  if (failure !== undefined) throw failure
}

export const useQuitPersistenceFlush = (): void => {
  useEffect(() => {
    const onFlushAborted = window.api.sessions?.onFlushAborted
    const onFlushRequest = window.api.sessions?.onFlushRequest
    const sendFlushResponse =
      window.api.sessions?.sendFlushResponse ?? window.api.storage?.ackDataRootHandoffFlush
    if (!onFlushRequest || !sendFlushResponse) return

    const removeFlushAborted = onFlushAborted?.(resumeAutoReviewsAfterQuitAbort)
    const removeFlushRequest = onFlushRequest((request) => {
      void completeQuitPersistenceFlush(request, {
        suppressAutoReviews: suppressAutoReviewsForQuit,
        drainRuntimeEvents: drainWorkspaceRuntimeEventsForPersistence,
        flushPersistence: flushSessionPersistence,
        flushPreviewPersistence,
        acknowledge: sendFlushResponse
      }).catch(() => undefined)
    })
    return () => {
      removeFlushAborted?.()
      removeFlushRequest()
    }
  }, [])
}
