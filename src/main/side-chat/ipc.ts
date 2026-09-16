import { randomUUID } from 'node:crypto'
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
  const starts = new Map<string, string>()
  const sends = new Map<string, { cancellation: AbortController; dispatching: boolean }>()
  const closedStarts = new Set<string>()
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
    const startId = request.sideSessionId ?? `side-chat-${randomUUID()}`
    if (starts.has(startId)) throw new Error('Side chat is already starting.')
    starts.set(startId, request.parentSessionId)
    try {
      const admitted = await dependencies.withParentAvailable(request.parentSessionId, async () => {
        const parent = await loadAvailableParent(request.projectId, request.parentSessionId)
        if (closedStarts.delete(startId)) {
          throw new Error('Side chat closed before startup completed.')
        }
        const historyPreamble = parent
          ? buildHistoryPreamble(parent.messages, {
              target: 'codex-bridge',
              budget: SIDE_CHAT_MESSAGE_LIMIT
            })
          : undefined
        const inherited = parent?.agentConfiguration
        const modelSelection =
          request.modelSelection ??
          (inherited
            ? {
                providerId: inherited.providerId,
                reasoningEffort: inherited.reasoningEffort,
                ...(inherited.model ? { model: inherited.model } : {})
              }
            : undefined)
        return {
          result: runtime.start({
            ...request,
            ...(modelSelection ? { modelSelection } : {}),
            sideSessionId: startId,
            historyPreamble
          })
        }
      })
      return admitted.result
    } finally {
      starts.delete(startId)
      closedStarts.delete(startId)
    }
  })
  ipcMainHandle('side-chat:send', async (_event, request: SideChatPromptRequest) => {
    if (sends.has(request.sideSessionId)) throw new Error('A Side chat prompt is already running.')
    const parent = runtime.parentFor(request.sideSessionId)
    if (!parent) throw new Error('Side chat Session is not active.')
    const send = { cancellation: new AbortController(), dispatching: false }
    sends.set(request.sideSessionId, send)
    try {
      const admitted = await dependencies.withParentAvailable(parent.parentSessionId, async () => {
        send.cancellation.signal.throwIfAborted()
        const parentSession = await loadAvailableParent(parent.projectId, parent.parentSessionId)
        send.cancellation.signal.throwIfAborted()
        const historyPreamble = parentSession
          ? buildHistoryPreamble(parentSession.messages, {
              target: 'codex-bridge',
              budget: SIDE_CHAT_MESSAGE_LIMIT
            })
          : undefined
        send.dispatching = true
        return { result: runtime.send({ ...request, historyPreamble }, send.cancellation) }
      })
      return admitted.result
    } finally {
      if (sends.get(request.sideSessionId) === send) sends.delete(request.sideSessionId)
    }
  })
  ipcMainHandle('side-chat:cancel', (_event, request: SideChatSessionRequest) => {
    const send = sends.get(request.sideSessionId)
    send?.cancellation.abort(new Error('Side chat prompt cancelled.'))
    if (send && !send.dispatching) return
    return runtime.cancel(request)
  })
  ipcMainHandle('side-chat:close', (_event, request: SideChatCloseRequest) => {
    if ('sideSessionId' in request) {
      if (starts.has(request.sideSessionId)) {
        closedStarts.add(request.sideSessionId)
        // Preflight may not have reached runtime ownership yet.
        if (!runtime.parentFor(request.sideSessionId)) return
      }
      return runtime.close(request)
    }
    for (const [id, parent] of starts) if (parent === request.parentSessionId) closedStarts.add(id)
    return runtime.closeForParent(request.parentSessionId)
  })
}

export { registerSideChatIpcHandlers }
export type { SideChatIpcDependencies }
