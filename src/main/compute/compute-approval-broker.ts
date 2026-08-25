import type { ComputeApprovalRequest, ComputeApprovalDecision } from '../../shared/compute'
import type { ComputePermissionGrantAdapter } from './permission-grant-adapter'

// Re-export so callers that import from this module don't have to reference shared/compute directly.
export type { ComputeApprovalDecision }

// Context passed with each approval request so the broker can check and record grants.
export type ComputeApprovalContext = {
  // Stable logical Session identifier. The durable adapter persists it across process restarts;
  // the legacy fallback below keeps the former in-memory behavior for isolated callers and tests.
  sessionId: string
  // Project identifier used for project-scope persistent grants.
  projectId: string
  // The compute operation being approved (e.g. 'call_command').
  operation: string
  // Immutable ComputeHost row id captured with the request. Provider ids are reusable, so this
  // distinguishes a deleted host from a later host created with the same SSH alias.
  ownerId?: string
}

type ComputeApprovalBrokerDeps = {
  // Pushes a pending approval request to the renderer.
  broadcast: (request: ComputeApprovalRequest, context?: ComputeApprovalContext) => void
  // Reprojects an existing request without repeating first-delivery side effects such as notifications.
  replay?: (request: ComputeApprovalRequest, context?: ComputeApprovalContext) => void
  // Injectable for deterministic tests; defaults to crypto.randomUUID.
  generateId: () => string
  // How long to wait before auto-denying (default: 5 minutes).
  timeoutMs?: number
  // Injectable timer for tests.
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  now?: () => number
  onSettled?: (id: string, state: 'resolved' | 'rejected' | 'expired' | 'cancelled') => void
  permissionGrants?: ComputePermissionGrantAdapter
  // Optional: check whether a project-scope grant exists for (projectId, operation, providerId).
  // Return true → skip the approval card with 'project' decision.
  checkProjectGrant?: (grant: {
    projectId: string
    operation: string
    providerId: string
  }) => Promise<boolean>
  // Optional: persist a new project-scope grant.
  saveProjectGrant?: (grant: {
    projectId: string
    operation: string
    providerId: string
  }) => Promise<void>
  // Revalidates the immutable host identity immediately before a remembered decision is persisted.
  isProviderCurrent?: (owner: { providerId: string; ownerId?: string }) => Promise<boolean>
}

type PendingComputeApproval = {
  request: ComputeApprovalRequest
  resolve: (decision: ComputeApprovalDecision) => void
  timer?: ReturnType<typeof setTimeout>
  remainingMs: number
  timerStartedAt?: number
  providerId: string
  context?: ComputeApprovalContext
  signal?: AbortSignal
  abortListener?: () => void
}

// Bridges the main-process compute gate to the renderer approval card. Holds the call_command
// open (a Promise) while the user decides; auto-denies after timeoutMs to prevent indefinite hangs.
// Follows the same promise + broadcast + IPC-respond pattern as ApprovalBroker in connectors.
//
// The wire protocol retains `conversation`, but the production adapter translates it to a durable
// Session grant. Project and Global use the same Registry; settings.json is read only for lazy legacy
// Project migration. Callers without the adapter retain the older in-memory/test hooks below.
//
// Use request() for legacy callers that do not supply context (only 'once'/'deny' can result).
// Use requestWithContext() to enable grant memory.
export class ComputeApprovalBroker {
  private readonly pending = new Map<string, PendingComputeApproval>()
  private readonly pausedSessions = new Set<string>()

  private readonly providerGenerations = new Map<string, number>()
  private readonly invalidatingProviders = new Set<string>()
  private readonly inFlightRequests = new Map<string, Set<Promise<ComputeApprovalDecision>>>()

  // Legacy fallback used only when no durable adapter is supplied.
  private readonly conversationGrants = new Set<string>()

  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly now: () => number

  constructor(private readonly deps: ComputeApprovalBrokerDeps) {
    this.timeoutMs = deps.timeoutMs ?? 5 * 60_000
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
    this.now = deps.now ?? Date.now
  }

