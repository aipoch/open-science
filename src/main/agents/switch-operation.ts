// host.agents.switch(nameOrNull) operation module (issue 05).
//
// This is the standalone, durable next-message switch lifecycle for the trusted calling conversation.
// It resolves the target, requests the injected issue-02 approval gateway, and — on approval —
// persists the binding immediately and broadcasts a pending-reconfigure notification. The runtime
// reconfigure happens at the SAFE next-message boundary, so the Agent executing this SDK call is
// never destroyed before `agentsCall` returns (design.md §9 / PRD §8).
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
  ApprovalGateway,
  PendingSwitch,
  SwitchNotifier,
  TrustedCallingSession
} from '../../shared/agents-contract'
import type { SpecialistProfileView } from '../../shared/specialist'
import type { ProfileService } from '../specialist/service'
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
  profileService: ProfileService
  sessionBinding: SessionBindingService
  approvalGateway: ApprovalGateway
  switchNotifier: SwitchNotifier
  // Persists only the specialist UUID (or cleared Main binding) to the durable session file so the
  // approved binding survives application restart. Reuses the existing persistence seam.
  persistBinding: (sessionId: string, specialistId: string | undefined) => Promise<void>
  // Long-lived, session-keyed sequencer for the last-write-wins guard. The dispatcher supplies ONE
  // shared instance (held on AgentsService) so the commit queue survives per-call instantiation;
  // tests omit it to get a per-instance queue.
  sequencer?: SwitchCommitSequencer
}

// Public-name-or-null params after the dispatcher strips reserved routing/identity keys. `revision`
// optionally carries the reviewed revision so approval-time drift fails closed (PRD §8:267).
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

type SwitchCommit = {
  specialistId: string | undefined
  targetName: string | null
  revision?: number
}

// Long-lived, session-keyed exclusive commit queue. The dispatcher creates a fresh SwitchOperation
// per call, so the queue lives on AgentsService and is shared by those instances. Serializing the
// complete durable commit prevents an older slow persistence call from landing after a newer one;
// different sessions retain independent queues.
export class SwitchCommitSequencer {
  private readonly tails = new Map<string, Promise<void>>()

  enqueue<T>(sessionId: string, commit: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(commit)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(sessionId, tail)
    void tail.finally(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
    })
    return result
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
    const approval = await this.requestApproval(targetName, sessionId)
    if (approval.status === 'declined') {
      // Decline changes no binding, runtime, persisted session, or renderer state.
      return { status: 'declined', operation: SWITCH_METHOD }
    }

    return this.sequencer.enqueue(sessionId, async () => {
      // Revalidate inside the exclusive commit queue so drift is checked immediately before the
      // mutation, including time spent waiting behind an earlier commit for this session.
      const committed = await this.resolveForCommit(preResolved, params.revision)

      // Durable persistence comes first. The runtime identity changes only at the safe next-message
      // boundary, after the approved binding has survived application restart.
      try {
        await this.deps.persistBinding(sessionId, committed.specialistId)
      } catch (error) {
        throw new SwitchError(error)
      }

      this.deps.sessionBinding.setBinding(sessionId, committed.specialistId)

      const pendingReconfigure: PendingSwitch = {
        sessionId,
        targetName: committed.targetName
      }
      try {
        await this.deps.switchNotifier.notify(pendingReconfigure)
      } catch {
        // Best-effort mirror; the durable binding already took effect. Do not throw.
      }

      return {
        status: 'approved' as const,
        operation: SWITCH_METHOD,
        binding: {
          sessionId,
          specialistId: committed.specialistId,
          targetName: committed.targetName,
          ...(committed.revision !== undefined ? { revision: committed.revision } : {})
        },
        pendingReconfigure
      }
    })
  }

  // Resolves the target public name to the live profile (pre-approval). null selects Main Agent
  // without creating any mutable Main Profile record. The target must be a currently-enabled custom
  // Specialist; a disabled or unknown target fails closed before the approval gateway is consulted.
  private async resolveTarget(
    targetName: string | null
  ): Promise<{ kind: 'main' } | { kind: 'specialist'; profile: SpecialistProfileView }> {
    if (targetName === null) return { kind: 'main' }
    let profile: SpecialistProfileView
    try {
      profile = await this.deps.profileService.getByName(targetName)
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
      const current = await this.deps.profileService.getById(specialistId)
      return current.name
    } catch {
      return undefined
    }
  }

  // Approval-time re-resolution + drift check. Re-resolves name → UUID, verifies enabled state, and
  // (when a reviewed revision was carried) verifies the revision still matches. Failure fails closed
  // and never broadens to Main Agent. Returns the commit descriptor (specialistId/revision or Main).
  private async resolveForCommit(
    preResolved: { kind: 'main' } | { kind: 'specialist'; profile: SpecialistProfileView },
    reviewedRevision: number | undefined
  ): Promise<SwitchCommit> {
    if (preResolved.kind === 'main') {
      return { specialistId: undefined, targetName: null }
    }
    const name = preResolved.profile.name
    let profile: SpecialistProfileView
    try {
      profile = await this.deps.profileService.getByName(name)
    } catch (error) {
      // Renamed or deleted between approval and commit.
      throw new SwitchError(error)
    }
    if (!profile.enabled) {
      throw new SwitchError(
        agentsPublicError(`Specialist "${name}" was disabled before the switch committed`)
      )
    }
    if (reviewedRevision !== undefined && profile.revision !== reviewedRevision) {
      throw new SwitchError(
        agentsPublicError(
          `Specialist "${name}" revision changed (${reviewedRevision} → ${profile.revision}) before the switch committed`
        )
      )
    }
    return {
      specialistId: profile.id,
      targetName: profile.name,
      revision: profile.revision
    }
  }
}
