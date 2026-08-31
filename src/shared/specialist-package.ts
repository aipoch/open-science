import type { SkillSource } from './settings'

export const SPECIALIST_PACKAGE_SCHEMA_VERSION = 1 as const
export const DEFAULT_BUNDLED_SKILL_VERSION = '0.1.0' as const
export type SpecialistPackageArchiveLimits = {
  compressedBytes: number
  uncompressedBytes: number
  fileCount: number
  fileBytes: number
  compressionRatio: number
  pathDepth: number
}

export const SPECIALIST_PACKAGE_ARCHIVE_LIMITS: SpecialistPackageArchiveLimits = {
  compressedBytes: 50 * 1024 * 1024,
  uncompressedBytes: 200 * 1024 * 1024,
  fileCount: 2_000,
  fileBytes: 25 * 1024 * 1024,
  compressionRatio: 1_000,
  pathDepth: 32
}

export type SpecialistPackageSource = 'zip' | 'directory' | 'builtin'
export type PackageDiagnosticSeverity = 'error' | 'warning' | 'info'

export type ContributionTemplateExportResult = { saved: boolean }
export type SpecialistPackageReportSaveResult = { saved: boolean }
export type SpecialistExportSaveResult = { saved: boolean }

export type SpecialistExportSkillChoice = {
  id: string
  version: string
  kind: 'builtin' | 'owned' | 'referenced'
  selected: boolean
  selectable: boolean
}

export type SpecialistExportPreview = {
  specialistId: string
  name: string
  version: string
  fileName: string
  expectedRevision: number
  skills: readonly SpecialistExportSkillChoice[]
  connectorIds: readonly string[]
  diagnostics: readonly PackageDiagnostic[]
  canExport: boolean
}

export type SpecialistExportRequest = {
  specialistId: string
  expectedRevision: number
  includedSkillIds: readonly string[]
}

export type PackageDiagnostic = {
  severity: PackageDiagnosticSeverity
  code: string
  message: string
  path?: string
  relatedId?: string
  actual?: number
  limit?: number
  unit?: 'bytes' | 'files' | 'ratio' | 'levels'
}

export type SpecialistPackageArchiveMetrics = {
  compressedBytes: number
  uncompressedBytes?: number
  fileCount?: number
  limits: SpecialistPackageArchiveLimits
}

export type SpecialistPackageManifestV1 = {
  schema_version: typeof SPECIALIST_PACKAGE_SCHEMA_VERSION
  id: string
  version: string
  exported_with_app_version: string
}

/** In-memory payload normalized from the snake_case specialist.json boundary. */
export type SpecialistPackagePayload = {
  name: string
  displayName?: string
  description: string
  systemPrompt: string
  skillIds?: readonly string[]
  connectorIds?: readonly string[]
}

export type SpecialistPackageCatalogSnapshot = {
  appVersion: string
  builtinSkills: ReadonlyArray<{ id: string; appVersion: string; compatibility: string }>
  skills: ReadonlyArray<{
    id: string
    /** Immutable invocation/export name; defaults to id for legacy catalog fixtures. */
    name?: string
    displayName?: string
    source?: SkillSource
    version?: string
    builtin: boolean
    contentDigest?: string
    contentHash?: string
    standalone?: boolean
    ownerIds?: readonly string[]
    mainEnabled?: boolean
    specialistIds?: readonly string[]
  }>
  connectorIds: readonly string[]
  /** Local Connector ID (including Custom Connector UUID) to portable invocation name. */
  connectorAliases?: Readonly<Record<string, string>>
  protectedSpecialistIds: readonly string[]
  protectedSpecialistNames?: readonly string[]
  specialists?: ReadonlyArray<{ id: string; name: string }>
}

export type SpecialistPackageSkillDisposition =
  | 'install'
  | 'reuse-builtin'
  | 'reuse-owned'
  | 'reuse-standalone'
  | 'reuse-existing'
  | 'conflict'
  | 'replace-existing'

export type SpecialistPackageSkillConflict = {
  localId: string
  installedVersion: string
  installedContentHash: string
  mainEnabled: boolean
  specialists: ReadonlyArray<{ id: string; name: string }>
}

export type SpecialistPackageSkillPreview = {
  id: string
  version: string
  versionRange?: string
  disposition: SpecialistPackageSkillDisposition
  files: readonly string[]
  reason?: string
  conflict?: SpecialistPackageSkillConflict
}

export type SpecialistPackageSkillPlan = SpecialistPackageSkillPreview & {
  /** Target installation ID resolved from the portable package Skill name. */
  localId?: string
  contentHash: string
  filesToInstall: ReadonlyArray<{ path: string; bytes: Uint8Array }>
}

