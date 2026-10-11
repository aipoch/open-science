// Shared types and validation for reusable Specialists.
// All mutation rules live here so Settings, SDK, and runtime share one contract.

import type {
  SpecialistView as SpecialistProfile,
  CreateSpecialistInput,
  UpdateSpecialistInput,
  BuiltinSpecialistEntry,
  SpecialistDocumentIntegrity
} from '@aipoch/specialists'

// IPC channel names shared between main, preload, and renderer.
export const SPECIALIST_IPC = {
  LIST: 'specialist:list',
  CREATE: 'specialist:create',
  UPDATE: 'specialist:update',
  SET_ENABLED: 'specialist:set-enabled',
  PREVIEW_DELETE: 'specialist:delete-preview',
  DELETE: 'specialist:delete',
  DUPLICATE: 'specialist:duplicate',
  EXPORT_CONTRIBUTION_TEMPLATE: 'specialist:export-contribution-template',
  SELECT_PACKAGE: 'specialist:package-select',
  INSTALL_PACKAGE: 'specialist:package-install',
  CANCEL_PACKAGE: 'specialist:package-cancel',
  SAVE_PACKAGE_REPORT: 'specialist:package-report-save',
  PREVIEW_EXPORT: 'specialist:export-preview',
  EXPORT: 'specialist:export-save',
  CATALOG_CHANGED: 'specialist:catalog-changed',
  // Session switching (issue 07): per-session mutable binding.
  SET_SESSION_SPECIALIST: 'specialist:set-session-specialist',
  RESOLVE_SESSION_SPECIALIST: 'specialist:resolve-session-specialist',
  // Compatibility-only pending selection channel. Approved host.agents.switch() handoffs use the
  // durable lifecycle channel below; this channel carries no authority to resume or reconfigure a
  // prompt. Payload contains only a session id and public target name.
  PENDING_SWITCH: 'specialist:pending-switch',
  HANDOFF_LIFECYCLE_CHANGED: 'specialist:handoff-lifecycle-changed',
  GET_HANDOFF_EVENTS: 'specialist:get-handoff-events',
  RETRY_HANDOFF: 'specialist:retry-handoff',
  CANCEL_HANDOFF: 'specialist:cancel-handoff',
  // Sanitized application-owned handoff ordering metadata. This channel never carries completion
  // envelopes, transcript/history text, connector arguments, credentials, tokens, or raw errors.
  HANDOFF_LIFECYCLE: 'specialist:handoff-lifecycle'
} as const

export type CompletionHandoffPhase =
  | 'awaiting-approval'
  | 'switching'
  | 'reconfiguring'
  | 'continuation-start'
  | 'continued'
  | 'failed'

export type CompletionHandoffRetryFrom = 'switching' | 'reconfiguring' | 'continuation-start'

export type CompletionHandoffLifecycleEvent = {
  id: string
  sessionId: string
  sequence: number
  // Repository-assigned global commit order. Optional only for records written before the field
  // existed; all current lifecycle transitions persist it atomically.
  commitOrder?: number
  observedAt: number
  phase: CompletionHandoffPhase
  target: string | null
  provenance: {
    originatingTurnId: string
    originatingUserMessageId?: string
    attachmentIds: string[]
    artifactIds: string[]
  }
  continuation?: { outcome: string; switchReadback?: unknown }
  failure?: { retryFrom: CompletionHandoffRetryFrom; message: string }
  // A rejected/cancelled approval removes its pre-approval projection. It carries the same safe
  // identity fields as the prior upsert so renderers can remove only that card.
  removed?: true
}

export type CompletionHandoffCommand = { id: string; sessionId: string }

// Compatibility payload for explicit UI selections. The durable completion lifecycle remains the
// source of truth for approved SDK handoffs.
export type PendingSwitchBroadcast = {
  sessionId: string
  // Target Specialist immutable public name, or null to revert to Main Agent. Never a secret.
  targetName: string | null
}

