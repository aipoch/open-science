import { randomUUID } from 'node:crypto'

import type { AcpPromptRequest, AcpTurnTokenUsage } from '../../shared/acp'

const cloneProvenanceContext = (
  provenanceContext: AcpPromptRequest['provenanceContext']
): AcpPromptRequest['provenanceContext'] => {
  if (!provenanceContext) return undefined
  const clone: NonNullable<AcpPromptRequest['provenanceContext']> = {
    ...provenanceContext,
    ...(provenanceContext.messageBranchAncestry
      ? { messageBranchAncestry: [...provenanceContext.messageBranchAncestry] }
      : {}),
    ...(provenanceContext.messageAncestry
      ? { messageAncestry: [...provenanceContext.messageAncestry] }
      : {})
  }
  if (clone.messageBranchAncestry) Object.freeze(clone.messageBranchAncestry)
  if (clone.messageAncestry) Object.freeze(clone.messageAncestry)
  return Object.freeze(clone)
}

export type AcpSessionInteractionKind = 'prompt' | 'compaction'

export interface AcpPromptSessionInteractionRequest {
  readonly sessionId: string
  readonly kind: 'prompt'
  readonly promptMessageId?: string
  readonly provenanceContext?: AcpPromptRequest['provenanceContext']
  readonly memoryEnabled?: boolean
  readonly turnToken?: string
  readonly referencedSessionIds?: readonly string[]
}

export interface AcpCompactionSessionInteractionRequest {
  readonly sessionId: string
  readonly kind: 'compaction'
}

export type AcpSessionInteractionRequest =
  AcpPromptSessionInteractionRequest | AcpCompactionSessionInteractionRequest

interface AcpSessionInteractionScopeBase {
  readonly sessionId: string
  readonly sequence: number
  readonly signal: AbortSignal
}

export interface AcpPromptSessionInteractionScope extends AcpSessionInteractionScopeBase {
  readonly kind: 'prompt'
  readonly promptMessageId?: string
  readonly provenanceContext?: AcpPromptRequest['provenanceContext']
  readonly memoryEnabled?: boolean
  readonly turnToken: string
}

export interface AcpCompactionSessionInteractionScope extends AcpSessionInteractionScopeBase {
  readonly kind: 'compaction'
}

export type AcpSessionInteractionScope =
  AcpPromptSessionInteractionScope | AcpCompactionSessionInteractionScope

type ScopeFor<Request extends AcpSessionInteractionRequest> = Request extends {
  readonly kind: 'prompt'
}
  ? AcpPromptSessionInteractionScope
  : AcpCompactionSessionInteractionScope

export interface AcpSessionInteractionSnapshotEntry {
  readonly sessionId: string
  readonly kind: AcpSessionInteractionKind
}

export interface AcpSessionInteractionCancellationRequest {
  readonly sessionId: string
  readonly notify: () => Promise<void>
  readonly onAccepted: () => void
  readonly onTimeout: () => void
}

export interface AcpSessionInteractionOwnerOptions {
  readonly cancelTimeoutMs?: number
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  readonly now?: () => number
}

type AcpSessionInteractionTerminalKind = 'stop' | 'cancelled' | 'error'

interface AcpSessionInteractionTerminalInput {
  readonly turnUsage?: AcpTurnTokenUsage
  readonly modelTurnCount?: number
}

interface AcpSessionInteractionTerminalFacts {
  readonly timestamp: number
  readonly turnUsage?: Readonly<AcpTurnTokenUsage>
}

interface ActiveSessionInteraction {
  readonly scope: AcpSessionInteractionScope
  readonly abortController: AbortController
  readonly promptProvenance?: {
    value: AcpPromptRequest['provenanceContext']
  }
  cancelled: boolean
  modelTurnCount: number
  readonly referencedSessionIds: Set<string>
}

interface TerminalSettlement {
  readonly kind: AcpSessionInteractionTerminalKind
  readonly timestamp: number
  readonly modelTurnCount: number
  settled: boolean
}

interface CancellationAttempt {
  readonly promise: Promise<void>
  readonly settle: () => void
}

interface CancellationTimer {
  readonly scope: AcpSessionInteractionScope | undefined
  handle?: ReturnType<typeof setTimeout>
}