  // Broadcasts an approval request and resolves once the renderer responds (or the timeout denies).
  // Does NOT check grants — use requestWithContext for that.
  request(
    info: Omit<ComputeApprovalRequest, 'id'>,
    context?: ComputeApprovalContext,
    signal?: AbortSignal
  ): Promise<ComputeApprovalDecision> {
    signal?.throwIfAborted()
    const id = this.deps.generateId()
    const providerId = info.provider_id
    const request = { id, ...info }

    return new Promise<ComputeApprovalDecision>((resolve) => {
      const entry: PendingComputeApproval = {
        request,
        resolve,
        remainingMs: this.timeoutMs,
        providerId,
        context,
        signal
      }
      this.pending.set(id, entry)
      if (signal) {
        entry.abortListener = () => this.settle(id, 'deny', 'cancelled')
        signal.addEventListener('abort', entry.abortListener, { once: true })
        if (signal.aborted) {
          this.settle(id, 'deny', 'cancelled')
          return
        }
      }
      this.schedule(id, entry)
      this.deps.broadcast(request, context)
    })
  }

  getPending(id: string): ComputeApprovalRequest | null {
    const pending = this.pending.get(id)
    if (!pending) return null
    return {
      ...pending.request,
      ...(pending.context?.sessionId ? { session_id: pending.context.sessionId } : {})
    }
  }

  replayPending(): void {
    const replay = this.deps.replay ?? this.deps.broadcast
    for (const entry of this.pending.values()) replay(entry.request, entry.context)
  }

  // Like request(), but checks conversation and project grants first. If a grant matches, resolves
  // immediately without broadcasting. When the user responds with a scope that has memory, records it.
  requestWithContext(
    info: Omit<ComputeApprovalRequest, 'id'>,
    ctx: ComputeApprovalContext,
    signal?: AbortSignal
  ): Promise<ComputeApprovalDecision> {
    signal?.throwIfAborted()
    const providerId = info.provider_id
    if (this.invalidatingProviders.has(providerId)) return Promise.resolve('deny')

    const request = this.requestWithContextOperation(info, ctx, signal)
    const requests = this.inFlightRequests.get(providerId) ?? new Set()
    requests.add(request)
    this.inFlightRequests.set(providerId, requests)
    void request.then(
      () => this.releaseInFlightRequest(providerId, request),
      () => this.releaseInFlightRequest(providerId, request)
    )
    return request
  }

  private async requestWithContextOperation(
    info: Omit<ComputeApprovalRequest, 'id'>,
    ctx: ComputeApprovalContext,
    signal?: AbortSignal
  ): Promise<ComputeApprovalDecision> {
    const { sessionId, projectId, operation } = ctx
    const providerId = info.provider_id
    const providerGeneration = this.providerGenerations.get(providerId) ?? 0

    if (this.deps.permissionGrants) {
      const durableScope = await this.deps.permissionGrants.resolve({
        sessionId,
        projectId,
        operation,
        providerId
      })
      if (durableScope) {
        if (!(await this.isProviderCurrent(providerId, ctx.ownerId, providerGeneration))) {
          return 'deny'
        }
        if (durableScope === 'session') return 'conversation'
        return durableScope
      }
    }

    // ── legacy project grant check (persistent) ───────────────────────────────────
    if (this.deps.checkProjectGrant) {
      const hasProject = await this.deps.checkProjectGrant({ projectId, operation, providerId })
      if (hasProject) {
        return (await this.isProviderCurrent(providerId, ctx.ownerId, providerGeneration))
          ? 'project'
          : 'deny'
      }
    }

    // ── conversation grant check (session in-memory) ───────────────────────────────
    const convKey = `${sessionId}:${operation}:${providerId}`
    if (this.conversationGrants.has(convKey)) {
      return (await this.isProviderCurrent(providerId, ctx.ownerId, providerGeneration))
        ? 'conversation'
        : 'deny'
    }

    // ── no grant — show approval card ─────────────────────────────────────────────
    // Grant lookups above are asynchronous. Invalidation may have started after this operation
    // entered the in-flight set but before it reached the approval card. Fail closed here so the
    // invalidator cannot miss a newly-created pending request and wait on it indefinitely.
    if (
      this.invalidatingProviders.has(providerId) ||
      (this.providerGenerations.get(providerId) ?? 0) !== providerGeneration
    ) {
      return 'deny'
    }
    const decision = await this.request(info, ctx, signal)

    if ((this.providerGenerations.get(providerId) ?? 0) !== providerGeneration) return 'deny'

    const allowsDecision = decision !== 'deny'
    if (
      allowsDecision &&
      !(await this.isProviderCurrent(providerId, ctx.ownerId, providerGeneration))
    ) {
      return 'deny'
    }

    // Record grant if applicable.
    if (this.deps.permissionGrants) {
      await this.deps.permissionGrants.remember(
        { sessionId, projectId, operation, providerId },
        decision
      )
    } else if (decision === 'conversation') {
      this.conversationGrants.add(convKey)
    } else if (decision === 'project' && this.deps.saveProjectGrant) {
      await this.deps.saveProjectGrant({ projectId, operation, providerId })
    }

    if (
      allowsDecision &&
      !(await this.isProviderCurrent(providerId, ctx.ownerId, providerGeneration))
    ) {
      return 'deny'
    }

    return decision
  }