// Session switching request types — resolution type is declared after SpecialistView below.
export type SetSessionSpecialistRequest = {
  sessionId: string
  // undefined clears the binding (reverts to Main Agent).
  specialistId: string | undefined
}

// Response for SET_SESSION_SPECIALIST. Persistence is committed before runtime application, so a
// post-commit runtime/clear failure is reported as an explicit pending state and is never presented
// as a rollback. While pending, Main rejects new user prompts and the renderer keeps drafts queued.
export type SetSessionSpecialistResponse =
  | {
      status: 'applied'
      // True when the live agent session was replaced. The renderer must replay the active Branch
      // history into the next prompt so the new Specialist retains continuity.
      contextReset: boolean
    }
  | {
      status: 'pending'
      reason: 'runtime-application-failed' | 'pending-state-clear-failed'
    }

export type ResolveSessionSpecialistRequest = {
  sessionId: string
}

// The capability scope mode for a specialist.
export type SpecialistMarketplaceProvenance = {
  sourceId: string
  publisher: string
  version: string
}

export type SpecialistView = SpecialistProfile & {
  marketplaceProvenance?: SpecialistMarketplaceProvenance
}

// Filters provisioned `mcp-<id>` connector skill names down to those the specialist is allowed to
// discover. "selected" mode keeps only connectorIds; "full" mode keeps everything except
// excludedConnectorIds. This makes a restrictive skill whitelist (Claude's options.skills) match the
// specialist's connector capability scope, so the agent discovers only the connectors it can call.
// The per-call ConnectorService gate enforces the same config at execution time.
export const filterSpecialistConnectorSkills = (
  connectorSkillNames: string[],
  specialist: Pick<SpecialistView, 'capabilityMode' | 'fullAccess' | 'selectedCapabilities'>
): string[] => {
  const isAllowed =
    specialist.capabilityMode === 'full'
      ? (connectorId: string) => !specialist.fullAccess.excludedConnectorIds.includes(connectorId)
      : (connectorId: string) => specialist.selectedCapabilities.connectorIds.includes(connectorId)
  return connectorSkillNames.filter((skillName) => {
    const connectorId = skillName.replace(/^mcp-/, '')
    return isAllowed(connectorId)
  })
}

// The built-in Reviewer entry shown in the list (read-only, never a real profile).
export type ReviewerEntry = {
  kind: 'reviewer'
  id: 'reviewer'
}

// Exhaustive Settings/runtime catalog discriminant. Reviewer remains a placeholder, never a
// runnable Specialist.
export type SpecialistListItem =
  ({ kind: 'custom' } & SpecialistView) | BuiltinSpecialistEntry | ReviewerEntry

export type SpecialistCatalogSnapshot = Readonly<{
  items: SpecialistListItem[]
  integrity: SpecialistDocumentIntegrity
}>

// Resolution of a session's specialist binding at send time (requires SpecialistView above).
// 'main'        — no binding, main agent is used.
// 'bound'       — a valid enabled Specialist was found.
// 'unavailable' — the bound Specialist ID is unknown, disabled, or corrupt (send must be blocked).
export type SessionSpecialistResolution =
  | { kind: 'main' }
  | { kind: 'bound'; profile: SpecialistView }
  | { kind: 'unavailable'; reason: string }

// Request / response types for IPC.
export type CreateSpecialistRequest = CreateSpecialistInput
export type UpdateSpecialistRequest = UpdateSpecialistInput

export type SetSpecialistEnabledRequest = {
  id: string
  enabled: boolean
}

export type DeleteSpecialistRequest = { id: string; expectedRevision?: number }
export type DuplicateSpecialistRequest = { id: string }

export type ContributionTemplateExportResult = { saved: boolean }
export type SpecialistPackageReportSaveResult = { saved: boolean }
export type SpecialistExportSaveResult = { saved: boolean }
