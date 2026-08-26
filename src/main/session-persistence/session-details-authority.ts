import { sessionRevision, type PersistedChatSession } from '../../shared/session-persistence'
import { loadSessionMutationAuthority } from './repository'
import { saveSessionWithRevision } from './save-session'

type SessionDetailsAuthorityRepository = Parameters<typeof saveSessionWithRevision>[0] &
  Parameters<typeof loadSessionMutationAuthority>[0] & {
    assertSessionIdentityOwnership(sessionId: string, expectedProjectId: string): Promise<void>
  }

async function mutateSessionDetailsAuthority(
  repository: SessionDetailsAuthorityRepository,
  projectId: string,
  sessionId: string,
  mutation: (session: PersistedChatSession) => PersistedChatSession | undefined,
  recordSession: (session: PersistedChatSession) => void
): Promise<PersistedChatSession | undefined> {
  await repository.assertSessionIdentityOwnership(sessionId, projectId)
  const authority = await loadSessionMutationAuthority(repository, projectId, sessionId)
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
    repository,
    candidate,
    sessionRevision(authority.session)
  )
  recordSession(persisted)
  return persisted
}

export { mutateSessionDetailsAuthority }
