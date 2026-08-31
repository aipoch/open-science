// host.agents.switch(nameOrNull) operation module (issue 05).
//
// This is the durable approved-switch operation for the trusted calling conversation.
// It resolves the target, requests the injected issue-02 approval gateway, and — on approval —
// persists the binding immediately and broadcasts a pending-reconfigure notification. The runtime
// The completion gate reconfigures at the outer control-tool boundary, so the Agent executing this
// SDK call can finish before the old prompt is stopped (design.md §9 / PRD §8).
//
// BOUNDARIES (design.md §9, cross-cutting requirements):
//  - Reuses the EXISTING SessionBindingService (in-memory binding) + the EXISTING durable
//    persistence seam + the EXISTING runtime reconfigure barrier + history replay. It does NOT
//    create a parallel switch service, a renderer-only durable binding, or a new approval broker.
//  - Real approval-broker composition is deferred to issue 08; tests wire a FAKE gateway.
//  - NEVER accepts a sandbox-supplied session id. The trusted calling-session identity is captured
//    outside the sandbox (issue 02) and injected as server context. Reserved routing/identity keys
//    are stripped by the dispatcher before this module runs; even if one survived it is ignored.
//  - Errors are sanitized and prefixed `host.agents.switch:`. Logs, summaries, and notifications
//    exclude system instructions, history text, tokens, and sensitive runtime configuration.
//  - Switch NEVER broadens to Main Agent on target or reconfigure failure (fail closed).

import type {
  ApprovedSwitchReadback,
  ApprovalGateway,
  PendingSwitch,
  SwitchNotifier,
  TrustedCallingSession
} from '../../shared/agents-contract'
import type { HandoffApprovalContext } from '../../shared/handoff-lifecycle'
import type { SpecialistView } from '../../shared/specialist'
import type { SpecialistService } from '../specialist/service'
import type { SessionBindingService } from '../specialist/session-binding'
import { AgentsSafeError, agentsPublicError, formatAgentsError } from './agents-error'

// The method name used to prefix sanitized errors and to echo in structured results.
export const SWITCH_METHOD = 'switch' as const

class SwitchError extends AgentsSafeError {
  constructor(cause: unknown) {
    super(formatAgentsError(SWITCH_METHOD, cause))
    this.name = 'SwitchError'
  }
}

// The injected, fake-able dependencies. The durable persistence callback and SessionBindingService
// are the SAME authoritative seams the existing SET_SESSION_SPECIALIST IPC handler uses — there is
// no parallel switch service. The runtime reconfigure callback is intentionally NOT part of this
// module: it runs at the safe next-message boundary, not inside this SDK call.
export type SwitchOperationDeps = {
  specialistService: SpecialistService
  sessionBinding: SessionBindingService
  approvalGateway: ApprovalGateway
  switchNotifier: SwitchNotifier
  approvalLifecycle?: {
    onAwaitingApproval(context: HandoffApprovalContext): Promise<void> | void
    settleApproval(context: HandoffApprovalContext, approved: boolean): Promise<void> | void
  }
  // Persists only the specialist UUID (or cleared Main binding) to the durable session file so the
  // approved binding survives application restart. Reuses the existing persistence seam.
  persistBinding: (sessionId: string, specialistId: string | undefined) => Promise<void>
  // Long-lived, session-keyed sequencer for the last-write-wins guard. The dispatcher supplies ONE
  // shared instance (held on AgentsService) so generation state survives the per-call instantiation;
  // tests omit it to get a per-instance sequencer.
  sequencer?: SwitchCommitSequencer
}

// Public-name-or-null params after the dispatcher strips reserved routing/identity keys. `revision`
// may carry an explicit reviewed revision. When omitted by the public switch(nameOrNull) SDK, the
// pre-approval profile snapshot supplies the approved UUID/revision so approval-time drift still
// fails closed.
export type SwitchParams = {
  name?: string | null
  revision?: number
}

