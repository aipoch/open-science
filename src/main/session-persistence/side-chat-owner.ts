import { randomUUID } from 'node:crypto'

import {
  materializeSessionConversationGraph,
  getPersistedSideChats,
  sanitizeSessionRuntimeContext,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedSideChat,
  type PersistedSideChatRelay,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import { saveSessionWithRevision } from './save-session'
import { loadSessionMutationAuthority } from './repository'

type PersistedSideChatProjection = PersistedSideChat

type SaveSideChatProjectionCommand = Readonly<{
  projectId: string
  sessionId: string
  sideChat: PersistedSideChatProjection
}>

type AppendSideChatRelayCommand = Readonly<{
  projectId: string
  sessionId: string
  sideChatId: string
  relay: Omit<PersistedSideChatRelay, 'sideChatId'>
}>

type CommitSideChatRelaysCommand = Readonly<{
  projectId: string
  sessionId: string
  relayIds: readonly string[]
  // Accepted in-memory advisories; omitted only by legacy persistence callers.
  relays?: readonly PersistedSideChatRelay[]
  promptMessageId: string
}>

type ClearSideChatCommand = Readonly<{
  projectId: string
  sessionId: string
  sideChatId?: string
}>

type SideChatStateRepository = Readonly<{
  loadAllWithDiagnostics(options?: { mode?: 'repair' | 'read-only' }): Promise<{
    result: { sessions: PersistedChatSession[] }
    isComplete: boolean
  }>
  loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string
  ): Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
  saveSession(session: PersistedChatSession): Promise<PersistedChatSession>
}>

type SessionSideChatPersistenceOwnerOptions = Readonly<{
  repository: SideChatStateRepository
  assertMutable(projectId: string, sessionId: string, projectionOnly: boolean): void
  recordSession(session: PersistedChatSession): void
  notifySessionUpdated(session: PersistedChatSession): void
}>

const emptyRuntimeContext = (): SessionRuntimeContext => ({ version: 1, revision: 0 })

class SessionSideChatPersistenceOwner {
  constructor(private readonly options: SessionSideChatPersistenceOwnerOptions) {}

  async loadCatalog(): Promise<{
    sideChats: Array<{
      projectId: string
      parentSessionId: string
      sideChat: PersistedSideChat
    }>
    relays: Array<{
      projectId: string
      parentSessionId: string
      relays: readonly PersistedSideChatRelay[]
    }>
    isComplete: boolean
  }> {
    const scan = await this.options.repository.loadAllWithDiagnostics({ mode: 'read-only' })
    return {
      sideChats: scan.result.sessions.flatMap((session) =>
        getPersistedSideChats(session.runtimeContext).map((sideChat) => ({
          projectId: session.projectId,
          parentSessionId: session.id,
          sideChat: structuredClone(sideChat)
        }))
      ),
      relays: scan.result.sessions.flatMap((session) =>
        session.runtimeContext?.sideChatRelays?.length
          ? [
              {
                projectId: session.projectId,
                parentSessionId: session.id,
                relays: structuredClone(session.runtimeContext.sideChatRelays)
              }
            ]
          : []
      ),
      isComplete: scan.isComplete
    }
  }

  async saveProjection(command: SaveSideChatProjectionCommand): Promise<PersistedSideChat> {
    const session = await this.loadMutable(command.projectId, command.sessionId, true)
    const current = session.runtimeContext ?? emptyRuntimeContext()
    const chats = [...getPersistedSideChats(current)]
    const index = chats.findIndex((chat) => chat.id === command.sideChat.id)
    if (index >= 0) chats[index] = command.sideChat
    else chats.push(command.sideChat)
    const candidate = sanitizeSessionRuntimeContext({
      ...current,
      revision: current.revision + 1,
      sideChat: chats[0],
      ...(chats.length > 1 ? { sideChats: chats.slice(1) } : {})
    })
    const sideChat = getPersistedSideChats(candidate).find(
      (chat) => chat.id === command.sideChat.id
    )
    if (!candidate || !sideChat) throw new Error('Side chat projection is not JSON-safe.')
    await this.save(session, candidate)
    return structuredClone(sideChat)
  }

  async appendRelay(command: AppendSideChatRelayCommand): Promise<void> {
    const session = await this.loadMutable(command.projectId, command.sessionId)
    const current = session.runtimeContext ?? emptyRuntimeContext()
    this.requireSideChat(current, command.sideChatId, 'relay')
    const relays = current.sideChatRelays ?? []
    if (relays.some((relay) => relay.id === command.relay.id)) {
      throw new Error('Side chat relay identity is already queued.')
    }
    const candidate = sanitizeSessionRuntimeContext({
      ...current,
      revision: current.revision + 1,
      sideChatRelays: [...relays, { ...command.relay, sideChatId: command.sideChatId }]
    })
    if (!candidate?.sideChat || !candidate.sideChatRelays) {
      throw new Error('Side chat relay is not JSON-safe.')
    }
    await this.save(session, candidate)
  }

