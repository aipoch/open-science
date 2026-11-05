import { isDesktopRuntimeConnectionError } from '../../../../shared/desktop-runtime-recovery'
import type { RendererSessionWriteRecoveryDiagnostics } from '../../../../shared/diagnostics'
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
  retainedAt: number
  state: 'checking' | 'failed'
  reviewRequired: boolean
  error: unknown
  intent?: SessionWriteIntent
  manifest?: SaveSessionManifestRequest
}

export type RetainedSessionWrite = Readonly<RetainedWrite>

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
      report?: (
        write: RetainedSessionWrite,
        diagnostics: RendererSessionWriteRecoveryDiagnostics
      ) => void
    }
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): readonly SessionWriteIssue[] => this.snapshot

  private report(
    write: RetainedSessionWrite,
    event: RendererSessionWriteRecoveryDiagnostics['event'],
    details: Partial<RendererSessionWriteRecoveryDiagnostics> = {}
  ): void {
    try {
      this.policy.report?.(write, {
        event,
        state: write.state,
        attempt: write.version,
        elapsedMs: Math.max(0, Math.round(performance.now() - write.retainedAt)),
        ...details
      })
    } catch {
      // A diagnostics failure must never change retained intent or a save/quit barrier.
    }
  }

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
    this.retain(target, ++this.version, intent)
  }

  retainManifest(manifest: SaveSessionManifestRequest): void {
    this.retain('manifest', ++this.version, undefined, manifest)
  }

  private retain(
    target: string,
    version: number,
    intent?: () => SessionWriteIntent,
    manifest?: SaveSessionManifestRequest
  ): void {
    const retained = this.writes.get(target)
    if (retained?.intent && intent) {
      this.writes.set(target, {
        ...retained,
        version,
        intent: structuredClone(this.policy.merge(retained.intent, intent()))
      })
    } else if (retained?.manifest && manifest) {
      this.writes.set(target, { ...retained, version, manifest: { ...manifest } })
    } else {
      return
    }
    this.publish()
  }

  fail(
    target: string,
    error: unknown,
    expected: Readonly<RetainedWrite>,
    state?: 'checking' | 'failed'
  ): void {
    if (this.writes.get(target) !== expected) return
    const next: RetainedWrite = {
      ...expected,
      error: error instanceof SessionWriteUnconfirmedError ? expected.error : error,
      state: state ?? (isDesktopRuntimeConnectionError(error) ? 'checking' : 'failed'),
      reviewRequired: true
    }
    this.writes.set(target, next)
    this.report(next, 'retained')
    this.publish()
  }

  private begin(
    target: string,
    intent?: () => SessionWriteIntent,
    manifest?: SaveSessionManifestRequest
  ): number {
    const version = ++this.version
    this.attempts.set(target, version)
    this.retain(target, version, intent, manifest)
    return version
  }

  trackSession(
    target: string,
    intent: () => SessionWriteIntent,
    run: () => Promise<PersistedChatSession>
  ): Promise<PersistedChatSession> {
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

  private track(
    target: string,
    intent: () => SessionWriteIntent,
    manifest: undefined,
    run: () => Promise<PersistedChatSession>
  ): Promise<PersistedChatSession>
  private track(
    target: string,
    intent: undefined,
    manifest: SaveSessionManifestRequest,
    run: () => Promise<void>
  ): Promise<void>
  private async track(
    target: string,
    intent: (() => SessionWriteIntent) | undefined,
    manifest: SaveSessionManifestRequest | undefined,
    run: () => Promise<PersistedChatSession | void>
  ): Promise<PersistedChatSession | void> {
    const version = this.begin(target, intent, manifest)
    try {
      const result = await run()
      if (this.attempts.get(target) === version) {
        const retained = this.writes.get(target)
        if (
          !retained ||
          (retained.intent && result && this.policy.satisfied(retained.intent, result)) ||
          (manifest && retained.manifest?.lastSessionId === manifest.lastSessionId)
        )
          this.clear(target, retained, {
            reason: 'save-acknowledged',
            ...(result?.revision !== undefined ? { actualRevision: result.revision } : {})
          })
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
        const retained: RetainedWrite = {
          target,
          version: Math.max(version, previous?.version ?? 0),
          retainedAt: previous?.retainedAt ?? performance.now(),
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
        }
        this.writes.set(target, retained)
        this.report(retained, 'retained')
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
        this.report(write, 'reconcile-started')
        let reason: RendererSessionWriteRecoveryDiagnostics['reason']
        let actualRevision: number | undefined
        let readError: unknown
        const stale = (): boolean => {
          const reason = !isCurrent()
            ? 'runtime-changed'
            : this.writes.get(write.target) !== write
              ? 'write-replaced'
              : undefined
          if (!reason) return false
          this.report(write, 'reconcile-stale', { reason })
          return true
        }
        try {
          const authority = write.intent ? await load(write.intent) : undefined
          if (stale()) return
          actualRevision = authority?.revision
          if (
            (write.intent && authority && this.policy.satisfied(write.intent, authority)) ||
            (write.manifest && write.manifest.lastSessionId === manifest.lastSessionId)
          ) {
            this.clear(write.target, write, {
              reason: 'authority-confirmed',
              ...(actualRevision !== undefined ? { actualRevision } : {})
            })
            return
          }
          reason = write.manifest
            ? 'manifest-mismatch'
            : !authority
              ? 'session-missing'
              : 'intent-mismatch'
        } catch (error) {
          if (stale()) return
          readError = error
          reason = 'read-failed'
        }
        if (stale()) return
        // A successful reconnect proves transport availability, never that a user edit was saved.
        const failed: RetainedWrite = { ...write, state: 'failed', reviewRequired: true }
        this.writes.set(write.target, failed)
        this.report(
          reason === 'read-failed' ? { ...failed, error: readError } : failed,
          'reconcile-unconfirmed',
          {
            reason,
            ...(actualRevision !== undefined ? { actualRevision } : {})
          }
        )
        this.publish()
      })
    )
  }

  clear(
    target: string,
    expected?: Readonly<RetainedWrite>,
    details: Pick<RendererSessionWriteRecoveryDiagnostics, 'reason' | 'actualRevision'> = {
      reason: 'save-acknowledged'
    }
  ): void {
    if (expected && this.writes.get(target) !== expected) return
    const write = this.writes.get(target)
    if (write && this.writes.delete(target)) {
      this.report(write, 'resolved', details)
      this.publish()
    }
  }

  /** An authoritative deletion or an explicit discard cancels late receipts as well. */
  forget(
    target: string,
    reason: 'authoritative-deletion' | 'explicit-discard' = 'authoritative-deletion'
  ): void {
    this.attempts.delete(target)
    const write = this.writes.get(target)
    if (write && this.writes.delete(target)) {
      this.report(write, 'forgotten', { reason })
      this.publish()
    }
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
