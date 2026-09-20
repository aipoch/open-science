import type { PersistedChatSession } from '../../shared/session-persistence'
import type { SessionCatalog } from './coordinator'
import type { SessionRepository } from './repository'

// Shared by Specialist binding and delegated-work admission in the application composition.
export const createSessionRuntimeLookup = ({
  repository,
  coordinator
}: {
  repository: Pick<SessionRepository, 'loadAll' | 'loadSession' | 'assertSessionIdentityOwnership'>
  coordinator: Pick<SessionCatalog, 'sessionProjectId'>
}): ((sessionId: string) => Promise<PersistedChatSession[]>) => {
  // Keep at most the latest sample per stage, and only in an explicitly profiled run.
  const trace = process.env.OPEN_SCIENCE_PERF_SESSION_TRACE === '1'
  const measure = (stage: string, start: number): void => {
    if (!trace) return
    const name = `open-science:persistence-runtime-lookup-${stage}`
    performance.clearMeasures(name)
    performance.measure(name, { start })
  }
  const inFlight = new Map<string, Promise<PersistedChatSession[]>>()

  return (sessionId) => {
    const existing = inFlight.get(sessionId)
    if (existing) return existing

    const request = (async () => {
      const startedAt = performance.now()
      const projectId = await coordinator.sessionProjectId(sessionId)
      measure('catalog', startedAt)
      if (projectId === undefined) {
        // Before hydration or the first save, keep the existing catalog lookup semantics.
        const sessions = (await repository.loadAll()).sessions.filter(
          (session) => session.id === sessionId
        )
        measure('fallback', startedAt)
        return sessions
      }
      // Metadata locates the file; filename authority still rejects ambiguous global identities.
      // Neither step needs to decode unrelated transcripts on the prompt's critical path.
      const ownershipStartedAt = performance.now()
      await repository.assertSessionIdentityOwnership(sessionId, projectId)
      measure('ownership', ownershipStartedAt)
      const readStartedAt = performance.now()
      const session = await repository.loadSession(projectId, sessionId)
      measure('read', readStartedAt)
      measure('targeted', startedAt)
      return session ? [session] : []
    })().finally(() => {
      // Clear before delivering settlement to callers, including immediate retries after failure.
      if (inFlight.get(sessionId) === request) inFlight.delete(sessionId)
    })
    inFlight.set(sessionId, request)
    return request
  }
}
