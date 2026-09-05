import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import {
  currentAttempt,
  isDelegatedAttemptSettled,
  sameSession
} from './delegated-work-record-invariants'
import { DelegatedWorkProjectionOwner } from './delegated-work-projection'
import type {
  AuthenticatedDelegateCaller,
  DelegatedWorkDurableRecords,
  DurableChildSummary,
  DurableCollectOptions,
  DurableCollectSelector,
  DurableDelegateObservation,
  DurableSnapshot
} from './durable-delegated-work'

type DurableChild = DurableSnapshot['records'][number]

class DelegatedWorkReadModel {
  constructor(
    private readonly records: DelegatedWorkDurableRecords,
    private readonly projections: DelegatedWorkProjectionOwner,
    private readonly collectPollIntervalMs: number,
    private readonly monotonicNow: () => number = () => performance.now()
  ) {}

  async children(
    caller: AuthenticatedDelegateCaller,
    frameIds?: readonly string[]
  ): Promise<readonly DurableChildSummary[]> {
    const snapshot = await this.authenticatedSnapshot(caller)
    return this.selectAuthorizedChildren(snapshot, caller, frameIds).map((child) => {
      const attempt = currentAttempt(child)
      return {
        frameId: child.frameId,
        attemptId: attempt.id,
        title: child.title,
        name: child.title,
        agentName:
          attempt.resolvedAgent.kind === 'specialist'
            ? attempt.resolvedAgent.displayName
            : 'Main Agent',
        status: this.projections.isAwaitingUser(snapshot, child, attempt)
          ? ('awaiting_user' as const)
          : attempt.status
      }
    })
  }

