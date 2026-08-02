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
  | AcpPromptSessionInteractionRequest
  | AcpCompactionSessionInteractionRequest

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
  | AcpPromptSessionInteractionScope
  | AcpCompactionSessionInteractionScope

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
    if (active?.scope !== scope) return

    active.abortController.abort()
    this.release(scope)
  }

  supersedeCurrent(sessionId: string): void {
    const scope = this.current(sessionId)
    if (scope) this.supersede(scope)
  }

  supersedeAll(): void {
    for (const { scope } of Array.from(this.activeInteractions.values())) {
      this.supersede(scope)
    }
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
