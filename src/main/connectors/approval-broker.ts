import type { ApprovalDecision, ConnectorApprovalRequest } from '../../shared/settings'

export type ApprovalInfo = { connector: string; method: string; argsPreview: string }

type ApprovalBrokerDeps = {
  // Pushes a pending request to the renderer(s) that show the approval card.
  broadcast: (request: ConnectorApprovalRequest) => void
  // Injectable so tests are deterministic; defaults to crypto.randomUUID in the factory below.
  generateId: () => string
  // How long a request waits before it is auto-denied (a connector call must never block forever).
  timeoutMs?: number
  // Injectable timer for tests.
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

// Bridges the main-process connector gate to the renderer approval card: it holds a connector call
// open (a promise) while the user decides, and resolves it when the renderer responds. Unanswered
// requests are auto-denied after `timeoutMs` so a call can never hang the kernel indefinitely.
export class ApprovalBroker {
  private readonly pending = new Map<
    string,
    { resolve: (decision: ApprovalDecision) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void

  constructor(private readonly deps: ApprovalBrokerDeps) {
    this.timeoutMs = deps.timeoutMs ?? 5 * 60_000
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
  }

  // Broadcasts an approval request and resolves once the renderer responds (or the timeout denies it).
  request(info: ApprovalInfo): Promise<ApprovalDecision> {
    const id = this.deps.generateId()

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = this.setTimer(() => this.settle(id, 'deny'), this.timeoutMs)
      this.pending.set(id, { resolve, timer })
      this.deps.broadcast({ id, ...info })
    })
  }

  // Called from the IPC handler when the renderer responds. Unknown ids are ignored (already settled).
  respond(id: string, decision: ApprovalDecision): void {
    this.settle(id, decision)
  }

  private settle(id: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.clearTimer(entry.timer)
    this.pending.delete(id)
    entry.resolve(decision)
  }
}
