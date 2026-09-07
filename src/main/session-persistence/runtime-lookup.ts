import type { PersistedChatSession } from '../../shared/session-persistence'
import type { SessionCatalog } from './coordinator'
import type { SessionRepository } from './repository'

// Shared by Specialist binding and delegated-work admission in the application composition.
export const createSessionRuntimeLookup =
  ({
    repository,
    coordinator
  }: {
    repository: Pick<
      SessionRepository,
      'loadAll' | 'loadSession' | 'assertSessionIdentityOwnership'
    >
    coordinator: Pick<SessionCatalog, 'sessionProjectId'>
  }): ((sessionId: string) => Promise<PersistedChatSession[]>) =>
  async (sessionId) => {
    const projectId = await coordinator.sessionProjectId(sessionId)
    if (projectId === undefined) {
      // Before hydration or the first save, keep the existing catalog lookup semantics.
      return (await repository.loadAll()).sessions.filter((session) => session.id === sessionId)
    }
    // Metadata locates the file; filename authority still rejects ambiguous global identities.
    // Neither step needs to decode unrelated transcripts on the prompt's critical path.
    await repository.assertSessionIdentityOwnership(sessionId, projectId)
    const session = await repository.loadSession(projectId, sessionId)
    return session ? [session] : []
  }
