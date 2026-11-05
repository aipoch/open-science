import { isDesktopRuntimeConnectionError } from '../../../../shared/desktop-runtime-recovery'
import {
  isSessionRevisionConflictError,
  isSessionSizeLimitError,
  type PersistedChatSession,
  type SaveSessionManifestRequest,
  type SaveSessionOptions
} from '../../../../shared/session-persistence'

export type SessionWriteIntent = Readonly<{
  base?: PersistedChatSession
  session: PersistedChatSession
  options?: SaveSessionOptions
}>

type RetainedWrite = {
  target: string
  version: number
  state: 'checking' | 'failed'
  reviewRequired: boolean
  error: unknown
  intent?: SessionWriteIntent
  manifest?: SaveSessionManifestRequest
}

export type SessionWriteIssue = Readonly<{
  target: string
  sessionId?: string
  projectId?: string
  title?: string
  state: 'checking' | 'failed'
  kind: 'connection' | 'size-limit' | 'conflict' | 'storage'
  canDiscard?: boolean
  reviewRequired?: boolean
}>

export class SessionWriteUnconfirmedError extends Error {
  readonly code = 'session-save-unconfirmed'
  constructor() {
    super('Some conversation changes have not been confirmed as saved.')
    this.name = 'SessionWriteUnconfirmedError'
  }
}

/** Retains failed user intent across hydration; no automatic write is performed by reconciliation. */
export class SessionWriteRecovery {
  private readonly writes = new Map<string, RetainedWrite>()
  private readonly attempts = new Map<string, number>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  private snapshot: readonly SessionWriteIssue[] = []

  constructor(
    private readonly policy: {
      satisfied: (intent: SessionWriteIntent, authority: PersistedChatSession) => boolean
      merge: (retained: SessionWriteIntent, next: SessionWriteIntent) => SessionWriteIntent
      ignoreError?: (error: unknown) => boolean
    }
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): readonly SessionWriteIssue[] => this.snapshot

  private publish(): void {
    this.snapshot = [...this.writes.values()].map((write) => ({
      target: write.target,
      ...(write.intent
        ? {
            sessionId: write.intent.session.id,
            projectId: write.intent.session.projectId,
            title: write.intent.session.title
          }
        : {}),
      state: write.state,
      canDiscard: write.state === 'failed' && write.intent !== undefined,
      reviewRequired: write.reviewRequired,
      kind: isSessionSizeLimitError(write.error)
        ? 'size-limit'
        : isSessionRevisionConflictError(write.error)
          ? 'conflict'
          : isDesktopRuntimeConnectionError(write.error)
            ? 'connection'
            : 'storage'
    }))
    for (const listener of this.listeners) listener()
  }

  has(target: string): boolean {
    return this.writes.has(target)
  }

  get(target: string): Readonly<RetainedWrite> | undefined {
    return this.writes.get(target)
  }

  retainChanges(target: string, intent: () => SessionWriteIntent): void {
    const retained = this.writes.get(target)
    if (!retained?.intent) return
    this.writes.set(target, {
      ...retained,
      version: ++this.version,
      intent: structuredClone(this.policy.merge(retained.intent, intent()))
    })
    this.publish()
  }

  retainManifest(manifest: SaveSessionManifestRequest): void {
    const retained = this.writes.get('manifest')
    if (!retained) return
    this.writes.set('manifest', { ...retained, version: ++this.version, manifest: { ...manifest } })
    this.publish()
  }

  fail(
    target: string,
    error: unknown,
    expected: Readonly<RetainedWrite>,
    state?: 'checking' | 'failed'
  ): void {
    if (this.writes.get(target) !== expected) return
    this.writes.set(target, {
      ...expected,
      error: error instanceof SessionWriteUnconfirmedError ? expected.error : error,
      state: state ?? (isDesktopRuntimeConnectionError(error) ? 'checking' : 'failed'),
      reviewRequired: true
    })
    this.publish()
  }

  private begin(
    target: string,
    intent?: () => SessionWriteIntent,
    manifest?: SaveSessionManifestRequest
  ): number {
    const version = ++this.version
    this.attempts.set(target, version)
    const retained = this.writes.get(target)
    if (retained && intent && retained.intent) {
      this.writes.set(target, {
        ...retained,
        intent: this.policy.merge(retained.intent, intent()),
        version
      })
      this.publish()
    } else if (retained && manifest) {
      this.writes.set(target, { ...retained, manifest: { ...manifest }, version })
      this.publish()
    }
    return version
  }

