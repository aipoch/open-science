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
    this.activeInteractions.delete(scope.sessionId)
  }

  async run<T, Request extends AcpSessionInteractionRequest>(
    request: Request,
    work: (scope: ScopeFor<Request>) => Promise<T>
  ): Promise<T> {
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
    const active = { scope, abortController }
    this.activeInteractions.set(request.sessionId, active)

    try {
      return await work(scope as ScopeFor<Request>)
    } finally {
      if (this.activeInteractions.get(request.sessionId) === active) {
        this.activeInteractions.delete(request.sessionId)
      }
    }
  }
}
