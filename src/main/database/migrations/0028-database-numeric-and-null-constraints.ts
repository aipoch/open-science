/* Immutable 0028 migration snapshot. Do not regenerate after release. */
import { MEMORY_AUXILIARY_SCHEMA_OBJECTS } from './0017-agent-memory-project-scope'

// Copy into replacement tables before dropping originals. Unlike renaming the old tables,
// this preserves every inbound foreign-key target while enforcement is disabled by the owner.
const tables = [
  {
    tableName: 'SessionModelCallUsage',
    ddl: `CREATE TABLE IF NOT EXISTS "SessionModelCallUsage" (
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "callIndex" INTEGER NOT NULL,
    "sourceInvocationId" TEXT,
    "frameworkId" TEXT,
    "providerId" TEXT,
    "backendId" TEXT,
    "model" TEXT,
    "inputTokens" BIGINT NOT NULL,
    "cacheTokens" BIGINT NOT NULL,
    "cachedReadTokens" BIGINT,
    "cachedWriteTokens" BIGINT,
    "outputTokens" BIGINT NOT NULL,
    "contextUsedTokens" BIGINT,
    "contextWindowSize" BIGINT,

    PRIMARY KEY ("sessionId", "callId"),
    CONSTRAINT "SessionModelCallUsage_sessionId_messageId_fkey" FOREIGN KEY ("sessionId", "messageId") REFERENCES "SessionTurnUsage" ("sessionId", "messageId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionModelCallUsage_identity_check" CHECK (length(trim("messageId")) > 0 AND length(trim("callId")) > 0 AND "callIndex" >= 0 AND ("sourceInvocationId" IS NULL OR length(trim("sourceInvocationId")) > 0) AND ("frameworkId" IS NULL OR length(trim("frameworkId")) > 0) AND ("backendId" IS NULL OR length(trim("backendId")) > 0) AND ("model" IS NULL OR length(trim("model")) > 0)),
    CONSTRAINT "SessionModelCallUsage_nonnegative_check" CHECK ("inputTokens" >= 0 AND "cacheTokens" >= 0 AND "outputTokens" >= 0 AND (("cachedReadTokens" IS NULL AND "cachedWriteTokens" IS NULL) OR ("cachedReadTokens" IS NOT NULL AND "cachedWriteTokens" IS NOT NULL AND "cachedReadTokens" >= 0 AND "cachedWriteTokens" >= 0)) AND ("contextUsedTokens" IS NULL OR "contextUsedTokens" >= 0) AND ("contextWindowSize" IS NULL OR "contextWindowSize" > 0))
);`,
    columns: [
      'sessionId',
      'messageId',
      'callId',
      'callIndex',
      'sourceInvocationId',
      'frameworkId',
      'providerId',
      'backendId',
      'model',
      'inputTokens',
      'cacheTokens',
      'cachedReadTokens',
      'cachedWriteTokens',
      'outputTokens',
      'contextUsedTokens',
      'contextWindowSize'
    ]
  },
  {
    tableName: 'SessionAuxiliaryTurnUsage',
    ddl: `CREATE TABLE IF NOT EXISTS "SessionAuxiliaryTurnUsage" (
    "sessionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "providerId" TEXT,
    "model" TEXT,
    "completedAtMs" BIGINT NOT NULL,
    "inputTokens" BIGINT NOT NULL,
    "cacheTokens" BIGINT NOT NULL,
    "cachedReadTokens" BIGINT,
    "cachedWriteTokens" BIGINT,
    "outputTokens" BIGINT NOT NULL,
    "modelCallCount" INTEGER,

    PRIMARY KEY ("sessionId", "eventId"),
    CONSTRAINT "SessionAuxiliaryTurnUsage_identity_check" CHECK (length(trim("sessionId")) > 0 AND length(trim("eventId")) > 0 AND length(trim("frameworkId")) > 0 AND ("model" IS NULL OR length(trim("model")) > 0)),
    CONSTRAINT "SessionAuxiliaryTurnUsage_source_check" CHECK ("source" IN ('reviewer', 'side-chat', 'vision', 'session-details', 'host-llm', 'artifact-code-reconstruction', 'context-compaction')),
    CONSTRAINT "SessionAuxiliaryTurnUsage_nonnegative_check" CHECK ("completedAtMs" >= 0 AND "inputTokens" >= 0 AND "cacheTokens" >= 0 AND "outputTokens" >= 0 AND (("cachedReadTokens" IS NULL AND "cachedWriteTokens" IS NULL) OR ("cachedReadTokens" IS NOT NULL AND "cachedWriteTokens" IS NOT NULL AND "cachedReadTokens" >= 0 AND "cachedWriteTokens" >= 0)) AND ("modelCallCount" IS NULL OR "modelCallCount" > 0))
);`,
    columns: [
      'sessionId',
      'eventId',
      'source',
      'frameworkId',
      'providerId',
      'model',
      'completedAtMs',
      'inputTokens',
      'cacheTokens',
      'cachedReadTokens',
      'cachedWriteTokens',
      'outputTokens',
      'modelCallCount'
    ]
  },
  {
    tableName: 'ManagedFile',
    ddl: `CREATE TABLE IF NOT EXISTS "ManagedFile" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "sourceVersionId" TEXT,
    "checksum" TEXT,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT,
    "displayName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "mtimeMs" BIGINT,
    "sortAtMs" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "deleteOperationId" TEXT,
    CONSTRAINT "ManagedFile_source_check" CHECK ("source" IN ('artifact', 'upload')),
    CONSTRAINT "ManagedFile_numeric_bounds_check" CHECK ("sizeBytes" >= 0)
);`,
    columns: [
      'seq',
      'source',
      'sourceFileId',
      'sourceVersionId',
      'checksum',
      'projectId',
      'sessionId',
      'messageId',
      'displayName',
      'storageKey',
      'mimeType',
      'sizeBytes',
      'mtimeMs',
      'sortAtMs',
      'createdAt',
      'updatedAt',
      'deletedAt',
      'deleteOperationId'
    ]
  },
  {
    tableName: 'UploadVersion',
    ddl: `CREATE TABLE IF NOT EXISTS "UploadVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadFileId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "originKind" TEXT NOT NULL DEFAULT 'user_upload',
    "basedOnVersionId" TEXT,
    "storageTag" TEXT,
    "storedFilename" TEXT,
    "writeOperationId" TEXT,
    "contentStorageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdAt" DATETIME,
    "registeredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadVersion_uploadFileId_fkey" FOREIGN KEY ("uploadFileId") REFERENCES "UploadFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UploadVersion_uploadFileId_basedOnVersionId_fkey" FOREIGN KEY ("uploadFileId", "basedOnVersionId") REFERENCES "UploadVersion" ("uploadFileId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UploadVersion_state_check" CHECK ("state" IN ('staging', 'ready')),
    CONSTRAINT "UploadVersion_originKind_check" CHECK ("originKind" IN ('user_upload', 'user_edit', 'legacy')),
    CONSTRAINT "UploadVersion_userEdit_check" CHECK (("originKind" <> 'user_edit' OR ("state" = 'ready' AND "basedOnVersionId" IS NOT NULL AND "storageTag" IS NOT NULL AND "storedFilename" IS NOT NULL))),
    CONSTRAINT "UploadVersion_numeric_bounds_check" CHECK ("sizeBytes" >= 0 AND "versionNumber" >= 1)
);`,
    columns: [
      'id',
      'uploadFileId',
      'versionNumber',
      'state',
      'originKind',
      'basedOnVersionId',
      'storageTag',
      'storedFilename',
      'writeOperationId',
      'contentStorageKey',
      'filename',
      'originalFilename',
      'contentType',
      'sizeBytes',
      'checksum',
      'createdAt',
      'registeredAt',
      'updatedAt'
    ]
  },
  {
    tableName: 'ArtifactVersion',
    ddl: `CREATE TABLE IF NOT EXISTS "ArtifactVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "originKind" TEXT NOT NULL DEFAULT 'agent_generated',
    "basedOnVersionId" TEXT,
    "storageTag" TEXT,
    "storedFilename" TEXT,
    "artifactRunId" TEXT,
    "writeOperationId" TEXT,
    "writeRequestChecksum" TEXT,
    "rootFrameId" TEXT,
    "agentFrameId" TEXT,
    "messageBranchId" TEXT,
    "runtimeSegmentId" TEXT,
    "promptMessageId" TEXT,
    "notebookSessionId" TEXT,
    "producerRunId" TEXT,
    "producerRunIndex" INTEGER,
    "messageId" TEXT,
    "messageSnapshotId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "managedVisibleAt" DATETIME,
    "contentStorageKey" TEXT NOT NULL,
    "evidenceStorageKey" TEXT,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "evidenceJson" TEXT,
    "evidenceChecksum" TEXT,
    "evidenceSchemaVersion" INTEGER,
    "executionSnapshotJson" TEXT,
    "executionSnapshotChecksum" TEXT,
    "executionSnapshotStorageKey" TEXT,
    "executionSnapshotSchemaVersion" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "ArtifactLineage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersion_artifactId_basedOnVersionId_fkey" FOREIGN KEY ("artifactId", "basedOnVersionId") REFERENCES "ArtifactVersion" ("artifactId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersion_messageSnapshotId_fkey" FOREIGN KEY ("messageSnapshotId") REFERENCES "ArtifactMessageSnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersion_state_check" CHECK ("state" IN ('staging', 'pending', 'finalized')),
    CONSTRAINT "ArtifactVersion_filename_check" CHECK (length("filename") > 0),
    CONSTRAINT "ArtifactVersion_originKind_check" CHECK ("originKind" IN ('agent_generated', 'user_edit', 'legacy')),
    CONSTRAINT "ArtifactVersion_provenance_check" CHECK ((("originKind" = 'agent_generated' AND "artifactRunId" IS NOT NULL AND "rootFrameId" IS NOT NULL AND "agentFrameId" IS NOT NULL AND "messageBranchId" IS NOT NULL AND "runtimeSegmentId" IS NOT NULL AND "promptMessageId" IS NOT NULL AND "evidenceStorageKey" IS NOT NULL AND "evidenceJson" IS NOT NULL AND "evidenceChecksum" IS NOT NULL AND "evidenceSchemaVersion" IS NOT NULL) OR ("originKind" = 'user_edit' AND "state" = 'finalized' AND "basedOnVersionId" IS NOT NULL AND "storageTag" IS NOT NULL AND "storedFilename" IS NOT NULL AND "artifactRunId" IS NULL AND "writeRequestChecksum" IS NULL AND "rootFrameId" IS NULL AND "agentFrameId" IS NULL AND "messageBranchId" IS NULL AND "runtimeSegmentId" IS NULL AND "promptMessageId" IS NULL AND "notebookSessionId" IS NULL AND "producerRunId" IS NULL AND "producerRunIndex" IS NULL AND "messageId" IS NULL AND "messageSnapshotId" IS NULL AND "evidenceStorageKey" IS NULL AND "evidenceJson" IS NULL AND "evidenceChecksum" IS NULL AND "evidenceSchemaVersion" IS NULL AND "executionSnapshotJson" IS NULL AND "executionSnapshotChecksum" IS NULL AND "executionSnapshotStorageKey" IS NULL AND "executionSnapshotSchemaVersion" IS NULL) OR "originKind" = 'legacy')),
    CONSTRAINT "ArtifactVersion_evidenceJson_check" CHECK ("evidenceJson" IS NULL OR (json_valid("evidenceJson") AND json_type("evidenceJson") = 'object')),
    CONSTRAINT "ArtifactVersion_executionSnapshotJson_check" CHECK ("executionSnapshotJson" IS NULL OR (json_valid("executionSnapshotJson") AND json_type("executionSnapshotJson") = 'object')),
    CONSTRAINT "ArtifactVersion_executionSnapshotBundle_check" CHECK ((("executionSnapshotJson" IS NULL AND "executionSnapshotChecksum" IS NULL AND "executionSnapshotStorageKey" IS NULL AND "executionSnapshotSchemaVersion" IS NULL) OR ("executionSnapshotJson" IS NOT NULL AND "executionSnapshotChecksum" IS NOT NULL AND "executionSnapshotStorageKey" IS NOT NULL AND "executionSnapshotSchemaVersion" IS NOT NULL))),
    CONSTRAINT "ArtifactVersion_numeric_bounds_check" CHECK ("sizeBytes" >= 0 AND "versionNumber" >= 1)
);`,
    columns: [
      'id',
      'artifactId',
      'versionNumber',
      'filename',
      'originKind',
      'basedOnVersionId',
      'storageTag',
      'storedFilename',
      'artifactRunId',
      'writeOperationId',
      'writeRequestChecksum',
      'rootFrameId',
      'agentFrameId',
      'messageBranchId',
      'runtimeSegmentId',
      'promptMessageId',
      'notebookSessionId',
      'producerRunId',
      'producerRunIndex',
      'messageId',
      'messageSnapshotId',
      'state',
      'managedVisibleAt',
      'contentStorageKey',
      'evidenceStorageKey',
      'contentType',
      'sizeBytes',
      'checksum',
      'evidenceJson',
      'evidenceChecksum',
      'evidenceSchemaVersion',
      'executionSnapshotJson',
      'executionSnapshotChecksum',
      'executionSnapshotStorageKey',
      'executionSnapshotSchemaVersion',
      'createdAt',
      'updatedAt'
    ]
  },
  {
    tableName: 'ManagedFileVersionWriteOperation',
    ddl: `CREATE TABLE IF NOT EXISTS "ManagedFileVersionWriteOperation" (
    "operationId" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "basedOnVersionId" TEXT NOT NULL,
    "expectedHeadVersionId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "storageTag" TEXT NOT NULL,
    "storedFilename" TEXT NOT NULL,
    "contentStorageKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "textFormatJson" TEXT NOT NULL,
    "resultVersionId" TEXT,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ManagedFileVersionWriteOperation_source_check" CHECK ("source" IN ('artifact', 'upload')),
    CONSTRAINT "ManagedFileVersionWriteOperation_state_check" CHECK ("state" IN ('staging', 'file_ready', 'published', 'conflict', 'failed')),
    CONSTRAINT "ManagedFileVersionWriteOperation_numeric_bounds_check" CHECK ("sizeBytes" >= 0)
);`,
    columns: [
      'operationId',
      'source',
      'projectId',
      'sourceFileId',
      'basedOnVersionId',
      'expectedHeadVersionId',
      'state',
      'storageTag',
      'storedFilename',
      'contentStorageKey',
      'checksum',
      'sizeBytes',
      'textFormatJson',
      'resultVersionId',
      'errorCode',
      'createdAt',
      'updatedAt'
    ]
  },
  {
    tableName: 'ArtifactVersionInput',
    ddl: `CREATE TABLE IF NOT EXISTS "ArtifactVersionInput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactVersionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "inputFileVersionId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "sourceArtifactVersionId" TEXT,
    "sourceUploadVersionId" TEXT,
    "sourceVersionNumber" INTEGER,
    "sourceCreatedAt" DATETIME,
    "sourceProjectId" TEXT NOT NULL,
    "sourceSessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "strongestAssociation" TEXT NOT NULL,
    CONSTRAINT "ArtifactVersionInput_artifactVersionId_fkey" FOREIGN KEY ("artifactVersionId") REFERENCES "ArtifactVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceArtifactVersionId_fkey" FOREIGN KEY ("sourceArtifactVersionId") REFERENCES "ArtifactVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceUploadVersionId_fkey" FOREIGN KEY ("sourceUploadVersionId") REFERENCES "UploadVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceProjectId_sourceSessionId_fkey" FOREIGN KEY ("sourceProjectId", "sourceSessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceKind_check" CHECK ("sourceKind" IN ('artifact-version', 'upload-version')),
    CONSTRAINT "ArtifactVersionInput_sourceIdentity_check" CHECK ((("sourceKind" = 'artifact-version' AND "sourceArtifactVersionId" IS NOT NULL AND "sourceUploadVersionId" IS NULL AND "inputFileVersionId" = "sourceArtifactVersionId") OR ("sourceKind" = 'upload-version' AND "sourceArtifactVersionId" IS NULL AND "sourceUploadVersionId" IS NOT NULL AND "inputFileVersionId" = "sourceUploadVersionId"))),
    CONSTRAINT "ArtifactVersionInput_strongestAssociation_check" CHECK ("strongestAssociation" IN ('turn-attached', 'resolver-accessed', 'captured-version')),
    CONSTRAINT "ArtifactVersionInput_numeric_bounds_check" CHECK ("sizeBytes" >= 0 AND ("sourceVersionNumber" IS NULL OR "sourceVersionNumber" >= 1))
);`,
    columns: [
      'id',
      'artifactVersionId',
      'ordinal',
      'inputFileVersionId',
      'sourceKind',
      'sourceFileId',
      'sourceArtifactVersionId',
      'sourceUploadVersionId',
      'sourceVersionNumber',
      'sourceCreatedAt',
      'sourceProjectId',
      'sourceSessionId',
      'filename',
      'contentType',
      'sizeBytes',
      'checksum',
      'storageKey',
      'strongestAssociation'
    ]
  },
  {
    tableName: 'ComputeJobOperation',
    ddl: `CREATE TABLE IF NOT EXISTS "ComputeJobOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'active',
    "outcome" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "eligibleAt" DATETIME,
    "claimToken" TEXT,
    "claimExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ComputeJobOperation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ComputeJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ComputeJobOperation_kind_check" CHECK ("kind" = 'cancel'),
    CONSTRAINT "ComputeJobOperation_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "ComputeJobOperation_attemptCount_check" CHECK ("attemptCount" >= 0),
    CONSTRAINT "ComputeJobOperation_phase_check" CHECK ("phase" IN ('active', 'settled')),
    CONSTRAINT "ComputeJobOperation_lifecycle_check" CHECK (("phase" = 'active' AND "outcome" IS NULL AND "settledAt" IS NULL) OR ("phase" = 'settled' AND "outcome" IS NOT NULL AND "outcome" IN ('fulfilled', 'superseded') AND "settledAt" IS NOT NULL)),
    CONSTRAINT "ComputeJobOperation_claim_check" CHECK (("claimToken" IS NULL AND "claimExpiresAt" IS NULL) OR ("phase" = 'active' AND "claimToken" IS NOT NULL AND "claimExpiresAt" IS NOT NULL)),
    CONSTRAINT "ComputeJobOperation_settled_implementation_check" CHECK ("phase" = 'active' OR ("eligibleAt" IS NULL AND "claimToken" IS NULL AND "claimExpiresAt" IS NULL))
);`,
    columns: [
      'id',
      'jobId',
      'kind',
      'phase',
      'outcome',
      'revision',
      'attemptCount',
      'eligibleAt',
      'claimToken',
      'claimExpiresAt',
      'createdAt',
      'settledAt',
      'updatedAt'
    ]
  },
  {
    tableName: 'MemoryCategory',
    ddl: `CREATE TABLE IF NOT EXISTS "MemoryCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "systemKey" TEXT,
    "name" TEXT,
    "nameKey" TEXT,
    "guidance" TEXT NOT NULL DEFAULT '',
    "autoRecall" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MemoryCategory_shape_check" CHECK ((("systemKey" IS NOT NULL AND "systemKey" = 'about-you' AND "name" IS NULL AND "nameKey" IS NULL AND "guidance" = '' AND "autoRecall" = true) OR ("systemKey" IS NULL AND "name" IS NOT NULL AND "nameKey" IS NOT NULL))),
    CONSTRAINT "MemoryCategory_name_check" CHECK ("name" IS NULL OR length(trim("name")) BETWEEN 1 AND 64),
    CONSTRAINT "MemoryCategory_nameKey_check" CHECK ("nameKey" IS NULL OR length("nameKey") BETWEEN 1 AND 64),
    CONSTRAINT "MemoryCategory_guidance_check" CHECK (length("guidance") <= 1000),
    CONSTRAINT "MemoryCategory_autoRecall_check" CHECK ("autoRecall" IN (false, true)),
    CONSTRAINT "MemoryCategory_revision_check" CHECK ("revision" >= 1)
);`,
    columns: [
      'id',
      'systemKey',
      'name',
      'nameKey',
      'guidance',
      'autoRecall',
      'revision',
      'createdAt',
      'updatedAt'
    ]
  }
] as const

