import { randomUUID } from 'node:crypto'

import {
  materializeSessionConversationGraph,
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
  saveSession(session: PersistedChatSession): Promise<PersistedChatSession | void>
}>

type SessionSideChatPersistenceOwnerOptions = Readonly<{
  repository: SideChatStateRepository
  assertMutable(projectId: string, sessionId: string): void
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
        session.runtimeContext?.sideChat
          ? [
              {
                projectId: session.projectId,
                parentSessionId: session.id,
                sideChat: structuredClone(session.runtimeContext.sideChat)
              }
            ]
          : []
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
    const session = await this.loadMutable(command.projectId, command.sessionId)
    const current = session.runtimeContext ?? emptyRuntimeContext()
    if (current.sideChat && current.sideChat.id !== command.sideChat.id) {
      throw new Error('A different Side chat already owns this parent Session.')
    }
    const candidate = sanitizeSessionRuntimeContext({
      ...current,
      revision: current.revision + 1,
      sideChat: command.sideChat
    })
    const sideChat = candidate?.sideChat
    if (!candidate || !sideChat) throw new Error('Side chat projection is not JSON-safe.')
    await this.save(session, candidate)
    return structuredClone(sideChat)
  }

  async appendRelay(command: AppendSideChatRelayCommand): Promise<void> {
    const session = await this.loadMutable(command.projectId, command.sessionId)
    const current = session.runtimeContext ?? emptyRuntimeContext()
    const sideChat = this.requireSideChat(current, command.sideChatId, 'relay')
    const relays = current.sideChatRelays ?? []
    if (relays.some((relay) => relay.id === command.relay.id)) {
      throw new Error('Side chat relay identity is already queued.')
    }
    const candidate = sanitizeSessionRuntimeContext({
      ...current,
      revision: current.revision + 1,
      sideChat,
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
    const relays = queuedRelays.filter((relay) => relayIds.has(relay.id))
    if (relays.length !== relayIds.size) {
      throw new Error('One or more Side chat relays are no longer queued.')
    }
    if (relays.length === 0) return []

    const timestamp = Math.max(session.updatedAt + 1, Date.now())
    const messages = relays.map((relay, index): PersistedChatMessage => ({
      id: `message-${randomUUID()}`,
      role: 'user',
      content: relay.text,
      status: 'complete',
      eventIds: [],
      responseToMessageId: command.promptMessageId,
      relayedFrom: { kind: 'side-chat', direction: 'to-main' },
      createdAt: timestamp + index,
      updatedAt: timestamp + index
    }))
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
      messages: [...session.messages, ...messages],
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
    if (!current.sideChat) return false
    if (command.sideChatId && current.sideChat.id !== command.sideChatId) return false
    const candidate = { ...current, revision: current.revision + 1 }
    delete candidate.sideChat
    const runtimeContext = sanitizeSessionRuntimeContext(candidate)
    if (!runtimeContext) throw new Error('Cleared Side chat state is not JSON-safe.')
    await this.save(session, runtimeContext)
    return true
  }

  private async loadMutable(projectId: string, sessionId: string): Promise<PersistedChatSession> {
    this.options.assertMutable(projectId, sessionId)
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
    if (!context.sideChat || context.sideChat.id !== sideChatId) {
      throw new Error(`Side chat ${operation} does not match the durable parent Side chat.`)
    }
    return context.sideChat
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
