import { randomUUID } from 'node:crypto'
import {
  requestResearchExecutionConfigurationSchema,
  getResearchExecutionConfigurationSchema,
  resolveResearchExecutionConfigurationSchema,
  type ResearchExecutionConfigurationSnapshot,
  type ResearchExecutionPreflight,
  type ResearchExecutionPreflightRequest
} from '../../shared/research-execution-profile'

/** A configuration handoff only: no process, installation, secret read, or automatic run. */
export class ResearchExecutionConfigurationBroker {
  private readonly requests = new Map<string, ResearchExecutionConfigurationSnapshot>()
  private readonly pending = new Map<string, Promise<ResearchExecutionConfigurationSnapshot>>()
  constructor(
    private readonly dependencies: {
      preflight(
        request: ResearchExecutionPreflightRequest,
        signal?: AbortSignal
      ): Promise<ResearchExecutionPreflight>
      now?: () => number
    }
  ) {}
  private expire(): void {
    const now = this.dependencies.now?.() ?? Date.now()
    for (const [id, request] of this.requests) {
      if (request.expiresAt <= now && request.status === 'pending') request.status = 'expired'
      if (request.expiresAt + 30 * 60_000 <= now) this.requests.delete(id)
    }
  }
  async request(
    value: unknown,
    signal?: AbortSignal
  ): Promise<ResearchExecutionConfigurationSnapshot> {
    const request = requestResearchExecutionConfigurationSchema.parse(value)
    const { requestId, ...scope } = request
    const key = JSON.stringify([scope.projectId, scope.sessionId, requestId])
    this.expire()
    const existing = [...this.requests.values()].find(
      (item) =>
        item.requestId === requestId &&
        item.scope.projectId === scope.projectId &&
        item.scope.sessionId === scope.sessionId
    )
    if (existing) {
      if (JSON.stringify(existing.scope) !== JSON.stringify(scope))
        throw new Error('Research configuration request conflicts with its earlier contents.')
      await this.dependencies.preflight(scope, signal)
      return structuredClone(existing)
    }
    const active = this.pending.get(key)
    if (active) {
      const resolved = await active
      if (JSON.stringify(resolved.scope) !== JSON.stringify(scope))
        throw new Error('Research configuration request conflicts with its earlier contents.')
      return structuredClone(resolved)
    }
    const completion = (async (): Promise<ResearchExecutionConfigurationSnapshot> => {
      const preflight = await this.dependencies.preflight(scope, signal)
      signal?.throwIfAborted()
      if (!preflight.binding)
        throw new Error('Research configuration requires a verified research plan.')
      if (this.requests.size >= 128) throw new Error('Too many research configuration requests.')
      const now = this.dependencies.now?.() ?? Date.now()
      const snapshot: ResearchExecutionConfigurationSnapshot = {
        configurationId: randomUUID(),
        requestId,
        scope,
        status: 'pending',
        preflight,
        createdAt: now,
        expiresAt: now + 30 * 60_000
      }
      this.requests.set(snapshot.configurationId, snapshot)
      return structuredClone(snapshot)
    })()
    this.pending.set(key, completion)
    try {
      return await completion
    } finally {
      if (this.pending.get(key) === completion) this.pending.delete(key)
    }
  }
  async get(value: unknown, signal?: AbortSignal): Promise<ResearchExecutionConfigurationSnapshot> {
    const request = getResearchExecutionConfigurationSchema.parse(value)
    this.expire()
    const snapshot = this.requests.get(request.configurationId)
    if (
      !snapshot ||
      snapshot.scope.projectId !== request.projectId ||
      snapshot.scope.sessionId !== request.sessionId
    )
      throw new Error('Research configuration request not found.')
    await this.dependencies.preflight(snapshot.scope, signal)
    return structuredClone(snapshot)
  }
  listPending(): ResearchExecutionConfigurationSnapshot[] {
    this.expire()
    return structuredClone(
      [...this.requests.values()].filter((request) => request.status === 'pending')
    )
  }
  async resolve(
    value: unknown,
    signal?: AbortSignal
  ): Promise<ResearchExecutionConfigurationSnapshot> {
    const request = resolveResearchExecutionConfigurationSchema.parse(value)
    this.expire()
    const snapshot = this.requests.get(request.configurationId)
    if (!snapshot) throw new Error('Research configuration request not found.')
    if (snapshot.status !== 'pending') return structuredClone(snapshot)
    if (request.outcome === 'dismissed') {
      snapshot.status = 'dismissed'
      return structuredClone(snapshot)
    }
    if (!request.profileId) throw new Error('Select a configured local research profile.')
    const preflight = await this.dependencies.preflight(
      { ...snapshot.scope, profileId: request.profileId },
      signal
    )
    signal?.throwIfAborted()
    if (
      preflight.selectedProfileId !== request.profileId ||
      preflight.slots.some((slot) => slot.required && slot.status !== 'configured')
    )
      throw new Error('Required research credentials are not configured.')
    // Another desktop action may dismiss/expire the request while credential storage is opening.
    this.expire()
    if (snapshot.status !== 'pending') return structuredClone(snapshot)
    snapshot.status = 'configured'
    snapshot.profileId = request.profileId
    snapshot.preflight = preflight
    return structuredClone(snapshot)
  }
}
