import type { PersistedChatSession } from '../../shared/session-persistence'
import type {
  SideChatCloseRequest,
  SideChatPromptRequest,
  SideChatSessionRequest,
  SideChatStartRequest
} from '../../shared/side-chat'
import { SIDE_CHAT_MESSAGE_LIMIT } from '../../shared/side-chat'
import { buildHistoryPreamble } from '../../shared/history-preamble'
import { ipcMainHandle } from '../ipc-handler-registry'
import type { SideChatRuntimeOwner } from './runtime-owner'

type SideChatIpcDependencies = Readonly<{
  loadParentSession: (
    projectId: string,
    sessionId: string
  ) => Promise<PersistedChatSession | undefined>
  hasLiveParentSession: (projectId: string, sessionId: string) => boolean
  assertParentAvailable: (sessionId: string) => Promise<void>
}>

const registerSideChatIpcHandlers = (
  runtime: SideChatRuntimeOwner,
  dependencies: SideChatIpcDependencies
): void => {
  const startingParents = new Set<string>()
  const closeRequestedParents = new Set<string>()

  ipcMainHandle('side-chat:list', () => runtime.list())
  ipcMainHandle('side-chat:start', async (_event, request: SideChatStartRequest) => {
    startingParents.add(request.parentSessionId)
    try {
      await dependencies.assertParentAvailable(request.parentSessionId)
      const parent = await dependencies.loadParentSession(
        request.projectId,
        request.parentSessionId
      )
      if (
        !parent &&
        !dependencies.hasLiveParentSession(request.projectId, request.parentSessionId)
      ) {
        throw new Error('The parent Session is unavailable.')
      }
      if (closeRequestedParents.delete(request.parentSessionId)) {
        throw new Error('Side chat closed before startup completed.')
      }
      const historyPreamble = parent
        ? buildHistoryPreamble(parent.messages, {
            target: 'codex-bridge',
            budget: SIDE_CHAT_MESSAGE_LIMIT
          })
        : undefined
      return await runtime.start({ ...request, historyPreamble })
    } finally {
      startingParents.delete(request.parentSessionId)
      closeRequestedParents.delete(request.parentSessionId)
    }
  })
  ipcMainHandle('side-chat:send', (_event, request: SideChatPromptRequest) => runtime.send(request))
  ipcMainHandle('side-chat:cancel', (_event, request: SideChatSessionRequest) =>
    runtime.cancel(request)
  )
  ipcMainHandle('side-chat:close', (_event, request: SideChatCloseRequest) => {
    if ('sideSessionId' in request) return runtime.close(request)
    if (startingParents.has(request.parentSessionId)) {
      closeRequestedParents.add(request.parentSessionId)
    }
    return request.discardRelays
      ? runtime.closeForParent(request.parentSessionId)
      : runtime.closeActiveForParent(request.parentSessionId)
  })
}

export { registerSideChatIpcHandlers }
export type { SideChatIpcDependencies }
