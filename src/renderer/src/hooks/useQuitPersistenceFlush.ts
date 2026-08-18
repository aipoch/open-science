import { useEffect } from 'react'

import type {
  SessionPersistenceFlushRequest,
  SessionPersistenceFlushResponse
} from '../../../shared/session-persistence-flush'
import { isSessionRevisionConflictError } from '../../../shared/session-persistence'
import { suppressAutoReviewsForQuit } from '../lib/acp/workspace-events'
import { drainWorkspaceRuntimeEventsForPersistence } from '../lib/acp/useWorkspaceAgentRuntime'
import { flushSessionPersistence } from '../lib/session-persistence/session-persistence'

type QuitPersistenceFlushDeps = {
  suppressAutoReviews: () => void
  drainRuntimeEvents: () => Promise<void>
  flushPersistence: () => Promise<void>
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
    const onFlushRequest = window.api.sessions?.onFlushRequest
    const sendFlushResponse = window.api.sessions?.sendFlushResponse
    // Web/headless renderers do not participate in Electron's before-quit handshake.
    if (!onFlushRequest || !sendFlushResponse) return

    return onFlushRequest((request) => {
      void completeQuitPersistenceFlush(request, {
        suppressAutoReviews: suppressAutoReviewsForQuit,
        drainRuntimeEvents: drainWorkspaceRuntimeEventsForPersistence,
        flushPersistence: flushSessionPersistence,
        acknowledge: sendFlushResponse
      }).catch(() => undefined)
    })
  }, [])
}
