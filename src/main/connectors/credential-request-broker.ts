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
  onSettled?: (id: string) => void
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

  getPending(id: string): ConnectorCredentialRequest | null {
    return this.pending.get(id)?.request ?? null
  }

  replayPending(): void {
    const replay = this.deps.replay ?? this.deps.broadcast
    for (const entry of this.pending.values()) replay(entry.request)
  }

  respond(id: string, configured: boolean): void {
    this.settle(id, configured)
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
      this.deps.onSettled?.(id)
    } catch {
      // Event projection cannot roll back the already-settled Connector call.
    }
  }
}
