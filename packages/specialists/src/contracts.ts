import { RESOURCE_ID_MAX_LENGTH, inferResourceId, validateResourceId } from './resource-id'

export type SpecialistCapabilityMode = 'full' | 'selected'

export const CONNECTOR_TOOL_RULE_MAX_COUNT = 128
export const CONNECTOR_TOOL_PATTERN_MAX_LENGTH = 128

// Per-connector tool-level rules. Uses bare method names (no connector prefix). Patterns are
// anchored globs where `*` matches any characters and `?` matches one character.
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

// Resolve against the live catalog; callers must not snapshot catalog contents into a profile or
// session. Full access includes future entries by construction, while selected is an explicit list.
export const resolveEffectiveSpecialistSkills = (
  specialist:
    Pick<SpecialistView, 'capabilityMode' | 'fullAccess' | 'selectedCapabilities'> | undefined,
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

// Renderer-safe view of one Specialist (no secret fields).
export type SpecialistView = {
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
  ownedSkillIds?: string[]
  importBaseline?: {
    importedAt: string
    archiveDigest: string
    contentDigest: string
    packageContentDigest?: string
    packageVersion?: string
  }
}

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

export type BuiltinSpecialistEntry = {
  kind: 'builtin'
  readonly: true
  version: string
} & SpecialistView
export type SpecialistCatalogSnapshot = Readonly<{
  items: Array<({ kind: 'custom' } & SpecialistView) | BuiltinSpecialistEntry>
  integrity: SpecialistDocumentIntegrity
}>
