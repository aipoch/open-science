import type {
  ConnectorCredentialRequest,
  ConnectorCredentialRequestInfo
} from '../../shared/settings'

type CredentialRequestBrokerDeps = {
  broadcast: (request: ConnectorCredentialRequest) => void
  replay?: (request: ConnectorCredentialRequest) => void
  generateId: () => string
  timeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  onSettled?: (id: string, configured: boolean) => void
}

type PendingCredentialRequest = {
  request: ConnectorCredentialRequest
  resolve: (configured: boolean) => void
  timer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  abortListener?: () => void
}

// Holds the exact Connector call while the renderer collects a required credential. It carries only
// public request metadata; plaintext is submitted through the credential owner's settings command.
export class CredentialRequestBroker {
  private readonly pending = new Map<string, PendingCredentialRequest>()
  // Refusal lasts until Session deletion or app restart; undefined is the sessionless dialog group.
  private readonly declinedSessionIds = new Set<string | undefined>()
  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void

  constructor(private readonly deps: CredentialRequestBrokerDeps) {
    this.timeoutMs = deps.timeoutMs ?? 5 * 60_000
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  request(info: ConnectorCredentialRequestInfo, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    if (this.declinedSessionIds.has(info.sessionId)) return Promise.resolve(false)
    const id = this.deps.generateId()
    const request = { id, ...info }

    return new Promise<boolean>((resolve) => {
      const entry: PendingCredentialRequest = {
        request,
        resolve,
        signal
      }
      this.pending.set(id, entry)
      entry.timer = this.setTimer(() => this.settle(id, false), this.timeoutMs)
      if (signal) {
        entry.abortListener = () => this.settle(id, false)
        signal.addEventListener('abort', entry.abortListener, { once: true })
        if (signal.aborted) {
          entry.abortListener()
          return
        }
      }
      this.deps.broadcast(request)
    })
  }

  hasPendingForSession(sessionId: string): boolean {
    return [...this.pending.values()].some((entry) => entry.request.sessionId === sessionId)
  }

  getPending(id: string): ConnectorCredentialRequest | null {
    return this.pending.get(id)?.request ?? null
  }

  replayPending(): void {
    const replay = this.deps.replay ?? this.deps.broadcast
    for (const entry of this.pending.values()) replay(entry.request)
  }

  respond(id: string, configured: boolean): void {
    const entry = this.pending.get(id)
    if (!entry) return
    if (!configured) this.declinedSessionIds.add(entry.request.sessionId)

    // Saving satisfies every caller; declining only dismisses the current Session's group (or the
    // sessionless fallback group). Settle queued calls so Not now cannot reveal the next identical
    // prompt. Later calls in that group skip credential collection.
    const matchingIds = [...this.pending.entries()]
      .filter(
        ([, candidate]) =>
          candidate.request.credentialId === entry.request.credentialId &&
          (configured || candidate.request.sessionId === entry.request.sessionId)
      )
      .map(([pendingId]) => pendingId)
    for (const pendingId of matchingIds) this.settle(pendingId, configured)
  }

  clearSession(sessionId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.request.sessionId === sessionId) this.settle(id, false)
    }
    this.declinedSessionIds.delete(sessionId)
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, false)
  }

  private settle(id: string, configured: boolean): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (entry.timer !== undefined) this.clearTimer(entry.timer)
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener('abort', entry.abortListener)
    }
    entry.resolve(configured)
    try {
      this.deps.onSettled?.(id, configured)
    } catch {
      // Event projection cannot roll back the already-settled Connector call.
    }
  }
}
