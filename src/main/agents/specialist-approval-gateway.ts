// Concrete Specialist approval gateway backed by the existing ACP permission broker (issue 04).
//
// This module implements issue 02's `ApprovalGateway` contract for privileged Specialist operations
// (name-changing update, delete, switch) WITHOUT introducing a second request store, responder, or
// approval state machine. The existing ACP permission broker owns parking, publication, response
// validation, cancellation, and standard session permission rendering. This gateway only:
//   1. Maps the issue 02 `ApprovalRequest` into a redacted `SpecialistPermissionCardPayload`
//      (minimum public summary; no system instructions, UUIDs, secrets, tokens, or connector args).
//   2. Hands that payload to an injected `SpecialistPermissionBridge`, which delegates parking /
//      publication / cancellation / response validation to the ACP broker's lifecycle.
//   3. Shapes the bridge's decision into the `ApprovalResult` union (decline is a normal result).
//
// The bridge is intentionally the ONLY mutation authority over pending requests — this gateway holds
// no pending map and exposes no `respond()`. Issue 08 wires the bridge's concrete ACP-backed
// implementation into the dispatcher; tests pass fakes. The mapper functions come from the issue 04
// presentation module (no issue 03/05 implementation import).

import type {
  AgentsDeclinedResult,
  AgentsApprovedResult,
  ApprovalGateway,
  ApprovalRequest,
  ApprovalResult,
  SpecialistPermissionCardPayload,
  TrustedCallingSession
} from '../../shared/agents-contract'

// ---------------------------------------------------------------------------
// The injected bridge: the ACP-broker-backed transport for one approval decision
// ---------------------------------------------------------------------------

// INJECTED seam. The concrete implementation parks the card payload on the EXISTING ACP permission
// broker (which owns the pending map, publication, response validation, cancellation, and standard
// session permission rendering), awaits the renderer's decision, and returns a normalized result.
// `requestApproval` resolves with a decision the gateway can shape into an `ApprovalResult`; a
// cancelled/timeout/unanswered request is reported as a decline (design.md §8) — never an error.
//
// This interface deliberately exposes NO `respond()` and NO pending store: those live in the ACP
// broker behind the concrete implementation. That is what "no second approval system" means.
export type SpecialistPermissionBridge = {
  requestApproval(
    payload: SpecialistPermissionCardPayload,
    session: TrustedCallingSession
  ): Promise<SpecialistBridgeDecision>
}

// What the bridge resolves to. The bridge normalizes ACP outcomes (selected option, cancelled,
// timeout) into one of these; the gateway maps them onto the `ApprovalResult` union.
export type SpecialistBridgeDecision =
  { outcome: 'approved' } | { outcome: 'declined'; reason?: string }

// Exported for tests that build a fake and assert its shape without re-declaring the type.
export type SpecialistPermissionBridgeInFlight = SpecialistPermissionBridge

export type AcpSpecialistApprovalGatewayDeps = {
  bridge: SpecialistPermissionBridge
}

// ---------------------------------------------------------------------------
// Request -> card payload mapping (reuses the issue 04 presentation contract)
// ---------------------------------------------------------------------------

// Maps an issue 02 `ApprovalRequest` to the redacted card payload for the renderer. This is a pure
// transform over the request's public summary fields — it never reads system instructions, UUIDs,
// secrets, tokens, or connector args, and the produced payload provably excludes them.
const toCardPayload = (request: ApprovalRequest): SpecialistPermissionCardPayload => {
  const { operation, summary } = request
  if (operation === 'update') {
    return {
      kind: 'update',
      name: summary.name ?? '',
      newName: summary.newName ?? summary.name ?? '',
      // Name-changing update carries no other-field manifest here: the dispatcher (issue 08) builds
      // the full manifest via mapUpdateApprovalCard before calling decide(). The gateway only echoes
      // the summary it was handed. Bindings are always stable across a rename.
      changes: [],
      bindingsStable: true
    }
  }
  if (operation === 'delete') {
    return {
      kind: 'delete',
      name: summary.name ?? '',
      // Bound conversations become unavailable and are NOT switched to Main Agent.
      boundConversationsUnavailable: true
    }
  }
  // switch
  return {
    kind: 'switch',
    // summary.name is the CURRENT specialist (or null/omitted when on Main Agent).
    currentName: summary.name ?? null,
    // summary.target is the TARGET specialist, or null to revert to Main Agent.
    targetName: summary.target ?? null,
    takesEffectAfterCurrentTool: true
  }
}

// ---------------------------------------------------------------------------
// Concrete gateway
// ---------------------------------------------------------------------------

// Implements issue 02's `ApprovalGateway` over the existing ACP permission broker via the injected
// bridge. Holds no state of its own. A decline (or cancelled/timeout card) is a normal result.
export class AcpSpecialistApprovalGateway implements ApprovalGateway {
  constructor(private readonly deps: AcpSpecialistApprovalGatewayDeps) {}

  async decide(request: ApprovalRequest): Promise<ApprovalResult> {
    const payload = toCardPayload(request)
    const decision = await this.deps.bridge.requestApproval(payload, request.session)
    if (decision.outcome === 'approved') {
      const approved: AgentsApprovedResult = { status: 'approved' }
      return approved
    }
    const declined: AgentsDeclinedResult = {
      status: 'declined',
      operation: request.operation,
      ...(decision.reason ? { reason: decision.reason } : {})
    }
    return declined
  }
}

// ---------------------------------------------------------------------------
// Concrete ACP-backed bridge factory (used by issue 08 composition)
// ---------------------------------------------------------------------------

// The narrow transport the ACP broker already exposes, expressed without importing the broker type
// directly (so this module stays free of a src/main/acp import at type-check time and remains
// independently testable). Issue 08 supplies an adapter over the real `AcpPermissionBroker` that
// satisfies this shape by parking the payload, broadcasting the card, and resolving on `respond`.
export type SpecialistPermissionTransport = {
  // Parks the card payload on the broker, publishes it to the renderer, and resolves with the
  // renderer's decision (or a cancelled/timeout decline). The transport OWNS the pending state —
  // this gateway never does.
  request(
    payload: SpecialistPermissionCardPayload,
    session: TrustedCallingSession
  ): Promise<SpecialistBridgeDecision>
}

// Builds a `SpecialistPermissionBridge` whose concrete implementation delegates parking,
// publication, response validation, cancellation, and standard session rendering to the supplied
// transport (the existing ACP permission broker). This is the single composition point where issue
// 08 connects the gateway to the real broker without introducing a second approval system.
export const createAcpBackedSpecialistBridge = (
  transport: SpecialistPermissionTransport
): SpecialistPermissionBridge => ({
  requestApproval: (payload, session) => transport.request(payload, session)
})
