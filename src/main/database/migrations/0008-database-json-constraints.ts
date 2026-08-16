/* Immutable 0008 migration snapshot. Do not regenerate after release. */

const databaseJsonConstraintsMigration = {
  id: '0008_database_json_constraints',
  statements: [] as const,
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'ProjectPreviewState',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ProjectPreviewState" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "panelState" TEXT NOT NULL,
    "activeItemId" TEXT,
    "items" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectPreviewState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectPreviewState_panelState_check" CHECK ("panelState" IN ('open', 'collapsed')),
    CONSTRAINT "ProjectPreviewState_itemsJson_check" CHECK (json_valid("items") AND json_type("items") = 'array')
);`,
          columns: ['projectId', 'panelState', 'activeItemId', 'items', 'updatedAt']
        }
      ],
      dropOrder: ['ProjectPreviewState'],
      indexes: []
    },
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'NotificationInboxItem',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "NotificationInboxItem" (
    "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT,
    "attentionReason" TEXT,
    "projectId" TEXT,
    "sessionId" TEXT,
    "originId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    "actionState" TEXT,
    "settledAt" DATETIME,
    "targetInvalidatedAt" DATETIME,
    CONSTRAINT "NotificationInboxItem_source_check" CHECK ("source" IS NULL OR "source" IN ('agent-tool', 'agent-question', 'agent-runtime', 'connector', 'compute', 'skill-import', 'session-plan')),
    CONSTRAINT "NotificationInboxItem_attentionReason_check" CHECK ("attentionReason" IS NULL OR "attentionReason" IN ('waiting-for-user', 'waiting-permission', 'waiting-plan-approval', 'task-max-tokens', 'task-max-turn-requests', 'task-refusal', 'task-unclean-stop')),
    CONSTRAINT "NotificationInboxItem_kind_check" CHECK ("kind" IN ('task.completed', 'task.needs-attention', 'task.failed', 'authorization.required')),
    CONSTRAINT "NotificationInboxItem_actionState_check" CHECK ("actionState" IS NULL OR "actionState" IN ('pending', 'resolved', 'rejected', 'expired', 'cancelled')),
    CONSTRAINT "NotificationInboxItem_actionLifecycle_check" CHECK ((("actionState" IS NULL AND "settledAt" IS NULL) OR ("actionState" IS NOT NULL AND (("actionState" = 'pending' AND "settledAt" IS NULL) OR ("actionState" IN ('resolved', 'rejected', 'expired', 'cancelled') AND "settledAt" IS NOT NULL))))),
    CONSTRAINT "NotificationInboxItem_actionKind_check" CHECK ("actionState" IS NULL OR "kind" IN ('task.needs-attention', 'authorization.required')),
    CONSTRAINT "NotificationInboxItem_targetInvalidated_check" CHECK ("targetInvalidatedAt" IS NULL OR ("sessionId" IS NOT NULL AND "readAt" IS NOT NULL))
);`,
          columns: [
            'sequence',
            'id',
            'dedupeKey',
            'kind',
            'source',
            'attentionReason',
            'projectId',
            'sessionId',
            'originId',
            'title',
            'summary',
            'createdAt',
            'readAt',
            'actionState',
            'settledAt',
            'targetInvalidatedAt'
          ]
        }
      ],
      dropOrder: ['NotificationInboxItem'],
      indexes: [
        `CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInboxItem_id_key" ON "NotificationInboxItem"("id");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInboxItem_dedupeKey_key" ON "NotificationInboxItem"("dedupeKey");`,
        `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_readAt_sequence_idx" ON "NotificationInboxItem"("readAt", "sequence");`,
        `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_sessionId_idx" ON "NotificationInboxItem"("sessionId");`,
        `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_projectId_idx" ON "NotificationInboxItem"("projectId");`
      ]
    },
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'Review',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "Review" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnMessageId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '{}',
    "lifecycle" TEXT NOT NULL DEFAULT 'running',
    "outcome" TEXT,
    "errorMessage" TEXT,
    "model" TEXT NOT NULL DEFAULT '',
    "reviewerLog" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Review_lifecycle_check" CHECK ("lifecycle" IN ('running', 'complete', 'error')),
    CONSTRAINT "Review_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('pass', 'flagged')),
    CONSTRAINT "Review_state_check" CHECK ((("lifecycle" = 'running' AND "outcome" IS NULL AND "errorMessage" IS NULL) OR ("lifecycle" = 'complete' AND "outcome" IS NOT NULL AND "errorMessage" IS NULL) OR ("lifecycle" = 'error' AND "outcome" IS NULL AND "errorMessage" IS NOT NULL))),
    CONSTRAINT "Review_scopeJson_check" CHECK (json_valid("scope") AND json_type("scope") = 'object'),
    CONSTRAINT "Review_reviewerLogJson_check" CHECK (json_valid("reviewerLog") AND json_type("reviewerLog") = 'array')
);`,
          columns: [
            'id',
            'projectId',
            'sessionId',
            'turnMessageId',
            'scope',
            'lifecycle',
            'outcome',
            'errorMessage',
            'model',
            'reviewerLog',
            'createdAt',
            'updatedAt'
          ],
          optionalLegacyColumns: [
            { name: 'summary', definition: '"summary" TEXT' },
            { name: 'checks', definition: '"checks" TEXT' },
            { name: 'reasoning', definition: '"reasoning" TEXT' }
          ]
        },
        {
          tableName: 'Finding',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "Finding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pass',
    "resolution" TEXT NOT NULL DEFAULT 'open',
    "claim" TEXT NOT NULL DEFAULT '',
    "evidence" TEXT NOT NULL DEFAULT '',
    "locator" TEXT NOT NULL DEFAULT '{}',
    "artifactVersionId" TEXT,
    "artifactBindingState" TEXT NOT NULL DEFAULT 'legacy_unverified',
    "sortIndex" INTEGER NOT NULL DEFAULT 0,
    "reflagCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Finding_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Finding_status_check" CHECK ("status" IN ('pass', 'warn', 'fail')),
    CONSTRAINT "Finding_resolution_check" CHECK ("resolution" IN ('open', 'resolved', 'unaddressed')),
    CONSTRAINT "Finding_artifactBindingState_check" CHECK ("artifactBindingState" IN ('scope_validated', 'legacy_unverified')),
    CONSTRAINT "Finding_sortIndex_check" CHECK ("sortIndex" >= 0),
    CONSTRAINT "Finding_reflagCount_check" CHECK ("reflagCount" >= 0),
    CONSTRAINT "Finding_statusResolution_check" CHECK ("status" <> 'pass' OR "resolution" = 'open'),
    CONSTRAINT "Finding_artifactBinding_check" CHECK ("artifactBindingState" <> 'scope_validated' OR "artifactVersionId" IS NOT NULL),
    CONSTRAINT "Finding_locatorJson_check" CHECK (json_valid("locator") AND json_type("locator") = 'object')
);`,
          columns: [
            'id',
            'reviewId',
            'status',
            'resolution',
            'claim',
            'evidence',
            'locator',
            'artifactVersionId',
            'artifactBindingState',
            'sortIndex',
            'reflagCount'
          ],
          optionalLegacyColumns: [{ name: 'severity', definition: '"severity" TEXT' }]
        },
        {
          tableName: 'ReviewFindingDisposition',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ReviewFindingDisposition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceFindingId" TEXT NOT NULL,
    "causeReviewId" TEXT,
    "sequence" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "note" TEXT,
    "assessedArtifactVersionId" TEXT,
    "assessmentSnapshot" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewFindingDisposition_sourceFindingId_fkey" FOREIGN KEY ("sourceFindingId") REFERENCES "Finding" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewFindingDisposition_causeReviewId_fkey" FOREIGN KEY ("causeReviewId") REFERENCES "Review" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReviewFindingDisposition_sequence_check" CHECK ("sequence" >= 1),
    CONSTRAINT "ReviewFindingDisposition_trigger_check" CHECK ("trigger" IN ('review_submission', 'loop_terminated', 'correction_failed', 'aborted')),
    CONSTRAINT "ReviewFindingDisposition_outcome_check" CHECK ("outcome" IN ('still_open', 'resolved', 'unaddressed')),
    CONSTRAINT "ReviewFindingDisposition_state_check" CHECK ((("trigger" = 'review_submission' AND "causeReviewId" IS NOT NULL AND "outcome" IN ('still_open', 'resolved')) OR ("trigger" IN ('loop_terminated', 'correction_failed', 'aborted') AND "causeReviewId" IS NULL AND "outcome" = 'unaddressed'))),
    CONSTRAINT "ReviewFindingDisposition_assessmentSnapshotJson_check" CHECK ("assessmentSnapshot" IS NULL OR (json_valid("assessmentSnapshot") AND json_type("assessmentSnapshot") = 'object'))
);`,
          columns: [
            'id',
            'sourceFindingId',
            'causeReviewId',
            'sequence',
            'trigger',
            'outcome',
            'note',
            'assessedArtifactVersionId',
            'assessmentSnapshot',
            'createdAt'
          ]
        },
        {
          tableName: 'ReviewScopeSnapshot',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ReviewScopeSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "scopeTurnMessageId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "snapshotJson" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "blockCount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewScopeSnapshot_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewScopeSnapshot_state_check" CHECK ("state" IN ('staging', 'ready')),
    CONSTRAINT "ReviewScopeSnapshot_snapshotJson_check" CHECK (json_valid("snapshotJson") AND json_type("snapshotJson") = 'object')
);`,
          columns: [
            'id',
            'projectId',
            'sessionId',
            'reviewId',
            'scopeTurnMessageId',
            'state',
            'snapshotJson',
            'checksum',
            'storageKey',
            'schemaVersion',
            'blockCount',
            'createdAt'
          ]
        }
      ],
      dropOrder: ['ReviewFindingDisposition', 'ReviewScopeSnapshot', 'Finding', 'Review'],
      indexes: [
        `CREATE INDEX IF NOT EXISTS "ReviewFindingDisposition_causeReviewId_createdAt_idx" ON "ReviewFindingDisposition"("causeReviewId", "createdAt");`,
        `CREATE INDEX IF NOT EXISTS "ReviewFindingDisposition_assessedArtifactVersionId_idx" ON "ReviewFindingDisposition"("assessedArtifactVersionId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ReviewFindingDisposition_sourceFindingId_sequence_key" ON "ReviewFindingDisposition"("sourceFindingId", "sequence");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ReviewScopeSnapshot_reviewId_key" ON "ReviewScopeSnapshot"("reviewId");`,
        `CREATE INDEX IF NOT EXISTS "ReviewScopeSnapshot_projectId_sessionId_state_idx" ON "ReviewScopeSnapshot"("projectId", "sessionId", "state");`
      ]
    },
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'FileOriginSession',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "FileOriginSession" (
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "titleSnapshot" TEXT,
    "state" TEXT NOT NULL DEFAULT 'active',
    "deletedAt" DATETIME,
    "deletionOperationId" TEXT,
    "retainedReviewIdsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("projectId", "sessionId"),
    CONSTRAINT "FileOriginSession_state_check" CHECK ("state" IN ('active', 'deleting', 'deleted')),
    CONSTRAINT "FileOriginSession_retainedReviewIdsJson_check" CHECK ("retainedReviewIdsJson" IS NULL OR (json_valid("retainedReviewIdsJson") AND json_type("retainedReviewIdsJson") = 'array')),
    CONSTRAINT "FileOriginSession_lifecycle_check" CHECK ((("state" = 'active' AND "deletedAt" IS NULL AND "deletionOperationId" IS NULL AND "retainedReviewIdsJson" IS NULL) OR ("state" = 'deleting' AND "deletedAt" IS NULL AND "deletionOperationId" IS NOT NULL AND "retainedReviewIdsJson" IS NOT NULL) OR ("state" = 'deleted' AND "deletedAt" IS NOT NULL AND "deletionOperationId" IS NULL AND "retainedReviewIdsJson" IS NULL)))
);`,
          columns: [
            'projectId',
            'sessionId',
            'titleSnapshot',
            'state',
            'deletedAt',
            'deletionOperationId',
            'retainedReviewIdsJson',
            'createdAt',
            'updatedAt'
          ]
        },
        {
          tableName: 'ArtifactLineage',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ArtifactLineage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "normalizedFilename" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactLineage_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
);`,
          columns: [
            'id',
            'projectId',
            'sessionId',
            'normalizedFilename',
            'filename',
            'createdAt',
            'updatedAt'
          ]
        },
        {
          tableName: 'UploadFile',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "UploadFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadFile_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
);`,
          columns: [
            'id',
            'projectId',
            'sessionId',
            'filename',
            'originalFilename',
            'createdAt',
            'updatedAt'
          ]
        },
        {
          tableName: 'UploadVersion',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "UploadVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadFileId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staging',
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
    CONSTRAINT "UploadVersion_state_check" CHECK ("state" IN ('staging', 'ready'))
);`,
          columns: [
            'id',
            'uploadFileId',
            'versionNumber',
            'state',
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
          tableName: 'ArtifactMessageSnapshot',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ArtifactMessageSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "rootFrameId" TEXT NOT NULL,
    "agentFrameId" TEXT NOT NULL,
    "messageBranchId" TEXT NOT NULL,
    "terminalMessageId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL DEFAULT '',
    "messageCount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactMessageSnapshot_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactMessageSnapshot_state_check" CHECK ("state" IN ('staging', 'ready'))
);`,
          columns: [
            'id',
            'projectId',
            'sessionId',
            'rootFrameId',
            'agentFrameId',
            'messageBranchId',
            'terminalMessageId',
            'state',
            'storageKey',
            'checksum',
            'messageCount',
            'createdAt',
            'updatedAt'
          ]
        },
        {
          tableName: 'ArtifactVersion',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ArtifactVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "artifactRunId" TEXT NOT NULL,
    "writeOperationId" TEXT,
    "writeRequestChecksum" TEXT,
    "rootFrameId" TEXT NOT NULL,
    "agentFrameId" TEXT NOT NULL,
    "messageBranchId" TEXT NOT NULL,
    "runtimeSegmentId" TEXT NOT NULL,
    "promptMessageId" TEXT NOT NULL,
    "notebookSessionId" TEXT,
    "producerRunId" TEXT,
    "producerRunIndex" INTEGER,
    "messageId" TEXT,
    "messageSnapshotId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "contentStorageKey" TEXT NOT NULL,
    "evidenceStorageKey" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "evidenceChecksum" TEXT NOT NULL,
    "evidenceSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "executionSnapshotJson" TEXT,
    "executionSnapshotChecksum" TEXT,
    "executionSnapshotStorageKey" TEXT,
    "executionSnapshotSchemaVersion" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "ArtifactLineage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersion_messageSnapshotId_fkey" FOREIGN KEY ("messageSnapshotId") REFERENCES "ArtifactMessageSnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersion_state_check" CHECK ("state" IN ('staging', 'pending', 'finalized')),
    CONSTRAINT "ArtifactVersion_filename_check" CHECK (length("filename") > 0),
    CONSTRAINT "ArtifactVersion_evidenceJson_check" CHECK (json_valid("evidenceJson") AND json_type("evidenceJson") = 'object'),
    CONSTRAINT "ArtifactVersion_executionSnapshotJson_check" CHECK ("executionSnapshotJson" IS NULL OR (json_valid("executionSnapshotJson") AND json_type("executionSnapshotJson") = 'object')),
    CONSTRAINT "ArtifactVersion_executionSnapshotBundle_check" CHECK ((("executionSnapshotJson" IS NULL AND "executionSnapshotChecksum" IS NULL AND "executionSnapshotStorageKey" IS NULL AND "executionSnapshotSchemaVersion" IS NULL) OR ("executionSnapshotJson" IS NOT NULL AND "executionSnapshotChecksum" IS NOT NULL AND "executionSnapshotStorageKey" IS NOT NULL AND "executionSnapshotSchemaVersion" IS NOT NULL)))
);`,
          columns: [
            'id',
            'artifactId',
            'versionNumber',
            'filename',
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
          tableName: 'ArtifactVersionInput',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ArtifactVersionInput" (
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
    CONSTRAINT "ArtifactVersionInput_strongestAssociation_check" CHECK ("strongestAssociation" IN ('turn-attached', 'resolver-accessed', 'captured-version'))
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
        }
      ],
      dropOrder: [
        'ArtifactVersionInput',
        'ArtifactVersion',
        'ArtifactMessageSnapshot',
        'UploadVersion',
        'UploadFile',
        'ArtifactLineage',
        'FileOriginSession'
      ],
      indexes: [
        `CREATE INDEX IF NOT EXISTS "FileOriginSession_projectId_state_idx" ON "FileOriginSession"("projectId", "state");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactLineage_projectId_sessionId_idx" ON "ArtifactLineage"("projectId", "sessionId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactLineage_projectId_sessionId_normalizedFilename_key" ON "ArtifactLineage"("projectId", "sessionId", "normalizedFilename");`,
        `CREATE INDEX IF NOT EXISTS "UploadFile_projectId_sessionId_idx" ON "UploadFile"("projectId", "sessionId");`,
        `CREATE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_state_registeredAt_idx" ON "UploadVersion"("uploadFileId", "state", "registeredAt");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_versionNumber_key" ON "UploadVersion"("uploadFileId", "versionNumber");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactMessageSnapshot_projectId_sessionId_state_idx" ON "ArtifactMessageSnapshot"("projectId", "sessionId", "state");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactMessageSnapshot_projectId_sessionId_agentFrameId_messageBranchId_terminalMessageId_key" ON "ArtifactMessageSnapshot"("projectId", "sessionId", "agentFrameId", "messageBranchId", "terminalMessageId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_writeOperationId_key" ON "ArtifactVersion"("writeOperationId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_createdAt_idx" ON "ArtifactVersion"("artifactId", "createdAt");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactRunId_state_idx" ON "ArtifactVersion"("artifactRunId", "state");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersion_rootFrameId_agentFrameId_messageBranchId_promptMessageId_idx" ON "ArtifactVersion"("rootFrameId", "agentFrameId", "messageBranchId", "promptMessageId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageId_idx" ON "ArtifactVersion"("messageId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageSnapshotId_idx" ON "ArtifactVersion"("messageSnapshotId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_versionNumber_key" ON "ArtifactVersion"("artifactId", "versionNumber");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceKind_inputFileVersionId_idx" ON "ArtifactVersionInput"("sourceKind", "inputFileVersionId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceArtifactVersionId_idx" ON "ArtifactVersionInput"("sourceArtifactVersionId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceUploadVersionId_idx" ON "ArtifactVersionInput"("sourceUploadVersionId");`,
        `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceProjectId_sourceSessionId_idx" ON "ArtifactVersionInput"("sourceProjectId", "sourceSessionId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_sourceKind_inputFileVersionId_key" ON "ArtifactVersionInput"("artifactVersionId", "sourceKind", "inputFileVersionId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_ordinal_key" ON "ArtifactVersionInput"("artifactVersionId", "ordinal");`
      ]
    },
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'ManagedFile',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ManagedFile" (
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
    CONSTRAINT "ManagedFile_source_check" CHECK ("source" IN ('artifact', 'upload'))
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
        }
      ],
      dropOrder: ['ManagedFile'],
      indexes: [
        `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "deletedAt", "sortAtMs", "seq");`,
        `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "source", "deletedAt", "sortAtMs", "seq");`,
        `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_sessionId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "sessionId", "source", "deletedAt", "sortAtMs", "seq");`,
        `CREATE INDEX IF NOT EXISTS "ManagedFile_sessionId_deletedAt_idx" ON "ManagedFile"("sessionId", "deletedAt");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_sourceFileId_key" ON "ManagedFile"("projectId", "source", "sourceFileId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_storageKey_key" ON "ManagedFile"("projectId", "source", "storageKey");`
      ]
    },
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'ComputeJob',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ComputeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "intent" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "commandHash" TEXT NOT NULL,
    "environment" TEXT,
    "resourceRequest" TEXT,
    "inputManifest" TEXT,
    "outputManifest" TEXT,
    "harvestConfig" TEXT,
    "timeoutSeconds" INTEGER,
    "remoteWorkdir" TEXT,
    "remoteHandle" TEXT,
    "exitCode" INTEGER,
    "stdoutTail" TEXT,
    "stderrTail" TEXT,
    "errorCode" TEXT,
    "lastPollError" TEXT,
    "harvestError" TEXT,
    "leftOnRemote" TEXT,
    "notifiedAt" DATETIME,
    "notificationConsumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "harvestedAt" DATETIME,
    CONSTRAINT "ComputeJob_shape_check" CHECK ("shape" IN ('direct_ssh', 'scheduler_cluster', 'bridge_runner')),
    CONSTRAINT "ComputeJob_status_check" CHECK ("status" IN ('queued', 'submitted', 'running', 'success', 'failed', 'timeout', 'error')),
    CONSTRAINT "ComputeJob_errorCode_check" CHECK ("errorCode" IS NULL OR "errorCode" IN ('approval_denied', 'host_unreachable', 'dispatch_failed', 'job_failed', 'timeout', 'process_vanished')),
    CONSTRAINT "ComputeJob_timeoutSeconds_check" CHECK ("timeoutSeconds" IS NULL OR "timeoutSeconds" BETWEEN 1 AND 604800),
    CONSTRAINT "ComputeJob_notification_check" CHECK ("notificationConsumedAt" IS NULL OR "notifiedAt" IS NOT NULL),
    CONSTRAINT "ComputeJob_harvestPayload_check" CHECK (("harvestError" IS NULL AND "leftOnRemote" IS NULL) OR "harvestedAt" IS NOT NULL),
    CONSTRAINT "ComputeJob_harvestState_check" CHECK ("harvestedAt" IS NULL OR "status" IN ('success', 'failed', 'timeout')),
    CONSTRAINT "ComputeJob_errorState_check" CHECK ((("errorCode" IS NULL OR "status" IN ('failed', 'timeout', 'error')) AND ("status" <> 'error' OR "errorCode" IS NOT NULL))),
    CONSTRAINT "ComputeJob_resourceRequestJson_check" CHECK ("resourceRequest" IS NULL OR (json_valid("resourceRequest") AND json_type("resourceRequest") = 'object')),
    CONSTRAINT "ComputeJob_inputManifestJson_check" CHECK ("inputManifest" IS NULL OR (json_valid("inputManifest") AND json_type("inputManifest") = 'array')),
    CONSTRAINT "ComputeJob_outputManifestJson_check" CHECK ("outputManifest" IS NULL OR (json_valid("outputManifest") AND json_type("outputManifest") = 'array')),
    CONSTRAINT "ComputeJob_harvestConfigJson_check" CHECK ("harvestConfig" IS NULL OR (json_valid("harvestConfig") AND json_type("harvestConfig") = 'object')),
    CONSTRAINT "ComputeJob_remoteHandleJson_check" CHECK ("remoteHandle" IS NULL OR (json_valid("remoteHandle") AND json_type("remoteHandle") = 'object')),
    CONSTRAINT "ComputeJob_leftOnRemoteJson_check" CHECK ("leftOnRemote" IS NULL OR (json_valid("leftOnRemote") AND json_type("leftOnRemote") = 'array'))
);`,
          columns: [
            'id',
            'providerId',
            'shape',
            'sessionId',
            'projectId',
            'status',
            'intent',
            'command',
            'commandHash',
            'environment',
            'resourceRequest',
            'inputManifest',
            'outputManifest',
            'harvestConfig',
            'timeoutSeconds',
            'remoteWorkdir',
            'remoteHandle',
            'exitCode',
            'stdoutTail',
            'stderrTail',
            'errorCode',
            'lastPollError',
            'harvestError',
            'leftOnRemote',
            'notifiedAt',
            'notificationConsumedAt',
            'createdAt',
            'submittedAt',
            'startedAt',
            'finishedAt',
            'harvestedAt'
          ]
        },
        {
          tableName: 'ComputeHost',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ComputeHost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "shape" TEXT NOT NULL DEFAULT 'direct_ssh',
    "sshAlias" TEXT NOT NULL,
    "sshOverrides" TEXT,
    "scratchRoot" TEXT,
    "scratchPinned" BOOLEAN NOT NULL DEFAULT false,
    "concurrencyLimit" INTEGER,
    "probeResult" TEXT,
    "detailsDoc" TEXT NOT NULL DEFAULT '',
    "detailsUpdatedAt" DATETIME,
    "detailsUpdatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ComputeHost_shape_check" CHECK ("shape" IN ('direct_ssh', 'scheduler_cluster', 'bridge_runner')),
    CONSTRAINT "ComputeHost_scratchPinned_check" CHECK ("scratchPinned" IN (false, true)),
    CONSTRAINT "ComputeHost_concurrencyLimit_check" CHECK ("concurrencyLimit" IS NULL OR "concurrencyLimit" BETWEEN 1 AND 500),
    CONSTRAINT "ComputeHost_detailsUpdatedBy_check" CHECK ("detailsUpdatedBy" IS NULL OR "detailsUpdatedBy" IN ('user', 'agent')),
    CONSTRAINT "ComputeHost_detailsUpdate_check" CHECK (("detailsUpdatedAt" IS NULL AND "detailsUpdatedBy" IS NULL) OR ("detailsUpdatedAt" IS NOT NULL AND "detailsUpdatedBy" IS NOT NULL)),
    CONSTRAINT "ComputeHost_scratchRoot_check" CHECK ("scratchPinned" = false OR "scratchRoot" IS NOT NULL),
    CONSTRAINT "ComputeHost_sshOverridesJson_check" CHECK ("sshOverrides" IS NULL OR (json_valid("sshOverrides") AND json_type("sshOverrides") = 'object')),
    CONSTRAINT "ComputeHost_probeResultJson_check" CHECK ("probeResult" IS NULL OR (json_valid("probeResult") AND json_type("probeResult") = 'object'))
);`,
          columns: [
            'id',
            'providerId',
            'displayName',
            'shape',
            'sshAlias',
            'sshOverrides',
            'scratchRoot',
            'scratchPinned',
            'concurrencyLimit',
            'probeResult',
            'detailsDoc',
            'detailsUpdatedAt',
            'detailsUpdatedBy',
            'createdAt',
            'updatedAt'
          ]
        }
      ],
      dropOrder: ['ComputeJob', 'ComputeHost'],
      indexes: [
        `CREATE INDEX IF NOT EXISTS "ComputeJob_providerId_idx" ON "ComputeJob"("providerId");`,
        `CREATE INDEX IF NOT EXISTS "ComputeJob_sessionId_idx" ON "ComputeJob"("sessionId");`,
        `CREATE INDEX IF NOT EXISTS "ComputeJob_status_idx" ON "ComputeJob"("status");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ComputeHost_providerId_key" ON "ComputeHost"("providerId");`
      ]
    }
  ] as const,
  verifiers: [
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'NotificationInboxItem',
          constraints: [
            {
              name: 'NotificationInboxItem_kind_check',
              expression: `"kind" IN ('task.completed', 'task.needs-attention', 'task.failed', 'authorization.required')`
            },
            {
              name: 'NotificationInboxItem_actionState_check',
              expression: `"actionState" IS NULL OR "actionState" IN ('pending', 'resolved', 'rejected', 'expired', 'cancelled')`
            },
            {
              name: 'NotificationInboxItem_actionLifecycle_check',
              expression: `(("actionState" IS NULL AND "settledAt" IS NULL) OR ("actionState" IS NOT NULL AND (("actionState" = 'pending' AND "settledAt" IS NULL) OR ("actionState" IN ('resolved', 'rejected', 'expired', 'cancelled') AND "settledAt" IS NOT NULL))))`
            },
            {
              name: 'NotificationInboxItem_actionKind_check',
              expression: `"actionState" IS NULL OR "kind" IN ('task.needs-attention', 'authorization.required')`
            },
            {
              name: 'NotificationInboxItem_targetInvalidated_check',
              expression: `"targetInvalidatedAt" IS NULL OR ("sessionId" IS NOT NULL AND "readAt" IS NOT NULL)`
            }
          ]
        },
        {
          table: 'ProjectPreviewState',
          constraints: [
            {
              name: 'ProjectPreviewState_panelState_check',
              expression: `"panelState" IN ('open', 'collapsed')`
            },
            {
              name: 'ProjectPreviewState_itemsJson_check',
              expression: `json_valid("items") AND json_type("items") = 'array'`
            }
          ]
        },
        {
          table: 'FileOriginSession',
          constraints: [
            {
              name: 'FileOriginSession_retainedReviewIdsJson_check',
              expression: `"retainedReviewIdsJson" IS NULL OR (json_valid("retainedReviewIdsJson") AND json_type("retainedReviewIdsJson") = 'array')`
            },
            {
              name: 'FileOriginSession_lifecycle_check',
              expression: `(("state" = 'active' AND "deletedAt" IS NULL AND "deletionOperationId" IS NULL AND "retainedReviewIdsJson" IS NULL) OR ("state" = 'deleting' AND "deletedAt" IS NULL AND "deletionOperationId" IS NOT NULL AND "retainedReviewIdsJson" IS NOT NULL) OR ("state" = 'deleted' AND "deletedAt" IS NOT NULL AND "deletionOperationId" IS NULL AND "retainedReviewIdsJson" IS NULL))`
            }
          ]
        },
        {
          table: 'ManagedFile',
          constraints: [
            {
              name: 'ManagedFile_source_check',
              expression: `"source" IN ('artifact', 'upload')`
            }
          ]
        },
        {
          table: 'ArtifactVersion',
          constraints: [
            {
              name: 'ArtifactVersion_evidenceJson_check',
              expression: `json_valid("evidenceJson") AND json_type("evidenceJson") = 'object'`
            },
            {
              name: 'ArtifactVersion_executionSnapshotJson_check',
              expression: `"executionSnapshotJson" IS NULL OR (json_valid("executionSnapshotJson") AND json_type("executionSnapshotJson") = 'object')`
            },
            {
              name: 'ArtifactVersion_executionSnapshotBundle_check',
              expression: `(("executionSnapshotJson" IS NULL AND "executionSnapshotChecksum" IS NULL AND "executionSnapshotStorageKey" IS NULL AND "executionSnapshotSchemaVersion" IS NULL) OR ("executionSnapshotJson" IS NOT NULL AND "executionSnapshotChecksum" IS NOT NULL AND "executionSnapshotStorageKey" IS NOT NULL AND "executionSnapshotSchemaVersion" IS NOT NULL))`
            }
          ]
        },
        {
          table: 'ArtifactVersionInput',
          constraints: [
            {
              name: 'ArtifactVersionInput_strongestAssociation_check',
              expression: `"strongestAssociation" IN ('turn-attached', 'resolver-accessed', 'captured-version')`
            }
          ]
        },
        {
          table: 'ReviewScopeSnapshot',
          constraints: [
            {
              name: 'ReviewScopeSnapshot_snapshotJson_check',
              expression: `json_valid("snapshotJson") AND json_type("snapshotJson") = 'object'`
            }
          ]
        },
        {
          table: 'Review',
          constraints: [
            {
              name: 'Review_scopeJson_check',
              expression: `json_valid("scope") AND json_type("scope") = 'object'`
            },
            {
              name: 'Review_reviewerLogJson_check',
              expression: `json_valid("reviewerLog") AND json_type("reviewerLog") = 'array'`
            }
          ]
        },
        {
          table: 'Finding',
          constraints: [
            {
              name: 'Finding_locatorJson_check',
              expression: `json_valid("locator") AND json_type("locator") = 'object'`
            }
          ]
        },
        {
          table: 'ReviewFindingDisposition',
          constraints: [
            {
              name: 'ReviewFindingDisposition_assessmentSnapshotJson_check',
              expression: `"assessmentSnapshot" IS NULL OR (json_valid("assessmentSnapshot") AND json_type("assessmentSnapshot") = 'object')`
            }
          ]
        },
        {
          table: 'ComputeJob',
          constraints: [
            {
              name: 'ComputeJob_resourceRequestJson_check',
              expression: `"resourceRequest" IS NULL OR (json_valid("resourceRequest") AND json_type("resourceRequest") = 'object')`
            },
            {
              name: 'ComputeJob_inputManifestJson_check',
              expression: `"inputManifest" IS NULL OR (json_valid("inputManifest") AND json_type("inputManifest") = 'array')`
            },
            {
              name: 'ComputeJob_outputManifestJson_check',
              expression: `"outputManifest" IS NULL OR (json_valid("outputManifest") AND json_type("outputManifest") = 'array')`
            },
            {
              name: 'ComputeJob_harvestConfigJson_check',
              expression: `"harvestConfig" IS NULL OR (json_valid("harvestConfig") AND json_type("harvestConfig") = 'object')`
            },
            {
              name: 'ComputeJob_remoteHandleJson_check',
              expression: `"remoteHandle" IS NULL OR (json_valid("remoteHandle") AND json_type("remoteHandle") = 'object')`
            },
            {
              name: 'ComputeJob_leftOnRemoteJson_check',
              expression: `"leftOnRemote" IS NULL OR (json_valid("leftOnRemote") AND json_type("leftOnRemote") = 'array')`
            }
          ]
        },
        {
          table: 'ComputeHost',
          constraints: [
            {
              name: 'ComputeHost_sshOverridesJson_check',
              expression: `"sshOverrides" IS NULL OR (json_valid("sshOverrides") AND json_type("sshOverrides") = 'object')`
            },
            {
              name: 'ComputeHost_probeResultJson_check',
              expression: `"probeResult" IS NULL OR (json_valid("probeResult") AND json_type("probeResult") = 'object')`
            }
          ]
        }
      ]
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'NotificationInboxItem_id_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInboxItem_id_key" ON "NotificationInboxItem"("id");`
        },
        {
          name: 'NotificationInboxItem_dedupeKey_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInboxItem_dedupeKey_key" ON "NotificationInboxItem"("dedupeKey");`
        },
        {
          name: 'NotificationInboxItem_readAt_sequence_idx',
          sql: `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_readAt_sequence_idx" ON "NotificationInboxItem"("readAt", "sequence");`
        },
        {
          name: 'NotificationInboxItem_sessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_sessionId_idx" ON "NotificationInboxItem"("sessionId");`
        },
        {
          name: 'NotificationInboxItem_projectId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_projectId_idx" ON "NotificationInboxItem"("projectId");`
        },
        {
          name: 'ManagedFile_projectId_deletedAt_sortAtMs_seq_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "deletedAt", "sortAtMs", "seq");`
        },
        {
          name: 'ManagedFile_projectId_source_deletedAt_sortAtMs_seq_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "source", "deletedAt", "sortAtMs", "seq");`
        },
        {
          name: 'ManagedFile_projectId_sessionId_source_deletedAt_sortAtMs_seq_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_sessionId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "sessionId", "source", "deletedAt", "sortAtMs", "seq");`
        },
        {
          name: 'ManagedFile_sessionId_deletedAt_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ManagedFile_sessionId_deletedAt_idx" ON "ManagedFile"("sessionId", "deletedAt");`
        },
        {
          name: 'ManagedFile_projectId_source_sourceFileId_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_sourceFileId_key" ON "ManagedFile"("projectId", "source", "sourceFileId");`
        },
        {
          name: 'ManagedFile_projectId_source_storageKey_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_storageKey_key" ON "ManagedFile"("projectId", "source", "storageKey");`
        },
        {
          name: 'FileOriginSession_projectId_state_idx',
          sql: `CREATE INDEX IF NOT EXISTS "FileOriginSession_projectId_state_idx" ON "FileOriginSession"("projectId", "state");`
        },
        {
          name: 'ArtifactLineage_projectId_sessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactLineage_projectId_sessionId_idx" ON "ArtifactLineage"("projectId", "sessionId");`
        },
        {
          name: 'ArtifactLineage_projectId_sessionId_normalizedFilename_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactLineage_projectId_sessionId_normalizedFilename_key" ON "ArtifactLineage"("projectId", "sessionId", "normalizedFilename");`
        },
        {
          name: 'UploadFile_projectId_sessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "UploadFile_projectId_sessionId_idx" ON "UploadFile"("projectId", "sessionId");`
        },
        {
          name: 'UploadVersion_uploadFileId_state_registeredAt_idx',
          sql: `CREATE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_state_registeredAt_idx" ON "UploadVersion"("uploadFileId", "state", "registeredAt");`
        },
        {
          name: 'UploadVersion_uploadFileId_versionNumber_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_versionNumber_key" ON "UploadVersion"("uploadFileId", "versionNumber");`
        },
        {
          name: 'ArtifactMessageSnapshot_projectId_sessionId_state_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactMessageSnapshot_projectId_sessionId_state_idx" ON "ArtifactMessageSnapshot"("projectId", "sessionId", "state");`
        },
        {
          name: 'ArtifactMessageSnapshot_projectId_sessionId_agentFrameId_messageBranchId_terminalMessageId_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactMessageSnapshot_projectId_sessionId_agentFrameId_messageBranchId_terminalMessageId_key" ON "ArtifactMessageSnapshot"("projectId", "sessionId", "agentFrameId", "messageBranchId", "terminalMessageId");`
        },
        {
          name: 'ArtifactVersion_writeOperationId_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_writeOperationId_key" ON "ArtifactVersion"("writeOperationId");`
        },
        {
          name: 'ArtifactVersion_artifactId_createdAt_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_createdAt_idx" ON "ArtifactVersion"("artifactId", "createdAt");`
        },
        {
          name: 'ArtifactVersion_artifactRunId_state_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactRunId_state_idx" ON "ArtifactVersion"("artifactRunId", "state");`
        },
        {
          name: 'ArtifactVersion_rootFrameId_agentFrameId_messageBranchId_promptMessageId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersion_rootFrameId_agentFrameId_messageBranchId_promptMessageId_idx" ON "ArtifactVersion"("rootFrameId", "agentFrameId", "messageBranchId", "promptMessageId");`
        },
        {
          name: 'ArtifactVersion_messageId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageId_idx" ON "ArtifactVersion"("messageId");`
        },
        {
          name: 'ArtifactVersion_messageSnapshotId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageSnapshotId_idx" ON "ArtifactVersion"("messageSnapshotId");`
        },
        {
          name: 'ArtifactVersion_artifactId_versionNumber_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_versionNumber_key" ON "ArtifactVersion"("artifactId", "versionNumber");`
        },
        {
          name: 'ArtifactVersionInput_sourceKind_inputFileVersionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceKind_inputFileVersionId_idx" ON "ArtifactVersionInput"("sourceKind", "inputFileVersionId");`
        },
        {
          name: 'ArtifactVersionInput_sourceArtifactVersionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceArtifactVersionId_idx" ON "ArtifactVersionInput"("sourceArtifactVersionId");`
        },
        {
          name: 'ArtifactVersionInput_sourceUploadVersionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceUploadVersionId_idx" ON "ArtifactVersionInput"("sourceUploadVersionId");`
        },
        {
          name: 'ArtifactVersionInput_sourceProjectId_sourceSessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceProjectId_sourceSessionId_idx" ON "ArtifactVersionInput"("sourceProjectId", "sourceSessionId");`
        },
        {
          name: 'ArtifactVersionInput_artifactVersionId_sourceKind_inputFileVersionId_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_sourceKind_inputFileVersionId_key" ON "ArtifactVersionInput"("artifactVersionId", "sourceKind", "inputFileVersionId");`
        },
        {
          name: 'ArtifactVersionInput_artifactVersionId_ordinal_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_ordinal_key" ON "ArtifactVersionInput"("artifactVersionId", "ordinal");`
        },
        {
          name: 'ReviewFindingDisposition_causeReviewId_createdAt_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ReviewFindingDisposition_causeReviewId_createdAt_idx" ON "ReviewFindingDisposition"("causeReviewId", "createdAt");`
        },
        {
          name: 'ReviewFindingDisposition_assessedArtifactVersionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ReviewFindingDisposition_assessedArtifactVersionId_idx" ON "ReviewFindingDisposition"("assessedArtifactVersionId");`
        },
        {
          name: 'ReviewFindingDisposition_sourceFindingId_sequence_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ReviewFindingDisposition_sourceFindingId_sequence_key" ON "ReviewFindingDisposition"("sourceFindingId", "sequence");`
        },
        {
          name: 'ReviewScopeSnapshot_reviewId_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ReviewScopeSnapshot_reviewId_key" ON "ReviewScopeSnapshot"("reviewId");`
        },
        {
          name: 'ReviewScopeSnapshot_projectId_sessionId_state_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ReviewScopeSnapshot_projectId_sessionId_state_idx" ON "ReviewScopeSnapshot"("projectId", "sessionId", "state");`
        },
        {
          name: 'ComputeJob_providerId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ComputeJob_providerId_idx" ON "ComputeJob"("providerId");`
        },
        {
          name: 'ComputeJob_sessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ComputeJob_sessionId_idx" ON "ComputeJob"("sessionId");`
        },
        {
          name: 'ComputeJob_status_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ComputeJob_status_idx" ON "ComputeJob"("status");`
        },
        {
          name: 'ComputeHost_providerId_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ComputeHost_providerId_key" ON "ComputeHost"("providerId");`
        }
      ]
    }
  ] as const
}

export { databaseJsonConstraintsMigration }