export class AcpSessionInteractionOwner {
  private readonly activeInteractions = new Map<string, ActiveSessionInteraction>()
  private readonly pendingPromptReservations = new Map<string, ActiveSessionInteraction>()
  private readonly pendingCancellations = new Map<string, CancellationAttempt>()
  private readonly cancellationTimers = new Map<string, CancellationTimer>()
  private readonly terminalSettlements = new WeakMap<
    AcpPromptSessionInteractionScope,
    TerminalSettlement
  >()
  private readonly cancelTimeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly now: () => number
  private sequence = 0

  constructor(options: AcpSessionInteractionOwnerOptions = {}) {
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? 5_000
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
    this.now = options.now ?? Date.now
  }

  current(sessionId: string): AcpSessionInteractionScope | undefined {
    return this.activeInteractions.get(sessionId)?.scope
  }

  has(sessionId: string): boolean {
    return this.activeInteractions.has(sessionId) || this.pendingPromptReservations.has(sessionId)
  }

  isSessionReferenceAllowed(sessionId: string, referencedSessionId: string): boolean {
    const interaction = this.activeInteractions.get(sessionId)
    return (
      interaction?.scope.kind === 'prompt' &&
      interaction.referencedSessionIds.has(referencedSessionId)
    )
  }

  authorizeSessionReferences(sessionId: string, referencedSessionIds: readonly string[]): void {
    const interaction =
      this.activeInteractions.get(sessionId) ?? this.pendingPromptReservations.get(sessionId)
    if (interaction?.scope.kind !== 'prompt') return
    for (const referencedSessionId of referencedSessionIds) {
      if (referencedSessionId) interaction.referencedSessionIds.add(referencedSessionId)
    }
  }

  snapshot(): readonly AcpSessionInteractionSnapshotEntry[] {
    return Object.freeze(
      Array.from(this.activeInteractions.values(), ({ scope }) =>
        Object.freeze({
          sessionId: scope.sessionId,
          kind: scope.kind
        })
      )
    )
  }

  observeModelTurns(scope: AcpPromptSessionInteractionScope, delta: number): void {
    if (!Number.isSafeInteger(delta) || delta <= 0) return
    const active = this.activeInteractions.get(scope.sessionId)
    if (active?.scope !== scope) return
    const count = active.modelTurnCount + delta
    if (Number.isSafeInteger(count)) active.modelTurnCount = count
  }

  // Freezes the provider-terminal observation time before provider-specific usage collection or
  // artifact publication can add latency. Repeated capture is allowed until one outcome settles.
  captureTerminal(
    scope: AcpPromptSessionInteractionScope,
    kind: AcpSessionInteractionTerminalKind
  ): boolean {
    const terminal = this.terminalSettlements.get(scope)
    if (terminal) return terminal.kind === kind && !terminal.settled

    const active = this.activeInteractions.get(scope.sessionId)
    if (active?.scope !== scope) return false
    this.terminalSettlements.set(scope, {
      kind,
      timestamp: this.now(),
      modelTurnCount: active.modelTurnCount,
      settled: false
    })
    return true
  }

  settle(
    scope: AcpPromptSessionInteractionScope,
    input: AcpSessionInteractionTerminalInput
  ): AcpSessionInteractionTerminalFacts | undefined {
    const terminal = this.terminalSettlements.get(scope)
    if (!terminal || terminal.settled) return undefined
    terminal.settled = true

    const requestedModelTurnCount = input.modelTurnCount ?? terminal.modelTurnCount
    const modelTurnCount =
      Number.isSafeInteger(requestedModelTurnCount) && requestedModelTurnCount > 0
        ? requestedModelTurnCount
        : undefined
    const turnUsage = input.turnUsage
      ? Object.freeze({
          ...input.turnUsage,
          ...(modelTurnCount === undefined ? {} : { turnCount: modelTurnCount })
        })
      : undefined
    return Object.freeze({
      timestamp: terminal.timestamp,
      ...(turnUsage ? { turnUsage } : {})
    })
  }

