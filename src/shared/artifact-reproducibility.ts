import type { GetArtifactVersionProvenanceRequest } from './artifact-provenance'
import type { OutputComparisonPolicy, OutputComparisonReport } from './output-comparison'

export type ArtifactReproducibilityCheckRequest = GetArtifactVersionProvenanceRequest & {
  frontierId: string
  comparisonPolicy?: OutputComparisonPolicy
  expectedRecipeId?: string
}

export type CancelArtifactReproducibilityCheckRequest = {
  attemptId: string
}

export type ArtifactReproducibilityReceiptScope = GetArtifactVersionProvenanceRequest

export type GetArtifactReproducibilityCheckRequest = GetArtifactVersionProvenanceRequest

export type ListArtifactReproducibilityReceiptsRequest = ArtifactReproducibilityReceiptScope & {
  cursor?: string
  limit?: number
}

export type ArtifactReproducibilityReceiptPage = {
  sourceArtifactVersion?: ArtifactReproducibilityReceiptScope
  receipts: ArtifactReproducibilityReceipt[]
  latestFailedAttempt?: ArtifactReproducibilityFailedAttempt
  nextCursor?: string
}

export type GetArtifactReproducibilityCheckLogRequest = ArtifactReproducibilityReceiptScope &
  ({ receiptChecksum: string; attemptId?: never } | { attemptId: string; receiptChecksum?: never })

export type ExportArtifactReproducibilityReceiptRequest = ArtifactReproducibilityReceiptScope & {
  receiptChecksum: string
  outputEntityId?: string
  suggestedName: string
}

export type ExportArtifactReproducibilityReceiptResult = { saved: boolean }

export type ArtifactReproducibilityOutputStorage = {
  omittedOutputChecksums?: string[]
  sizeBytes: number
  fileCount: number
  clearedReceiptChecksums: string[]
}

export type ReadArtifactReproducibilityOutputRequest = ArtifactReproducibilityReceiptScope & {
  receiptChecksum: string
  entityId: string
}
export type ReproducibilityOutputPreview =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'unsupported' }
export type ArtifactReproducibilityOutputPreview = {
  filename: string
  original?: ReproducibilityOutputPreview
  reproduced: ReproducibilityOutputPreview
  differenceImage?: string
}

export type ExportArtifactEnvironmentLockRequest = ArtifactReproducibilityReceiptScope & {
  lockChecksum: string
}

export type ExportArtifactEnvironmentLockResult = { saved: boolean }

export type ArtifactEnvironmentLockPackageManager =
  'conda' | 'pip' | 'uv' | 'poetry' | 'renv' | 'pak'

export type ArtifactEnvironmentLockBundleInfo = {
  schemaVersion: 1
  format: 'open-science-environment-lock-export'
  lockChecksum: string
  lockState: 'available' | 'partial'
  kernelKind: 'python' | 'r'
  environmentName: string
  platform?: string
  architecture?: string
  packageManagers: ArtifactEnvironmentLockPackageManager[]
}

export type DescribeArtifactEnvironmentLockRequest = ExportArtifactEnvironmentLockRequest

export type CreateArtifactEnvironmentFromLockRequest = ExportArtifactEnvironmentLockRequest

export type CreateArtifactEnvironmentFromLockResult = {
  environmentName: string
  kernelKind: 'python' | 'r'
  reused: boolean
}

export type ImportArtifactEnvironmentLockRequest = { projectId?: string }

export type ImportArtifactEnvironmentLockResult =
  | { imported: false }
  | {
      imported: true
      environmentName: string
      kernelKind: 'python' | 'r'
      reused: boolean
    }

export type ArtifactReproducibilityCheckComparison = {
  relativePath: string
  status: 'matched' | 'different'
  reason?: 'missing' | 'not-file' | 'linked' | 'size-mismatch' | 'checksum-mismatch'
}

type ArtifactReproducibilityCheckLogBase = {
  kernelKind: 'python' | 'r'
  stream: 'stdout' | 'stderr'
  text: string
  recordedAt?: string
  truncated?: boolean
}

export type ArtifactReproducibilityCheckLog = ArtifactReproducibilityCheckLogBase &
  (
    | {
        source: 'environment'
        requirementId: string
        environmentIndex: number
        environmentTotal: number
      }
    | {
        source: 'notebook'
        stepId: string
        runIndex: number
      }
  )

export type ArtifactReproducibilityCheckLogReference = {
  logChecksum: string
  entryCount: number
  sizeBytes: number
  truncated: boolean
}

export type ArtifactReproducibilityCheckLogRecord = {
  schemaVersion: 1
  attemptId: string
  entries: ArtifactReproducibilityCheckLog[]
  truncated: boolean
  logChecksum: string
}

export type ArtifactReproducibilityFailedAttempt = {
  schemaVersion: 1
  attemptId: string
  startedAt: string
  completedAt: string
  artifactVersion: ArtifactReproducibilityReceiptScope
  frontierId: string
  phase?: ArtifactReproducibilityCheckState['phase']
  checkLog: ArtifactReproducibilityCheckLogReference
}

export type ArtifactReproducibilityReceiptComparison = ArtifactReproducibilityCheckComparison & {
  contentComparison?: OutputComparisonReport
  contentComparisonUnavailableReason?:
    'unsupported-format' | 'budget-exceeded' | 'comparison-failed'
  stepId: string
  entityId: string
  expectedChecksum: string
  expectedSizeBytes: number
  actualChecksum?: string
  actualSizeBytes?: number
  outputCaptured?: true
  outputCaptureReason?: 'too-large' | 'storage-limit' | 'unavailable'
}

export type ArtifactReproducibilityReceipt = {
  schemaVersion: 1 | 2
  receiptId: string
  startedAt: string
  completedAt: string
  outcome: 'matched' | 'different'
  artifactVersion: {
    projectId: string
    appSessionId: string
    artifactId: string
    versionId: string
    targetChecksum: string
  }
  frontier: {
    frontierId: string
    claimScope: 'end-to-end' | 'downstream-only'
  }
  recipe: {
    recipeId: string
    graphChecksum: string
  }
  environmentLocks: Array<{
    requirementId: string
    kernelKind: 'python' | 'r'
    environmentName?: string
    lockChecksum: string
  }>
  completedStepIds: string[]
  comparisons: ArtifactReproducibilityReceiptComparison[]
  checkLog?: ArtifactReproducibilityCheckLogReference
  receiptChecksum: string
}

export type ArtifactReproducibilityCheckState = {
  attemptId: string
  startedAt: string
  request: ArtifactReproducibilityCheckRequest
  revision: number
  status: 'running' | 'matched' | 'different' | 'failed' | 'cancelled'
  phase?:
    | 'loading-evidence'
    | 'materializing-inputs'
    | 'restoring-environments'
    | 'executing'
    | 'comparing'
  completedSteps: number
  totalSteps: number
  completedEnvironments: number
  totalEnvironments: number
  activeEnvironment?: {
    kernelKind: 'python' | 'r'
    index: number
    total: number
    stage: 'validating-lock' | 'restoring-packages' | 'verifying-runtime'
  }
  totalComparisons: number
  comparisons: ArtifactReproducibilityCheckComparison[]
  logs?: ArtifactReproducibilityCheckLog[]
  logsTruncated?: boolean
  receipt?: ArtifactReproducibilityReceipt
  errorMessage?: string
}