  async collect(
    caller: AuthenticatedDelegateCaller,
    selectors: readonly DurableCollectSelector[],
    options: DurableCollectOptions = {}
  ): Promise<readonly DurableDelegateObservation[]> {
    if (!Array.isArray(selectors) || selectors.length === 0) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'collect requires at least one child'
      )
    }
    const timeoutSeconds = options.timeoutSeconds ?? 30
    const returnWhen = options.returnWhen ?? 'all'
    if (returnWhen !== 'all' && returnWhen !== 'any') {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'collect returnWhen must be all or any'
      )
    }
    if (
      typeof timeoutSeconds !== 'number' ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds < 0 ||
      timeoutSeconds > 1800
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'collect timeoutSeconds must be a finite number from 0 through 1800'
      )
    }
    const initialSnapshot = await this.authenticatedSnapshot(caller)
    const pinned = this.pinSelectors(initialSnapshot, caller, selectors)
    const startedAt = this.monotonicNow()
    let snapshot = initialSnapshot
    for (;;) {
      const attempts = this.resolvePinned(snapshot, caller, pinned)
      const observations = await Promise.all(
        attempts.map(({ child, attempt }) =>
          this.projections.projectSnapshotObservation(snapshot, child, attempt)
        )
      )
      const settled = observations.map((observation) =>
        observation.status === 'awaiting_user'
          ? false
          : isDelegatedAttemptSettled(observation.status)
      )
      if (returnWhen === 'all' ? settled.every(Boolean) : settled.some(Boolean)) {
        return observations
      }
      if (timeoutSeconds === 0) return observations
      if (this.monotonicNow() - startedAt >= timeoutSeconds * 1000) {
        const decidingSnapshot = await this.authenticatedSnapshot(caller)
        const decidingAttempts = this.resolvePinned(decidingSnapshot, caller, pinned)
        return Promise.all(
          decidingAttempts.map(({ child, attempt }) =>
            this.projections.projectSnapshotObservation(decidingSnapshot, child, attempt)
          )
        )
      }
      const remainingMs = timeoutSeconds * 1000 - (this.monotonicNow() - startedAt)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(this.collectPollIntervalMs, Math.max(0, remainingMs)))
      )
      snapshot = await this.authenticatedSnapshot(caller)
    }
  }

  async findAuthorizedChild(
    caller: AuthenticatedDelegateCaller,
    frameId: string
  ): Promise<DurableChild> {
    const snapshot = await this.authenticatedSnapshot(caller)
    const child = snapshot.records.find((candidate) => candidate.frameId === frameId)
    if (!child || !this.isActiveAuthorizedChild(snapshot, caller, child)) {
      throw new DurableDelegatedWorkError('authorization', 'caller cannot access delegated child')
    }
    return child
  }

  async pinAuthorizedChildren(
    caller: AuthenticatedDelegateCaller,
    frameIds: readonly string[]
  ): Promise<readonly DurableChild[]> {
    if (
      !Array.isArray(frameIds) ||
      frameIds.length === 0 ||
      frameIds.some((frameId) => typeof frameId !== 'string' || !frameId.trim())
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'stop requires at least one child Frame id'
      )
    }
    const snapshot = await this.authenticatedSnapshot(caller)
    return this.selectAuthorizedChildren(snapshot, caller, frameIds)
  }

  private async authenticatedSnapshot(
    caller: AuthenticatedDelegateCaller
  ): Promise<DurableSnapshot> {
    const snapshot = await this.records.snapshot()
    if (
      caller.role !== 'main' ||
      !sameSession(snapshot.session, caller.session) ||
      caller.frameId !== snapshot.rootFrameId ||
      !snapshot.originMessageIds.includes(caller.originMessageId) ||
      !caller.toolInvocationId.trim()
    ) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'delegated children are outside the authenticated parent conversation'
      )
    }
    return snapshot
  }

  private selectAuthorizedChildren(
    snapshot: DurableSnapshot,
    caller: AuthenticatedDelegateCaller,
    frameIds?: readonly string[]
  ): readonly DurableChild[] {
    const directChildren = snapshot.records.filter((child) =>
      this.isActiveAuthorizedChild(snapshot, caller, child)
    )
    if (!frameIds) return directChildren
    const selected = frameIds.map((frameId) =>
      directChildren.find((child) => child.frameId === frameId)
    )
    if (selected.some((child) => !child)) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'one or more requested children are outside the authenticated parent conversation'
      )
    }
    return selected as readonly DurableChild[]
  }

  private isActiveAuthorizedChild(
    snapshot: DurableSnapshot,
    caller: AuthenticatedDelegateCaller,
    child: DurableChild
  ): boolean {
    return (
      child.parentFrameId === caller.frameId &&
      child.originBindingState === 'validated' &&
      !!child.originMessageId &&
      snapshot.originMessageIds.includes(child.originMessageId)
    )
  }

  private pinSelectors(
    snapshot: DurableSnapshot,
    caller: AuthenticatedDelegateCaller,
    selectors: readonly DurableCollectSelector[]
  ): readonly Readonly<{ frameId: string; attemptId: string }>[] {
    return selectors.map((selector) => {
      if (
        typeof selector !== 'string' &&
        (!selector ||
          typeof selector !== 'object' ||
          typeof selector.frameId !== 'string' ||
          typeof selector.attemptId !== 'string')
      ) {
        throw new DurableDelegatedWorkError('admission_rejection', 'collect selector is invalid')
      }
      const frameId = typeof selector === 'string' ? selector : selector.frameId
      const child = snapshot.records.find((candidate) => candidate.frameId === frameId)
      if (!child || !this.isActiveAuthorizedChild(snapshot, caller, child)) {
        throw new DurableDelegatedWorkError(
          'authorization',
          child?.originBindingState === 'legacy-unavailable'
            ? 'delegated child branch ownership is unavailable for legacy data'
            : 'one or more requested children are outside the authenticated parent conversation'
        )
      }
      const attemptId = typeof selector === 'string' ? currentAttempt(child).id : selector.attemptId
      if (!child.attempts.some((attempt) => attempt.id === attemptId)) {
        throw new DurableDelegatedWorkError(
          'authorization',
          'one or more requested Attempts are outside the authenticated delegated child'
        )
      }
      return { frameId, attemptId }
    })
  }

  private resolvePinned(
    snapshot: DurableSnapshot,
    caller: AuthenticatedDelegateCaller,
    pinned: readonly Readonly<{ frameId: string; attemptId: string }>[]
  ): readonly Readonly<{
    child: DurableChild
    attempt: DurableChild['attempts'][number]
  }>[] {
    return pinned.map(({ frameId, attemptId }) => {
      const child = snapshot.records.find((candidate) => candidate.frameId === frameId)
      const attempt = child?.attempts.find((candidate) => candidate.id === attemptId)
      if (!child || !attempt || !this.isActiveAuthorizedChild(snapshot, caller, child)) {
        throw new DurableDelegatedWorkError(
          'authorization',
          'delegated child authorization changed while collecting observations'
        )
      }
      return { child, attempt }
    })
  }
}

export { DelegatedWorkReadModel }