  // Unexpected protocol closure has no provider response to route through sendPrompt. Settle every
  // visible prompt here so teardown can publish one owner-timestamped failure per App Session.
  settleActivePrompts(): ReadonlyArray<{
    readonly scope: AcpPromptSessionInteractionScope
    readonly terminal: AcpSessionInteractionTerminalFacts
  }> {
    const settled: Array<{
      scope: AcpPromptSessionInteractionScope
      terminal: AcpSessionInteractionTerminalFacts
    }> = []
    for (const active of this.activeInteractions.values()) {
      if (active.scope.kind !== 'prompt') continue
      // A provider stop/cancellation already observed by sendPrompt owns the outcome even if
      // connection teardown releases its public activity lock before usage finalization completes.
      if (this.terminalSettlements.has(active.scope)) continue
      if (!this.captureTerminal(active.scope, 'error')) continue
      const terminal = this.settle(active.scope, {})
      if (terminal) settled.push({ scope: active.scope, terminal })
    }
    return settled
  }

  isCancellationAccepted(scope: AcpSessionInteractionScope): boolean {
    const active = this.activeInteractions.get(scope.sessionId)
    return active?.scope === scope && active.cancelled
  }

  async cancellationCheckpoint(scope: AcpSessionInteractionScope): Promise<'active' | 'cancelled'> {
    for (;;) {
      const attempt = this.pendingCancellations.get(scope.sessionId)
      if (!attempt) return this.isCancellationAccepted(scope) ? 'cancelled' : 'active'
      await attempt.promise
    }
  }

  async cancelPrompt(request: AcpSessionInteractionCancellationRequest): Promise<void> {
    let settle!: () => void
    const attempt: CancellationAttempt = {
      promise: new Promise<void>((resolve) => {
        settle = resolve
      }),
      settle: () => settle()
    }
    this.pendingCancellations.set(request.sessionId, attempt)

    const active =
      this.pendingPromptReservations.get(request.sessionId) ??
      this.activeInteractions.get(request.sessionId)
    const scope = active?.scope
    active?.abortController.abort()
    this.clearCancellationTimer(request.sessionId)

    const timer: CancellationTimer = { scope }
    timer.handle = this.setTimer(() => {
      if (this.cancellationTimers.get(request.sessionId) !== timer) return
      this.cancellationTimers.delete(request.sessionId)
      if (scope && this.current(request.sessionId) === scope) request.onTimeout()
    }, this.cancelTimeoutMs)
    this.cancellationTimers.set(request.sessionId, timer)

    let accepted = false
    try {
      await request.notify()
      if (
        active &&
        (this.activeInteractions.get(request.sessionId) === active ||
          this.pendingPromptReservations.get(request.sessionId) === active)
      ) {
        active.cancelled = true
      }
      accepted = true
    } catch (error) {
      this.clearCancellationTimer(request.sessionId, timer)
      throw error
    } finally {
      attempt.settle()
      if (this.pendingCancellations.get(request.sessionId) === attempt) {
        this.pendingCancellations.delete(request.sessionId)
      }
    }

    if (accepted) request.onAccepted()
  }

  // Signals the displaced work and releases the slot immediately. The work may still unwind, so every
  // later cleanup remains guarded by scope identity and cannot clear a replacement interaction.
  supersede(scope: AcpSessionInteractionScope): void {
    const active = this.activeInteractions.get(scope.sessionId)
    const pending = this.pendingPromptReservations.get(scope.sessionId)
    const owned = active?.scope === scope ? active : pending?.scope === scope ? pending : undefined
    if (!owned) return

    owned.abortController.abort()
    this.release(scope)
  }

  supersedeCurrent(sessionId: string): void {
    const activeScope = this.activeInteractions.get(sessionId)?.scope
    const pendingScope = this.pendingPromptReservations.get(sessionId)?.scope
    if (activeScope) this.supersede(activeScope)
    if (pendingScope) this.supersede(pendingScope)
  }

  supersedeAll(): void {
    const owned = [...this.activeInteractions.values(), ...this.pendingPromptReservations.values()]
    for (const { scope } of owned) {
      this.supersede(scope)
    }
    for (const sessionId of Array.from(this.cancellationTimers.keys())) {
      this.clearCancellationTimer(sessionId)
    }
  }