export type SpecialistPackageSummary = {
  id: string
  version: string
  name: string
  description: string
  source: SpecialistPackageSource
  bundledSkillIds: readonly string[]
  requiredSkillIds: readonly string[]
  builtinSkillIds: readonly string[]
  connectorIds: readonly string[]
  skills: readonly SpecialistPackageSkillPreview[]
}

export type SpecialistPackagePreview = {
  summary?: SpecialistPackageSummary
  diagnostics: readonly PackageDiagnostic[]
  installable: boolean
  archive?: SpecialistPackageArchiveMetrics
}

export type SpecialistPackageReport = {
  schemaVersion: 1
  summary?: Pick<SpecialistPackageSummary, 'id' | 'version' | 'name' | 'description' | 'source'>
  diagnostics: readonly PackageDiagnostic[]
  installable: boolean
  archive?: SpecialistPackageArchiveMetrics
}

export const specialistPackageReportFromPreview = (
  preview: SpecialistPackagePreview
): SpecialistPackageReport => ({
  schemaVersion: 1,
  ...(preview.summary
    ? {
        summary: {
          id: preview.summary.id,
          version: preview.summary.version,
          name: preview.summary.name,
          description: preview.summary.description,
          source: preview.summary.source
        }
      }
    : {}),
  diagnostics: preview.diagnostics,
  installable: preview.installable,
  ...(preview.archive ? { archive: preview.archive } : {})
})

export type SpecialistPackageCandidatePreview = SpecialistPackagePreview & {
  candidateToken: string
  overwrite?: {
    id: string
    target: 'custom'
    currentVersion: string
    incomingVersion: string
    modifiedSinceImport: boolean
    hasImportBaseline: boolean
  }
}

export type SpecialistPackageInstallRequest = {
  candidateToken: string
  confirmOverwrite?: true
  skillConflictResolutions?: readonly SpecialistPackageSkillConflictResolution[]
}

export type SpecialistPackageSkillConflictResolution = {
  skillId: string
  resolution: 'use-installed' | 'use-incoming'
}

export type SpecialistPackageInstallResult =
  | { status: 'installed'; specialist: import('./specialist').SpecialistView }
  | {
      status: 'failed'
      code:
        | 'candidate-invalid'
        | 'candidate-expired'
        | 'stale-candidate'
        | 'candidate-not-installable'
        | 'skill-conflict-resolution-required'
        | 'overwrite-confirmation-required'
        | 'revision-conflict'
        | 'protected-target'
        | 'recovery-failed'
        | 'rollback-failed'
        | 'commit-failed'
    }

export type SpecialistDeleteProtectionCode =
  'builtin' | 'main-enabled' | 'shared-owner' | 'referenced'

export type SpecialistDeleteSkillKind = 'exclusive' | SpecialistDeleteProtectionCode

export type SpecialistDeleteSkillPreview = {
  id: string
  displayName: string
  source: SkillSource
  kind: SpecialistDeleteSkillKind
  deletable: boolean
  reasons: ReadonlyArray<{
    code: SpecialistDeleteProtectionCode
    specialistIds: readonly string[]
  }>
}

export type SpecialistDeletePreview = {
  specialistId: string
  specialistName: string
  expectedRevision: number
  skills: readonly SpecialistDeleteSkillPreview[]
}

export type SpecialistDeleteRequest = {
  id: string
  expectedRevision: number
  deleteSkillIds: readonly string[]
}

export type SpecialistDeleteResult =
  | { status: 'deleted' }
  | {
      status: 'failed'
      code:
        | 'stale-preview'
        | 'revision-conflict'
        | 'protected-skill'
        | 'protected-target'
        | 'recovery-failed'
        | 'rollback-failed'
        | 'commit-failed'
    }

export type SpecialistPackageValidationPlan = {
  specialistId: string
  packageVersion: string
  source: SpecialistPackageSource
  contentHash: string
  manifest: SpecialistPackageManifestV1
  payload: SpecialistPackagePayload
  skillIds: readonly string[]
  connectorIds: readonly string[]
  skills: readonly SpecialistPackageSkillPlan[]
}

export type SpecialistPackageValidationResult = {
  preview: SpecialistPackagePreview
  plan?: Readonly<SpecialistPackageValidationPlan>
}

export type BuiltinSpecialistRegistryEntry = SpecialistPackagePayload & {
  kind: 'builtin'
  readonly: true
  enabled: true
  id: string
  version: string
  iconKey?: string
  colorKey?: string
  capabilityMode: import('./specialist').SpecialistCapabilityMode
  fullAccess: import('./specialist').SpecialistFullAccessConfig
  selectedCapabilities: import('./specialist').SpecialistSelectedConfig
}

export type BuiltinSpecialistRegistryResult = {
  entries: readonly BuiltinSpecialistRegistryEntry[]
  diagnostics: readonly PackageDiagnostic[]
}