  async commitRelays(
    command: CommitSideChatRelaysCommand
  ): Promise<readonly PersistedChatMessage[]> {
    if (!command.promptMessageId) {
      throw new Error('Main prompt message identity is required to deliver Side chat advisories.')
    }
    const session = await this.loadMutable(command.projectId, command.sessionId)
    const current = session.runtimeContext ?? emptyRuntimeContext()
    const relayIds = new Set(command.relayIds)
    const queuedRelays = current.sideChatRelays ?? []
    const relays = command.relays ?? queuedRelays.filter((relay) => relayIds.has(relay.id))
    if (
      new Set(relays.map((relay) => relay.id)).size !== relays.length ||
      relays.some((relay) => !relayIds.has(relay.id))
    ) {
      throw new Error('Side chat relay identities do not match the accepted batch.')
    }
    if (relays.length !== relayIds.size) {
      throw new Error('One or more Side chat relays are no longer queued.')
    }
    if (relays.length === 0) return []

    const timestamp = Math.max(session.updatedAt + 1, Date.now())
    // Stable message identities make an accepted batch retry safe when the authority write
    // committed but projection publication or notification failed afterwards.
    const existingMessages = new Map(
      [...(session.conversationGraph?.messages ?? []), ...session.messages].map((message) => [
        message.id,
        message
      ])
    )
    const messages = relays.map((relay, index): PersistedChatMessage => {
      const id = command.relays ? `message-${relay.id}` : `message-${randomUUID()}`
      const existing = existingMessages.get(id)
      if (existing) {
        if (
          existing.relayedFrom?.kind !== 'side-chat' ||
          existing.content !== relay.text ||
          existing.responseToMessageId !== command.promptMessageId
        ) {
          throw new Error('Side chat delivery identity conflicts with an existing message.')
        }
        return existing
      }
      return {
        id,
        role: 'user',
        content: relay.text,
        status: 'complete',
        eventIds: [],
        responseToMessageId: command.promptMessageId,
        relayedFrom: { kind: 'side-chat', direction: 'to-main' },
        createdAt: timestamp + index,
        updatedAt: timestamp + index
      }
    })
    const newMessages = messages.filter((message) => !existingMessages.has(message.id))
    if (newMessages.length === 0) {
      this.options.recordSession(session)
      this.options.notifySessionUpdated(session)
      return messages
    }
    const remainingRelays = queuedRelays.filter((relay) => !relayIds.has(relay.id))
    const candidateInput: {
      version: 1
      revision: number
      plan?: SessionRuntimeContext['plan']
      sideChat?: PersistedSideChat
      sideChatRelays?: readonly PersistedSideChatRelay[]
    } = {
      ...current,
      revision: current.revision + 1
    }
    if (remainingRelays.length > 0) candidateInput.sideChatRelays = remainingRelays
    else delete candidateInput.sideChatRelays
    const candidate = sanitizeSessionRuntimeContext(candidateInput)
    if (!candidate) throw new Error('Committed Side chat state is not JSON-safe.')
    const durable = materializeSessionConversationGraph({
      ...session,
      runtimeContext: candidate,
      messages: [...session.messages, ...newMessages],
      updatedAt: timestamp + messages.length - 1
    })
    const persisted = await saveSessionWithRevision(this.options.repository, durable)
    this.options.recordSession(persisted)
    this.options.notifySessionUpdated(persisted)
    return messages
  }

  async clear(command: ClearSideChatCommand): Promise<boolean> {
    const session = await this.loadMutable(command.projectId, command.sessionId)
    const current = session.runtimeContext ?? emptyRuntimeContext()
    const chats = getPersistedSideChats(current)
    const remaining = command.sideChatId
      ? chats.filter((chat) => chat.id !== command.sideChatId)
      : []
    if (chats.length === remaining.length) return false
    const candidate = { ...current, revision: current.revision + 1 }
    delete candidate.sideChat
    delete candidate.sideChats
    if (remaining.length) candidate.sideChat = remaining[0]
    if (remaining.length > 1) candidate.sideChats = remaining.slice(1)
    const runtimeContext = sanitizeSessionRuntimeContext(candidate)
    if (!runtimeContext) throw new Error('Cleared Side chat state is not JSON-safe.')
    await this.save(session, runtimeContext)
    return true
  }

  private async loadMutable(
    projectId: string,
    sessionId: string,
    projectionOnly = false
  ): Promise<PersistedChatSession> {
    this.options.assertMutable(projectId, sessionId, projectionOnly)
    const loaded = await loadSessionMutationAuthority(this.options.repository, projectId, sessionId)
    if (loaded.status === 'unreadable') {
      throw new Error('Cannot mutate Side chat because its parent Session JSON is unreadable.')
    }
    if (loaded.status === 'missing') {
      throw new Error('Cannot mutate Side chat for a missing parent Session.')
    }
    return loaded.session
  }

  private requireSideChat(
    context: SessionRuntimeContext,
    sideChatId: string,
    operation: string
  ): PersistedSideChat {
    const chat = getPersistedSideChats(context).find((candidate) => candidate.id === sideChatId)
    if (!chat) {
      throw new Error(`Side chat ${operation} does not match the durable parent Side chat.`)
    }
    return chat
  }

  private async save(
    session: PersistedChatSession,
    runtimeContext: SessionRuntimeContext
  ): Promise<void> {
    const durable = {
      ...session,
      runtimeContext,
      updatedAt: Math.max(session.updatedAt + 1, Date.now())
    }
    const persisted = await saveSessionWithRevision(this.options.repository, durable)
    this.options.recordSession(persisted)
    this.options.notifySessionUpdated(persisted)
  }
}

export { SessionSideChatPersistenceOwner }
export type {
  AppendSideChatRelayCommand,
  ClearSideChatCommand,
  CommitSideChatRelaysCommand,
  PersistedSideChatProjection,
  SaveSideChatProjectionCommand
}