// The read-back binding state returned after an approved switch. Mirrors what was actually
// persisted: never contains system instructions or sensitive runtime configuration.
export type SwitchBindingReadBack = {
  sessionId: string
  // The persisted specialist UUID, or undefined when the binding was cleared to Main Agent.
  specialistId: string | undefined
  // The target public name (null = Main Agent). Echoed for diagnostics; never a secret.
  targetName: string | null
  // The live record revision at commit time (omitted for Main).
  revision?: number
}

// The structured result contract. A decline is a NORMAL camelCase result — not an error.
export type SwitchResult =
  | {
      status: 'approved'
      operation: typeof SWITCH_METHOD
      binding: SwitchBindingReadBack
      // The pending-reconfigure intent broadcast to the renderer/runtime. The approved target takes
      // effect on the NEXT message; it survives restart.
      pendingReconfigure: PendingSwitch
    }
  | { status: 'declined'; operation: typeof SWITCH_METHOD }

// Internal bookkeeping for last-write-wins across interleaved approved switches. Each approved run
// captures the monotonic generation it observed at approval time; a completion whose generation is
// older than the newest committed generation is a stale write and is discarded.
type PendingCommit = {
  generation: number
  specialistId: string | undefined
  targetName: string | null
  revision?: number
}

// Long-lived, session-keyed commit sequencer for the switch last-write-wins guard. The dispatcher
// (agents-service.ts runSwitch) creates a FRESH SwitchOperation per host.agents.switch call, so the
// generation counters CANNOT live on the per-call instance — they would reset to 0 every call and
// the interleaving guard would never fire (only the single-instance unit test would pass). This
// sequencer is held by the long-lived AgentsService and shared across every SwitchOperation it
// spawns, keyed by sessionId so concurrent switches in different sessions never collide.
export class SwitchCommitSequencer {
  // Per session: highest generation CLAIMED at commit-start, and highest COMMITTED (broadcast done).
  private readonly claimed = new Map<string, number>()
  private readonly committed = new Map<string, number>()

  // Claim the next generation for this session's commit attempt. Returns whether a newer commit has
  // already completed — if so, this attempt is stale before it persists and is discarded.
  claim(sessionId: string): { generation: number; staleBecauseNewerCommitted: boolean } {
    const generation = (this.claimed.get(sessionId) ?? 0) + 1
    this.claimed.set(sessionId, generation)
    return {
      generation,
      staleBecauseNewerCommitted: generation <= (this.committed.get(sessionId) ?? 0)
    }
  }

  // After persisting, check whether a newer commit was claimed during the await. If so, this
  // completion must not overwrite the newer target.
  supersededByNewerClaim(sessionId: string, generation: number): boolean {
    return generation < (this.claimed.get(sessionId) ?? 0)
  }

  // Record this generation as the newest committed for this session (monotonic; stale completions
  // return before reaching here, so this only advances).
  markCommitted(sessionId: string, generation: number): void {
    const current = this.committed.get(sessionId) ?? 0
    if (generation > current) this.committed.set(sessionId, generation)
  }
}

export class SwitchOperation {
  private readonly deps: SwitchOperationDeps
  // Shared (when supplied by the dispatcher) long-lived sequencer, or a per-instance one when omitted
  // (tests that don't exercise cross-call ordering). The state MUST outlive a single run() call.
  private readonly sequencer: SwitchCommitSequencer

  constructor(deps: SwitchOperationDeps) {
    this.deps = deps
    this.sequencer = deps.sequencer ?? new SwitchCommitSequencer()
  }