  reservePrompt(request: AcpPromptSessionInteractionRequest): AcpPromptSessionInteractionScope {
    if (this.activeInteractions.get(request.sessionId)?.scope.kind === 'prompt') {
      throw new Error('An ACP interaction is already running for this session')
    }

    const abortController = new AbortController()
    const promptProvenance = {
      value: cloneProvenanceContext(request.provenanceContext)
    }
    const scope: AcpPromptSessionInteractionScope = Object.freeze({
      sessionId: request.sessionId,
      kind: 'prompt',
      promptMessageId: request.promptMessageId,
      get provenanceContext() {
        return promptProvenance.value
      },
      ...(request.memoryEnabled !== undefined ? { memoryEnabled: request.memoryEnabled } : {}),
      turnToken: request.turnToken ?? randomUUID(),
      sequence: ++this.sequence,
      signal: abortController.signal
    })
    this.pendingPromptReservations.get(request.sessionId)?.abortController.abort()
    this.pendingPromptReservations.set(request.sessionId, {
      scope,
      abortController,
      promptProvenance,
      cancelled: false,
      modelTurnCount: 0,
      referencedSessionIds: new Set(request.referencedSessionIds ?? [])
    })

    return scope
  }

  activatePrompt(scope: AcpPromptSessionInteractionScope): AcpPromptSessionInteractionScope {
    if (this.activeInteractions.has(scope.sessionId)) {
      throw new Error('An ACP interaction is already running for this session')
    }

    const pending = this.pendingPromptReservations.get(scope.sessionId)
    if (pending?.scope !== scope) {
      throw new Error('ACP prompt reservation was superseded')
    }

    this.pendingPromptReservations.delete(scope.sessionId)
    this.activeInteractions.set(scope.sessionId, pending)
    return scope
  }

  updatePromptProvenance(
    scope: AcpPromptSessionInteractionScope,
    provenanceContext: AcpPromptRequest['provenanceContext']
  ): void {
    const active = this.activeInteractions.get(scope.sessionId)
    if (active?.scope !== scope || !active.promptProvenance) {
      throw new Error('ACP prompt interaction is no longer active')
    }
    active.promptProvenance.value = cloneProvenanceContext(provenanceContext)
  }

  claim<Request extends AcpSessionInteractionRequest>(request: Request): ScopeFor<Request> {
    if (
      this.activeInteractions.has(request.sessionId) ||
      this.pendingPromptReservations.has(request.sessionId)
    ) {
      throw new Error('An ACP interaction is already running for this session')
    }

    const abortController = new AbortController()
    const promptProvenance =
      request.kind === 'prompt'
        ? { value: cloneProvenanceContext(request.provenanceContext) }
        : undefined
    const base = {
      sessionId: request.sessionId,
      sequence: ++this.sequence,
      signal: abortController.signal
    }
    const scope: AcpSessionInteractionScope = Object.freeze(
      request.kind === 'prompt'
        ? {
            ...base,
            kind: request.kind,
            promptMessageId: request.promptMessageId,
            get provenanceContext() {
              return promptProvenance?.value
            },
            turnToken: request.turnToken ?? randomUUID()
          }
        : { ...base, kind: request.kind }
    )
    this.activeInteractions.set(request.sessionId, {
      scope,
      abortController,
      ...(promptProvenance ? { promptProvenance } : {}),
      cancelled: false,
      modelTurnCount: 0,
      referencedSessionIds: new Set(
        request.kind === 'prompt' ? (request.referencedSessionIds ?? []) : []
      )
    })

    return scope as ScopeFor<Request>
  }

  release(scope: AcpSessionInteractionScope): void {
    if (this.activeInteractions.get(scope.sessionId)?.scope === scope) {
      const timer = this.cancellationTimers.get(scope.sessionId)
      if (!timer?.scope || timer.scope === scope) {
        this.clearCancellationTimer(scope.sessionId, timer)
      }
      this.activeInteractions.delete(scope.sessionId)
      return
    }

    if (this.pendingPromptReservations.get(scope.sessionId)?.scope === scope) {
      this.pendingPromptReservations.delete(scope.sessionId)
    }
  }

  private clearCancellationTimer(sessionId: string, expected?: CancellationTimer): void {
    const timer = this.cancellationTimers.get(sessionId)
    if (!timer || (expected && timer !== expected)) return
    if (timer.handle !== undefined) this.clearTimer(timer.handle)
    this.cancellationTimers.delete(sessionId)
  }

  async run<T, Request extends AcpSessionInteractionRequest>(
    request: Request,
    work: (scope: ScopeFor<Request>) => Promise<T>
  ): Promise<T> {
    const scope = this.claim(request)

    try {
      return await work(scope)
    } finally {
      this.release(scope)
    }
  }
}
