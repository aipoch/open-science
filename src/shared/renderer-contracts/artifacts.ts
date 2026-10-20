import type { ProvenanceReadResult } from '../provenance-read-result'

import type { ArtifactLiteratureManifest } from '../artifact-literature'

import type {
  ArtifactPreviewResult,
  FinalizeRunArtifactsRequest,
  FinalizeRunArtifactsResult,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest,
  ReconcilePendingArtifactsRequest,
  ReconcilePendingArtifactsResult,
  ResolveArtifactVersionDescriptorsRequest
} from '../artifacts'

import type {
  ArtifactLineageProvenance,
  ArtifactVersionDescriptor,
  ArtifactVersionExecutionProvenance,
  ArtifactVersionMessagesProvenance,
  ArtifactVersionProvenance,
  ArtifactVersionReviewProvenance,
  GetArtifactLineageRequest,
  GetArtifactVersionProvenanceRequest
} from '../artifact-provenance'

import type {
  ArtifactReproducibilityCheckRequest,
  ArtifactReproducibilityCheckLogRecord,
  ArtifactReproducibilityCheckState,
  ArtifactEnvironmentLockBundleInfo,
  ArtifactReproducibilityReceiptPage,
  CancelArtifactReproducibilityCheckRequest,
  ExportArtifactEnvironmentLockRequest,
  ExportArtifactEnvironmentLockResult,
  DescribeArtifactEnvironmentLockRequest,
  ExportArtifactReproducibilityReceiptRequest,
  ReadArtifactReproducibilityOutputRequest,
  ArtifactReproducibilityReceiptScope,
  ArtifactReproducibilityOutputStorage,
  ArtifactReproducibilityOutputPreview,
  ExportArtifactReproducibilityReceiptResult,
  GetArtifactReproducibilityCheckLogRequest,
  GetArtifactReproducibilityCheckRequest,
  ImportArtifactEnvironmentLockRequest,
  ImportArtifactEnvironmentLockResult,
  CreateArtifactEnvironmentFromLockRequest,
  CreateArtifactEnvironmentFromLockResult,
  ListArtifactReproducibilityReceiptsRequest
} from '../artifact-reproducibility'

import type {
  ArtifactCodeReconstructionState,
  GenerateArtifactCodeReconstructionRequest,
  GetArtifactCodeReconstructionRequest
} from '../artifact-code-reconstruction'

import { callable, ELECTRON, LOCAL, type RemoveListener, ELECTRON_EVENT } from './definition'

