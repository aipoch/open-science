// Shared types and validation for Personal Specialist Profiles.
// All mutation rules live here so Settings, SDK, and runtime share one contract.

import { RESOURCE_ID_MAX_LENGTH, inferResourceId, validateResourceId } from './resource-id'

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

// Session switching request types — resolution type is declared after SpecialistProfileView below.
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
export type SpecialistCapabilityMode = 'full' | 'selected'

// Per-connector tool-level rules. Uses bare method names (no connector prefix).
export type ConnectorToolRule = {
  connectorId: string
  includedMethods?: string[]
  excludedMethods?: string[]
  includeToolsPattern?: string
  excludeToolsPattern?: string
}

// Full access mode config: default-include-all, explicit exclusions only.
export type SpecialistFullAccessConfig = {
  excludedSkillIds: string[]
  excludedConnectorIds: string[]
  connectorTools: ConnectorToolRule[]
}

// Selected capabilities mode config: default-exclude-all, explicit inclusions only.
export type SpecialistSelectedConfig = {
  skillIds: string[]
  connectorIds: string[]
  connectorTools: ConnectorToolRule[]
}

// A Skill catalog entry deliberately uses the durable app id for policy and the framework-facing
// name only at the transport boundary. Main Agent enablement is not represented here: Specialists
// own their capability policy independently of the Main Agent's disabled-skill preference.
export type SpecialistSkillCatalogEntry = {
  id: string
  frameworkName: string
  displayName?: string
}

export type EffectiveSpecialistSkills =
  | { kind: 'main' }
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'specialist'
      skillIds: string[]
      frameworkNames: string[]
      missingSkillIds: string[]
    }

export type SpecialistMarketplaceProvenance = {
  sourceId: string
  publisher: string
  version: string
}

// Resolve against the live catalog; callers must not snapshot catalog contents into a profile or
// session. Full access includes future entries by construction, while selected is an explicit list.
export const resolveEffectiveSpecialistSkills = (
  specialist:
    | Pick<SpecialistProfileView, 'capabilityMode' | 'fullAccess' | 'selectedCapabilities'>
    | undefined,
  catalog: SpecialistSkillCatalogEntry[]
): EffectiveSpecialistSkills => {
  if (specialist === undefined) return { kind: 'main' }
  const byId = new Map(catalog.map((skill) => [skill.id, skill]))
  const requestedIds =
    specialist.capabilityMode === 'full'
      ? catalog
          .filter((skill) => !specialist.fullAccess.excludedSkillIds.includes(skill.id))
          .map((skill) => skill.id)
      : specialist.selectedCapabilities.skillIds

  const skillIds: string[] = []
  const frameworkNames: string[] = []
  const missingSkillIds: string[] = []
  for (const id of requestedIds) {
    const skill = byId.get(id)
    if (!skill) {
      // Exclusions are valid durable references too, but a missing exclusion has no local effect.
      if (specialist.capabilityMode === 'selected') missingSkillIds.push(id)
      continue
    }
    if (skillIds.includes(id)) continue
    skillIds.push(id)
    frameworkNames.push(skill.frameworkName)
  }
  return { kind: 'specialist', skillIds, frameworkNames, missingSkillIds }
}