  async trackSession<Result>(
    target: string,
    intent: () => SessionWriteIntent,
    run: () => Promise<Result>
  ): Promise<Result> {
    // Reading identity does not serialize a growing transcript on every streaming tick.
    return this.observe(this.track(target, intent, undefined, run))
  }

  trackManifest(request: SaveSessionManifestRequest, run: () => Promise<void>): Promise<void> {
    return this.observe(this.track('manifest', undefined, request, run))
  }

  private observe<Result>(operation: Promise<Result>): Promise<Result> {
    this.pending.add(operation)
    const settled = (): void => {
      this.pending.delete(operation)
    }
    void operation.then(settled, settled)
    return operation
  }

  async whenIdle(): Promise<void> {
    // Queue completion precedes the outer rejection handler by a few microtasks. A quit/send
    // barrier must also wait until every admitted attempt has published its retained outcome.
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  private async track<Result>(
    target: string,
    intent: (() => SessionWriteIntent) | undefined,
    manifest: SaveSessionManifestRequest | undefined,
    run: () => Promise<Result>
  ): Promise<Result> {
    const version = this.begin(target, intent, manifest)
    try {
      const result = await run()
      if (this.attempts.get(target) === version) {
        const retained = this.writes.get(target)
        if (
          !retained ||
          (retained.intent &&
            this.policy.satisfied(retained.intent, result as PersistedChatSession)) ||
          (manifest && retained.manifest?.lastSessionId === manifest.lastSessionId)
        )
          this.clear(target)
      }
      return result
    } catch (error) {
      if (this.attempts.get(target) === version && !this.policy.ignoreError?.(error)) {
        const previous = this.writes.get(target)
        let nextIntent: SessionWriteIntent | undefined
        try {
          nextIntent = intent ? structuredClone(intent()) : undefined
        } catch {
          // Serialization itself may be the failure. Preserve the original error and quit gate.
        }
        this.writes.set(target, {
          target,
          version: Math.max(version, previous?.version ?? 0),
          error,
          state: isDesktopRuntimeConnectionError(error) ? 'checking' : 'failed',
          reviewRequired:
            previous?.reviewRequired === true ||
            isDesktopRuntimeConnectionError(error) ||
            isSessionRevisionConflictError(error),
          intent:
            previous && previous.version > version
              ? previous.intent
              : previous?.intent && nextIntent
                ? this.policy.merge(previous.intent, nextIntent)
                : nextIntent,
          manifest:
            previous && previous.version > version
              ? previous.manifest
              : manifest
                ? { ...manifest }
                : undefined
        })
        this.publish()
      }
      throw error
    } finally {
      if (this.attempts.get(target) === version) this.attempts.delete(target)
    }
  }

  async reconcile(
    load: (intent: SessionWriteIntent) => Promise<PersistedChatSession | undefined>,
    manifest: SaveSessionManifestRequest,
    isCurrent: () => boolean
  ): Promise<void> {
    await Promise.all(
      [...this.writes.values()].map(async (write) => {
        try {
          const authority = write.intent ? await load(write.intent) : undefined
          if (!isCurrent() || this.writes.get(write.target) !== write) return
          if (
            (write.intent && authority && this.policy.satisfied(write.intent, authority)) ||
            (write.manifest && write.manifest.lastSessionId === manifest.lastSessionId)
          ) {
            this.clear(write.target)
            return
          }
        } catch {
          if (!isCurrent() || this.writes.get(write.target) !== write) return
        }
        if (!isCurrent() || this.writes.get(write.target) !== write) return
        // A successful reconnect proves transport availability, never that a user edit was saved.
        this.writes.set(write.target, { ...write, state: 'failed', reviewRequired: true })
        this.publish()
      })
    )
  }

  clear(target: string, expected?: Readonly<RetainedWrite>): void {
    if (expected && this.writes.get(target) !== expected) return
    if (this.writes.delete(target)) this.publish()
  }

  /** An authoritative deletion or an explicit discard cancels late receipts as well. */
  forget(target: string): void {
    this.attempts.delete(target)
    this.clear(target)
  }

  reset(): void {
    this.writes.clear()
    this.attempts.clear()
    this.pending.clear()
    this.publish()
  }

  assertSettled(target?: string): void {
    if (target ? this.writes.has(target) : this.writes.size > 0)
      throw new SessionWriteUnconfirmedError()
  }
}
