import { PackageHistory } from './history-schema'
import { PackageLiterature } from './literature-contract'
import type { PackagePdfNotes } from './pdf-notes-contract'
import { PackageReproducibility } from './reproducibility-contract'

// A package contract is an allowlist, not an arbitrary database dump. Schema changes must opt in
// here rather than silently exporting new columns (which could carry local authority or secrets).
export const COLUMNS = {
  FileOriginSession:
    'projectId sessionId titleSnapshot state deletedAt deletionOperationId retainedReviewIdsJson createdAt updatedAt',
  Review:
    'id projectId sessionId turnMessageId scope lifecycle outcome errorMessage model reviewerLog createdAt updatedAt',
  Finding:
    'id reviewId status resolution claim evidence locator artifactVersionId artifactBindingState sortIndex reflagCount',
  ReviewFindingDisposition:
    'id sourceFindingId causeReviewId sequence trigger outcome note assessedArtifactVersionId assessmentSnapshot createdAt',
  ReviewScopeSnapshot:
    'id projectId sessionId reviewId scopeTurnMessageId state snapshotJson checksum storageKey schemaVersion blockCount createdAt',
  UploadFile:
    'id projectId sessionId filename originalFilename currentVersionId createdAt updatedAt',
  UploadVersion:
    'id uploadFileId versionNumber state originKind basedOnVersionId storageTag storedFilename writeOperationId contentStorageKey filename originalFilename contentType sizeBytes checksum createdAt registeredAt updatedAt',
  ArtifactVersionInput:
    'id artifactVersionId ordinal inputFileVersionId sourceKind sourceFileId sourceArtifactVersionId sourceUploadVersionId sourceVersionNumber sourceCreatedAt sourceProjectId sourceSessionId filename contentType sizeBytes checksum storageKey strongestAssociation',
  ArtifactMessageSnapshot:
    'id projectId sessionId rootFrameId agentFrameId messageBranchId terminalMessageId state storageKey checksum messageCount createdAt updatedAt',
  ArtifactLineage:
    'id projectId sessionId normalizedFilename filename currentVersionId createdAt updatedAt',
  ArtifactVersion:
    'id artifactId versionNumber filename originKind basedOnVersionId storageTag storedFilename artifactRunId writeOperationId writeRequestChecksum rootFrameId agentFrameId messageBranchId runtimeSegmentId promptMessageId notebookSessionId producerRunId producerRunIndex messageId messageSnapshotId state managedVisibleAt contentStorageKey evidenceStorageKey contentType sizeBytes checksum evidenceJson evidenceChecksum evidenceSchemaVersion executionSnapshotJson executionSnapshotChecksum executionSnapshotStorageKey executionSnapshotSchemaVersion createdAt updatedAt'
} as const

export type NativeTable = keyof typeof COLUMNS

export type NativeRow = Record<string, string | number | boolean | null>

export type PackageRecords = {
  schemaVersion: 1
  tables: Record<NativeTable, NativeRow[]>
  pdfNotes?: PackagePdfNotes
  literature?: PackageLiterature
  history?: PackageHistory
  reproducibility?: PackageReproducibility
}
