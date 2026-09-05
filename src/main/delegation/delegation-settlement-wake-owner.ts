import { randomUUID } from 'node:crypto'
import {
  isDelegatedAttemptSettled,
  type DurableSettledAttemptStatus
} from './delegated-work-record-invariants'

type SettledStatus = DurableSettledAttemptStatus

const MAX_RETRY_DELAY_MS = 5_000

type DelegationSettlementAttempt = Readonly<{
  frameId: string
  attemptId: string
  parentFrameId: string
  originatingPromptId: string
  name: string
  status: 'running' | SettledStatus
}>

type DelegationSettlementSnapshot = Readonly<{
  projectId: string
  sessionId: string
  rootFrameId: string
  rootBranchId?: string
  activeRootPromptIds: readonly string[]
  rootPromptRuntimeSegments: Readonly<Record<string, string>>
  attempts: readonly DelegationSettlementAttempt[]
}>

type DelegationSettlementDispatch = Readonly<{
  projectId: string
  sessionId: string
  originatingPromptId: string
  rootFrameId: string
  rootBranchId?: string
  runtimeSegmentId: string
  promptId: string
  text: string
}>

type DelegationSettlementWakeOwnerOptions = Readonly<{
  readSnapshot(sessionId: string): Promise<DelegationSettlementSnapshot | undefined>
  dispatch(request: DelegationSettlementDispatch): Promise<void> | void
  createPromptId?: () => string
  debounceMs?: number
}>

type WatchedAttempt = Readonly<{
  frameId: string
  attemptId: string
  name: string
}>

type SettlementItem = WatchedAttempt & Readonly<{ status: SettledStatus }>

type Watch = {
  projectId: string
  originatingPromptId: string
  rootFrameId: string
  rootBranchId?: string
  runtimeSegmentId: string
  remaining: Map<string, WatchedAttempt>
  pending: Map<string, SettlementItem>
}

type SessionWakeState = {
  tail: Promise<void>
  watches: Map<string, Watch>
  turnLeases: Map<
    string,
    {
      originatingPromptId: string
      baselineAttemptKeys: ReadonlySet<string>
      unobserved: Map<string, WatchedAttempt>
    }
  >
  flight?: Readonly<{
    promptId: string
    originatingPromptId: string
    items: readonly SettlementItem[]
  }>
  timer?: ReturnType<typeof setTimeout>
  retryDelayMs?: number
}

const handleKey = (frameId: string, attemptId: string): string => `${frameId}\u0000${attemptId}`

const stableItems = (items: Iterable<SettlementItem>): SettlementItem[] =>
  [...items].sort(
    (left, right) =>
      left.frameId.localeCompare(right.frameId) || left.attemptId.localeCompare(right.attemptId)
  )

const settlementText = (items: readonly SettlementItem[], remaining: number): string => {
  const lines = items.map(
    ({ name, frameId, attemptId, status }) =>
      `- ${name}: frame=${frameId}; attempt=${attemptId}; status=${status}`
  )
  const summary =
    remaining === 0
      ? 'All watched Subagent Attempts have settled.'
      : `${remaining} watched Subagent Attempt${remaining === 1 ? ' remains' : 's remain'} running.`
  return [
    'Delegated work settlement update (application-owned context, not a user message).',
    'The following Subagent Attempts newly settled; settled does not imply success:',
    ...lines,
    summary,
    'Use the exact Frame/Attempt identities if you choose to collect results. Decide whether to inspect evidence, handle failures, continue waiting, or update the user.'
  ].join('\n')
}

class DelegationSettlementWakeOwner {
  private readonly sessions = new Map<string, SessionWakeState>()
  private readonly debounceMs: number
  private readonly createPromptId: () => string
  private stopped = false

  constructor(private readonly options: DelegationSettlementWakeOwnerOptions) {
    this.debounceMs = options.debounceMs ?? 100
    this.createPromptId = options.createPromptId ?? (() => `delegation-settlement-${randomUUID()}`)
  }