  // Called from the IPC handler when the renderer responds. Unknown ids are ignored.
  respond(id: string, decision: ComputeApprovalDecision): void {
    this.settle(id, decision, decision === 'deny' ? 'rejected' : 'resolved')
  }

  pauseSession(sessionId: string): void {
    if (this.pausedSessions.has(sessionId)) return
    this.pausedSessions.add(sessionId)
    for (const entry of this.pending.values()) {
      if (entry.context?.sessionId !== sessionId || entry.timer === undefined) continue
      this.clearTimer(entry.timer)
      entry.timer = undefined
      entry.remainingMs = Math.max(
        0,
        entry.remainingMs - (this.now() - (entry.timerStartedAt ?? this.now()))
      )
      entry.timerStartedAt = undefined
    }
  }

  resumeSession(sessionId: string): void {
    if (!this.pausedSessions.delete(sessionId)) return
    for (const [id, entry] of this.pending) {
      if (entry.context?.sessionId === sessionId) this.schedule(id, entry)
    }
  }

  cancelSession(sessionId: string): void {
    this.pausedSessions.delete(sessionId)
    for (const key of this.conversationGrants) {
      if (key.startsWith(`${sessionId}:`)) this.conversationGrants.delete(key)
    }
    for (const [id, entry] of this.pending) {
      if (entry.context?.sessionId === sessionId) this.settle(id, 'deny', 'cancelled')
    }
  }

  private schedule(id: string, entry: PendingComputeApproval): void {
    const sessionId = entry.context?.sessionId
    if (sessionId && this.pausedSessions.has(sessionId)) return
    if (entry.remainingMs <= 0) {
      this.settle(id, 'deny', 'expired')
      return
    }
    entry.timerStartedAt = this.now()
    entry.timer = this.setTimer(() => this.settle(id, 'deny', 'expired'), entry.remainingMs)
  }

  // Host deletion begins by advancing its generation and denying every approval card that was
  // created for the old owner. A later host may reuse providerId, but it cannot reuse these calls.
  async invalidateProvider(providerId: string): Promise<void> {
    this.invalidatingProviders.add(providerId)
    this.providerGenerations.set(providerId, (this.providerGenerations.get(providerId) ?? 0) + 1)
    for (const key of this.conversationGrants) {
      if (key.endsWith(`:${providerId}`)) this.conversationGrants.delete(key)
    }
    for (const [id, entry] of this.pending) {
      if (entry.providerId === providerId) this.settle(id, 'deny', 'cancelled')
    }
    await Promise.allSettled(Array.from(this.inFlightRequests.get(providerId) ?? []))
  }

  completeProviderInvalidation(providerId: string): void {
    this.invalidatingProviders.delete(providerId)
  }

  private releaseInFlightRequest(
    providerId: string,
    request: Promise<ComputeApprovalDecision>
  ): void {
    const requests = this.inFlightRequests.get(providerId)
    requests?.delete(request)
    if (requests?.size === 0) this.inFlightRequests.delete(providerId)
  }

  private async isProviderCurrent(
    providerId: string,
    ownerId: string | undefined,
    expectedGeneration: number
  ): Promise<boolean> {
    if ((this.providerGenerations.get(providerId) ?? 0) !== expectedGeneration) return false
    if (
      this.deps.isProviderCurrent &&
      !(await this.deps.isProviderCurrent({ providerId, ownerId }))
    ) {
      return false
    }
    return (this.providerGenerations.get(providerId) ?? 0) === expectedGeneration
  }

  private settle(
    id: string,
    decision: ComputeApprovalDecision,
    state: 'resolved' | 'rejected' | 'expired' | 'cancelled'
  ): void {
    const entry = this.pending.get(id)
    if (!entry) return
    if (entry.timer !== undefined) this.clearTimer(entry.timer)
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener('abort', entry.abortListener)
    }
    this.pending.delete(id)
    entry.resolve(decision)
    try {
      this.deps.onSettled?.(id, state)
    } catch {
      // Renderer/event projection cannot roll back the broker decision or keep the call parked.
    }
  }
}