  async run(params: SwitchParams, trustedSession: TrustedCallingSession): Promise<SwitchResult> {
    // The trusted calling-session identity is the ONLY session this operation may target. It is
    // captured outside the sandbox (issue 02) and threaded as server context. Sandbox-supplied
    // session id fields are already stripped by the dispatcher; we read neither here.
    const sessionId = trustedSession.sessionId
    if (!sessionId) {
      throw new SwitchError(agentsPublicError('Missing trusted calling-session identity'))
    }

    // Phase 1 — pre-approval resolution. Resolve the exact public name to the live profile so the
    // approval summary describes a real, enabled target. null → Main Agent (no mutable Main Profile).
    const targetName = params.name ?? null
    const preResolved = await this.resolveTarget(targetName)

    // Phase 2 — request the injected approval gateway. The summary carries ONLY the target public
    // name (or null for Main) — never system instructions, credentials, or runtime configuration.
    const turnId = trustedSession.turnId
    const originatingTurnId = trustedSession.originatingTurnId ?? turnId
    const toolInvocationId = trustedSession.toolInvocationId
    const approvalContext: HandoffApprovalContext | undefined =
      turnId &&
      trustedSession.controlInvocationGeneration !== undefined &&
      originatingTurnId &&
      toolInvocationId
        ? {
            sessionId,
            turnId,
            controlInvocationGeneration: trustedSession.controlInvocationGeneration,
            originatingTurnId,
            originatingUserMessageId: trustedSession.originatingUserMessageId ?? originatingTurnId,
            toolInvocationId,
            target:
              targetName === null ? { kind: 'main' } : { kind: 'specialist', name: targetName },
            attachmentIds: trustedSession.attachmentIds ?? [],
            artifactIds: trustedSession.artifactIds ?? []
          }
        : undefined
    if (approvalContext) await this.deps.approvalLifecycle?.onAwaitingApproval(approvalContext)

    let approval: Awaited<ReturnType<SwitchOperation['requestApproval']>>
    try {
      approval = await this.requestApproval(targetName, sessionId)
    } catch (error) {
      if (approvalContext) await this.deps.approvalLifecycle?.settleApproval(approvalContext, false)
      throw error
    }
    if (approval.status === 'declined') {
      if (approvalContext) await this.deps.approvalLifecycle?.settleApproval(approvalContext, false)
      // Decline changes no binding, runtime, persisted session, or renderer state.
      return { status: 'declined', operation: SWITCH_METHOD }
    }
    // Phase 3 — approval-time re-validation. Re-resolve target name → UUID and verify current
    // enabled state and (when carried) the reviewed revision. Rename, disable, delete, or revision
    // drift while approval was pending causes the approved call to fail closed (PRD §8:267). A Main
    // switch (null target) needs no re-validation — clearing a binding cannot drift.
    let committed: Awaited<ReturnType<SwitchOperation['resolveForCommit']>>
    try {
      committed = await this.resolveForCommit(preResolved, params.revision)
    } catch (error) {
      if (approvalContext) await this.deps.approvalLifecycle?.settleApproval(approvalContext, false)
      throw error
    }

    // Phase 4 — last-write-wins guard. Claim a generation (session-scoped, shared across calls via
    // the sequencer) before the await so a newer approved switch interleaved during
    // persistence/broadcast can supersede this completion.
    const { generation, staleBecauseNewerCommitted } = this.sequencer.claim(sessionId)
    if (staleBecauseNewerCommitted) {
      if (approvalContext) await this.deps.approvalLifecycle?.settleApproval(approvalContext, false)
      // An even newer commit already completed; this stale completion is discarded.
      return this.readBackStale(sessionId, committed)
    }

    // Phase 5 — durable persistence FIRST. The binding survives restart immediately; runtime
    // identity changes only at the safe next-message boundary (distinct durable vs runtime state).
    try {
      await this.deps.persistBinding(sessionId, committed.specialistId)
    } catch (error) {
      if (approvalContext) await this.deps.approvalLifecycle?.settleApproval(approvalContext, false)
      throw new SwitchError(error)
    }

    // A newer approved switch may have interleaved while persisting. If so, this completion is
    // stale: do not overwrite the newer target. The newer run owns the final persisted state.
    if (this.sequencer.supersededByNewerClaim(sessionId, generation)) {
      if (approvalContext) await this.deps.approvalLifecycle?.settleApproval(approvalContext, false)
      return this.readBackStale(sessionId, committed)
    }

    // Expose the durable binding to the live in-memory resolver (reuses SessionBindingService).
    this.deps.sessionBinding.setBinding(sessionId, committed.specialistId)

    // Broadcast the pending-reconfigure notification. The renderer renders the "takes effect next
    // message" state; the runtime reconfigure barrier applies the approved binding at the next send.
    // PendingSwitch carries ONLY sessionId + targetName — no system instructions or secrets. The
    // broadcast is a BEST-EFFORT renderer mirror: the persisted binding is authoritative and applies
    // at the next send regardless, so a notify failure must NOT surface as a thrown error to the
    // caller — the switch has already committed. Swallow the failure and continue so this run still
    // reaches markCommitted and reports approved.
    const pendingReconfigure: PendingSwitch = {
      sessionId,
      targetName: committed.targetName,
      ...(trustedSession.turnId ? { turnId: trustedSession.turnId } : {}),
      ...(trustedSession.controlInvocationGeneration !== undefined
        ? { controlInvocationGeneration: trustedSession.controlInvocationGeneration }
        : {}),
      ...(trustedSession.toolInvocationId
        ? { toolInvocationId: trustedSession.toolInvocationId }
        : {}),
      ...(trustedSession.originatingTurnId
        ? { originatingTurnId: trustedSession.originatingTurnId }
        : {}),
      ...(trustedSession.originatingUserMessageId
        ? { originatingUserMessageId: trustedSession.originatingUserMessageId }
        : {}),
      ...(trustedSession.attachmentIds ? { attachmentIds: trustedSession.attachmentIds } : {}),
      ...(trustedSession.artifactIds ? { artifactIds: trustedSession.artifactIds } : {})
    }
    const readback: ApprovedSwitchReadback = {
      status: 'approved',
      operation: SWITCH_METHOD,
      binding: {
        sessionId,
        specialistId: committed.specialistId,
        targetName: committed.targetName,
        ...(committed.revision !== undefined ? { revision: committed.revision } : {})
      },
      pendingReconfigure
    }
    try {
      if (this.deps.switchNotifier.notifyApproved) {
        await this.deps.switchNotifier.notifyApproved(pendingReconfigure, readback)
      } else {
        await this.deps.switchNotifier.notify(pendingReconfigure)
      }
    } catch (error) {
      if (this.deps.switchNotifier.authority === 'completion-gate') throw error
      // Best-effort mirror; the durable binding already took effect. Do not throw.
    }
    if (approvalContext) await this.deps.approvalLifecycle?.settleApproval(approvalContext, true)

    // If an even newer switch interleaved during broadcast, the newest target still wins; this run
    // reports its own commit but does not clobber the newer persisted state.
    this.sequencer.markCommitted(sessionId, generation)

    return readback
  }

