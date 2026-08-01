// Pass-through Specialist approval gateway (issue 08a milestone composition).
//
// In this milestone the user-facing confirmation for privileged Specialist operations (name-changing
// update, delete, switch) is the `/customize` Skill's chat-text review, NOT the standard ACP
// permission card (that card is a separate, later issue — see issue 08d for the documented security
// tradeoff). The SDK approval gateway is therefore a PASS-THROUGH: every `decide()` resolves to an
// immediate `{ status: 'approved' }`.
//
// This object exists as an explicit SUBSTITUTION POINT: the dispatcher routes every privileged op
// THROUGH the `ApprovalGateway` seam (issue 02 contract). Swapping in a future standard-card
// gateway (a separate issue) requires no dispatcher, Skill, or issue-02 contract change — only the
// injected implementation here changes.
//
// Cross-cutting requirements honored (issue 08a):
//  - It holds NO pending state, NO second approval store, NO responder, and NO state machine. It is
//    a single pure function dressed as the gateway interface.
//  - A decline never happens on this gateway, so structured declines never originate here. (The
//    result type still allows declines so the seam shape is stable for the future card gateway.)

import type { ApprovalGateway, ApprovalResult } from '../../shared/agents-contract'

// The pass-through decision. Always approved; never throws, never parks a card, never waits. Kept as
// a constant so the gateway is allocation-free and provably stateless.
const PASSTHROUGH_APPROVED: ApprovalResult = { status: 'approved' }

// The pass-through approval gateway. Inject this wherever an `ApprovalGateway` is required during
// the chat-confirmation milestone; replace it with the standard-card gateway when that lands.
export const passthroughApprovalGateway: ApprovalGateway = {
  decide(): Promise<ApprovalResult> {
    return Promise.resolve(PASSTHROUGH_APPROVED)
  }
}
