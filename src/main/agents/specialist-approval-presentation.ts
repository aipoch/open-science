// Standard renderer presentation mapper for privileged Specialist operations (issue 04).
//
// This module is the SINGLE producer of `SpecialistPermissionCardPayload` — the redacted, public
// card surface the renderer renders for name-changing update, delete, and switch (design.md §7,
// PRD §6, prototype.html scenes 5/7/8). It is pure and side-effect free so it is independently
// testable with issue 02 contracts/fakes.
//
// Cross-cutting invariants enforced here (design.md §14, issue 04 acceptance):
//  - Cards carry ONLY minimum public change summaries. They never embed complete system
//    instructions, descriptions, capability lists, UUIDs, secrets, RPC tokens, or connector args.
//    Full target state lives in the chat review, never on a card.
//  - The name-changing update card shows old name -> new name plus a COMPACT manifest of every other
//    field changed in the same atomic patch (edited / added-removed counts), and states that stable
//    conversation bindings are unaffected.
//  - The delete card states that bound conversations become UNAVAILABLE and are NOT auto-switched
//    to Main Agent.
//  - The switch card states "takes effect on the next message".
//
// This module imports ONLY shared types + the Profile view type. It does not import issue 03 or
// issue 05 implementation modules.

import type {
  SpecialistDeleteCardPayload,
  SpecialistFieldChange,
  SpecialistSwitchCardPayload,
  SpecialistUpdateCardPayload
} from '../../shared/agents-contract'
import type {
  SpecialistFullAccessConfig,
  SpecialistProfileView,
  SpecialistSelectedConfig
} from '../../shared/specialist'

// The validated update patch this mapper consumes. Fields are the host.agents.update patch fields
// (design.md §4 / PRD §3). `name` is the rename that makes the whole patch privileged; the mapper
// never reads it into the change manifest (it is shown as old -> new instead).
export type SpecialistUpdatePatch = {
  name?: string
  displayName?: string
  description?: string
  systemPrompt?: string
  iconKey?: string
  colorKey?: string
  enabled?: boolean
  capabilityMode?: 'full' | 'selected'
  fullAccess?: SpecialistFullAccessConfig
  selectedCapabilities?: SpecialistSelectedConfig
}

// Computes the added/removed/total counts for a capability collection that is being exactly
// replaced by the patch. Returns undefined when the patch did not touch the collection.
const collectionChange = (
  before: readonly string[],
  after: readonly string[] | undefined
): { added: number; removed: number; total: number } | undefined => {
  if (after === undefined) return undefined
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  let added = 0
  let removed = 0
  for (const id of afterSet) if (!beforeSet.has(id)) added += 1
  for (const id of beforeSet) if (!afterSet.has(id)) removed += 1
  return { added, removed, total: after.length }
}

// Projects the active capability collection (skills/connectors) for the profile's current mode, so
// the manifest reflects what the user actually sees today.
const activeSkills = (profile: SpecialistProfileView): readonly string[] =>
  profile.capabilityMode === 'full'
    ? profile.fullAccess.excludedSkillIds
    : profile.selectedCapabilities.skillIds

const activeConnectors = (profile: SpecialistProfileView): readonly string[] =>
  profile.capabilityMode === 'full'
    ? profile.fullAccess.excludedConnectorIds
    : profile.selectedCapabilities.connectorIds

