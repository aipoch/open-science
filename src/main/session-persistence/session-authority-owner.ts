import { sessionRevision, type PersistedChatSession } from '../../shared/session-persistence'
import { saveSessionWithRevision } from './save-session'
import { loadSessionMutationAuthority } from './repository'

type SessionAuthorityRepository = Parameters<typeof saveSessionWithRevision>[0] & {
  loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string,
    options?: { mode?: 'repair' | 'read-only'; preserveRuntimeState?: boolean }
  ): Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
  assertSessionIdentityOwnership(sessionId: string, expectedProjectId: string): Promise<void>
}

type SessionAuthorityOwnerOptions = {
  repository: SessionAuthorityRepository
  assertMutable: (projectId: string, sessionId: string) => void
  recordSession: (session: PersistedChatSession) => void
  invalidateBindingTopology: (projectId: string, sessionId: string) => void
  metadataSnapshot: () => {
    sessions: readonly Pick<PersistedChatSession, 'id' | 'projectId'>[]
    isComplete: boolean
  }
}

class SessionPersistenceAuthorityOwner {
  constructor(private readonly options: SessionAuthorityOwnerOptions) {}

  async assertIdentityOwnership(
    session: Pick<PersistedChatSession, 'id' | 'projectId'>
  ): Promise<void> {
    const metadata = this.options.metadataSnapshot()
    const existingProjectId = metadata.sessions.find((item) => item.id === session.id)?.projectId
    if (existingProjectId !== undefined && existingProjectId !== session.projectId) {
      throw new Error('Cannot save a Session id that is already owned by another Project.')
    }
    if (!metadata.isComplete) {
      await this.options.repository.assertSessionIdentityOwnership(session.id, session.projectId)
    }
  }

  async loadForContinuation(projectId: string, sessionId: string): Promise<PersistedChatSession> {
    const loaded = await this.options.repository.loadSessionWithDiagnostics(projectId, sessionId)
    if (loaded.status !== 'found') {
      throw new Error(`Cannot prepare a durable continuation for a ${loaded.status} Session.`)
    }
    return structuredClone(loaded.session)
  }

  async runMutation<Result>(
    projectId: string,
    sessionId: string,
    mutation: () => Promise<Result>
  ): Promise<Result> {
    this.options.assertMutable(projectId, sessionId)
    try {
      return await mutation()
    } finally {
      this.options.invalidateBindingTopology(projectId, sessionId)
    }
  }

  async mutateSessionDetails(
    projectId: string,
    sessionId: string,
    mutation: (session: PersistedChatSession) => PersistedChatSession | undefined
  ): Promise<PersistedChatSession | undefined> {
    this.options.assertMutable(projectId, sessionId)
    await this.options.repository.assertSessionIdentityOwnership(sessionId, projectId)
    const authority = await loadSessionMutationAuthority(
      this.options.repository,
      projectId,
      sessionId
    )
    if (authority.status === 'missing') return undefined
    if (authority.status === 'unreadable') {
      throw new Error('Cannot mutate Session details because durable JSON is unreadable.')
    }
    const candidate = mutation(authority.session)
    if (!candidate) return undefined
    if (candidate.projectId !== projectId || candidate.id !== sessionId) {
      throw new Error('Session details mutation cannot change Session ownership.')
    }
    const persisted = await saveSessionWithRevision(
      this.options.repository,
      candidate,
      sessionRevision(authority.session)
    )
    this.options.recordSession(persisted)
    return persisted
  }
}

export { SessionPersistenceAuthorityOwner }