const indexes = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "SessionModelCallUsage_sessionId_messageId_callIndex_key" ON "SessionModelCallUsage"("sessionId", "messageId", "callIndex");`,
  `CREATE INDEX IF NOT EXISTS "SessionAuxiliaryTurnUsage_completedAtMs_idx" ON "SessionAuxiliaryTurnUsage"("completedAtMs");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "deletedAt", "sortAtMs", "seq");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "source", "deletedAt", "sortAtMs", "seq");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_sessionId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "sessionId", "source", "deletedAt", "sortAtMs", "seq");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFile_sessionId_deletedAt_idx" ON "ManagedFile"("sessionId", "deletedAt");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_sourceFileId_key" ON "ManagedFile"("projectId", "source", "sourceFileId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_storageKey_key" ON "ManagedFile"("projectId", "source", "storageKey");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "UploadVersion_writeOperationId_key" ON "UploadVersion"("writeOperationId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "UploadVersion_contentStorageKey_key" ON "UploadVersion"("contentStorageKey");`,
  `CREATE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_state_registeredAt_idx" ON "UploadVersion"("uploadFileId", "state", "registeredAt");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_versionNumber_key" ON "UploadVersion"("uploadFileId", "versionNumber");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_id_key" ON "UploadVersion"("uploadFileId", "id");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_writeOperationId_key" ON "ArtifactVersion"("writeOperationId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_contentStorageKey_key" ON "ArtifactVersion"("contentStorageKey");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_createdAt_idx" ON "ArtifactVersion"("artifactId", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactRunId_state_idx" ON "ArtifactVersion"("artifactRunId", "state");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_rootFrameId_agentFrameId_messageBranchId_promptMessageId_idx" ON "ArtifactVersion"("rootFrameId", "agentFrameId", "messageBranchId", "promptMessageId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageId_idx" ON "ArtifactVersion"("messageId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageSnapshotId_idx" ON "ArtifactVersion"("messageSnapshotId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_versionNumber_key" ON "ArtifactVersion"("artifactId", "versionNumber");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_id_key" ON "ArtifactVersion"("artifactId", "id");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFileVersionWriteOperation_contentStorageKey_key" ON "ManagedFileVersionWriteOperation"("contentStorageKey");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFileVersionWriteOperation_resultVersionId_key" ON "ManagedFileVersionWriteOperation"("resultVersionId");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFileVersionWriteOperation_source_sourceFileId_state_idx" ON "ManagedFileVersionWriteOperation"("source", "sourceFileId", "state");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFileVersionWriteOperation_projectId_state_createdAt_idx" ON "ManagedFileVersionWriteOperation"("projectId", "state", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceKind_inputFileVersionId_idx" ON "ArtifactVersionInput"("sourceKind", "inputFileVersionId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceArtifactVersionId_idx" ON "ArtifactVersionInput"("sourceArtifactVersionId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceUploadVersionId_idx" ON "ArtifactVersionInput"("sourceUploadVersionId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceProjectId_sourceSessionId_idx" ON "ArtifactVersionInput"("sourceProjectId", "sourceSessionId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_sourceKind_inputFileVersionId_key" ON "ArtifactVersionInput"("artifactVersionId", "sourceKind", "inputFileVersionId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_ordinal_key" ON "ArtifactVersionInput"("artifactVersionId", "ordinal");`,
  `CREATE INDEX IF NOT EXISTS "ComputeJobOperation_kind_phase_eligibleAt_createdAt_idx" ON "ComputeJobOperation"("kind", "phase", "eligibleAt", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "ComputeJobOperation_kind_phase_claimExpiresAt_idx" ON "ComputeJobOperation"("kind", "phase", "claimExpiresAt");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ComputeJobOperation_jobId_kind_key" ON "ComputeJobOperation"("jobId", "kind");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MemoryCategory_systemKey_key" ON "MemoryCategory"("systemKey");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MemoryCategory_nameKey_key" ON "MemoryCategory"("nameKey");`
] as const

const numericAndNullConstraintsMigration = {
  id: '0028_database_numeric_and_null_constraints',
  statements: [] as const,
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 2,
      tables: tables.map(({ tableName, ddl, columns }) => ({
        tableName,
        canonicalTableDdl: ddl,
        columns
      })),
      dropOrder: tables.map(({ tableName }) => tableName),
      indexes,
      triggers: MEMORY_AUXILIARY_SCHEMA_OBJECTS.filter(
        ({ type, name }) => type === 'trigger' && name.startsWith('MemoryCategory_')
      ).map(({ sql }) => sql)
    }
  ] as const,
  verifiers: [
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'MemoryCategory',
          constraints: [
            {
              name: 'MemoryCategory_shape_check',
              expression:
                '(("systemKey" IS NOT NULL AND "systemKey" = \'about-you\' AND "name" IS NULL AND "nameKey" IS NULL AND "guidance" = \'\' AND "autoRecall" = true) OR ("systemKey" IS NULL AND "name" IS NOT NULL AND "nameKey" IS NOT NULL))'
            }
          ]
        },
        {
          table: 'ComputeJobOperation',
          constraints: [
            {
              name: 'ComputeJobOperation_lifecycle_check',
              expression:
                '("phase" = \'active\' AND "outcome" IS NULL AND "settledAt" IS NULL) OR ("phase" = \'settled\' AND "outcome" IS NOT NULL AND "outcome" IN (\'fulfilled\', \'superseded\') AND "settledAt" IS NOT NULL)'
            }
          ]
        },
        {
          table: 'SessionAuxiliaryTurnUsage',
          constraints: [
            {
              name: 'SessionAuxiliaryTurnUsage_nonnegative_check',
              expression:
                '"completedAtMs" >= 0 AND "inputTokens" >= 0 AND "cacheTokens" >= 0 AND "outputTokens" >= 0 AND (("cachedReadTokens" IS NULL AND "cachedWriteTokens" IS NULL) OR ("cachedReadTokens" IS NOT NULL AND "cachedWriteTokens" IS NOT NULL AND "cachedReadTokens" >= 0 AND "cachedWriteTokens" >= 0)) AND ("modelCallCount" IS NULL OR "modelCallCount" > 0)'
            }
          ]
        },
        {
          table: 'SessionModelCallUsage',
          constraints: [
            {
              name: 'SessionModelCallUsage_nonnegative_check',
              expression:
                '"inputTokens" >= 0 AND "cacheTokens" >= 0 AND "outputTokens" >= 0 AND (("cachedReadTokens" IS NULL AND "cachedWriteTokens" IS NULL) OR ("cachedReadTokens" IS NOT NULL AND "cachedWriteTokens" IS NOT NULL AND "cachedReadTokens" >= 0 AND "cachedWriteTokens" >= 0)) AND ("contextUsedTokens" IS NULL OR "contextUsedTokens" >= 0) AND ("contextWindowSize" IS NULL OR "contextWindowSize" > 0)'
            }
          ]
        },
        {
          table: 'UploadVersion',
          constraints: [
            {
              name: 'UploadVersion_numeric_bounds_check',
              expression: '"sizeBytes" >= 0 AND "versionNumber" >= 1'
            }
          ]
        },
        {
          table: 'ArtifactVersion',
          constraints: [
            {
              name: 'ArtifactVersion_numeric_bounds_check',
              expression: '"sizeBytes" >= 0 AND "versionNumber" >= 1'
            }
          ]
        },
        {
          table: 'ArtifactVersionInput',
          constraints: [
            {
              name: 'ArtifactVersionInput_numeric_bounds_check',
              expression:
                '"sizeBytes" >= 0 AND ("sourceVersionNumber" IS NULL OR "sourceVersionNumber" >= 1)'
            }
          ]
        },
        {
          table: 'ManagedFile',
          constraints: [
            { name: 'ManagedFile_numeric_bounds_check', expression: '"sizeBytes" >= 0' }
          ]
        },
        {
          table: 'ManagedFileVersionWriteOperation',
          constraints: [
            {
              name: 'ManagedFileVersionWriteOperation_numeric_bounds_check',
              expression: '"sizeBytes" >= 0'
            }
          ]
        }
      ]
    },
    { kind: 'foreign-key-integrity', version: 1 }
  ] as const
}

export { numericAndNullConstraintsMigration }
