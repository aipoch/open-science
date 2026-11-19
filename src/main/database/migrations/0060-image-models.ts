// Immutable table snapshot: retain existing usage and Artifact versions while admitting image generation and editing.
const imageModelsMigration = {
  id: '0060_image_models',
  statements: [],
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 2,
      tables: [
        {
          tableName: 'SessionAuxiliaryTurnUsage',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "SessionAuxiliaryTurnUsage" (
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
    CONSTRAINT "SessionAuxiliaryTurnUsage_source_check" CHECK ("source" IN ('reviewer', 'side-chat', 'vision', 'session-details', 'host-llm', 'artifact-code-reconstruction', 'context-compaction', 'classification', 'image-generation')),
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
          tableName: 'ArtifactVersion',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ArtifactVersion" (
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
    "contentBlobId" TEXT,
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
    CONSTRAINT "ArtifactVersion_provenance_check" CHECK ((("originKind" = 'agent_generated' AND "artifactRunId" IS NOT NULL AND "rootFrameId" IS NOT NULL AND "agentFrameId" IS NOT NULL AND "messageBranchId" IS NOT NULL AND (("runtimeSegmentId" IS NOT NULL AND "promptMessageId" IS NOT NULL) OR ("runtimeSegmentId" IS NULL AND "promptMessageId" IS NULL AND "messageId" IS NULL AND "messageSnapshotId" IS NULL AND "notebookSessionId" IS NULL AND "producerRunId" IS NULL AND "producerRunIndex" IS NULL AND "evidenceSchemaVersion" = 1 AND COALESCE(json_extract("evidenceJson", '$.image_task_id') = "artifactRunId" AND json_extract("evidenceJson", '$.producer.kind') = 'connector' AND json_extract("evidenceJson", '$.producer.connector_id') = 'image-model', 0))) AND "evidenceStorageKey" IS NOT NULL AND "evidenceJson" IS NOT NULL AND "evidenceChecksum" IS NOT NULL AND "evidenceSchemaVersion" IS NOT NULL) OR ("originKind" = 'user_edit' AND "state" = 'finalized' AND "basedOnVersionId" IS NOT NULL AND "storageTag" IS NOT NULL AND "storedFilename" IS NOT NULL AND "artifactRunId" IS NULL AND "writeRequestChecksum" IS NULL AND "rootFrameId" IS NULL AND "agentFrameId" IS NULL AND "messageBranchId" IS NULL AND "runtimeSegmentId" IS NULL AND "promptMessageId" IS NULL AND "notebookSessionId" IS NULL AND "producerRunId" IS NULL AND "producerRunIndex" IS NULL AND "messageId" IS NULL AND "messageSnapshotId" IS NULL AND "evidenceStorageKey" IS NULL AND "evidenceJson" IS NULL AND "evidenceChecksum" IS NULL AND "evidenceSchemaVersion" IS NULL AND "executionSnapshotJson" IS NULL AND "executionSnapshotChecksum" IS NULL AND "executionSnapshotStorageKey" IS NULL AND "executionSnapshotSchemaVersion" IS NULL) OR "originKind" = 'legacy')),
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
            'contentBlobId',
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
        }
      ],
      dropOrder: ['ArtifactVersion', 'SessionAuxiliaryTurnUsage'],
      indexes: [
        'CREATE INDEX "SessionAuxiliaryTurnUsage_completedAtMs_idx" ON "SessionAuxiliaryTurnUsage"("completedAtMs")',
        'CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_writeOperationId_key" ON "ArtifactVersion"("writeOperationId");',
        'CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_contentStorageKey_key" ON "ArtifactVersion"("contentStorageKey");',
        'CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_createdAt_idx" ON "ArtifactVersion"("artifactId", "createdAt");',
        'CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactRunId_state_idx" ON "ArtifactVersion"("artifactRunId", "state");',
        'CREATE INDEX IF NOT EXISTS "ArtifactVersion_rootFrameId_agentFrameId_messageBranchId_promptMessageId_idx" ON "ArtifactVersion"("rootFrameId", "agentFrameId", "messageBranchId", "promptMessageId");',
        'CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageId_idx" ON "ArtifactVersion"("messageId");',
        'CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageSnapshotId_idx" ON "ArtifactVersion"("messageSnapshotId");',
        'CREATE INDEX IF NOT EXISTS "ArtifactVersion_contentBlobId_idx" ON "ArtifactVersion"("contentBlobId");',
        'CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_versionNumber_key" ON "ArtifactVersion"("artifactId", "versionNumber");',
        'CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_id_key" ON "ArtifactVersion"("artifactId", "id");'
      ]
    }
  ],
  verifiers: [
    { kind: 'foreign-key-integrity', version: 1 },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'SessionAuxiliaryTurnUsage',
          constraints: [
            {
              name: 'SessionAuxiliaryTurnUsage_source_check',
              expression: `"source" IN ('reviewer', 'side-chat', 'vision', 'session-details', 'host-llm', 'artifact-code-reconstruction', 'context-compaction', 'classification', 'image-generation')`
            }
          ]
        },
        {
          table: 'ArtifactVersion',
          constraints: [
            {
              name: 'ArtifactVersion_provenance_check',
              expression: `(("originKind" = 'agent_generated' AND "artifactRunId" IS NOT NULL AND "rootFrameId" IS NOT NULL AND "agentFrameId" IS NOT NULL AND "messageBranchId" IS NOT NULL AND (("runtimeSegmentId" IS NOT NULL AND "promptMessageId" IS NOT NULL) OR ("runtimeSegmentId" IS NULL AND "promptMessageId" IS NULL AND "messageId" IS NULL AND "messageSnapshotId" IS NULL AND "notebookSessionId" IS NULL AND "producerRunId" IS NULL AND "producerRunIndex" IS NULL AND "evidenceSchemaVersion" = 1 AND COALESCE(json_extract("evidenceJson", '$.image_task_id') = "artifactRunId" AND json_extract("evidenceJson", '$.producer.kind') = 'connector' AND json_extract("evidenceJson", '$.producer.connector_id') = 'image-model', 0))) AND "evidenceStorageKey" IS NOT NULL AND "evidenceJson" IS NOT NULL AND "evidenceChecksum" IS NOT NULL AND "evidenceSchemaVersion" IS NOT NULL) OR ("originKind" = 'user_edit' AND "state" = 'finalized' AND "basedOnVersionId" IS NOT NULL AND "storageTag" IS NOT NULL AND "storedFilename" IS NOT NULL AND "artifactRunId" IS NULL AND "writeRequestChecksum" IS NULL AND "rootFrameId" IS NULL AND "agentFrameId" IS NULL AND "messageBranchId" IS NULL AND "runtimeSegmentId" IS NULL AND "promptMessageId" IS NULL AND "notebookSessionId" IS NULL AND "producerRunId" IS NULL AND "producerRunIndex" IS NULL AND "messageId" IS NULL AND "messageSnapshotId" IS NULL AND "evidenceStorageKey" IS NULL AND "evidenceJson" IS NULL AND "evidenceChecksum" IS NULL AND "evidenceSchemaVersion" IS NULL AND "executionSnapshotJson" IS NULL AND "executionSnapshotChecksum" IS NULL AND "executionSnapshotStorageKey" IS NULL AND "executionSnapshotSchemaVersion" IS NULL) OR "originKind" = 'legacy')`
            }
          ]
        }
      ]
    }
  ]
} as const
const IMAGE_MODELS_ALLOWED_SUFFIX_CHECKS = {
  SessionAuxiliaryTurnUsage: {
    SessionAuxiliaryTurnUsage_source_check: `"source" IN ('reviewer', 'side-chat', 'vision', 'session-details', 'host-llm', 'artifact-code-reconstruction', 'context-compaction', 'classification', 'image-generation')`
  },
  ArtifactVersion: {
    ArtifactVersion_provenance_check: `(("originKind" = 'agent_generated' AND "artifactRunId" IS NOT NULL AND "rootFrameId" IS NOT NULL AND "agentFrameId" IS NOT NULL AND "messageBranchId" IS NOT NULL AND (("runtimeSegmentId" IS NOT NULL AND "promptMessageId" IS NOT NULL) OR ("runtimeSegmentId" IS NULL AND "promptMessageId" IS NULL AND "messageId" IS NULL AND "messageSnapshotId" IS NULL AND "notebookSessionId" IS NULL AND "producerRunId" IS NULL AND "producerRunIndex" IS NULL AND "evidenceSchemaVersion" = 1 AND COALESCE(json_extract("evidenceJson", '$.image_task_id') = "artifactRunId" AND json_extract("evidenceJson", '$.producer.kind') = 'connector' AND json_extract("evidenceJson", '$.producer.connector_id') = 'image-model', 0))) AND "evidenceStorageKey" IS NOT NULL AND "evidenceJson" IS NOT NULL AND "evidenceChecksum" IS NOT NULL AND "evidenceSchemaVersion" IS NOT NULL) OR ("originKind" = 'user_edit' AND "state" = 'finalized' AND "basedOnVersionId" IS NOT NULL AND "storageTag" IS NOT NULL AND "storedFilename" IS NOT NULL AND "artifactRunId" IS NULL AND "writeRequestChecksum" IS NULL AND "rootFrameId" IS NULL AND "agentFrameId" IS NULL AND "messageBranchId" IS NULL AND "runtimeSegmentId" IS NULL AND "promptMessageId" IS NULL AND "notebookSessionId" IS NULL AND "producerRunId" IS NULL AND "producerRunIndex" IS NULL AND "messageId" IS NULL AND "messageSnapshotId" IS NULL AND "evidenceStorageKey" IS NULL AND "evidenceJson" IS NULL AND "evidenceChecksum" IS NULL AND "evidenceSchemaVersion" IS NULL AND "executionSnapshotJson" IS NULL AND "executionSnapshotChecksum" IS NULL AND "executionSnapshotStorageKey" IS NULL AND "executionSnapshotSchemaVersion" IS NULL) OR "originKind" = 'legacy')`
  }
} as const
export { imageModelsMigration, IMAGE_MODELS_ALLOWED_SUFFIX_CHECKS }