// Builds the compact change manifest for every field the patch changes OTHER than `name`. System
// instructions and free text appear as an `edited` entry with no body; capability collections appear
// as `collection` entries with counts. Order is stable for deterministic snapshots.
const buildChangeManifest = (
  current: SpecialistProfileView,
  patch: SpecialistUpdatePatch
): SpecialistFieldChange[] => {
  const changes: SpecialistFieldChange[] = []

  if (patch.displayName !== undefined && patch.displayName !== current.displayName) {
    changes.push({ field: 'display name', kind: 'edited' })
  }
  if (patch.description !== undefined && patch.description !== current.description) {
    changes.push({ field: 'description', kind: 'edited' })
  }
  if (patch.systemPrompt !== undefined && patch.systemPrompt !== current.systemPrompt) {
    // Never embed the prompt text — the card only signals that it changed.
    changes.push({ field: 'system instructions', kind: 'edited' })
  }
  if (patch.iconKey !== undefined && patch.iconKey !== current.iconKey) {
    changes.push({
      field: 'icon',
      kind: 'changed',
      from: String(current.iconKey ?? ''),
      to: patch.iconKey
    })
  }
  if (patch.colorKey !== undefined && patch.colorKey !== current.colorKey) {
    changes.push({
      field: 'color',
      kind: 'changed',
      from: String(current.colorKey ?? ''),
      to: patch.colorKey
    })
  }
  if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
    changes.push({
      field: 'enabled',
      kind: 'changed',
      from: current.enabled ? 'enabled' : 'disabled',
      to: patch.enabled ? 'enabled' : 'disabled'
    })
  }
  if (patch.capabilityMode !== undefined && patch.capabilityMode !== current.capabilityMode) {
    changes.push({
      field: 'capability mode',
      kind: 'changed',
      from: current.capabilityMode,
      to: patch.capabilityMode
    })
  }

  // Capability collections: when a selected patch replaces skills/connectors, show counts. When the
  // mode also changes, the "before" collection is read from the profile's current mode.
  if (patch.selectedCapabilities !== undefined) {
    const skills = collectionChange(activeSkills(current), patch.selectedCapabilities.skillIds)
    if (skills && !(skills.added === 0 && skills.removed === 0)) {
      changes.push({ field: 'skills', kind: 'collection', ...skills })
    }
    const connectors = collectionChange(
      activeConnectors(current),
      patch.selectedCapabilities.connectorIds
    )
    if (connectors && !(connectors.added === 0 && connectors.removed === 0)) {
      changes.push({ field: 'connectors', kind: 'collection', ...connectors })
    }
  }
  if (patch.fullAccess !== undefined) {
    const skills = collectionChange(activeSkills(current), patch.fullAccess.excludedSkillIds)
    if (skills && !(skills.added === 0 && skills.removed === 0)) {
      changes.push({ field: 'skills', kind: 'collection', ...skills })
    }
    const connectors = collectionChange(
      activeConnectors(current),
      patch.fullAccess.excludedConnectorIds
    )
    if (connectors && !(connectors.added === 0 && connectors.removed === 0)) {
      changes.push({ field: 'connectors', kind: 'collection', ...connectors })
    }
  }

  return changes
}

// Renders the name-changing update card (prototype scene 7). `current` is the live profile the card
// was created against; `patch` is the validated update patch (which MUST include a new `name`).
// The mapper trusts its caller to only invoke it for a name-changing patch; it does not re-classify.
export const mapUpdateApprovalCard = (
  current: SpecialistProfileView,
  patch: SpecialistUpdatePatch
): SpecialistUpdateCardPayload => ({
  kind: 'update',
  name: current.name,
  newName: patch.name ?? current.name,
  changes: buildChangeManifest(current, patch),
  // Bindings follow the profile UUID, not the public name, so they keep working after a rename.
  bindingsStable: true
})

// Renders the delete card (prototype scene 8). Bound conversations resolve as unavailable and are
// NOT silently switched to Main Agent (design.md §10).
export const mapDeleteApprovalCard = (
  current: SpecialistProfileView
): SpecialistDeleteCardPayload => ({
  kind: 'delete',
  name: current.name,
  boundConversationsUnavailable: true
})

// Renders the switch card (prototype scene 5). `currentName`/`targetName` are public Specialist
// display names, or null for Main Agent. The switch takes effect on the NEXT message (design.md §9).
export const mapSwitchApprovalCard = (
  currentName: string | null,
  targetName: string | null
): SpecialistSwitchCardPayload => ({
  kind: 'switch',
  currentName,
  targetName,
  takesEffectOnNextMessage: true
})
