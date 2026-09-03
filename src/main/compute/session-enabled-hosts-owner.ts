import type { PersistedChatSession } from '../../shared/session-persistence'
import { ComputeHostPreferenceValidationError } from '../../shared/compute'
import type { EnabledComputeHostsRegistry } from './enabled-hosts-registry'
import {
  sessionComputeHostAccess,
  type SessionComputeHostAccessMutation
} from './session-compute-host-access'
import {
  canReconcileSessionAbsences,
  type SessionCatalog
} from '../session-persistence/catalog-authority'

type SessionEnabledComputeHostsAuthority = Readonly<{
  sessionProjectId(sessionId: string): Promise<string | undefined>
  setSessionEnabledComputeHosts(
    projectId: string,
    sessionId: string,
    providerIds: readonly string[]
  ): Promise<PersistedChatSession>
  mutateSessionComputeHostAccess?(
    projectId: string,
    sessionId: string,
    mutation: SessionComputeHostAccessMutation
  ): Promise<PersistedChatSession>
  pruneSessionEnabledComputeHosts(validProviderIds: readonly string[]): Promise<{
    sessions: PersistedChatSession[]
    previousSelections: Array<{
      projectId: string
      sessionId: string
      providerIds: string[]
      selectedProviderIds?: string[]
    }>
  }>
}>

type SessionEnabledComputeHostsOwnerOptions = Readonly<{
  registry: EnabledComputeHostsRegistry
  hostExists(providerId: string): Promise<boolean>
  listHostIds(): Promise<readonly string[]>
  sessionAuthority: SessionEnabledComputeHostsAuthority
  projectSessionConcurrencyLimit?(sessionId: string, limit: number): Promise<void>
  clearSessionConcurrencyLimits?(sessionIds: readonly string[]): Promise<void>
  withDataRootWrite<Result>(operation: () => Promise<Result>): Promise<Result>
}>

const validateSessionConcurrencyLimit = (limit: number | undefined): void => {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
    throw new Error(
      `Session concurrency limit must be an integer in the range 1..500 (got ${limit}).`
    )
  }
}

class SessionEnabledComputeHostsOwner {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly reservationCounts = new Map<string, number>()

