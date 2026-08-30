import { useCallback, useEffect, useState } from 'react'

import type {
  SessionPersistenceFlushAbortedEvent,
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

type QuitPersistenceFlushProjection = Readonly<{
  notice: SessionPersistenceFlushAbortedEvent | undefined
  dismissNotice: () => void
}>

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

export const useQuitPersistenceFlush = (): QuitPersistenceFlushProjection => {
  const [notice, setNotice] = useState<SessionPersistenceFlushAbortedEvent>()
  const dismissNotice = useCallback(() => setNotice(undefined), [])

  useEffect(() => {
    const onFlushAborted = window.api.sessions?.onFlushAborted
    const onFlushRequest = window.api.sessions?.onFlushRequest
    const sendFlushResponse =
      window.api.sessions?.sendFlushResponse ?? window.api.storage?.ackDataRootHandoffFlush
    if (!onFlushRequest || !sendFlushResponse) return

    const removeFlushAborted = onFlushAborted?.((event) => {
      resumeAutoReviewsAfterQuitAbort()
      if (event) setNotice(event)
    })
    const removeFlushRequest = onFlushRequest((request) => {
      void (async () => {
        if (request.targetLifecycleClientId) {
          const lifecycleClientId = await window.api.lifecycle.getClientId()
          if (lifecycleClientId !== request.targetLifecycleClientId) return
        }
        await completeQuitPersistenceFlush(request, {
          suppressAutoReviews: suppressAutoReviewsForQuit,
          drainRuntimeEvents: drainWorkspaceRuntimeEventsForPersistence,
          flushPersistence: flushSessionPersistence,
          flushPreviewPersistence,
          acknowledge: sendFlushResponse
        })
      })().catch(() => undefined)
    })
    return () => {
      removeFlushAborted?.()
      removeFlushRequest()
    }
  }, [])

  return { notice, dismissNotice }
}

export type { QuitPersistenceFlushProjection }
