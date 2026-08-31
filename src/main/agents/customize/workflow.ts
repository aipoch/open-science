// Customize Skill workflow policy — the pure rules that govern the conversational `/customize` flow.
//
// design.md §7 defines the workflow: scope → live read → complete draft → applicable confirmation →
// mutation → read-back. This module turns those rules into pure, testable functions the Skill (and
// its contract tests) drive against a `host.agents` SDK (real in production, fake in tests).
//
// The Skill is WORKFLOW GUIDANCE, not a security boundary (design.md §11, PRD §10). It never merges
// or auto-retries; it never treats the chat entry as authorization; it never exposes UUIDs/revisions
// in ordinary prose. Confirmation boundaries (design.md §7):
//  - ordinary mutations (create and update): chat review + explicit textual confirmation; no
//    second system permission card;
//  - privileged mutations (delete and switch): explain the impending action, then
//    invoke the SDK — the standard permission card is the single authorization point.

import type { SpecialistDetailReadModel, ConnectorReadModel } from '../agents-service'

// ---------------------------------------------------------------------------
// Scope clarification (design.md §5: never silently grant Full)
// ---------------------------------------------------------------------------

// When the user has not specified Full versus Selected, the Skill MUST ask. It must not use the SDK's
// omitted-fields Full default silently.
export type CapabilityScope = 'full' | 'selected' | 'unspecified'

export const resolveCreateScope = (input: {
  unrestricted?: boolean
  skillNames?: unknown
  connectorNames?: unknown
}): CapabilityScope => {
  if (input.unrestricted === true) return 'full'
  if (input.skillNames !== undefined || input.connectorNames !== undefined) return 'selected'
  return 'unspecified'
}

// The conversational clarification the Skill emits when scope is unspecified. Fixed UI-facing copy
// stays English (PRD §10). Returns whether the Skill must stop and ask before drafting.
export const mustAskForScope = (scope: CapabilityScope): boolean => scope === 'unspecified'

export const SCOPE_CLARIFICATION =
  'Do you want this specialist to have full access (same capabilities as Main) or selected ' +
  'capabilities (a specific list of skills and connectors)? I will not assume full access for you.'

// ---------------------------------------------------------------------------
// Live read + complete draft (design.md §6, §7)
// ---------------------------------------------------------------------------

// The reviewed target state. Mirrors the ordinary-review checklist (design.md §7). The Skill reads
// live Profiles plus Skill/Connector catalogs before proposing this.
export type ReviewedTargetState = {
  name: string
  displayName: string
  description: string
  systemPrompt: string
  iconKey?: string
  colorKey?: string
  enabled: boolean
  capabilityMode: 'full' | 'selected'
  skillIds: string[]
  connectorIds: string[]
  revision: number
}

export const buildReviewedTarget = (
  profile: SpecialistDetailReadModel,
  connectorCatalog: ConnectorReadModel[] = []
): ReviewedTargetState => {
  const connectorNameById = new Map(connectorCatalog.map(({ id, name }) => [id, name]))
  return {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    iconKey: profile.iconKey,
    colorKey: profile.colorKey,
    enabled: profile.enabled,
    capabilityMode: profile.capabilityMode,
    skillIds: profile.selectedCapabilities.skillIds,
    // The profile persists local IDs, including Custom Connector UUIDs. Reviews and SDK mutation
    // inputs use immutable public names so internal UUIDs never reach ordinary user-facing prose.
    connectorIds: profile.selectedCapabilities.connectorIds.map(
      (id) => connectorNameById.get(id) ?? id
    ),
    revision: profile.revision
  }
}