  async onRootTurnStarted(
    input: Readonly<{ sessionId: string; originatingPromptId: string }>
  ): Promise<string | undefined> {
    if (this.stopped) return undefined
    const state = this.sessions.get(input.sessionId) ?? {
      tail: Promise.resolve(),
      watches: new Map(),
      turnLeases: new Map()
    }
    if (!this.sessions.has(input.sessionId)) this.sessions.set(input.sessionId, state)
    const leaseId = randomUUID()
    state.turnLeases.set(leaseId, {
      originatingPromptId: input.originatingPromptId,
      baselineAttemptKeys: new Set(),
      unobserved: new Map()
    })
    let snapshot: DelegationSettlementSnapshot | undefined
    try {
      snapshot = await this.options.readSnapshot(input.sessionId)
    } catch (error) {
      state.turnLeases.delete(leaseId)
      this.deleteIfIdle(input.sessionId, state)
      throw error
    }
    if (
      this.stopped ||
      this.sessions.get(input.sessionId) !== state ||
      !state.turnLeases.has(leaseId)
    ) {
      return undefined
    }
    state.turnLeases.set(leaseId, {
      originatingPromptId: input.originatingPromptId,
      baselineAttemptKeys: new Set(
        snapshot?.attempts.map((attempt) => handleKey(attempt.frameId, attempt.attemptId)) ?? []
      ),
      unobserved: state.turnLeases.get(leaseId)?.unobserved ?? new Map()
    })
    return leaseId
  }

  trackUnobservedAttempts(
    input: Readonly<{
      sessionId: string
      originatingPromptId: string
      attempts: readonly WatchedAttempt[]
    }>
  ): void {
    const state = this.sessions.get(input.sessionId)
    if (!state) return
    for (const lease of state.turnLeases.values()) {
      if (lease.originatingPromptId !== input.originatingPromptId) continue
      for (const attempt of input.attempts) {
        lease.unobserved.set(handleKey(attempt.frameId, attempt.attemptId), attempt)
      }
    }
  }

  markAttemptsObserved(
    input: Readonly<{
      sessionId: string
      originatingPromptId: string
      attempts: readonly Readonly<{ frameId: string; attemptId: string }>[]
    }>
  ): void {
    const state = this.sessions.get(input.sessionId)
    if (!state) return
    for (const lease of state.turnLeases.values()) {
      if (lease.originatingPromptId !== input.originatingPromptId) continue
      for (const attempt of input.attempts) {
        lease.unobserved.delete(handleKey(attempt.frameId, attempt.attemptId))
      }
    }
  }

  onRootTurnEnded(
    input: Readonly<{
      sessionId: string
      originatingPromptId: string
      clean: boolean
      leaseId?: string
    }>
  ): Promise<void> {
    const state = this.sessions.get(input.sessionId)
    if (!state || !input.leaseId) return Promise.resolve()
    return this.enqueueExisting(input.sessionId, state, async () => {
      const lease = state.turnLeases.get(input.leaseId!)
      if (lease?.originatingPromptId !== input.originatingPromptId) return
      state.turnLeases.delete(input.leaseId!)
      if (!input.clean) {
        this.deleteIfIdle(input.sessionId, state)
        return
      }
      const snapshot = await this.options.readSnapshot(input.sessionId)
      if (!snapshot || !snapshot.activeRootPromptIds.includes(input.originatingPromptId)) {
        this.deleteIfIdle(input.sessionId, state)
        return
      }
      const runtimeSegmentId = snapshot.rootPromptRuntimeSegments[input.originatingPromptId]
      if (!runtimeSegmentId) {
        this.deleteIfIdle(input.sessionId, state)
        return
      }
      const remaining = new Map<string, WatchedAttempt>()
      const pending = new Map<string, SettlementItem>()
      for (const attempt of snapshot.attempts) {
        const key = handleKey(attempt.frameId, attempt.attemptId)
        if (
          attempt.parentFrameId !== snapshot.rootFrameId ||
          attempt.originatingPromptId !== input.originatingPromptId ||
          (lease.baselineAttemptKeys.has(key) && !lease.unobserved.has(key))
        ) {
          continue
        }
        const watched = lease.unobserved.get(key) ?? {
          frameId: attempt.frameId,
          attemptId: attempt.attemptId,
          name: attempt.name
        }
        if (isDelegatedAttemptSettled(attempt.status)) {
          if (lease.unobserved.has(key)) pending.set(key, { ...watched, status: attempt.status })
        } else {
          remaining.set(key, watched)
        }
      }
      if (remaining.size === 0 && pending.size === 0) {
        this.deleteIfIdle(input.sessionId, state)
        return
      }
      const existing = state.watches.get(input.originatingPromptId)
      if (
        existing &&
        existing.projectId === snapshot.projectId &&
        existing.rootFrameId === snapshot.rootFrameId &&
        existing.runtimeSegmentId === runtimeSegmentId
      ) {
        existing.rootBranchId = snapshot.rootBranchId
        for (const [key, watched] of remaining) {
          if (!existing.pending.has(key)) existing.remaining.set(key, watched)
        }
        for (const [key, settled] of pending) {
          existing.remaining.delete(key)
          existing.pending.set(key, settled)
        }
      } else {
        state.watches.set(input.originatingPromptId, {
          projectId: snapshot.projectId,
          originatingPromptId: input.originatingPromptId,
          rootFrameId: snapshot.rootFrameId,
          ...(snapshot.rootBranchId ? { rootBranchId: snapshot.rootBranchId } : {}),
          runtimeSegmentId,
          remaining,
          pending
        })
      }
      await this.reconcile(input.sessionId, state)
    })
  }