  constructor(private readonly options: SessionEnabledComputeHostsOwnerOptions) {}

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private enqueueWrite<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.enqueue(() => this.options.withDataRootWrite(operation))
  }

  private async validateProviderIds(providerIds: readonly string[]): Promise<string[]> {
    const normalized = [...new Set(providerIds)]
    for (const providerId of normalized) {
      if (!providerId.startsWith('ssh:') || providerId.length <= 4) {
        throw new ComputeHostPreferenceValidationError('invalid_provider_id', providerId)
      }
      if (!(await this.options.hostExists(providerId))) {
        throw new ComputeHostPreferenceValidationError('host_not_found', providerId)
      }
    }
    return normalized
  }

  get(sessionId: string): string[] {
    return this.options.registry.getEnabled(sessionId)
  }

  getSelected(sessionId: string): string[] {
    return this.options.registry.getSelected(sessionId)
  }

  validate(providerIds: readonly string[]): Promise<string[]> {
    return this.enqueueWrite(() => this.validateProviderIds(providerIds))
  }

  listAvailable(): Promise<readonly string[]> {
    return this.enqueue(() => this.options.listHostIds())
  }

  async withReservation<Result>(
    providerIds: readonly string[],
    operation: (providerIds: string[]) => Promise<Result>
  ): Promise<Result> {
    const normalized = await this.enqueueWrite(async () => {
      const validated = await this.validateProviderIds(providerIds)
      for (const providerId of validated) {
        this.reservationCounts.set(providerId, (this.reservationCounts.get(providerId) ?? 0) + 1)
      }
      return validated
    })
    try {
      return await operation(normalized)
    } finally {
      for (const providerId of normalized) {
        const next = (this.reservationCounts.get(providerId) ?? 1) - 1
        if (next > 0) this.reservationCounts.set(providerId, next)
        else this.reservationCounts.delete(providerId)
      }
    }
  }

  project(session: PersistedChatSession): void {
    this.options.registry.setAccess(session.id, sessionComputeHostAccess(session))
  }

  private async mutateDurableAccess(
    projectId: string,
    sessionId: string,
    mutation: SessionComputeHostAccessMutation
  ): Promise<PersistedChatSession> {
    if (this.options.sessionAuthority.mutateSessionComputeHostAccess) {
      return this.options.sessionAuthority.mutateSessionComputeHostAccess(
        projectId,
        sessionId,
        mutation
      )
    }
    if (mutation.kind === 'select-explicit') {
      return this.options.sessionAuthority.setSessionEnabledComputeHosts(
        projectId,
        sessionId,
        mutation.providerIds
      )
    }
    if (mutation.kind === 'replace-access') {
      const enabled = mutation.access.enabledProviderIds
      const selected = mutation.access.selectedProviderIds
      if (enabled.length === selected.length && enabled.every((id) => selected.includes(id))) {
        return this.options.sessionAuthority.setSessionEnabledComputeHosts(
          projectId,
          sessionId,
          enabled
        )
      }
    }
    throw new Error('Session Compute Host access authority is unavailable.')
  }

  clear(sessionIds: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      await this.options.clearSessionConcurrencyLimits?.(sessionIds)
      for (const sessionId of sessionIds) this.options.registry.clear(sessionId)
    })
  }

  pruneProvider(
    providerId: string,
    afterPrune?: () => Promise<void>
  ): Promise<PersistedChatSession[]> {
    return this.enqueueWrite(async () => {
      if ((this.reservationCounts.get(providerId) ?? 0) > 0) {
        throw new Error(`Compute Host is reserved by a Session being created: ${providerId}`)
      }
      const validProviderIds = (await this.options.listHostIds()).filter(
        (candidate) => candidate !== providerId
      )
      const repair =
        await this.options.sessionAuthority.pruneSessionEnabledComputeHosts(validProviderIds)
      this.options.registry.removeProvider(providerId)
      try {
        await afterPrune?.()
      } catch (error) {
        try {
          const restoredSessions: PersistedChatSession[] = []
          for (const selection of repair.previousSelections) {
            restoredSessions.push(
              await this.mutateDurableAccess(selection.projectId, selection.sessionId, {
                kind: 'replace-access',
                access: {
                  enabledProviderIds: selection.providerIds,
                  selectedProviderIds: selection.selectedProviderIds ?? selection.providerIds
                }
              })
            )
          }
          this.options.registry.reconcileAccess(
            restoredSessions.map((session) => [session.id, sessionComputeHostAccess(session)]),
            false
          )
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Compute Host mutation failed and enabled Session selections could not be restored.'
          )
        }
        throw error
      }
      this.options.registry.reconcileAccess(
        repair.sessions.map((session) => [session.id, sessionComputeHostAccess(session)]),
        true
      )
      return repair.sessions
    })
  }

  hydrateFromSessionCatalog<Result extends SessionCatalog>(
    loadCatalog: () => Promise<Result>
  ): Promise<Result> {
    return this.enqueueWrite(async () => {
      const catalog = await loadCatalog()
      return {
        ...catalog,
        sessions: await this.reconcileNow(catalog.sessions, canReconcileSessionAbsences(catalog))
      }
    })
  }

  private async reconcileNow(
    sessions: readonly PersistedChatSession[],
    isComplete: boolean
  ): Promise<PersistedChatSession[]> {
    let validProviderIds: readonly string[]
    try {
      validProviderIds = await this.options.listHostIds()
    } catch {
      return [...sessions]
    }
    const validProviderIdSet = new Set(validProviderIds)
    const hasMissingHost = sessions.some((session) => {
      const access = sessionComputeHostAccess(session)
      return [...access.enabledProviderIds, ...access.selectedProviderIds].some(
        (providerId) => !validProviderIdSet.has(providerId)
      )
    })
    const authoritativeSessions =
      isComplete && hasMissingHost
        ? (await this.options.sessionAuthority.pruneSessionEnabledComputeHosts(validProviderIds))
            .sessions
        : sessions
    this.options.registry.reconcileAccess(
      authoritativeSessions.map((session) => {
        const access = sessionComputeHostAccess(session)
        return [
          session.id,
          {
            enabledProviderIds: access.enabledProviderIds.filter((providerId) =>
              validProviderIdSet.has(providerId)
            ),
            selectedProviderIds: access.selectedProviderIds.filter((providerId) =>
              validProviderIdSet.has(providerId)
            )
          }
        ] as const
      }),
      isComplete
    )
    return [...authoritativeSessions]
  }

  reconcileSession(session: PersistedChatSession): Promise<PersistedChatSession> {
    return this.enqueueWrite(async () => {
      let validProviderIds: readonly string[]
      try {
        validProviderIds = await this.options.listHostIds()
      } catch {
        return session
      }
      const validProviderIdSet = new Set(validProviderIds)
      const access = sessionComputeHostAccess(session)
      const repairedAccess = {
        enabledProviderIds: access.enabledProviderIds.filter((providerId) =>
          validProviderIdSet.has(providerId)
        ),
        selectedProviderIds: access.selectedProviderIds.filter((providerId) =>
          validProviderIdSet.has(providerId)
        )
      }
      const changed =
        repairedAccess.enabledProviderIds.length !== access.enabledProviderIds.length ||
        repairedAccess.selectedProviderIds.length !== access.selectedProviderIds.length
      const durable = changed
        ? await this.mutateDurableAccess(session.projectId, session.id, {
            kind: 'replace-access',
            access: repairedAccess
          })
        : session
      this.project(durable)
      return durable
    })
  }

  createSession(
    session: PersistedChatSession,
    commit: (session: PersistedChatSession) => Promise<PersistedChatSession>
  ): Promise<PersistedChatSession> {
    return this.enqueueWrite(async () => {
      validateSessionConcurrencyLimit(session.computeConcurrencyLimit)
      const enabledComputeHosts = await this.validateProviderIds(session.enabledComputeHosts ?? [])
      const selectedComputeHosts = await this.validateProviderIds(
        session.selectedComputeHosts ?? enabledComputeHosts
      )
      const enabledComputeHostSet = new Set(enabledComputeHosts)
      const invalidSelection = selectedComputeHosts.find(
        (providerId) => !enabledComputeHostSet.has(providerId)
      )
      if (invalidSelection) {
        throw new Error(`Selected Compute Host is not enabled: ${invalidSelection}`)
      }
      const durableSession = await commit({
        ...session,
        ...(session.enabledComputeHosts || enabledComputeHosts.length > 0
          ? { enabledComputeHosts }
          : {}),
        ...(session.selectedComputeHosts !== undefined || enabledComputeHosts.length > 0
          ? { selectedComputeHosts }
          : {})
      })
      if (durableSession.computeConcurrencyLimit !== undefined) {
        if (!this.options.projectSessionConcurrencyLimit) {
          throw new Error('Session concurrency ownership is not initialized.')
        }
        await this.options.projectSessionConcurrencyLimit(
          durableSession.id,
          durableSession.computeConcurrencyLimit
        )
      }
      this.project(durableSession)
      return durableSession
    })
  }

  set(sessionId: string, providerIds: readonly string[]): Promise<PersistedChatSession> {
    return this.selectExplicit(sessionId, providerIds)
  }

  setHostEnabled(
    sessionId: string,
    providerId: string,
    enabled: boolean
  ): Promise<PersistedChatSession> {
    return this.enqueueWrite(async () => {
      if (enabled) await this.validateProviderIds([providerId])
      const projectId = await this.options.sessionAuthority.sessionProjectId(sessionId)
      if (!projectId) throw new Error(`Session not found: ${sessionId}`)
      const session = await this.mutateDurableAccess(projectId, sessionId, {
        kind: 'set-host-enabled',
        providerId,
        enabled
      })
      this.project(session)
      return session
    })
  }

  setHostSelected(
    sessionId: string,
    providerId: string,
    selected: boolean
  ): Promise<PersistedChatSession> {
    return this.enqueueWrite(async () => {
      if (selected) await this.validateProviderIds([providerId])
      const projectId = await this.options.sessionAuthority.sessionProjectId(sessionId)
      if (!projectId) throw new Error(`Session not found: ${sessionId}`)
      const session = await this.mutateDurableAccess(projectId, sessionId, {
        kind: 'set-host-selected',
        providerId,
        selected
      })
      this.project(session)
      return session
    })
  }

  selectExplicit(sessionId: string, providerIds: readonly string[]): Promise<PersistedChatSession> {
    return this.enqueueWrite(async () => {
      const normalized = await this.validateProviderIds(providerIds)
      const projectId = await this.options.sessionAuthority.sessionProjectId(sessionId)
      if (!projectId) throw new Error(`Session not found: ${sessionId}`)
      const session = await this.mutateDurableAccess(projectId, sessionId, {
        kind: 'select-explicit',
        providerIds: normalized
      })
      this.project(session)
      return session
    })
  }
}

export { SessionEnabledComputeHostsOwner }
export type { SessionEnabledComputeHostsAuthority, SessionEnabledComputeHostsOwnerOptions }