  // Resolves the target public name to the live profile (pre-approval). null selects Main Agent
  // without creating any mutable Main Profile record. The target must be a currently-enabled custom
  // Specialist; a disabled or unknown target fails closed before the approval gateway is consulted.
  private async resolveTarget(
    targetName: string | null
  ): Promise<{ kind: 'main' } | { kind: 'specialist'; profile: SpecialistView }> {
    if (targetName === null) return { kind: 'main' }
    let profile: SpecialistView
    try {
      profile = await this.deps.specialistService.resolveRunnableByName(targetName)
    } catch (error) {
      throw new SwitchError(error)
    }
    if (!profile.enabled) {
      throw new SwitchError(agentsPublicError(`Specialist "${targetName}" is not enabled`))
    }
    return { kind: 'specialist', profile }
  }

  // Requests the injected approval gateway with the shared switch approval request shape. The
  // trusted session is the one captured outside the sandbox; the gateway must never trust a
  // caller-supplied value. Per the contract (SpecialistSwitchCardPayload / ApprovalRequest.summary),
  // `summary.name` is the CURRENT specialist public name (struck through on the card) and
  // `summary.target` is the destination. The current name is resolved from the live binding: omitted
  // when the session is on Main Agent (no binding). Never carries system instructions or secrets.
  private async requestApproval(
    targetName: string | null,
    sessionId: string
  ): Promise<{ status: 'approved' } | { status: 'declined'; operation: 'switch' }> {
    const currentName = await this.resolveCurrentName(sessionId)
    const summary =
      targetName === null
        ? currentName === undefined
          ? { target: null }
          : { target: null, name: currentName }
        : currentName === undefined
          ? { target: targetName }
          : { target: targetName, name: currentName }
    const approval = await this.deps.approvalGateway.decide({
      operation: SWITCH_METHOD,
      summary,
      session: { sessionId }
    })
    if (approval.status === 'declined') {
      return { status: 'declined', operation: 'switch' }
    }
    return { status: 'approved' }
  }

