export type ExecutionActivityKind = 'notebook-run' | 'compute-job'

export type ExecutionFileEvidenceCoverage = 'complete' | 'partial' | 'unavailable'

export type ExecutionFileEvidenceReason =
  | 'file-reads-not-observed'
  | 'initial-file-generations-not-captured'
  | 'external-paths-not-observed'
  | 'remote-outputs-not-observed'
  | 'transient-files-not-captured'
  | 'delayed-writes-not-observed'
  | 'writer-not-isolated'
  | 'watcher-unavailable'
  | 'observation-not-started'
  | 'observer-conflict'
  | 'observer-limit-exceeded'
  | 'observer-failed'
  | 'generation-budget-exceeded'
  | 'generation-freeze-failed'
  | 'evidence-persistence-failed'
  | 'activity-identity-missing'
  | 'remote-input-generation-not-captured'
  | 'remote-output-not-harvested'
  | 'harvest-incomplete'
  | 'compute-activity-lineage-missing'
  | 'dynamic-path-unresolved'
  | 'absolute-path-not-frozen'
  | 'source-analysis-unsupported-call'

export type ScientificOutputStorageShape = 'single-file' | 'file-set' | 'directory-tree'

export type ScientificOutputRisk =
  | 'format-validity-not-verified'
  | 'multi-file-consistency-not-verified'
  | 'database-state-not-verified'
  | 'runtime-dependent-serialization'

export type ScientificOutputEvidence = {
  outputId: string
  storageShape: ScientificOutputStorageShape
  formatHint?: string
  classificationAuthority: 'path-heuristic'
  // Portable relation paths from the same evidence sidecar. Members may include deleted paths when
  // an activity replaced a partition or companion file while producing the logical output.
  members: string[]
  riskCodes: ScientificOutputRisk[]
}

export type ExecutionFileEvidenceSummary = {
  schemaVersion: 1
  activityId?: string
  activityKind: ExecutionActivityKind
  parentActivityId?: string
  state: 'available' | 'partial' | 'unavailable'
  evidenceId?: string
  checksum?: string
  storageKey?: string
  relationCount?: number
  generationCount?: number
  scientificOutputCount: number
  initialViewState: ExecutionFileEvidenceCoverage
  managedRootsFinalState: ExecutionFileEvidenceCoverage
  scientificOutputAnalysis: ExecutionFileEvidenceCoverage
  fileReads: ExecutionFileEvidenceCoverage
  externalPaths: ExecutionFileEvidenceCoverage
  writerAttribution: ExecutionFileEvidenceCoverage
  reasonCodes: ExecutionFileEvidenceReason[]
}

export const hasImmutableExecutionFileEvidenceReference = (
  summary: ExecutionFileEvidenceSummary | undefined
): summary is ExecutionFileEvidenceSummary & {
  evidenceId: string
  checksum: string
  storageKey: string
} => Boolean(summary?.evidenceId && summary.checksum && summary.storageKey)

const ACTIVITY_KINDS = new Set<ExecutionActivityKind>(['notebook-run', 'compute-job'])
const EVIDENCE_STATES = new Set(['available', 'partial', 'unavailable'])
const COVERAGE_STATES = new Set<ExecutionFileEvidenceCoverage>([
  'complete',
  'partial',
  'unavailable'
])
const REASON_CODES = new Set<ExecutionFileEvidenceReason>([
  'file-reads-not-observed',
  'initial-file-generations-not-captured',
  'external-paths-not-observed',
  'remote-outputs-not-observed',
  'transient-files-not-captured',
  'delayed-writes-not-observed',
  'writer-not-isolated',
  'watcher-unavailable',
  'observation-not-started',
  'observer-conflict',
  'observer-limit-exceeded',
  'observer-failed',
  'generation-budget-exceeded',
  'generation-freeze-failed',
  'evidence-persistence-failed',
  'activity-identity-missing',
  'remote-input-generation-not-captured',
  'remote-output-not-harvested',
  'harvest-incomplete',
  'compute-activity-lineage-missing',
  'dynamic-path-unresolved',
  'absolute-path-not-frozen',
  'source-analysis-unsupported-call'
])
const SAFE_ACTIVITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const SHA256 = /^[a-f0-9]{64}$/u

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isCoverage = (value: unknown): value is ExecutionFileEvidenceCoverage =>
  typeof value === 'string' && COVERAGE_STATES.has(value as ExecutionFileEvidenceCoverage)
