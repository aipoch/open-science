import { randomUUID } from 'node:crypto'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type {
  SideChatCloseRequest,
  SideChatPromptRequest,
  SideChatSessionRequest,
  SideChatStartRequest,
  SideChatStartResponse
} from '../../shared/side-chat'
import {
  SIDE_CHAT_MESSAGE_LIMIT,
  sideChatParentBranch,
  type SideChatParentBranch
} from '../../shared/side-chat'
import { buildHistoryPreamble } from '../../shared/history-preamble'
import type { SideChatRuntimeOwner } from './runtime-owner'

type SideChatCommandDependencies = Readonly<{
  loadParentSession: (
    projectId: string,
    sessionId: string
  ) => Promise<PersistedChatSession | undefined>
  hasLiveParentSession: (projectId: string, sessionId: string) => boolean
  withParentAvailable<Result>(sessionId: string, operation: () => Promise<Result>): Promise<Result>
}>

const assertParentSnapshot = (
  parent: PersistedChatSession | undefined,
  expected: SideChatParentBranch | undefined
): void => {
  if (!expected) return
  const saved = sideChatParentBranch(parent?.conversationGraph)
  if (!saved || saved.frameId !== expected.frameId || saved.branchId !== expected.branchId) {
    throw new Error(
      'The selected conversation branch has not been saved yet. Retry Side chat after saving completes.'
    )
  }
}

export const createSideChatCommandOwner = (
  runtime: SideChatRuntimeOwner,
  dependencies: SideChatCommandDependencies
): SideChatCommandOwner => {
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

  const start = async (request: SideChatStartRequest): Promise<SideChatStartResponse> => {
    const startId = request.sideSessionId ?? `side-chat-${randomUUID()}`
    if (starts.has(startId)) throw new Error('Side chat is already starting.')
    starts.set(startId, request.parentSessionId)
    try {
      const admitted = await dependencies.withParentAvailable(request.parentSessionId, async () => {
        const parent = await loadAvailableParent(request.projectId, request.parentSessionId)
        if (closedStarts.delete(startId)) {
          throw new Error('Side chat closed before startup completed.')
        }
        assertParentSnapshot(parent, request.expectedParentBranch)
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
  }
  const send = async (request: SideChatPromptRequest): Promise<void> => {
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
        assertParentSnapshot(parentSession, request.expectedParentBranch)
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
  }
  const cancel = (
    request: SideChatSessionRequest
  ): ReturnType<SideChatRuntimeOwner['cancel']> | void => {
    const send = sends.get(request.sideSessionId)
    send?.cancellation.abort(new Error('Side chat prompt cancelled.'))
    if (send && !send.dispatching) return
    return runtime.cancel(request)
  }
  const close = (
    request: SideChatCloseRequest
  ): ReturnType<SideChatRuntimeOwner['close']> | void => {
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
  }
  return { list: () => runtime.list(), start, send, cancel, close }
}

export type SideChatCommandOwner = Readonly<{
  list: SideChatRuntimeOwner['list']
  start(request: SideChatStartRequest): Promise<SideChatStartResponse>
  send(request: SideChatPromptRequest): Promise<void>
  cancel(request: SideChatSessionRequest): ReturnType<SideChatRuntimeOwner['cancel']> | void
  close(request: SideChatCloseRequest): ReturnType<SideChatRuntimeOwner['close']> | void
}>

export type { SideChatCommandDependencies }
