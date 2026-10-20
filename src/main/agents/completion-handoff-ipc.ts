import { ipcMainHandle } from '../ipc-handler-registry'
import {
  SPECIALIST_IPC,
  type CompletionHandoffCommand,
  type CompletionHandoffLifecycleEvent
} from '../../shared/specialist'

type CompletionHandoffCommands = {
  getEvents(sessionId: string): Promise<CompletionHandoffLifecycleEvent[]>
  retryById(id: string, sessionId: string): Promise<unknown>
  cancelById(id: string, sessionId: string): Promise<void>
}

export type CompletionHandoffCommandOwner = {
  getEvents(sessionId: unknown): Promise<CompletionHandoffLifecycleEvent[]>
  retry(request: CompletionHandoffCommand): Promise<unknown>
  cancel(request: CompletionHandoffCommand): Promise<void>
}
export const createCompletionHandoffCommands = (
  lifecycle: CompletionHandoffCommands
): CompletionHandoffCommandOwner => ({
  getEvents: (sessionId) => {
    if (typeof sessionId !== 'string') throw new Error('Handoff sessionId must be a string.')
    return lifecycle.getEvents(sessionId)
  },
  retry: (request) => {
    assertCommand(request, 'retry')
    return lifecycle.retryById(request.id, request.sessionId)
  },
  cancel: (request) => {
    assertCommand(request, 'cancel')
    return lifecycle.cancelById(request.id, request.sessionId)
  }
})
export const registerCompletionHandoffIpcHandlers = (
  lifecycle: CompletionHandoffCommands
): void => {
  const owner = createCompletionHandoffCommands(lifecycle)
  ipcMainHandle(SPECIALIST_IPC.GET_HANDOFF_EVENTS, (_event, sessionId: unknown) =>
    owner.getEvents(sessionId)
  )
  ipcMainHandle(SPECIALIST_IPC.RETRY_HANDOFF, (_event, request: CompletionHandoffCommand) =>
    owner.retry(request)
  )
  ipcMainHandle(SPECIALIST_IPC.CANCEL_HANDOFF, (_event, request: CompletionHandoffCommand) =>
    owner.cancel(request)
  )
}

const assertCommand = (request: CompletionHandoffCommand, operation: 'retry' | 'cancel'): void => {
  if (!request || typeof request.id !== 'string' || typeof request.sessionId !== 'string') {
    throw new Error(`Invalid completion handoff ${operation} request.`)
  }
}
