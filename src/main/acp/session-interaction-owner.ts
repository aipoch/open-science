import { randomUUID } from 'node:crypto'

export type AcpSessionInteractionKind = 'prompt' | 'compaction'

export interface AcpPromptSessionInteractionRequest {
  readonly sessionId: string
  readonly kind: 'prompt'
  readonly promptMessageId?: string
  readonly turnToken?: string
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

interface ActiveSessionInteraction {
  readonly scope: AcpSessionInteractionScope
  readonly abortController: AbortController
}

export class AcpSessionInteractionOwner {
  private readonly activeInteractions = new Map<string, ActiveSessionInteraction>()
  private readonly pendingPromptReservations = new Map<string, ActiveSessionInteraction>()
  private sequence = 0

  current(sessionId: string): AcpSessionInteractionScope | undefined {
    return this.activeInteractions.get(sessionId)?.scope
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
  }

  reservePrompt(request: AcpPromptSessionInteractionRequest): AcpPromptSessionInteractionScope {
    if (this.activeInteractions.has(request.sessionId)) {
      throw new Error('An ACP interaction is already running for this session')
    }

    const abortController = new AbortController()
    const scope: AcpPromptSessionInteractionScope = Object.freeze({
      sessionId: request.sessionId,
      kind: 'prompt',
      promptMessageId: request.promptMessageId,
      turnToken: request.turnToken ?? randomUUID(),
      sequence: ++this.sequence,
      signal: abortController.signal
    })
    this.pendingPromptReservations.get(request.sessionId)?.abortController.abort()
    this.pendingPromptReservations.set(request.sessionId, { scope, abortController })

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

  claim<Request extends AcpSessionInteractionRequest>(request: Request): ScopeFor<Request> {
    if (this.activeInteractions.has(request.sessionId)) {
      throw new Error('An ACP interaction is already running for this session')
    }

    const abortController = new AbortController()
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
            turnToken: request.turnToken ?? randomUUID()
          }
        : { ...base, kind: request.kind }
    )
    this.activeInteractions.set(request.sessionId, { scope, abortController })

    return scope as ScopeFor<Request>
  }

  release(scope: AcpSessionInteractionScope): void {
    if (this.activeInteractions.get(scope.sessionId)?.scope === scope) {
      this.activeInteractions.delete(scope.sessionId)
      return
    }

    if (this.pendingPromptReservations.get(scope.sessionId)?.scope === scope) {
      this.pendingPromptReservations.delete(scope.sessionId)
    }
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