  // Resolves the CURRENT specialist public name for the approval summary from the live binding. The
  // card shows current → target; when the session is on Main Agent (no binding, or the bound profile
  // is absent), there is no current name to show and this returns undefined so `summary.name` is
  // omitted. Never throws — a missing current name is a legitimate Main state, not a switch failure.
  private async resolveCurrentName(sessionId: string): Promise<string | undefined> {
    const specialistId = this.deps.sessionBinding.getBinding(sessionId)
    if (!specialistId) return undefined
    try {
      const current = await this.deps.specialistService.resolveRunnableById(specialistId)
      return current.name
    } catch {
      return undefined
    }
  }

  // Approval-time re-resolution + drift check. Re-resolves name → UUID, verifies enabled state, and
  // verifies that both UUID and revision still match the identity shown for approval. An explicit
  // reviewed revision wins when carried; otherwise the pre-approval snapshot is authoritative.
  // Failure fails closed and never broadens to Main Agent. Returns the commit descriptor
  // (specialistId/revision or Main).
  private async resolveForCommit(
    preResolved: { kind: 'main' } | { kind: 'specialist'; profile: SpecialistView },
    reviewedRevision: number | undefined
  ): Promise<PendingCommit> {
    if (preResolved.kind === 'main') {
      return { generation: 0, specialistId: undefined, targetName: null }
    }
    const name = preResolved.profile.name
    let profile: SpecialistView
    try {
      profile = await this.deps.specialistService.resolveRunnableByName(name)
    } catch (error) {
      // Renamed or deleted between approval and commit.
      throw new SwitchError(error)
    }
    if (!profile.enabled) {
      throw new SwitchError(
        agentsPublicError(`Specialist "${name}" was disabled before the switch committed`)
      )
    }
    if (profile.id !== preResolved.profile.id) {
      throw new SwitchError(
        agentsPublicError(`Specialist "${name}" identity changed before the switch committed`)
      )
    }
    const approvedRevision = reviewedRevision ?? preResolved.profile.revision
    if (profile.revision !== approvedRevision) {
      throw new SwitchError(
        agentsPublicError(
          `Specialist "${name}" revision changed (${approvedRevision} → ${profile.revision}) before the switch committed`
        )
      )
    }
    return {
      generation: 0,
      specialistId: profile.id,
      targetName: profile.name,
      revision: profile.revision
    }
  }

  // Read-back for a stale completion. The stale run returns its own observed target so the caller
  // sees a coherent result, but it has NOT overwritten the newer persisted target (it returned
  // before persistence/broadcast). Main-targeted stale reads report a cleared binding.
  private readBackStale(
    sessionId: string,
    committed: PendingCommit
  ): {
    status: 'approved'
    operation: typeof SWITCH_METHOD
    binding: SwitchBindingReadBack
    pendingReconfigure: PendingSwitch
  } {
    const pendingReconfigure: PendingSwitch = {
      sessionId,
      targetName: committed.targetName
    }
    return {
      status: 'approved',
      operation: SWITCH_METHOD,
      binding: {
        sessionId,
        specialistId: committed.specialistId,
        targetName: committed.targetName,
        ...(committed.revision !== undefined ? { revision: committed.revision } : {})
      },
      pendingReconfigure
    }
  }
}