const isOptionalCount = (value: unknown): boolean =>
  value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0)
const isPortableStorageKey = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith('/') &&
  !/^[A-Za-z]:[\\/]/u.test(value) &&
  !value.includes('\\') &&
  value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')

export const parseExecutionFileEvidenceSummary = (
  value: unknown
): ExecutionFileEvidenceSummary | undefined => {
  if (!isRecord(value)) return undefined
  if (
    value.schemaVersion !== 1 ||
    typeof value.activityKind !== 'string' ||
    !ACTIVITY_KINDS.has(value.activityKind as ExecutionActivityKind) ||
    typeof value.state !== 'string' ||
    !EVIDENCE_STATES.has(value.state) ||
    (value.activityId !== undefined &&
      (typeof value.activityId !== 'string' || !SAFE_ACTIVITY_ID.test(value.activityId))) ||
    (value.parentActivityId !== undefined &&
      (typeof value.parentActivityId !== 'string' ||
        !SAFE_ACTIVITY_ID.test(value.parentActivityId))) ||
    (value.evidenceId !== undefined &&
      (typeof value.evidenceId !== 'string' || value.evidenceId.length === 0)) ||
    (value.checksum !== undefined &&
      (typeof value.checksum !== 'string' || !SHA256.test(value.checksum))) ||
    (value.storageKey !== undefined &&
      (typeof value.storageKey !== 'string' || !isPortableStorageKey(value.storageKey))) ||
    !isOptionalCount(value.relationCount) ||
    !isOptionalCount(value.generationCount) ||
    !Number.isSafeInteger(value.scientificOutputCount) ||
    Number(value.scientificOutputCount) < 0 ||
    !isCoverage(value.initialViewState) ||
    !isCoverage(value.managedRootsFinalState) ||
    !isCoverage(value.scientificOutputAnalysis) ||
    !isCoverage(value.fileReads) ||
    !isCoverage(value.externalPaths) ||
    !isCoverage(value.writerAttribution) ||
    !Array.isArray(value.reasonCodes) ||
    value.reasonCodes.length > REASON_CODES.size ||
    value.reasonCodes.some(
      (reason) =>
        typeof reason !== 'string' || !REASON_CODES.has(reason as ExecutionFileEvidenceReason)
    )
  ) {
    return undefined
  }
  return value as ExecutionFileEvidenceSummary
}

export const parseOwnedExecutionFileEvidenceSummary = (
  value: unknown,
  owner: {
    activityId: string
    activityKind: ExecutionActivityKind
    parentActivityId?: string
    storageKey?: string
  }
): ExecutionFileEvidenceSummary | undefined => {
  const summary = parseExecutionFileEvidenceSummary(value)
  if (
    !summary ||
    summary.activityId !== owner.activityId ||
    summary.activityKind !== owner.activityKind ||
    summary.parentActivityId !== owner.parentActivityId
  ) {
    return undefined
  }
  const referenceCount = [summary.evidenceId, summary.checksum, summary.storageKey].filter(
    (reference) => reference !== undefined
  ).length
  if (
    (referenceCount !== 0 && referenceCount !== 3) ||
    (summary.state !== 'unavailable' && referenceCount !== 3) ||
    (owner.storageKey !== undefined &&
      summary.storageKey !== undefined &&
      summary.storageKey !== owner.storageKey)
  ) {
    return undefined
  }
  return summary
}
