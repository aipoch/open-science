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
  withParentAvailable<Result>(sessionId: string, operation: () => Promise<Result>): Promise<Result>
}>

const registerSideChatIpcHandlers = (
  runtime: SideChatRuntimeOwner,
  dependencies: SideChatIpcDependencies
): void => {
  const startingParents = new Set<string>()
  const closeRequestedParents = new Set<string>()
  const loadAvailableParent = async (
    projectId: string,
    parentSessionId: string
  ): Promise<PersistedChatSession | undefined> => {
    const parent = await dependencies.loadParentSession(projectId, parentSessionId)
    if (!parent && !dependencies.hasLiveParentSession(projectId, parentSessionId)) {
      throw new Error('The parent Session is unavailable.')
    }
    return parent
  }

  ipcMainHandle('side-chat:list', () => runtime.list())
  ipcMainHandle('side-chat:start', async (_event, request: SideChatStartRequest) => {
    startingParents.add(request.parentSessionId)
    try {
      return await dependencies.withParentAvailable(request.parentSessionId, async () => {
        const parent = await loadAvailableParent(request.projectId, request.parentSessionId)
        if (closeRequestedParents.delete(request.parentSessionId)) {
          throw new Error('Side chat closed before startup completed.')
        }
        const historyPreamble = parent
          ? buildHistoryPreamble(parent.messages, {
              target: 'codex-bridge',
              budget: SIDE_CHAT_MESSAGE_LIMIT
            })
          : undefined
        return runtime.start({ ...request, historyPreamble })
      })
    } finally {
      startingParents.delete(request.parentSessionId)
      closeRequestedParents.delete(request.parentSessionId)
    }
  })
  ipcMainHandle('side-chat:send', async (_event, request: SideChatPromptRequest) => {
    const parent = runtime.parentFor(request.sideSessionId)
    if (!parent) throw new Error('Side chat Session is not active.')
    return dependencies.withParentAvailable(parent.parentSessionId, async () => {
      const parentSession = await loadAvailableParent(parent.projectId, parent.parentSessionId)
      const historyPreamble = parentSession
        ? buildHistoryPreamble(parentSession.messages, {
            target: 'codex-bridge',
            budget: SIDE_CHAT_MESSAGE_LIMIT
          })
        : undefined
      return runtime.send({ ...request, historyPreamble })
    })
  })
  ipcMainHandle('side-chat:cancel', (_event, request: SideChatSessionRequest) =>
    runtime.cancel(request)
  )
  ipcMainHandle('side-chat:close', (_event, request: SideChatCloseRequest) => {
    if ('sideSessionId' in request) return runtime.close(request)
    if (startingParents.has(request.parentSessionId)) {
      closeRequestedParents.add(request.parentSessionId)
    }
    return runtime.closeForParent(request.parentSessionId)
  })
}

export { registerSideChatIpcHandlers }
export type { SideChatIpcDependencies }
