// Standard renderer presentation mapper for privileged Specialist operations (issue 04).
//
// This module is the SINGLE producer of `SpecialistPermissionCardPayload` — the redacted, public
// card surface the renderer renders for delete and switch (design.md §7, PRD §6, prototype.html
// scenes 5/8). It is pure and side-effect free so it is independently testable with issue 02
// contracts/fakes.
//
// Cross-cutting invariants enforced here (design.md §14, issue 04 acceptance):
//  - Cards carry ONLY minimum public change summaries. They never embed complete system
//    instructions, descriptions, capability lists, UUIDs, secrets, RPC tokens, or connector args.
//    Full target state lives in the chat review, never on a card.
//  - The delete card states that bound conversations become UNAVAILABLE and are NOT auto-switched
//    to Main Agent.
//  - The switch card states that approval transfers execution after the current control tool.
//
// This module imports ONLY shared types + the Profile view type. It does not import issue 03 or
// issue 05 implementation modules.

import type {
  SpecialistDeleteCardPayload,
  SpecialistSwitchCardPayload
} from '../../shared/agents-contract'
import type { SpecialistView } from '../../shared/specialist'

// Renders the delete card (prototype scene 8). Bound conversations resolve as unavailable and are
// NOT silently switched to Main Agent (design.md §10).
export const mapDeleteApprovalCard = (current: SpecialistView): SpecialistDeleteCardPayload => ({
  kind: 'delete',
  name: current.name,
  boundConversationsUnavailable: true
})

// Renders the switch card (prototype scene 5). `currentName`/`targetName` are public Specialist
// display names, or null for Main Agent. The switch takes effect after the current control tool.
export const mapSwitchApprovalCard = (
  currentName: string | null,
  targetName: string | null
): SpecialistSwitchCardPayload => ({
  kind: 'switch',
  currentName,
  targetName,
  takesEffectAfterCurrentTool: true
})
