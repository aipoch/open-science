// Standalone privileged Specialist Profile operation: delete (issue 04).
//
// This module is the privileged-mutation branch of the conversational Specialist management flow.
// host.agents.update (including renames) is an ordinary chat-reviewed mutation handled by the issue
// 03 module; only DELETE passes through this approval-gated module (issue 04). It is deliberately
// standalone and independently testable: it consumes ONLY issue 02's ApprovalGateway contract and
// the existing SpecialistService. It does NOT import issue 03 (ordinary mutation) or issue 05 (switch)
// implementation modules. Issue 08 composes it into the dispatcher.
//
// Design rules mirrored from design.md §8/§10 and the issue 04 acceptance criteria:
//  - Approval re-resolves the PUBLIC NAME to the ID and verifies the REVIEWED REVISION immediately
//    before committing. Pre-card resolution is never mutation authority.
//  - A stale, renamed, deleted, or otherwise changed target after card creation FAILS CLOSED
//    without applying any part of the patch (sanitized `host.agents.<method>:` error).
//  - Delete verifies ABSENCE and returns `{ status: "deleted", name }` WITHOUT clearing or rewriting
//    session ID bindings. Bound conversations resolve unavailable later (design.md §10).
//  - Decline returns a structured camelCase result such as `{ status: "declined", operation: "delete" }`
//    and produces NO mutation, invalidation, binding, runtime, or renderer state change.
//  - Catalog invalidation occurs ONLY after a successful mutation.

import type {
  ApprovalGateway,
  ApprovalResult,
  TrustedCallingSession
} from '../../shared/agents-contract'
import type { SpecialistView } from '../../shared/specialist'
import type {
  SpecialistDeleteRequest,
  SpecialistDeleteResult
} from '../../shared/specialist-package'
import type { SpecialistService } from '../specialist/service'
import { AgentsSafeError, agentsPublicError, formatAgentsError } from './agents-error'

class PrivilegedOpError extends AgentsSafeError {
  constructor(method: string, cause: unknown) {
    super(formatAgentsError(method, cause))
    this.name = 'PrivilegedOpError'
  }
}

// ---------------------------------------------------------------------------
// Result shapes (camelCase, returned to the SDK / Skill)
// ---------------------------------------------------------------------------

export type AgentDeletedResult = {
  status: 'deleted'
  name: string
}

export type AgentDeclinedResult = {
  status: 'declined'
  operation: 'delete'
  reason?: string
}

export type DeleteResult = AgentDeletedResult | AgentDeclinedResult

// ---------------------------------------------------------------------------
// Shared re-resolution: name -> ID + revision verification immediately before mutation
// ---------------------------------------------------------------------------

// Resolves the public name to the live Profile and verifies the reviewed revision still matches.
// Throws a sanitized error on any drift (missing, renamed, disabled is irrelevant for mutation, or
// revision mismatch) so the caller fails closed. Pre-card resolution is never mutation authority —
// the ONLY authority is this re-resolution, performed after approval.
const reResolveForMutation = async (
  method: string,
  specialistService: SpecialistService,
  currentName: string,
  reviewedRevision: number
): Promise<SpecialistView> => {
  let current: SpecialistView
  try {
    current = await specialistService.resolveCustomMutationByName(currentName)
  } catch (error) {
    // Target was renamed or deleted after card creation.
    throw new PrivilegedOpError(method, error)
  }
  if (current.revision !== reviewedRevision) {
    throw new PrivilegedOpError(
      method,
      agentsPublicError(
        `reviewed revision ${reviewedRevision} no longer matches current revision ${current.revision}`
      )
    )
  }
  return current
}

// ---------------------------------------------------------------------------
// Privileged deps
// ---------------------------------------------------------------------------

