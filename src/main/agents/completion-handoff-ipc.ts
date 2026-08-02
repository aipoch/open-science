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

export const registerCompletionHandoffIpcHandlers = (
  lifecycle: CompletionHandoffCommands
): void => {
  ipcMainHandle(SPECIALIST_IPC.GET_HANDOFF_EVENTS, (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('Handoff sessionId must be a string.')
    return lifecycle.getEvents(sessionId)
  })
  ipcMainHandle(SPECIALIST_IPC.RETRY_HANDOFF, (_event, request: CompletionHandoffCommand) => {
    assertCommand(request, 'retry')
    return lifecycle.retryById(request.id, request.sessionId)
  })
  ipcMainHandle(
    SPECIALIST_IPC.CANCEL_HANDOFF,
    async (_event, request: CompletionHandoffCommand) => {
      assertCommand(request, 'cancel')
      await lifecycle.cancelById(request.id, request.sessionId)
    }
  )
}

const assertCommand = (request: CompletionHandoffCommand, operation: 'retry' | 'cancel'): void => {
  if (!request || typeof request.id !== 'string' || typeof request.sessionId !== 'string') {
    throw new Error(`Invalid completion handoff ${operation} request.`)
  }
}
