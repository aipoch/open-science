import { useMemo } from 'react'
import { useStore } from 'zustand'

import type {
  AcpAgentRuntimeScope,
  AcpAgentRuntimeUpdate,
  AcpRuntimeEvent
} from '../../../../shared/acp'
import type {
  DelegatedWorkAttemptRecord,
  PersistedChatMessage
} from '../../../../shared/session-persistence'
import {
  createSessionStore,
  type ChatSession,
  type SessionStoreApi,
  type StreamingMessageContentByMessageId
} from '../../stores/session-store'
import {
  projectConversationMessage,
  resolveMessageBranchPath
} from '../../../../shared/conversation-graph'
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

const childConversationSession = (
  session: ChatSession,
  detail: WorkspaceSubagentFrameProjection
): ChatSession => {
  const messages = [...detail.messages]
  const promptMessage = messages.findLast((message) => message.role === 'user')
  const running = detail.status === 'running' && detail.attempt?.status === 'running'
  const runtimeSegmentId = detail.attempt?.runtimeSegmentIds.at(-1)

  return {
    ...session,
    status: detail.status === 'running' ? 'running' : detail.status === 'error' ? 'error' : 'idle',
    error: detail.attempt?.error?.message,
    activeRun:
      running && promptMessage
        ? { promptMessageId: promptMessage.id, startedAt: detail.attempt.startedAt }
        : undefined,
    // A resumed root has its own execution segment. The isolated child transcript must
    // never use that segment when appending output or projecting a terminal event.
    activeRunRuntimeSegmentId: session.conversationGraph?.runtimeSegments.some(
      (segment) => segment.id === runtimeSegmentId && segment.agentFrameId === detail.frameId
    )
      ? runtimeSegmentId
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

const mergeLiveItems = <Item extends { id: string; updatedAt: number }>(
  current: readonly Item[],
  incoming: readonly Item[]
): Item[] => {
  const incomingById = new Map(incoming.map((item) => [item.id, item]))
  const merged = current.map((item) => {
    const durable = incomingById.get(item.id)
    incomingById.delete(item.id)
    return durable && durable.updatedAt > item.updatedAt ? durable : item
  })
  return [...merged, ...incomingById.values()]
}

const indexDurableEvents = <Item extends { eventIds: readonly string[] }>(
  items: readonly Item[]
): Map<string, Array<{ item: Item; eventIds: ReadonlySet<string> }>> => {
  const byEventId = new Map<string, Array<{ item: Item; eventIds: ReadonlySet<string> }>>()
  for (const item of items) {
    const indexed = { item, eventIds: new Set(item.eventIds) }
    for (const eventId of indexed.eventIds) {
      const candidates = byEventId.get(eventId)
      if (candidates) candidates.push(indexed)
      else byEventId.set(eventId, [indexed])
    }
  }
  return byEventId
}

const hasDurableCoverage = <Item>(
  byEventId: ReadonlyMap<string, readonly { item: Item; eventIds: ReadonlySet<string> }[]>,
  liveEventIds: readonly string[],
  sameOwner: (item: Item) => boolean
): boolean =>
  liveEventIds.length > 0 &&
  (byEventId.get(liveEventIds[0]) ?? []).some(
    ({ item, eventIds }) => sameOwner(item) && liveEventIds.every((id) => eventIds.has(id))
  )

const reconcileRunningChild = (
  current: ChatSession,
  incoming: ChatSession,
  streamingMessages: StreamingMessageContentByMessageId,
  runtimeSegmentId: string | undefined
): { session: ChatSession; streamingMessages: StreamingMessageContentByMessageId } => {
  const durableMessagesByEventId = indexDurableEvents(incoming.messages)
  const durableActivitiesByEventId = indexDurableEvents(incoming.activities ?? [])
  const coveredMessageIds = new Set(
    current.messages
      .filter(
        (message) =>
          message.role === 'agent' &&
          hasDurableCoverage(
            durableMessagesByEventId,
            streamingMessages[message.id]?.eventIds ?? message.eventIds,
            (durable) =>
              durable.role === 'agent' &&
              durable.responseToMessageId === message.responseToMessageId
          )
      )
      .map(({ id }) => id)
  )
  const liveMessages = current.messages.filter(({ id }) => !coveredMessageIds.has(id))
  const liveActivities = (current.activities ?? []).filter(
    (activity) =>
      !hasDurableCoverage(
        durableActivitiesByEventId,
        activity.eventIds,
        (durable) => durable.promptMessageId === activity.promptMessageId
      )
  )
  const liveGroups = (current.activityGroups ?? []).filter(
    (group) =>
      !runtimeSegmentId ||
      !incoming.activityGroups?.some(
        (durable) =>
          durable.id ===
          `agent-runtime:${encodeURIComponent(runtimeSegmentId)}:${encodeURIComponent(group.id)}`
      )
  )
  return {
    session: {
      ...current,
      ...incoming,
      messages: mergeLiveItems(liveMessages, incoming.messages).sort(
        (left, right) => left.createdAt - right.createdAt
      ),
      activities: mergeLiveItems(liveActivities, incoming.activities ?? []),
      activityGroups: mergeLiveItems(liveGroups, incoming.activityGroups ?? [])
    },
    streamingMessages:
      coveredMessageIds.size === 0
        ? streamingMessages
        : Object.fromEntries(
            Object.entries(streamingMessages).filter(([id]) => !coveredMessageIds.has(id))
          )
  }
}

type TranscriptEntry = {
  store: SessionStoreApi
  context: ReturnType<typeof createRuntimePresentationContext>
  processedEventIds: Set<string>
  scope?: AcpAgentRuntimeScope
  sourceSession?: ChatSession
  durableSettled: boolean
}

const scopeKey = (scope: AcpAgentRuntimeScope): string =>
  JSON.stringify([
    scope.projectId,
    scope.sessionId,
    scope.agentFrameId,
    scope.attemptId,
    scope.runtimeSegmentId,
    scope.promptMessageId
  ])

const detailScope = (
  session: ChatSession,
  detail: WorkspaceSubagentFrameProjection
): AcpAgentRuntimeScope | undefined => {
  const runtimeSegmentId = detail.attempt?.runtimeSegmentIds.at(-1)
  const promptMessageId = detail.messages.findLast((message) => message.role === 'user')?.id
  if (!session.projectId || !detail.attempt || !runtimeSegmentId || !promptMessageId) return
  return {
    projectId: session.projectId,
    sessionId: session.id,
    agentFrameId: detail.frameId,
    attemptId: detail.attempt.id,
    runtimeSegmentId,
    promptMessageId
  }
}

const createEntry = (session: ChatSession, scope?: AcpAgentRuntimeScope): TranscriptEntry => {
  const store = createSessionStore()
  store.setState({ sessions: [session], selectedSessionId: session.id })
  return {
    store,
    scope,
    context: createRuntimePresentationContext(),
    durableSettled: false,
    processedEventIds: new Set([
      ...session.messages.flatMap((message) => message.eventIds),
      ...(session.activities ?? []).flatMap((activity) => activity.eventIds)
    ])
  }
}

/**
 * The App-level runtime owns these materialized transcripts for the lifetime of a run.
 * Views only subscribe to a selected store; mounting, hiding or closing a view cannot stop
 * ingestion or discard history. This projection never writes to the authoritative Session store.
 */
type SubagentTranscriptOwner = Readonly<{
  select(session: ChatSession, detail: WorkspaceSubagentFrameProjection): SessionStoreApi
  ingest(update: AcpAgentRuntimeUpdate): void
  reconcileSessions(sessions: readonly ChatSession[]): void
}>

const createSubagentTranscriptOwner = (): SubagentTranscriptOwner => {
  const entries = new Map<string, TranscriptEntry>()

  const reconcile = (
    entry: TranscriptEntry,
    session: ChatSession,
    detail: WorkspaceSubagentFrameProjection
  ): void => {
    if (entry.sourceSession === session) return
    entry.sourceSession = session
    const incoming = childConversationSession(session, detail)
    entry.durableSettled = detail.attempt?.status !== 'running'
    entry.store.setState((state) => {
      if (!entry.durableSettled) {
        const merged = reconcileRunningChild(
          state.sessions[0],
          incoming,
          state.streamingMessages,
          entry.scope?.runtimeSegmentId
        )
        return { sessions: [merged.session], streamingMessages: merged.streamingMessages }
      }
      entry.context.activityGroupToolCallIdsBySession.clear()
      entry.processedEventIds.clear()
      for (const item of [...incoming.messages, ...(incoming.activities ?? [])]) {
        for (const id of item.eventIds) entry.processedEventIds.add(id)
      }
      return { sessions: [incoming], streamingMessages: {} }
    })
  }

  return {
    select(session: ChatSession, detail: WorkspaceSubagentFrameProjection): SessionStoreApi {
      const scope = detailScope(session, detail)
      const key = scope
        ? scopeKey(scope)
        : JSON.stringify([session.projectId, session.id, detail.frameId])
      let entry = entries.get(key)
      if (!entry) {
        entry = createEntry(childConversationSession(session, detail), scope)
        entries.set(key, entry)
      }
      reconcile(entry, session, detail)
      return entry.store
    },
    ingest(update: AcpAgentRuntimeUpdate): void {
      const { scope } = update
      const key = scopeKey(scope)
      let entry = entries.get(key)
      if (!entry) {
        // A child may emit before its durable frame reaches the renderer. Routing identity is
        // already authoritative; seed only the prompt identity, then hydrate its text/metadata
        // from the graph. Zero timestamps ensure the real prompt supersedes this placeholder.
        entry = createEntry(
          {
            id: scope.sessionId,
            projectId: scope.projectId,
            title: '',
            cwd: '',
            status: 'running',
            createdAt: 0,
            updatedAt: 0,
            activeRun: {
              promptMessageId: scope.promptMessageId,
              startedAt: update.event.timestamp
            },
            agentPromptInFlight: true,
            messages: [
              {
                id: scope.promptMessageId,
                role: 'user',
                content: '',
                status: 'complete',
                eventIds: [],
                createdAt: 0,
                updatedAt: 0
              }
            ]
          },
          scope
        )
        entries.set(key, entry)
      }
      if (entry.durableSettled || entry.processedEventIds.has(update.event.id)) return
      entry.processedEventIds.add(update.event.id)
      const event = {
        ...update.event,
        sessionId: scope.sessionId,
        promptMessageId: scope.promptMessageId
      } as AcpRuntimeEvent
      if (applyRuntimePresentationEvent(event, entry.store, entry.context)) return
      if (event.kind === 'stop') {
        entry.context.activityGroupToolCallIdsBySession.delete(scope.sessionId)
        entry.store
          .getState()
          .finishRun(
            scope.sessionId,
            event.turnUsage,
            scope.promptMessageId,
            undefined,
            event.modelCallUsage
          )
      } else if (event.kind === 'error') {
        entry.context.activityGroupToolCallIdsBySession.delete(scope.sessionId)
        entry.store
          .getState()
          .failRun(scope.sessionId, event.text?.trim() || event.title?.trim() || 'Agent run failed')
      } else if (event.kind === 'system' && event.level === 'warning' && event.text) {
        entry.store.getState().setAgentStatus(scope.sessionId, event.text)
      }
    },
    reconcileSessions(sessions: readonly ChatSession[]): void {
      const byId = new Map(sessions.map((session) => [session.id, session]))
      for (const [key, entry] of entries) {
        const session = byId.get(entry.store.getState().sessions[0].id)
        if (!session || session.contentLoaded === false) {
          // Live state outlives residency and view changes. Once durable, the root graph can
          // reconstruct it and an evicted session no longer needs a duplicate projection.
          if (entry.durableSettled) entries.delete(key)
          continue
        }
        const scope = entry.scope
        const graph = session.conversationGraph
        if (!scope || !graph || session.projectId !== scope.projectId) continue
        const frame = graph.frames.find((frame) => frame.id === scope.agentFrameId)
        const attempt = session.runtimeContext?.delegatedWork?.records
          .find((record) => record.agentFrameId === scope.agentFrameId)
          ?.attempts.find((attempt) => attempt.id === scope.attemptId)
        if (!frame || !attempt) continue
        if (attempt.runtimeSegmentIds.at(-1) !== scope.runtimeSegmentId) {
          // Continuations retain their Attempt identity but append a new runtime segment.
          // Once that Attempt settles, its earlier turns are durable; retire their stores
          // rather than leaving them permanently marked live and immune to residency eviction.
          if (attempt.status !== 'running') entries.delete(key)
          continue
        }
        const messages = resolveMessageBranchPath(graph, frame.activeBranchId).map(
          projectConversationMessage
        )
        if (messages.findLast((message) => message.role === 'user')?.id !== scope.promptMessageId)
          continue
        reconcile(entry, session, { frameId: frame.id, status: frame.status, attempt, messages })
      }
    }
  }
}

const useSubagentRuntimePresentation = (
  owner: SubagentTranscriptOwner,
  session: ChatSession,
  detail: WorkspaceSubagentFrameProjection
): ChatSession => {
  const store = owner.select(session, detail)
  const liveSession = useStore(store, (state) => state.sessions[0])
  const streamingMessages = useStore(store, (state) => state.streamingMessages)
  return useMemo(() => {
    let messages: ChatSession['messages'] | undefined
    for (let index = 0; index < liveSession.messages.length; index += 1) {
      const message = liveSession.messages[index]
      const entry = streamingMessages[message.id]
      if (!entry) continue
      if (!messages) messages = liveSession.messages.slice()
      messages[index] = {
        ...message,
        content: entry.content,
        eventIds: entry.eventIds,
        updatedAt: Math.max(message.updatedAt, entry.updatedAt)
      }
    }
    return messages ? { ...liveSession, messages } : liveSession
  }, [liveSession, streamingMessages])
}

export { createSubagentTranscriptOwner, useSubagentRuntimePresentation }
export type { SubagentTranscriptOwner, WorkspaceSubagentFrameProjection }