export const contracts = {
  'artifacts.cancelReproducibilityCheck': callable<
    (request: CancelArtifactReproducibilityCheckRequest) => Promise<void>
  >()('artifacts', ['artifacts:cancel-reproducibility-check', ELECTRON], { optionalMember: true }),
  'artifacts.exportEnvironmentLock': callable<
    (request: ExportArtifactEnvironmentLockRequest) => Promise<ExportArtifactEnvironmentLockResult>
  >()('artifacts', ['artifacts:export-environment-lock', ELECTRON], { optionalMember: true }),
  'artifacts.describeEnvironmentLock': callable<
    (request: DescribeArtifactEnvironmentLockRequest) => Promise<ArtifactEnvironmentLockBundleInfo>
  >()('artifacts', ['artifacts:describe-environment-lock', ELECTRON], { optionalMember: true }),
  'artifacts.importEnvironmentLock': callable<
    (request: ImportArtifactEnvironmentLockRequest) => Promise<ImportArtifactEnvironmentLockResult>
  >()('artifacts', ['artifacts:import-environment-lock', ELECTRON], { optionalMember: true }),
  'artifacts.createEnvironmentFromLock': callable<
    (
      request: CreateArtifactEnvironmentFromLockRequest
    ) => Promise<CreateArtifactEnvironmentFromLockResult>
  >()('artifacts', ['artifacts:create-environment-from-lock', ELECTRON], { optionalMember: true }),
  'artifacts.readReproducibilityOutput': callable<
    (
      request: ReadArtifactReproducibilityOutputRequest
    ) => Promise<ArtifactReproducibilityOutputPreview>
  >()('artifacts', ['artifacts:read-reproducibility-output', ELECTRON], { optionalMember: true }),
  'artifacts.getReproducibilityOutputStorage': callable<
    (request: ArtifactReproducibilityReceiptScope) => Promise<ArtifactReproducibilityOutputStorage>
  >()('artifacts', ['artifacts:get-reproducibility-output-storage', ELECTRON], {
    optionalMember: true
  }),
  'artifacts.clearReproducibilityOutputs': callable<
    (request: ArtifactReproducibilityReceiptScope) => Promise<ArtifactReproducibilityOutputStorage>
  >()('artifacts', ['artifacts:clear-reproducibility-outputs', ELECTRON], { optionalMember: true }),
  'artifacts.exportReproducibilityReceipt': callable<
    (
      request: ExportArtifactReproducibilityReceiptRequest
    ) => Promise<ExportArtifactReproducibilityReceiptResult>
  >()('artifacts', ['artifacts:export-reproducibility-receipt', ELECTRON], {
    optionalMember: true
  }),
  'artifacts.finalizeRunArtifacts': callable<
    (request: FinalizeRunArtifactsRequest) => Promise<FinalizeRunArtifactsResult>
  >()('artifacts', ['artifacts:finalize-run']),
  'artifacts.generateCodeReconstruction': callable<
    (request: GenerateArtifactCodeReconstructionRequest) => Promise<ArtifactCodeReconstructionState>
  >()('artifacts', ['artifacts:generate-code-reconstruction']),
  'artifacts.getCodeReconstruction': callable<
    (request: GetArtifactCodeReconstructionRequest) => Promise<ArtifactCodeReconstructionState>
  >()('artifacts', ['artifacts:get-code-reconstruction']),
  'artifacts.getLineage': callable<
    (
      request: GetArtifactLineageRequest
    ) => Promise<ProvenanceReadResult<ArtifactLineageProvenance | undefined>>
  >()('artifacts', ['artifacts:get-lineage']),
  'artifacts.getReproducibilityCheck': callable<
    (
      request: GetArtifactReproducibilityCheckRequest
    ) => Promise<ArtifactReproducibilityCheckState | undefined>
  >()('artifacts', ['artifacts:get-reproducibility-check', ELECTRON], { optionalMember: true }),
  'artifacts.getReproducibilityCheckLog': callable<
    (
      request: GetArtifactReproducibilityCheckLogRequest
    ) => Promise<ArtifactReproducibilityCheckLogRecord | undefined>
  >()('artifacts', ['artifacts:get-reproducibility-check-log', ELECTRON], {
    optionalMember: true
  }),
  'artifacts.getVersionExecution': callable<
    (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ProvenanceReadResult<ArtifactVersionExecutionProvenance>>
  >()('artifacts', ['artifacts:get-version-execution']),
  'artifacts.getVersionLiterature': callable<
    (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ArtifactLiteratureManifest | undefined>
  >()('artifacts', ['artifacts:get-version-literature']),
  'artifacts.getVersionMessages': callable<
    (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ProvenanceReadResult<ArtifactVersionMessagesProvenance>>
  >()('artifacts', ['artifacts:get-version-messages']),
  'artifacts.getVersionProvenance': callable<
    (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ProvenanceReadResult<ArtifactVersionProvenance>>
  >()('artifacts', ['artifacts:get-version-provenance']),
  'artifacts.getVersionReview': callable<
    (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ProvenanceReadResult<ArtifactVersionReviewProvenance>>
  >()('artifacts', ['artifacts:get-version-review']),
  'artifacts.listReproducibilityReceipts': callable<
    (
      request: ListArtifactReproducibilityReceiptsRequest
    ) => Promise<ArtifactReproducibilityReceiptPage>
  >()('artifacts', ['artifacts:list-reproducibility-receipts', ELECTRON], {
    optionalMember: true
  }),
  'artifacts.openFile': callable<(request: OpenArtifactFileRequest) => Promise<void>>()(
    'artifacts',
    ['artifacts:open-file', LOCAL]
  ),
  'artifacts.onReproducibilityCheckChanged': callable<
    (listener: (state: ArtifactReproducibilityCheckState) => void) => RemoveListener
  >()('artifacts', ['artifacts:reproducibility-check-changed', ELECTRON_EVENT], {
    optionalMember: true
  }),
  'artifacts.readPreview': callable<
    (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  >()('artifacts', ['artifacts:read-preview']),
  'artifacts.reconcilePendingArtifacts': callable<
    (request: ReconcilePendingArtifactsRequest) => Promise<ReconcilePendingArtifactsResult>
  >()('artifacts', ['artifacts:reconcile-pending']),
  'artifacts.resolveVersionDescriptors': callable<
    (request: ResolveArtifactVersionDescriptorsRequest) => Promise<ArtifactVersionDescriptor[]>
  >()('artifacts', ['artifacts:resolve-version-descriptors']),
  'artifacts.startReproducibilityCheck': callable<
    (request: ArtifactReproducibilityCheckRequest) => Promise<ArtifactReproducibilityCheckState>
  >()('artifacts', ['artifacts:start-reproducibility-check', ELECTRON], { optionalMember: true }),
  'artifacts.sessionReproducibility': callable<
    (
      request: import('../session-reproducibility').SessionReproducibilityCommand
    ) => Promise<import('../session-reproducibility').SessionReproducibilityBatch | undefined>
  >()('artifacts', ['artifacts:session-reproducibility', ELECTRON], { optionalMember: true })
} as const
