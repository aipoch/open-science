import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'

import type { AcpAgentRuntimeUpdate, AcpRuntimeEvent } from '../../../../shared/acp'
import type { ChatSession } from '../../stores/session-store'
import { createSessionStore } from '../../stores/session-store'
import {
  applyRuntimePresentationEvent,
  createRuntimePresentationContext
} from './runtime-event-presentation'
import {
  childConversationSession,
  fenceTerminalLifecycle,
  reconcileDurableChildProjection,
  type WorkspaceSubagentFrameProjection
} from './workspace-subagent-runtime-transcript'

type SubscribeToSubagentRuntimeUpdates = (
  listener: (update: AcpAgentRuntimeUpdate) => void
) => () => void

const isSelectedRuntimeUpdate = (
  update: AcpAgentRuntimeUpdate,
  session: ChatSession,
  detail: WorkspaceSubagentFrameProjection,
  runtimeSegmentId: string,
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
  const running = detail.status === 'running' && detail.attempt?.status === 'running'
  const runtimeIdentity =
    detail.attempt && runtimeSegmentId && promptMessageId
      ? [
          session.projectId,
          session.id,
          detail.frameId,
          detail.attempt.id,
          runtimeSegmentId,
          promptMessageId
        ].join('\u0000')
      : undefined
  const currentRuntimeIdentity = useRef(runtimeIdentity)
  const latestLifecycle = useRef({
    running,
    terminalProjection: childConversationSession(session, detail)
  })
  useLayoutEffect(() => {
    currentRuntimeIdentity.current = runtimeIdentity
    latestLifecycle.current = {
      running,
      terminalProjection: childConversationSession(session, detail)
    }
  }, [detail, running, runtimeIdentity, session])
  const liveSession = useStore(store, (state) => state.sessions[0])

  useEffect(() => {
    reconcileDurableChildProjection(
      store,
      childConversationSession(session, detail),
      running,
      detail.status,
      runtimeSegmentId
    )
  }, [detail, running, runtimeSegmentId, session, store])

  useEffect(() => {
    if (!runtimeIdentity || !runtimeSegmentId) return

    return subscribe((update) => {
      if (
        currentRuntimeIdentity.current !== runtimeIdentity ||
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
      const lifecycle = latestLifecycle.current
      const appliedPresentation = applyRuntimePresentationEvent(event, store, presentationContext)

      if (!appliedPresentation && event.kind === 'stop') {
        presentationContext.activityGroupToolCallIdsBySession.delete(session.id)
        store.getState().finishRun(session.id, event.turnUsage, update.scope.promptMessageId)
      } else if (!appliedPresentation && event.kind === 'error') {
        presentationContext.activityGroupToolCallIdsBySession.delete(session.id)
        store
          .getState()
          .failRun(session.id, event.text?.trim() || event.title?.trim() || 'Agent run failed')
      } else if (
        !appliedPresentation &&
        event.kind === 'system' &&
        event.level === 'warning' &&
        event.text
      ) {
        store.getState().setAgentStatus(session.id, event.text)
      }
      if (!lifecycle.running) fenceTerminalLifecycle(store, lifecycle.terminalProjection)
    })
  }, [
    detail,
    presentationContext,
    promptMessageId,
    runtimeIdentity,
    runtimeSegmentId,
    session,
    store,
    subscribe
  ])

  return liveSession
}

export { useSubagentRuntimePresentation }
export type { SubscribeToSubagentRuntimeUpdates, WorkspaceSubagentFrameProjection }
