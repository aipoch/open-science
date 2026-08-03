import { useEffect } from 'react'

import type {
  SessionPersistenceFlushRequest,
  SessionPersistenceFlushResponse
} from '../../../shared/session-persistence-flush'
import { drainWorkspaceRuntimeEventsForPersistence } from '../lib/acp/useWorkspaceAgentRuntime'
import { flushSessionPersistence } from '../lib/session-persistence/session-persistence'

type QuitPersistenceFlushDeps = {
  drainRuntimeEvents: () => Promise<void>
  flushPersistence: () => Promise<void>
  acknowledge: (response: SessionPersistenceFlushResponse) => void
}

export const completeQuitPersistenceFlush = async (
  request: SessionPersistenceFlushRequest,
  deps: QuitPersistenceFlushDeps
): Promise<void> => {
  try {
    await deps.drainRuntimeEvents()
    await deps.flushPersistence()
  } finally {
    deps.acknowledge({ requestId: request.requestId })
  }
}

export const useQuitPersistenceFlush = (): void => {
  useEffect(() => {
    const onFlushRequest = window.api.sessions?.onFlushRequest
    const sendFlushResponse = window.api.sessions?.sendFlushResponse
    // Web/headless renderers do not participate in Electron's before-quit handshake.
    if (!onFlushRequest || !sendFlushResponse) return

    return onFlushRequest((request) => {
      void completeQuitPersistenceFlush(request, {
        drainRuntimeEvents: drainWorkspaceRuntimeEventsForPersistence,
        flushPersistence: flushSessionPersistence,
        acknowledge: sendFlushResponse
      }).catch(() => undefined)
    })
  }, [])
}
