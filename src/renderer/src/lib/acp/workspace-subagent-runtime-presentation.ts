import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'

import type { AcpAgentRuntimeUpdate, AcpRuntimeEvent } from '../../../../shared/acp'
import type {
  DelegatedWorkAttemptRecord,
  PersistedChatMessage
} from '../../../../shared/session-persistence'
import { createSessionStore, type ChatSession } from '../../stores/session-store'
import {
  applyRuntimePresentationEvent,
  createRuntimePresentationContext
} from './runtime-event-presentation'

type WorkspaceSubagentFrameProjection = Readonly<{
  frameId: string
  status: 'running' | 'awaiting_user' | 'completed' | 'cancelled' | 'error'
  attempt?: DelegatedWorkAttemptRecord
  messages: readonly PersistedChatMessage[]
}>

type SubscribeToSubagentRuntimeUpdates = (
  listener: (update: AcpAgentRuntimeUpdate) => void
) => () => void

const childConversationSession = (
  session: ChatSession,
  detail: WorkspaceSubagentFrameProjection
): ChatSession => {
  const messages = [...detail.messages]
  const promptMessage = messages.findLast((message) => message.role === 'user')
  const running = detail.status === 'running' && detail.attempt?.status === 'running'

  return {
    ...session,
    status: detail.status === 'running' ? 'running' : detail.status === 'error' ? 'error' : 'idle',
    error: detail.attempt?.error?.message,
    activeRun:
      running && promptMessage
        ? { promptMessageId: promptMessage.id, startedAt: detail.attempt.startedAt }
        : undefined,
    agentPromptInFlight: running ? true : undefined,
    messages,
    conversationGraph: session.conversationGraph
      ? { ...session.conversationGraph, activeFrameId: detail.frameId }
      : undefined,
    // This store is an isolated presentation projection. Authority remains in the root Session
    // graph; the adapter only lets the existing transcript components render the selected Frame.
    activities: session.conversationGraph?.activities
      .filter((activity) => activity.agentFrameId === detail.frameId)
      .map(({ agentFrameId, messageBranchId, runtimeSegmentId, ...activity }) => {
        void agentFrameId
        void messageBranchId
        void runtimeSegmentId
        return activity
      }) as ChatSession['activities'],
    activityGroups: session.conversationGraph?.activityGroups
      .filter((group) => group.agentFrameId === detail.frameId)
      .map(({ agentFrameId, messageBranchId, ...group }) => {
        void agentFrameId
        void messageBranchId
        return group
      })
  }
}

const isSelectedRuntimeUpdate = (
  update: AcpAgentRuntimeUpdate,
  session: ChatSession,
  detail: WorkspaceSubagentFrameProjection,
  runtimeSegmentId: string | undefined,
  promptMessageId: string | undefined
): boolean =>
  update.scope.projectId === session.projectId &&
  update.scope.sessionId === session.id &&
  update.scope.agentFrameId === detail.frameId &&
  update.scope.attemptId === detail.attempt?.id &&
  update.scope.runtimeSegmentId === runtimeSegmentId &&
  update.scope.promptMessageId === promptMessageId

/**
 * Adapts the owner-provided child event selector to the existing transcript view model.
 * It owns no transport subscription and never writes to the authoritative Session store.
 */
const useSubagentRuntimePresentation = (
  subscribe: SubscribeToSubagentRuntimeUpdates,
  session: ChatSession,
  detail: WorkspaceSubagentFrameProjection
): ChatSession => {
  const [store] = useState(() => {
    const isolatedPresentationStore = createSessionStore()
    isolatedPresentationStore.setState({
      sessions: [childConversationSession(session, detail)],
      selectedSessionId: session.id
    })
    return isolatedPresentationStore
  })
  const [presentationContext] = useState(createRuntimePresentationContext)
  const processedEventIds = useRef(new Set<string>())
  const runtimeSegmentId = detail.attempt?.runtimeSegmentIds.at(-1)
  const promptMessageId = detail.messages.findLast((message) => message.role === 'user')?.id
  const liveSession = useStore(store, (state) => state.sessions[0])

  // Runtime updates are ephemeral, so a subscription can miss an event while the selected detail
  // is mounting or being replaced. Reconcile every newer durable projection into the isolated
  // store; the store's identity merge preserves already-applied live events until durability
  // catches up, while a terminal projection advances status and the transcript authoritatively.
  useEffect(() => {
    store.getState().upsertPersistedSession(childConversationSession(session, detail))
  }, [detail, session, store])

  useEffect(() => {
    if (!runtimeSegmentId) return

    return subscribe((update) => {
      if (
        !isSelectedRuntimeUpdate(update, session, detail, runtimeSegmentId, promptMessageId) ||
        processedEventIds.current.has(update.event.id)
      ) {
        return
      }
      processedEventIds.current.add(update.event.id)
      const event = {
        ...update.event,
        sessionId: session.id,
        promptMessageId: update.scope.promptMessageId
      } as AcpRuntimeEvent

      if (applyRuntimePresentationEvent(event, store, presentationContext)) return
      if (event.kind === 'stop') {
        presentationContext.activityGroupToolCallIdsBySession.delete(session.id)
        store
          .getState()
          .finishRun(
            session.id,
            event.turnUsage,
            update.scope.promptMessageId,
            undefined,
            event.modelCallUsage
          )
      } else if (event.kind === 'error') {
        presentationContext.activityGroupToolCallIdsBySession.delete(session.id)
        store
          .getState()
          .failRun(session.id, event.text?.trim() || event.title?.trim() || 'Agent run failed')
      } else if (event.kind === 'system' && event.level === 'warning' && event.text) {
        store.getState().setAgentStatus(session.id, event.text)
      }
    })
  }, [detail, presentationContext, promptMessageId, runtimeSegmentId, session, store, subscribe])

  return liveSession
}

export { useSubagentRuntimePresentation }
export type { SubscribeToSubagentRuntimeUpdates, WorkspaceSubagentFrameProjection }