export type PrivilegedOpDeps = {
  specialistService: SpecialistService
  // The injected approval gateway (issue 02 contract). Real production wiring is the ACP-backed
  // gateway; tests pass fakes. A decline is a normal result, never a thrown error.
  decide: (request: Parameters<ApprovalGateway['decide']>[0]) => Promise<ApprovalResult>
  // The trusted calling-session identity, threaded from server context by the dispatcher (mirroring
  // runSwitch). The ACP-backed gateway parks the approval card on THIS session; an empty session
  // makes the bridge report "approval surface is unavailable" and decline. Optional for test
  // compatibility — production wiring always supplies it.
  session?: TrustedCallingSession
  // Invalidates the runtime catalog (Settings/picker/runtime capability resolution). Invoked ONLY
  // after a successful mutation; never on decline or failure.
  invalidateCatalog?: () => Promise<void> | void
}

// ---------------------------------------------------------------------------
// Delete (privileged, fail-closed bindings)
// ---------------------------------------------------------------------------

export type ApplyDeleteDeps = PrivilegedOpDeps & {
  currentName: string
  reviewedRevision: number
  // OPTIONAL sink that, IF provided, lets a caller (issue 08) observe the deleted Specialist ID.
  // This module NEVER invokes it: delete keeps stable ID bindings so bound conversations resolve unavailable
  // later (design.md §10). It exists only so the contract is testable — a test asserts it is never
  // called. Clearing/rewriting bindings is explicitly forbidden behavior.
  clearSessionBindings?: (specialistId: string) => Promise<void> | void
  deleteSpecialist?: (request: SpecialistDeleteRequest) => Promise<SpecialistDeleteResult>
}

// Approves and deletes a Specialist. On approval, re-resolves name -> ID, verifies the reviewed
// revision, deletes through SpecialistService, verifies absence, invalidates the catalog, and returns
// `{ status: "deleted", name }`. Session ID bindings are NEVER cleared or rewritten. On decline,
// returns `{ status: "declined", operation: "delete" }` with NO mutation. On drift/failure, throws a
// sanitized `host.agents.delete:` error.
export const applyDelete = async (deps: ApplyDeleteDeps): Promise<DeleteResult> => {
  const { specialistService, currentName, reviewedRevision, clearSessionBindings } = deps

  const decision = await deps.decide({
    operation: 'delete',
    summary: { name: currentName },
    session: deps.session ?? {}
  })
  if (decision.status === 'declined') {
    return { status: 'declined', operation: 'delete', reason: decision.reason }
  }

  // Re-resolve and verify revision before mutation. The clearSessionBindings sink is intentionally
  // NOT invoked here or anywhere — delete must not rewrite historical session bindings.
  void clearSessionBindings

  const current = await reResolveForMutation(
    'delete',
    specialistService,
    currentName,
    reviewedRevision
  )

  try {
    if (deps.deleteSpecialist) {
      const result = await deps.deleteSpecialist({
        id: current.id,
        expectedRevision: current.revision,
        deleteSkillIds: []
      })
      if (result.status === 'failed') throw agentsPublicError(result.code)
    } else {
      await specialistService.delete(current.id, current.revision)
    }
  } catch (error) {
    throw new PrivilegedOpError('delete', error)
  }

  // Verify absence: the name no longer resolves. Distinguish the EXPECTED "not found" (deletion
  // succeeded) from an unexpected I/O or data error — mirror session-binding.ts so a corrupt store
  // is diagnosable instead of being silently misreported as a successful deletion.
  let stillPresent = false
  try {
    await specialistService.getByName(currentName)
    stillPresent = true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('not found')) {
      // Not the expected "not found" — an unexpected store/IO failure. Must NOT be treated as
      // "absence verified"; surface it as a sanitized delete error.
      throw new PrivilegedOpError('delete', error)
    }
    // Expected: getByName threw "not found" — absence verified.
  }
  if (stillPresent) {
    throw new PrivilegedOpError(
      'delete',
      agentsPublicError(`specialist "${currentName}" still present after delete`)
    )
  }

  if (!deps.deleteSpecialist && deps.invalidateCatalog) await deps.invalidateCatalog()
  return { status: 'deleted', name: currentName }
}