// A textual review of the complete target state for the ordinary-mutation chat review. It shows every
// field the checklist requires AND states that Connector tool scope is not configured (design.md §7,
// PRD §4) — it must NOT represent tool scope as an empty reviewed configuration. It deliberately
// omits UUIDs/revisions from ordinary prose (design.md §4).
export const renderOrdinaryReview = (
  target: ReviewedTargetState,
  changedFields?: string[]
): string => {
  const lines: string[] = []
  lines.push(`Name: ${target.name}`)
  lines.push(`Display name: ${target.displayName}`)
  lines.push(`Description: ${target.description}`)
  lines.push('Full system instructions:')
  lines.push(target.systemPrompt)
  if (target.iconKey) lines.push(`Icon: ${target.iconKey}`)
  if (target.colorKey) lines.push(`Color: ${target.colorKey}`)
  lines.push(`Enabled: ${target.enabled ? 'yes' : 'no'}`)
  lines.push(`Mode: ${target.capabilityMode}`)
  lines.push(`Skills: ${target.skillIds.length ? target.skillIds.join(', ') : '(none)'}`)
  lines.push(
    `Connectors: ${target.connectorIds.length ? target.connectorIds.join(', ') : '(none)'}`
  )
  lines.push('Connector tool scope: not configured in this milestone')
  if (changedFields && changedFields.length > 0) {
    lines.push(`Changed fields: ${changedFields.join(', ')}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Confirmation boundaries (design.md §7)
// ---------------------------------------------------------------------------

export type OperationKind = 'create' | 'ordinary-update' | 'delete' | 'switch'

// Ordinary mutations use chat review + explicit textual confirmation and do NOT request a second
// system permission card. Name-changing update, delete, and switch explain the impending action and
// invoke the SDK directly; the standard card is the only authorization point.
export const requiresSystemPermissionCard = (kind: OperationKind): boolean =>
  kind === 'delete' || kind === 'switch'

// Whether the operation waits for an explicit textual confirmation in chat BEFORE mutating (ordinary
// path). Privileged ops do not require a separate preceding "yes": the card is the authorization.
export const requiresTextualConfirmation = (kind: OperationKind): boolean =>
  kind === 'create' || kind === 'ordinary-update'

// The textual confirmation token the ordinary path waits for. Case-insensitive substring match.
export const isExplicitConfirmation = (text: string): boolean =>
  /\b(yes|confirm|ok|okay)\b/i.test(text.trim())

// ---------------------------------------------------------------------------
// Revision / stale-draft handling (design.md §8)
// ---------------------------------------------------------------------------

// A draft is stale when the reviewed revision no longer matches the live record. A changed draft or
// stale revision invalidates prior textual confirmation and requires a fresh read/review. The Skill
// does NOT merge or auto-retry.
export const isStaleRevision = (reviewedRevision: number, liveRevision: number): boolean =>
  reviewedRevision !== liveRevision

// A changed draft invalidates prior confirmation: after the user edits the draft, the Skill must
// re-review. Returns true when the current draft differs from the draft that was confirmed.
export const draftChangedSinceConfirmation = <T>(
  currentDraft: T,
  confirmedDraft: T | undefined
): boolean =>
  confirmedDraft === undefined || JSON.stringify(currentDraft) !== JSON.stringify(confirmedDraft)

// ---------------------------------------------------------------------------
// Atomic-update preference (design.md §7: prefer one atomic update over attach/detach loops)
// ---------------------------------------------------------------------------

// Multi-field ordinary changes prefer one atomic update instead of attach/detach loops that could
// partially succeed. Returns the single update patch to apply, or null when only a single collection
// moves by one element (an incremental attach/detach is acceptable there).
export type OrdinaryChangePlan = {
  kind: 'atomic-update'
  patch: {
    displayName?: string
    description?: string
    systemPrompt?: string
    iconKey?: string
    colorKey?: string
    enabled?: boolean
    skillNames?: string[]
    connectorNames?: string[]
  }
}

export const preferAtomicUpdate = (
  target: ReviewedTargetState,
  live: ReviewedTargetState
): OrdinaryChangePlan => {
  const patch: OrdinaryChangePlan['patch'] = {}
  if (target.displayName !== live.displayName) patch.displayName = target.displayName
  if (target.description !== live.description) patch.description = target.description
  if (target.systemPrompt !== live.systemPrompt) patch.systemPrompt = target.systemPrompt
  if ((target.iconKey ?? '') !== (live.iconKey ?? '')) patch.iconKey = target.iconKey
  if ((target.colorKey ?? '') !== (live.colorKey ?? '')) patch.colorKey = target.colorKey
  if (target.enabled !== live.enabled) patch.enabled = target.enabled
  const skillChanged = JSON.stringify(target.skillIds) !== JSON.stringify(live.skillIds)
  const connectorChanged = JSON.stringify(target.connectorIds) !== JSON.stringify(live.connectorIds)
  if (skillChanged) patch.skillNames = target.skillIds
  if (connectorChanged) patch.connectorNames = target.connectorIds
  return { kind: 'atomic-update', patch }
}

// ---------------------------------------------------------------------------
// Privileged operation explanations (design.md §7 permission cards)
// ---------------------------------------------------------------------------

// These explanations are shown in chat BEFORE invoking the SDK; the standard permission card is the
// only authorization point. They do not show UUIDs, secrets, or the full system prompt.
export const explainSwitch = (currentName: string | null, targetName: string | null): string =>
  `About to switch this conversation from ${currentName ?? 'Main Agent'} to ${
    targetName ?? 'Main Agent'
  }. If approved, the current control tool finishes and the conversation continues automatically under the approved identity.`

export const explainDelete = (name: string): string =>
  `About to delete "${name}". Conversations still bound to it become unavailable; they are not ` +
  'switched to Main Agent.'

// ---------------------------------------------------------------------------
// Reporting (design.md §8 read-back, §9 switch timing, §10 delete)
// ---------------------------------------------------------------------------

// Switch reporting: approval lets the current control tool finish, then continues the same task.
export const reportSwitch = (targetName: string | null): string =>
  `The approved target (${targetName ?? 'Main Agent'}) will continue this task automatically after the current control tool finishes.`

// Delete reporting: bound conversations become unavailable, NOT switched to Main Agent.
export const reportDelete = (name: string): string =>
  `Deleted "${name}". Existing conversations that were bound to it are now unavailable and are NOT ` +
  'switched to Main Agent; the user must choose a specialist or Main Agent explicitly.'
