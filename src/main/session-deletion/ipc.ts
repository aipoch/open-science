import type { DeleteSessionRequest, SessionDeletionResult } from '../../shared/session-persistence'
import { LIFECYCLE_CHANNELS } from '../../shared/lifecycle-events'
import { broadcastLifecycleEvent } from '../lifecycle-broadcast'
import { ipcMainHandle } from '../ipc-handler-registry'

type SessionDeletionCommand = {
  delete(request: DeleteSessionRequest): Promise<SessionDeletionResult>
}

const registerSessionDeletionIpcHandler = (command: SessionDeletionCommand): void => {
  ipcMainHandle('sessions:delete-session', async (_event, request: DeleteSessionRequest) => {
    const result = await command.delete(request)
    if (result.status === 'deleted') {
      broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionDeleted, request)
    }
    return result
  })
}

export { registerSessionDeletionIpcHandler }
export type { SessionDeletionCommand }
