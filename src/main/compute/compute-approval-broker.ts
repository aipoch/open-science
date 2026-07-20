import type { ComputeApprovalRequest } from '../../shared/compute'

// The compute approval decision. Only 'once' and 'deny' are supported in this issue (Phase 1);
// 'conversation' and 'project' scopes are added in issue 05.
export type ComputeApprovalDecision = 'once' | 'deny'

type ComputeApprovalBrokerDeps = {
  // Pushes a pending approval request to the renderer.
  broadcast: (request: ComputeApprovalRequest) => void
  // Injectable for deterministic tests; defaults to crypto.randomUUID.
  generateId: () => string
  // How long to wait before auto-denying (default: 5 minutes).
  timeoutMs?: number
  // Injectable timer for tests.
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

// Bridges the main-process compute gate to the renderer approval card. Holds the call_command
// open (a Promise) while the user decides; auto-denies after timeoutMs to prevent indefinite hangs.
// Follows the same promise + broadcast + IPC-respond pattern as ApprovalBroker in connectors.
// Phase 1 supports only Once/deny; issue 05 extends with conversation/project scope.
export class ComputeApprovalBroker {
  private readonly pending = new Map<
    string,
    {
      resolve: (decision: ComputeApprovalDecision) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void

  constructor(private readonly deps: ComputeApprovalBrokerDeps) {
    this.timeoutMs = deps.timeoutMs ?? 5 * 60_000
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
  }

  // Broadcasts an approval request and resolves once the renderer responds (or the timeout denies).
  request(info: Omit<ComputeApprovalRequest, 'id'>): Promise<ComputeApprovalDecision> {
    const id = this.deps.generateId()

    return new Promise<ComputeApprovalDecision>((resolve) => {
      const timer = this.setTimer(() => this.settle(id, 'deny'), this.timeoutMs)
      this.pending.set(id, { resolve, timer })
      this.deps.broadcast({ id, ...info })
    })
  }

  // Called from the IPC handler when the renderer responds. Unknown ids are ignored.
  respond(id: string, decision: ComputeApprovalDecision): void {
    this.settle(id, decision)
  }

  private settle(id: string, decision: ComputeApprovalDecision): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.clearTimer(entry.timer)
    this.pending.delete(id)
    entry.resolve(decision)
  }
}
