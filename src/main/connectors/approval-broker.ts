import type { ApprovalDecision, ConnectorApprovalRequest } from '../../shared/settings'

export type ApprovalInfo = Omit<ConnectorApprovalRequest, 'id'>

type ApprovalBrokerDeps = {
  // Pushes a pending request to the renderer(s) that show the approval card.
  broadcast: (request: ConnectorApprovalRequest) => void
  // Reprojects an existing request without repeating first-delivery side effects such as notifications.
  replay?: (request: ConnectorApprovalRequest) => void
  // Injectable so tests are deterministic; defaults to crypto.randomUUID in the factory below.
  generateId: () => string
  // How long a request waits before it is auto-denied (a connector call must never block forever).
  timeoutMs?: number
  // Injectable timer for tests.
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  now?: () => number
  onSettled?: (id: string, state: 'resolved' | 'rejected' | 'expired' | 'cancelled') => void
}

type PendingApproval = {
  request: ConnectorApprovalRequest
  resolve: (decision: ApprovalDecision) => void
  timer?: ReturnType<typeof setTimeout>
  remainingMs: number
  timerStartedAt?: number
  signal?: AbortSignal
  abortListener?: () => void
}

// Bridges the main-process connector gate to the renderer approval card: it holds a connector call
// open (a promise) while the user decides, and resolves it when the renderer responds. Unanswered
// requests are auto-denied after `timeoutMs` so a call can never hang the kernel indefinitely.
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly pausedSessions = new Set<string>()
  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly now: () => number

  constructor(private readonly deps: ApprovalBrokerDeps) {
    this.timeoutMs = deps.timeoutMs ?? 5 * 60_000
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
    this.now = deps.now ?? Date.now
  }

  // Broadcasts an approval request and resolves once the renderer responds (or the timeout denies it).
  request(info: ApprovalInfo, signal?: AbortSignal): Promise<ApprovalDecision> {
    signal?.throwIfAborted()
    const id = this.deps.generateId()
    const request = { id, ...info, availableScopes: info.availableScopes ?? ['once'] }

    return new Promise<ApprovalDecision>((resolve) => {
      const entry: PendingApproval = { request, resolve, remainingMs: this.timeoutMs, signal }
      this.pending.set(id, entry)
      if (signal) {
        entry.abortListener = () => this.settle(id, 'deny', 'cancelled')
        signal.addEventListener('abort', entry.abortListener, { once: true })
        if (signal.aborted) {
          entry.abortListener()
          return
        }
      }
      this.schedule(id, entry)
      this.deps.broadcast(request)
    })
  }

  getPending(id: string): ConnectorApprovalRequest | null {
    return this.pending.get(id)?.request ?? null
  }

  replayPending(): void {
    const replay = this.deps.replay ?? this.deps.broadcast
    for (const entry of this.pending.values()) replay(entry.request)
  }

  // Called from the IPC handler when the renderer responds. Unknown ids are ignored (already settled).
  respond(id: string, decision: ApprovalDecision): void {
    this.settle(id, decision, decision === 'deny' ? 'rejected' : 'resolved')
  }

  pauseSession(sessionId: string): void {
    if (this.pausedSessions.has(sessionId)) return
    this.pausedSessions.add(sessionId)
    for (const entry of this.pending.values()) {
      if (entry.request.sessionId !== sessionId || entry.timer === undefined) continue
      this.clearTimer(entry.timer)
      entry.timer = undefined
      entry.remainingMs = Math.max(
        0,
        entry.remainingMs - (this.now() - (entry.timerStartedAt ?? this.now()))
      )
      entry.timerStartedAt = undefined
    }
  }

  resumeSession(sessionId: string): void {
    if (!this.pausedSessions.delete(sessionId)) return
    for (const [id, entry] of this.pending) {
      if (entry.request.sessionId === sessionId) this.schedule(id, entry)
    }
  }

  private schedule(id: string, entry: PendingApproval): void {
    const sessionId = entry.request.sessionId
    if (sessionId && this.pausedSessions.has(sessionId)) return
    if (entry.remainingMs <= 0) {
      this.settle(id, 'deny', 'expired')
      return
    }
    entry.timerStartedAt = this.now()
    entry.timer = this.setTimer(() => this.settle(id, 'deny', 'expired'), entry.remainingMs)
  }

  private settle(
    id: string,
    decision: ApprovalDecision,
    state: 'resolved' | 'rejected' | 'expired' | 'cancelled'
  ): void {
    const entry = this.pending.get(id)
    if (!entry) return
    if (entry.timer !== undefined) this.clearTimer(entry.timer)
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener('abort', entry.abortListener)
    }
    this.pending.delete(id)
    entry.resolve(decision)
    try {
      this.deps.onSettled?.(id, state)
    } catch {
      // Renderer/event projection cannot roll back the broker decision or keep the call parked.
    }
  }
}
