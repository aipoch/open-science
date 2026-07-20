import type { ComputeApprovalRequest, ComputeApprovalDecision } from '../../shared/compute'

// Re-export so callers that import from this module don't have to reference shared/compute directly.
export type { ComputeApprovalDecision }

// Context passed with each approval request so the broker can check and record grants.
export type ComputeApprovalContext = {
  // Unique identifier for the current session (process lifetime). Used as the key for
  // conversation-scope in-memory grants. A new process → no conversation grants.
  sessionId: string
  // Project identifier used for project-scope persistent grants.
  projectId: string
  // The compute operation being approved (e.g. 'call_command').
  operation: string
}

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
  // Optional: check whether a project-scope grant exists for (projectId, operation, providerId).
  // Return true → skip the approval card with 'project' decision.
  checkProjectGrant?: (grant: {
    projectId: string
    operation: string
    providerId: string
  }) => Promise<boolean>
  // Optional: persist a new project-scope grant.
  saveProjectGrant?: (grant: {
    projectId: string
    operation: string
    providerId: string
  }) => Promise<void>
}

// Bridges the main-process compute gate to the renderer approval card. Holds the call_command
// open (a Promise) while the user decides; auto-denies after timeoutMs to prevent indefinite hangs.
// Follows the same promise + broadcast + IPC-respond pattern as ApprovalBroker in connectors.
//
// Issue 05 extends the issue-04 base with three approval scopes (design.md §6):
//   - 'once':         no memory; card shown every time
//   - 'conversation': in-memory grants map per (sessionId, operation, providerId); cleared on restart
//   - 'project':      persisted via settings JSON per (projectId, operation, providerId)
//
// Use request() for legacy callers that do not supply context (only 'once'/'deny' can result).
// Use requestWithContext() to enable grant memory.
export class ComputeApprovalBroker {
  private readonly pending = new Map<
    string,
    {
      resolve: (decision: ComputeApprovalDecision) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  // Conversation-scope in-memory grants. Key = `${sessionId}:${operation}:${providerId}`.
  // Scoped to this broker instance (= one app session). A restart creates a new broker → no grants.
  private readonly conversationGrants = new Set<string>()

  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void

  constructor(private readonly deps: ComputeApprovalBrokerDeps) {
    this.timeoutMs = deps.timeoutMs ?? 5 * 60_000
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
  }

  // Broadcasts an approval request and resolves once the renderer responds (or the timeout denies).
  // Does NOT check grants — use requestWithContext for that.
  request(info: Omit<ComputeApprovalRequest, 'id'>): Promise<ComputeApprovalDecision> {
    const id = this.deps.generateId()

    return new Promise<ComputeApprovalDecision>((resolve) => {
      const timer = this.setTimer(() => this.settle(id, 'deny'), this.timeoutMs)
      this.pending.set(id, { resolve, timer })
      this.deps.broadcast({ id, ...info })
    })
  }

  // Like request(), but checks conversation and project grants first. If a grant matches, resolves
  // immediately without broadcasting. When the user responds with a scope that has memory, records it.
  async requestWithContext(
    info: Omit<ComputeApprovalRequest, 'id'>,
    ctx: ComputeApprovalContext
  ): Promise<ComputeApprovalDecision> {
    const { sessionId, projectId, operation } = ctx
    const providerId = info.provider_id

    // ── project grant check (persistent) ──────────────────────────────────────────
    if (this.deps.checkProjectGrant) {
      const hasProject = await this.deps.checkProjectGrant({ projectId, operation, providerId })
      if (hasProject) return 'project'
    }

    // ── conversation grant check (session in-memory) ───────────────────────────────
    const convKey = `${sessionId}:${operation}:${providerId}`
    if (this.conversationGrants.has(convKey)) return 'conversation'

    // ── no grant — show approval card ─────────────────────────────────────────────
    const decision = await this.request(info)

    // Record grant if applicable.
    if (decision === 'conversation') {
      this.conversationGrants.add(convKey)
    } else if (decision === 'project' && this.deps.saveProjectGrant) {
      await this.deps.saveProjectGrant({ projectId, operation, providerId })
    }

    return decision
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