// Filters provisioned `mcp-<id>` connector skill names down to those the specialist is allowed to
// discover. "selected" mode keeps only connectorIds; "full" mode keeps everything except
// excludedConnectorIds. This makes a restrictive skill whitelist (Claude's options.skills) match the
// specialist's connector capability scope, so the agent discovers only the connectors it can call.
// The per-call ConnectorService gate enforces the same config at execution time.
export const filterSpecialistConnectorSkills = (
  connectorSkillNames: string[],
  specialist: Pick<SpecialistProfileView, 'capabilityMode' | 'fullAccess' | 'selectedCapabilities'>
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

// Renderer-safe view of one specialist profile (no secret fields).
export type SpecialistProfileView = {
  id: string
  name: string // immutable-reference-safe public UPPER_SNAKE identifier
  displayName?: string
  description: string
  systemPrompt: string
  iconKey?: string
  colorKey?: string
  enabled: boolean
  // Imported Specialists remain non-runnable until their first editor save completes setup.
  setupPending?: boolean
  capabilityMode: SpecialistCapabilityMode
  fullAccess: SpecialistFullAccessConfig
  selectedCapabilities: SpecialistSelectedConfig
  revision: number
  packageVersion?: string
  origin?: 'local' | 'imported' | 'marketplace'
  // Derived from the current portable profile and importBaseline; never persisted.
  modifiedSinceImport?: boolean
  // Derived from exact Marketplace provenance plus the current import archive digest; never
  // persisted with the Specialist profile. Absent for manual imports and historical provenance
  // that cannot prove it still describes the installed package.
  marketplaceProvenance?: SpecialistMarketplaceProvenance
  ownedSkillIds?: string[]
  importBaseline?: {
    importedAt: string
    archiveDigest: string
    contentDigest: string
    packageContentDigest?: string
    packageVersion?: string
  }
}

// The built-in Reviewer entry shown in the list (read-only, never a real profile).
export type ReviewerEntry = {
  kind: 'reviewer'
  id: 'reviewer'
}

export type BuiltinSpecialistEntry = {
  kind: 'builtin'
  readonly: true
  version: string
} & SpecialistProfileView

// Exhaustive Settings/runtime catalog discriminant. Reviewer remains a placeholder, never a
// runnable profile.
export type SpecialistListItem =
  ({ kind: 'custom' } & SpecialistProfileView) | BuiltinSpecialistEntry | ReviewerEntry

export type SpecialistDocumentIntegrityIssue = Readonly<{
  code:
    | 'document-invalid'
    | 'version-unsupported'
    | 'legacy-schema-unsupported'
    | 'record-invalid'
    | 'record-sanitized'
  // Position only; never return the malformed record because it may contain system instructions or
  // unexpected sensitive fields.
  recordIndex?: number
}>

export type SpecialistDocumentIntegrity =
  | Readonly<{ status: 'ok' }>
  | Readonly<{
      status: 'degraded'
      issues: readonly SpecialistDocumentIntegrityIssue[]
    }>

export type SpecialistCatalogSnapshot = Readonly<{
  items: SpecialistListItem[]
  integrity: SpecialistDocumentIntegrity
}>

// Resolution of a session's specialist binding at send time (requires SpecialistProfileView above).
// 'main'        — no binding, main agent is used.
// 'bound'       — a valid enabled profile was found.
// 'unavailable' — the bound Specialist ID is unknown, disabled, or corrupt (send must be blocked).
export type SessionSpecialistResolution =
  | { kind: 'main' }
  | { kind: 'bound'; profile: SpecialistProfileView }
  | { kind: 'unavailable'; reason: string }

// Input for creating a new specialist.
export type CreateSpecialistInput = {
  // Optional immutable public ID. Omission lets the main process infer one from `name` and fall back
  // to a UUID when the inferred value is unsafe or already used.
  id?: string
  name: string
  displayName?: string
  description?: string
  systemPrompt?: string
  iconKey?: string
  colorKey?: string
  capabilityMode?: SpecialistCapabilityMode
  fullAccess?: SpecialistFullAccessConfig
  selectedCapabilities?: SpecialistSelectedConfig
}

// Input for updating an existing specialist. Both capability configurations are
// deliberately independent of the active mode: switching modes must never throw
// away the other mode's connector (or skill) selection. `revision` enables
// optimistic concurrency (must match the stored record).
export type UpdateSpecialistInput = {
  id: string
  revision: number
  packageVersion?: string
  displayName?: string
  description?: string
  systemPrompt?: string
  iconKey?: string
  colorKey?: string
  enabled?: boolean
  // Narrow import lifecycle operation. When true for a pending Specialist, the submitted editor
  // fields and capabilities are committed atomically with setup completion and enablement.
  completeSetup?: true
  capabilityMode?: SpecialistCapabilityMode
  fullAccess?: SpecialistFullAccessConfig
  selectedCapabilities?: SpecialistSelectedConfig
}

// Request / response types for IPC.
export type CreateSpecialistRequest = CreateSpecialistInput
export type UpdateSpecialistRequest = UpdateSpecialistInput

export type SetSpecialistEnabledRequest = {
  id: string
  enabled: boolean
}

export type DeleteSpecialistRequest = { id: string; expectedRevision?: number }
export type DuplicateSpecialistRequest = { id: string }

// Validation error for a single field.
export type SpecialistFieldError = {
  field: 'id' | 'name' | 'description' | 'systemPrompt' | 'packageVersion'
  message: string
}

// ---------------------------------------------------------------------------
// Field length limits
// ---------------------------------------------------------------------------

// Hard caps shared by validation, the UI counters, and the maxLength attrs so
// the three never drift apart.
export const SPECIALIST_NAME_MAX_LENGTH = 80
export const SPECIALIST_DISPLAY_NAME_MAX_LENGTH = 80
export const SPECIALIST_ID_MAX_LENGTH = RESOURCE_ID_MAX_LENGTH
export const SPECIALIST_DESCRIPTION_MAX_LENGTH = 1000
export const SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH = 32_768

export const validateSpecialistId = validateResourceId
export const inferSpecialistId = inferResourceId

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export const validateSpecialistPackageVersion = (version: string): string | undefined =>
  SEMVER_PATTERN.test(version) ? undefined : 'Package version must be valid SemVer.'

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

// Legacy editor validation remains permissive; lifecycle/SDK mutations use the
// strict public-name validator below.
// Returns an error message string, or undefined when the name is valid.
export const validateSpecialistName = (
  name: string,
  existingNames: string[],
  currentId?: string, // pass for edit: skip self-collision
  existingIds?: Map<string, string> // name -> id for duplicate detection
): string | undefined => {
  if (!name.trim()) return 'Name is required.'
  if (name.trim().length > SPECIALIST_NAME_MAX_LENGTH) {
    return `Name must be ${SPECIALIST_NAME_MAX_LENGTH} characters or fewer.`
  }

  // Duplicate check: skip self when editing.
  const collision = existingIds?.get(name)
  if (collision !== undefined && collision !== currentId) {
    return 'Name is already in use.'
  }
  // Fallback when existingIds not provided.
  if (!existingIds && existingNames.includes(name)) {
    return 'Name is already in use.'
  }

  return undefined
}

// Validates the public-facing name. Allows letters, digits, spaces, hyphens, and underscores;
// minimum 2 non-whitespace characters after trimming; maximum 80 to match the field maxLength.
export const validateSpecialistPublicName = (name: string): string | undefined => {
  const trimmed = name.trim()
  if (trimmed.length < 2) return 'Name must be at least 2 characters.'
  if (trimmed.length > 80) return 'Name must be 80 characters or fewer.'
  if (!/^[\p{L}0-9 _-]+$/u.test(trimmed))
    return 'Name may only contain letters, digits, spaces, hyphens, and underscores.'
  return undefined
}

export const validateSpecialistDisplayName = (displayName: string): string | undefined => {
  if (!displayName.trim()) return 'Display name is required.'
  if (displayName.length > SPECIALIST_DISPLAY_NAME_MAX_LENGTH) {
    return `Display name must be ${SPECIALIST_DISPLAY_NAME_MAX_LENGTH} characters or fewer.`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Description validation
// ---------------------------------------------------------------------------

// Validate a candidate description. Empty is allowed (the field is optional).
// Returns an error message string, or undefined when the description is valid.
export const validateSpecialistDescription = (description: string): string | undefined => {
  if (description.length > SPECIALIST_DESCRIPTION_MAX_LENGTH) {
    return `Description must be ${SPECIALIST_DESCRIPTION_MAX_LENGTH} characters or fewer.`
  }
  return undefined
}

export const validateSpecialistSystemPrompt = (systemPrompt: string): string | undefined => {
  if (systemPrompt.length > SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH) {
    return `System prompt must be ${SPECIALIST_SYSTEM_PROMPT_MAX_LENGTH} characters or fewer.`
  }
  return undefined
}

// Validate all fields for a CreateSpecialistInput.
// Returns an array of field errors (empty = valid).
export const validateCreateSpecialistInput = (
  input: CreateSpecialistInput,
  existingNames: string[],
  existingIds?: Map<string, string>,
  usedSpecialistIds: readonly string[] = []
): SpecialistFieldError[] => {
  const errors: SpecialistFieldError[] = []

  if (input.id !== undefined) {
    const idError = validateSpecialistId(input.id)
    if (idError) errors.push({ field: 'id', message: idError })
    else if (usedSpecialistIds.includes(input.id)) {
      errors.push({ field: 'id', message: 'ID is already in use.' })
    }
  }

  const nameError = validateSpecialistName(input.name, existingNames, undefined, existingIds)
  if (nameError) errors.push({ field: 'name', message: nameError })
  else {
    const publicNameError = validateSpecialistPublicName(input.name)
    if (publicNameError) errors.push({ field: 'name', message: publicNameError })
  }

  if (input.displayName !== undefined) {
    const displayNameError = validateSpecialistDisplayName(input.displayName)
    if (displayNameError) errors.push({ field: 'name', message: displayNameError })
  }

  if (input.description !== undefined) {
    const descriptionError = validateSpecialistDescription(input.description)
    if (descriptionError) errors.push({ field: 'description', message: descriptionError })
  }

  if (input.systemPrompt !== undefined) {
    const systemPromptError = validateSpecialistSystemPrompt(input.systemPrompt)
    if (systemPromptError) errors.push({ field: 'systemPrompt', message: systemPromptError })
  }

  return errors
}

// Validate the provided (partial) fields for an UpdateSpecialistInput.
// Only fields that are present are validated. The stable name is not updateable.
export const validateUpdateSpecialistInput = (
  input: UpdateSpecialistInput
): SpecialistFieldError[] => {
  const errors: SpecialistFieldError[] = []

  if (input.packageVersion !== undefined) {
    const packageVersionError = validateSpecialistPackageVersion(input.packageVersion)
    if (packageVersionError) {
      errors.push({ field: 'packageVersion', message: packageVersionError })
    }
  }

  if (input.displayName !== undefined) {
    const displayNameError = validateSpecialistDisplayName(input.displayName)
    if (displayNameError) errors.push({ field: 'name', message: displayNameError })
  }

  if (input.description !== undefined) {
    const descriptionError = validateSpecialistDescription(input.description)
    if (descriptionError) errors.push({ field: 'description', message: descriptionError })
  }

  if (input.systemPrompt !== undefined) {
    const systemPromptError = validateSpecialistSystemPrompt(input.systemPrompt)
    if (systemPromptError) errors.push({ field: 'systemPrompt', message: systemPromptError })
  }

  return errors
}

// ---------------------------------------------------------------------------
// Empty config helpers
// ---------------------------------------------------------------------------

export const emptyFullAccessConfig = (): SpecialistFullAccessConfig => ({
  excludedSkillIds: [],
  excludedConnectorIds: [],
  connectorTools: []
})

export const emptySelectedConfig = (): SpecialistSelectedConfig => ({
  skillIds: [],
  connectorIds: [],
  connectorTools: []
})
