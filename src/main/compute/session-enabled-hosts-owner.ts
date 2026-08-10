import type { PersistedChatSession } from '../../shared/session-persistence'
import type { EnabledComputeHostsRegistry } from './enabled-hosts-registry'

type SessionEnabledComputeHostsAuthority = Readonly<{
  sessionProjectId(sessionId: string): Promise<string | undefined>
  setSessionEnabledComputeHosts(
    projectId: string,
    sessionId: string,
    providerIds: readonly string[]
  ): Promise<PersistedChatSession>
  pruneSessionEnabledComputeHosts(
    validProviderIds: readonly string[]
  ): Promise<PersistedChatSession[]>
}>

type SessionEnabledComputeHostsOwnerOptions = Readonly<{
  registry: EnabledComputeHostsRegistry
  hostExists(providerId: string): Promise<boolean>
  listHostIds(): Promise<readonly string[]>
  sessionAuthority: SessionEnabledComputeHostsAuthority
}>

class SessionEnabledComputeHostsOwner {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: SessionEnabledComputeHostsOwnerOptions) {}

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async validate(providerIds: readonly string[]): Promise<string[]> {
    const normalized = [...new Set(providerIds)]
    for (const providerId of normalized) {
      if (!providerId.startsWith('ssh:') || providerId.length <= 4) {
        throw new Error(`Invalid Compute Host provider id: ${providerId}`)
      }
      if (!(await this.options.hostExists(providerId))) {
        throw new Error(`Compute Host not found: ${providerId}`)
      }
    }
    return normalized
  }

  get(sessionId: string): string[] {
    return this.options.registry.get(sessionId)
  }

  project(session: PersistedChatSession): void {
    this.options.registry.set(session.id, session.enabledComputeHosts ?? [])
  }

  clear(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) this.options.registry.clear(sessionId)
  }

  pruneProvider(providerId: string): Promise<PersistedChatSession[]> {
    this.options.registry.removeProvider(providerId)
    return this.enqueue(async () => {
      this.options.registry.removeProvider(providerId)
      const validProviderIds = (await this.options.listHostIds()).filter(
        (candidate) => candidate !== providerId
      )
      const sessions =
        await this.options.sessionAuthority.pruneSessionEnabledComputeHosts(validProviderIds)
      this.options.registry.reconcile(
        sessions.map((session) => [session.id, session.enabledComputeHosts ?? []] as const),
        true
      )
      return sessions
    })
  }

  reconcile(
    sessions: readonly PersistedChatSession[],
    isComplete: boolean
  ): Promise<PersistedChatSession[]> {
    return this.enqueue(async () => {
      const validProviderIds = await this.options.listHostIds()
      const validProviderIdSet = new Set(validProviderIds)
      const hasMissingHost = sessions.some((session) =>
        session.enabledComputeHosts?.some((providerId) => !validProviderIdSet.has(providerId))
      )
      const authoritativeSessions =
        isComplete && hasMissingHost
          ? await this.options.sessionAuthority.pruneSessionEnabledComputeHosts(validProviderIds)
          : sessions.map((session) => ({
              ...session,
              enabledComputeHosts: session.enabledComputeHosts?.filter((providerId) =>
                validProviderIdSet.has(providerId)
              )
            }))
      this.options.registry.reconcile(
        authoritativeSessions.map(
          (session) => [session.id, session.enabledComputeHosts ?? []] as const
        ),
        isComplete
      )
      return isComplete ? authoritativeSessions : [...sessions]
    })
  }

  createSession(
    session: PersistedChatSession,
    commit: (session: PersistedChatSession) => Promise<PersistedChatSession>
  ): Promise<PersistedChatSession> {
    return this.enqueue(async () => {
      const enabledComputeHosts = await this.validate(session.enabledComputeHosts ?? [])
      const durableSession = await commit({
        ...session,
        ...(session.enabledComputeHosts || enabledComputeHosts.length > 0
          ? { enabledComputeHosts }
          : {})
      })
      this.project(durableSession)
      return durableSession
    })
  }

  set(sessionId: string, providerIds: readonly string[]): Promise<PersistedChatSession> {
    return this.enqueue(async () => {
      const normalized = await this.validate(providerIds)
      const projectId = await this.options.sessionAuthority.sessionProjectId(sessionId)
      if (!projectId) throw new Error(`Session not found: ${sessionId}`)

      const session = await this.options.sessionAuthority.setSessionEnabledComputeHosts(
        projectId,
        sessionId,
        normalized
      )
      this.project(session)
      return session
    })
  }
}

export { SessionEnabledComputeHostsOwner }
export type { SessionEnabledComputeHostsAuthority, SessionEnabledComputeHostsOwnerOptions }
