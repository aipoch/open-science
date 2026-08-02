import type {
  HandoffEventsRequest,
  HandoffLifecycleEvent,
  HandoffRetryRequest
} from '../../shared/handoff-lifecycle'
import { HANDOFF_LIFECYCLE_IPC } from '../../shared/handoff-lifecycle'
import { ipcMainHandle } from '../ipc-handler-registry'

type HandoffLifecycleIpcCoordinator = {
  getEvents(sessionId: string): readonly HandoffLifecycleEvent[]
  retry(request: HandoffRetryRequest): Promise<void>
}

const requireStringField = (request: unknown, field: string): string => {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error(`HANDOFF_LIFECYCLE: ${field} must be a string.`)
  }
  const value = (request as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`HANDOFF_LIFECYCLE: ${field} must be a non-empty string.`)
  }
  return value
}

const registerHandoffLifecycleIpcHandlers = (coordinator: HandoffLifecycleIpcCoordinator): void => {
  ipcMainHandle(HANDOFF_LIFECYCLE_IPC.LIST, (_event, request: HandoffEventsRequest) =>
    coordinator.getEvents(requireStringField(request, 'sessionId'))
  )
  ipcMainHandle(HANDOFF_LIFECYCLE_IPC.RETRY, (_event, request: HandoffRetryRequest) =>
    coordinator.retry({
      sessionId: requireStringField(request, 'sessionId'),
      originatingTurnId: requireStringField(request, 'originatingTurnId')
    })
  )
}

export { registerHandoffLifecycleIpcHandlers }
export type { HandoffLifecycleIpcCoordinator }