  onRecordsChanged(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return Promise.resolve()
    return this.enqueueExisting(sessionId, state, () => this.reconcile(sessionId, state))
  }

  onWakePromptEnded(sessionId: string, promptId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return Promise.resolve()
    return this.enqueueExisting(sessionId, state, async () => {
      if (state.flight?.promptId !== promptId) return
      state.flight = undefined
      state.retryDelayMs = undefined
      this.cleanupWatches(state)
      if (this.hasPending(state)) this.schedule(sessionId, state)
      else this.deleteIfIdle(sessionId, state)
    })
  }

  invalidateSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state?.timer) clearTimeout(state.timer)
    this.sessions.delete(sessionId)
  }

  async invalidateProject(projectId: string): Promise<void> {
    const invalidations: Promise<void>[] = []
    for (const [sessionId, state] of this.sessions) {
      invalidations.push(
        this.enqueueExisting(sessionId, state, async () => {
          const snapshot = await this.options.readSnapshot(sessionId)
          if (this.sessions.get(sessionId) !== state) return
          if (snapshot?.projectId === projectId) {
            if (state.timer) clearTimeout(state.timer)
            state.watches.clear()
            state.turnLeases.clear()
            state.flight = undefined
            state.timer = undefined
            this.sessions.delete(sessionId)
            return
          }
          const invalidatedOrigins = new Set<string>()
          for (const [originatingPromptId, watch] of state.watches) {
            if (watch.projectId !== projectId) continue
            invalidatedOrigins.add(originatingPromptId)
            state.watches.delete(originatingPromptId)
          }
          if (state.flight && invalidatedOrigins.has(state.flight.originatingPromptId)) {
            state.flight = undefined
          }
          this.finishInvalidation(sessionId, state)
        })
      )
    }
    await Promise.all(invalidations)
  }

  invalidateBranch(sessionId: string, originatingPromptId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return Promise.resolve()
    return this.enqueueExisting(sessionId, state, async () => {
      state.watches.delete(originatingPromptId)
      for (const [leaseId, lease] of state.turnLeases) {
        if (lease.originatingPromptId === originatingPromptId) state.turnLeases.delete(leaseId)
      }
      this.finishInvalidation(sessionId, state)
    })
  }

  invalidateAll(): void {
    for (const state of this.sessions.values()) if (state.timer) clearTimeout(state.timer)
    this.sessions.clear()
  }

  shutdown(): void {
    this.stopped = true
    this.invalidateAll()
  }

  private enqueueExisting(
    sessionId: string,
    state: SessionWakeState,
    operation: () => Promise<void>
  ): Promise<void> {
    const result = state.tail.then(async () => {
      if (this.sessions.get(sessionId) !== state) return
      await operation()
    })
    state.tail = result.catch(() => undefined)
    return result
  }

  private async reconcile(
    sessionId: string,
    state: SessionWakeState,
    schedulePending = true
  ): Promise<void> {
    const snapshot = await this.options.readSnapshot(sessionId)
    if (this.sessions.get(sessionId) !== state) return
    if (!snapshot) {
      this.invalidateSession(sessionId)
      return
    }
    const active = new Set(snapshot.activeRootPromptIds)
    const attempts = new Map(
      snapshot.attempts.map((attempt) => [handleKey(attempt.frameId, attempt.attemptId), attempt])
    )
    for (const [originatingPromptId, watch] of state.watches) {
      if (!active.has(originatingPromptId) || watch.projectId !== snapshot.projectId) {
        state.watches.delete(originatingPromptId)
        continue
      }
      for (const [key, watched] of watch.remaining) {
        const attempt = attempts.get(key)
        if (!attempt) {
          watch.remaining.delete(key)
          continue
        }
        if (isDelegatedAttemptSettled(attempt.status)) {
          watch.remaining.delete(key)
          watch.pending.set(key, { ...watched, status: attempt.status })
        }
      }
    }
    this.cleanupWatches(state)
    if (schedulePending && !state.flight && this.hasPending(state)) this.schedule(sessionId, state)
    else this.deleteIfIdle(sessionId, state)
  }

  private schedule(sessionId: string, state: SessionWakeState): void {
    if (state.timer || state.flight) return
    const delayMs = state.retryDelayMs ?? this.debounceMs
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.enqueueExisting(sessionId, state, async () => {
        await this.reconcile(sessionId, state, false)
        if (this.sessions.get(sessionId) !== state || state.flight) return
        const selected = [...state.watches.values()].find((watch) => watch.pending.size > 0)
        if (!selected) return
        const items = stableItems(selected.pending.values())
        selected.pending.clear()
        const promptId = this.createPromptId()
        state.flight = {
          promptId,
          originatingPromptId: selected.originatingPromptId,
          items
        }
        const request: DelegationSettlementDispatch = {
          projectId: selected.projectId,
          sessionId,
          originatingPromptId: selected.originatingPromptId,
          rootFrameId: selected.rootFrameId,
          ...(selected.rootBranchId ? { rootBranchId: selected.rootBranchId } : {}),
          runtimeSegmentId: selected.runtimeSegmentId,
          promptId,
          text: settlementText(items, selected.remaining.size)
        }
        try {
          const dispatched = this.options.dispatch(request)
          void Promise.resolve(dispatched).catch(() => {
            void this.onDispatchFailed(sessionId, promptId)
          })
        } catch {
          this.clearFailedFlight(sessionId, state, promptId)
        }
      })
    }, delayMs)
  }

  private onDispatchFailed(sessionId: string, promptId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return Promise.resolve()
    return this.enqueueExisting(sessionId, state, async () => {
      this.clearFailedFlight(sessionId, state, promptId)
    })
  }

  private clearFailedFlight(sessionId: string, state: SessionWakeState, promptId: string): void {
    const flight = state.flight
    if (flight?.promptId !== promptId) return
    const watch = state.watches.get(flight.originatingPromptId)
    if (watch) {
      for (const item of flight.items) {
        watch.pending.set(handleKey(item.frameId, item.attemptId), item)
      }
    }
    state.flight = undefined
    state.retryDelayMs = Math.min(
      state.retryDelayMs === undefined ? Math.max(this.debounceMs, 1) : state.retryDelayMs * 2,
      MAX_RETRY_DELAY_MS
    )
    this.cleanupWatches(state)
    if (this.hasPending(state)) this.schedule(sessionId, state)
    else this.deleteIfIdle(sessionId, state)
  }

  private cleanupWatches(state: SessionWakeState): void {
    for (const [origin, watch] of state.watches) {
      const ownsFlight = state.flight?.originatingPromptId === origin
      if (watch.remaining.size === 0 && watch.pending.size === 0 && !ownsFlight) {
        state.watches.delete(origin)
      }
    }
  }

  private hasPending(state: SessionWakeState): boolean {
    return [...state.watches.values()].some((watch) => watch.pending.size > 0)
  }

  private finishInvalidation(sessionId: string, state: SessionWakeState): void {
    if (state.timer && !this.hasPending(state)) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    if (!state.flight && this.hasPending(state)) this.schedule(sessionId, state)
    else this.deleteIfIdle(sessionId, state)
  }

  private deleteIfIdle(sessionId: string, state: SessionWakeState): void {
    if (this.sessions.get(sessionId) !== state) return
    if (!state.flight && !state.timer && state.watches.size === 0 && state.turnLeases.size === 0) {
      this.sessions.delete(sessionId)
    }
  }
}

export { DelegationSettlementWakeOwner }
export type {
  DelegationSettlementAttempt,
  DelegationSettlementDispatch,
  DelegationSettlementSnapshot,
  DelegationSettlementWakeOwnerOptions
}
