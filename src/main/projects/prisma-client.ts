import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { PrismaClient } from '@prisma/client'

import {
  ensureSqliteCheckConstraints,
  type SqliteCheckConstraintMigration
} from './sqlite-schema-migrations'

const PROJECT_DB_FILE = 'open-science.db'
// SQLite PRAGMAs are connection-scoped. The runtime constraint migration disables foreign keys
// before entering its rebuild transaction, so this client must keep both operations on one physical
// connection. A single writer also avoids unnecessary SQLITE_BUSY contention for the local Project DB.
const PROJECT_DB_CONNECTION_LIMIT = 1

// Exact DDL Prisma generates for the Project model (verified via `prisma migrate diff`). Applying it as
// CREATE TABLE IF NOT EXISTS lets a packaged app create its schema without shipping the migrate engine,
// while staying byte-compatible with what the generated client reads and writes.
const PROJECT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isExample" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`

// Same runtime-DDL approach for the per-project preview panel state table.
const PREVIEW_STATE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ProjectPreviewState" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "panelState" TEXT NOT NULL,
    "activeItemId" TEXT,
    "items" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);`

// Reviewer results: one Review per audited turn, plus its child checks (stored in Finding table).
// v2 (issue 12): Review no longer has summary/checks JSON columns; all checks are Finding rows.
// v3 (issue 13): reasoning replaced by reviewerLog (captured action stream JSON array).
// Same runtime-DDL approach — applied as CREATE TABLE IF NOT EXISTS so a packaged app stays
// byte-compatible with the generated client.
const REVIEW_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "Review" (
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
    "updatedAt" DATETIME NOT NULL
);`

// Migration: for existing DBs that still have the old reasoning column, add reviewerLog.
// The reasoning column is simply ignored by the new Prisma client.
const REVIEW_ADD_REVIEWER_LOG_DDL = `ALTER TABLE "Review" ADD COLUMN "reviewerLog" TEXT NOT NULL DEFAULT '[]'`

// Migration: add the `status` column to Finding if it doesn't exist yet (for DBs that have the old
// `severity` column). The schema guard below checks the desired column before applying this DDL.
const FINDING_ADD_STATUS_COLUMN_DDL = `ALTER TABLE "Finding" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pass'`

// The FOREIGN KEY ... ON DELETE CASCADE matches Prisma's generated DDL; the reviewer repository also
// deletes findings explicitly (deleteReviewsForSession/Project) so cleanup does not depend on the
// SQLite foreign-keys pragma being enabled.
// v2: severity replaced by status ('pass'|'warn'|'fail'); locator is now optional (pass checks omit it).
// v4 (issue 15): added reflagCount column (Phase 3 fix loop re-flag counter).
const FINDING_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "Finding" (
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
    CONSTRAINT "Finding_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`

// Migration guard: add the `reflagCount` column to Finding if it doesn't exist yet (for DBs that
// predate issue 15). SQLite does not support IF NOT EXISTS on ALTER TABLE ADD COLUMN, so the schema
// guard below proves the column postcondition explicitly.
const FINDING_ADD_REFLAG_COUNT_DDL = `ALTER TABLE "Finding" ADD COLUMN "reflagCount" INTEGER NOT NULL DEFAULT 0`
const FINDING_ADD_ARTIFACT_BINDING_STATE_DDL = `ALTER TABLE "Finding" ADD COLUMN "artifactBindingState" TEXT NOT NULL DEFAULT 'legacy_unverified'`

// Runtime DDL remains idempotent for existing installations that do not run a separate migration
// command. Prisma models provide typed access after these tables and indexes have been ensured.
const PROJECT_DELETION_INTENT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ProjectDeletionIntent" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);`

// ManagedFile is a metadata projection only: storageKey points back into the existing managed roots,
// while soft-delete fields keep Files queries reversible during durable session/project deletion.
const MANAGED_FILE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ManagedFile" (
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
    "deleteOperationId" TEXT
);`

const MANAGED_FILE_ADD_SOURCE_VERSION_ID_DDL = `ALTER TABLE "ManagedFile" ADD COLUMN "sourceVersionId" TEXT`
const MANAGED_FILE_ADD_CHECKSUM_DDL = `ALTER TABLE "ManagedFile" ADD COLUMN "checksum" TEXT`

// One ledger row per session provides the filesRevision fast path, materialized source counts, and the
// independent ordering key used by artifact-group pagination.
const MANAGED_FILE_SESSION_SYNC_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ManagedFileSessionSync" (
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "filesRevision" INTEGER NOT NULL,
    "groupSortAtMs" BIGINT NOT NULL,
    "artifactCount" INTEGER NOT NULL DEFAULT 0,
    "uploadCount" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    "deleteOperationId" TEXT,
    PRIMARY KEY ("projectId", "sessionId")
);`

// Index order mirrors the three keyset queries: uploads, one session's artifacts, and session groups.
// Project-scoped unique keys also enforce canonical ownership for legacy duplicate references.
const MANAGED_FILE_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "deletedAt", "sortAtMs", "seq");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "source", "deletedAt", "sortAtMs", "seq");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_sessionId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "sessionId", "source", "deletedAt", "sortAtMs", "seq");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFile_sessionId_deletedAt_idx" ON "ManagedFile"("sessionId", "deletedAt");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_sourceFileId_key" ON "ManagedFile"("projectId", "source", "sourceFileId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_storageKey_key" ON "ManagedFile"("projectId", "source", "storageKey");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFileSessionSync_projectId_deletedAt_groupSortAtMs_sessionId_idx" ON "ManagedFileSessionSync"("projectId", "deletedAt", "groupSortAtMs", "sessionId");`
]

// Artifact Provenance starts with a narrow retained origin, one stable filename lineage, and its
// immutable save Versions. Runtime DDL mirrors Prisma's SQLite migration output so packaged installs
// can add the tables without shipping the migrate engine.
const FILE_ORIGIN_SESSION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "FileOriginSession" (
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "titleSnapshot" TEXT,
    "state" TEXT NOT NULL DEFAULT 'active',
    "deletedAt" DATETIME,
    "deletionOperationId" TEXT,
    "retainedReviewIdsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FileOriginSession_state_check" CHECK ("state" IN ('active', 'deleting', 'deleted')),
    PRIMARY KEY ("projectId", "sessionId")
);`

const ARTIFACT_LINEAGE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ArtifactLineage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "normalizedFilename" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactLineage_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
);`

const UPLOAD_FILE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "UploadFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadFile_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
);`

const UPLOAD_VERSION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "UploadVersion" (
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
    CONSTRAINT "UploadVersion_state_check" CHECK ("state" IN ('staging', 'ready')),
    CONSTRAINT "UploadVersion_uploadFileId_fkey" FOREIGN KEY ("uploadFileId") REFERENCES "UploadFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`

const ARTIFACT_MESSAGE_SNAPSHOT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ArtifactMessageSnapshot" (
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
    CONSTRAINT "ArtifactMessageSnapshot_state_check" CHECK ("state" IN ('staging', 'ready')),
    CONSTRAINT "ArtifactMessageSnapshot_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
);`

const ARTIFACT_MESSAGE_SNAPSHOT_ADD_CHECKSUM_DDL = `ALTER TABLE "ArtifactMessageSnapshot" ADD COLUMN "checksum" TEXT NOT NULL DEFAULT '';`

const ARTIFACT_VERSION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ArtifactVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
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
    CONSTRAINT "ArtifactVersion_state_check" CHECK ("state" IN ('staging', 'pending', 'finalized')),
    CONSTRAINT "ArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "ArtifactLineage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersion_messageSnapshotId_fkey" FOREIGN KEY ("messageSnapshotId") REFERENCES "ArtifactMessageSnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`

const ARTIFACT_VERSION_INPUT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ArtifactVersionInput" (
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
    CONSTRAINT "ArtifactVersionInput_sourceKind_check" CHECK ("sourceKind" IN ('artifact-version', 'upload-version')),
    CONSTRAINT "ArtifactVersionInput_sourceIdentity_check" CHECK (
      ("sourceKind" = 'artifact-version' AND "sourceArtifactVersionId" IS NOT NULL AND "sourceUploadVersionId" IS NULL AND "inputFileVersionId" = "sourceArtifactVersionId") OR
      ("sourceKind" = 'upload-version' AND "sourceUploadVersionId" IS NOT NULL AND "sourceArtifactVersionId" IS NULL AND "inputFileVersionId" = "sourceUploadVersionId")
    ),
    CONSTRAINT "ArtifactVersionInput_artifactVersionId_fkey" FOREIGN KEY ("artifactVersionId") REFERENCES "ArtifactVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceArtifactVersionId_fkey" FOREIGN KEY ("sourceArtifactVersionId") REFERENCES "ArtifactVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceUploadVersionId_fkey" FOREIGN KEY ("sourceUploadVersionId") REFERENCES "UploadVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceProjectId_sourceSessionId_fkey" FOREIGN KEY ("sourceProjectId", "sourceSessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
);`

const REVIEW_FINDING_DISPOSITION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ReviewFindingDisposition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceFindingId" TEXT NOT NULL,
    "causeReviewId" TEXT,
    "sequence" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "note" TEXT,
    "assessedArtifactVersionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewFindingDisposition_sourceFindingId_fkey" FOREIGN KEY ("sourceFindingId") REFERENCES "Finding" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewFindingDisposition_causeReviewId_fkey" FOREIGN KEY ("causeReviewId") REFERENCES "Review" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);`

const REVIEW_SCOPE_SNAPSHOT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ReviewScopeSnapshot" (
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
    CONSTRAINT "ReviewScopeSnapshot_state_check" CHECK ("state" IN ('staging', 'ready')),
    CONSTRAINT "ReviewScopeSnapshot_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`

const PROVENANCE_CHECK_CONSTRAINT_MIGRATIONS: readonly SqliteCheckConstraintMigration[] = [
  {
    tableName: 'FileOriginSession',
    columnName: 'state',
    constraintNames: ['FileOriginSession_state_check'],
    allowedValues: ['active', 'deleting', 'deleted'],
    canonicalTableDdl: FILE_ORIGIN_SESSION_TABLE_DDL
  },
  {
    tableName: 'UploadVersion',
    columnName: 'state',
    constraintNames: ['UploadVersion_state_check'],
    allowedValues: ['staging', 'ready'],
    canonicalTableDdl: UPLOAD_VERSION_TABLE_DDL
  },
  {
    tableName: 'ArtifactMessageSnapshot',
    columnName: 'state',
    constraintNames: ['ArtifactMessageSnapshot_state_check'],
    allowedValues: ['staging', 'ready'],
    canonicalTableDdl: ARTIFACT_MESSAGE_SNAPSHOT_TABLE_DDL
  },
  {
    tableName: 'ArtifactVersion',
    columnName: 'state',
    constraintNames: ['ArtifactVersion_state_check'],
    allowedValues: ['staging', 'pending', 'finalized'],
    canonicalTableDdl: ARTIFACT_VERSION_TABLE_DDL
  },
  {
    tableName: 'ArtifactVersionInput',
    columnName: 'sourceKind',
    constraintNames: [
      'ArtifactVersionInput_sourceKind_check',
      'ArtifactVersionInput_sourceIdentity_check'
    ],
    allowedValues: ['artifact-version', 'upload-version'],
    canonicalTableDdl: ARTIFACT_VERSION_INPUT_TABLE_DDL
  },
  {
    tableName: 'ReviewScopeSnapshot',
    columnName: 'state',
    constraintNames: ['ReviewScopeSnapshot_state_check'],
    allowedValues: ['staging', 'ready'],
    canonicalTableDdl: REVIEW_SCOPE_SNAPSHOT_TABLE_DDL
  }
]

const ARTIFACT_PROVENANCE_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS "FileOriginSession_projectId_state_idx" ON "FileOriginSession"("projectId", "state");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactLineage_projectId_sessionId_idx" ON "ArtifactLineage"("projectId", "sessionId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactLineage_projectId_sessionId_normalizedFilename_key" ON "ArtifactLineage"("projectId", "sessionId", "normalizedFilename");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_writeOperationId_key" ON "ArtifactVersion"("writeOperationId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_createdAt_idx" ON "ArtifactVersion"("artifactId", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactRunId_state_idx" ON "ArtifactVersion"("artifactRunId", "state");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_rootFrameId_agentFrameId_messageBranchId_promptMessageId_idx" ON "ArtifactVersion"("rootFrameId", "agentFrameId", "messageBranchId", "promptMessageId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageId_idx" ON "ArtifactVersion"("messageId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageSnapshotId_idx" ON "ArtifactVersion"("messageSnapshotId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_versionNumber_key" ON "ArtifactVersion"("artifactId", "versionNumber");`,
  `CREATE INDEX IF NOT EXISTS "UploadFile_projectId_sessionId_idx" ON "UploadFile"("projectId", "sessionId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_versionNumber_key" ON "UploadVersion"("uploadFileId", "versionNumber");`,
  `CREATE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_state_registeredAt_idx" ON "UploadVersion"("uploadFileId", "state", "registeredAt");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactMessageSnapshot_projectId_sessionId_agentFrameId_messageBranchId_terminalMessageId_key" ON "ArtifactMessageSnapshot"("projectId", "sessionId", "agentFrameId", "messageBranchId", "terminalMessageId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactMessageSnapshot_projectId_sessionId_state_idx" ON "ArtifactMessageSnapshot"("projectId", "sessionId", "state");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_sourceKind_inputFileVersionId_key" ON "ArtifactVersionInput"("artifactVersionId", "sourceKind", "inputFileVersionId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_ordinal_key" ON "ArtifactVersionInput"("artifactVersionId", "ordinal");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceKind_inputFileVersionId_idx" ON "ArtifactVersionInput"("sourceKind", "inputFileVersionId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceArtifactVersionId_idx" ON "ArtifactVersionInput"("sourceArtifactVersionId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceUploadVersionId_idx" ON "ArtifactVersionInput"("sourceUploadVersionId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceProjectId_sourceSessionId_idx" ON "ArtifactVersionInput"("sourceProjectId", "sourceSessionId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ReviewFindingDisposition_sourceFindingId_sequence_key" ON "ReviewFindingDisposition"("sourceFindingId", "sequence");`,
  `CREATE INDEX IF NOT EXISTS "ReviewFindingDisposition_causeReviewId_createdAt_idx" ON "ReviewFindingDisposition"("causeReviewId", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "ReviewFindingDisposition_assessedArtifactVersionId_idx" ON "ReviewFindingDisposition"("assessedArtifactVersionId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ReviewScopeSnapshot_reviewId_key" ON "ReviewScopeSnapshot"("reviewId");`,
  `CREATE INDEX IF NOT EXISTS "ReviewScopeSnapshot_projectId_sessionId_state_idx" ON "ReviewScopeSnapshot"("projectId", "sessionId", "state");`
]

// Compute settings: one row per registered SSH compute host (Compute tab, issue 01). Pure-additive
// table — it references nothing and nothing references it, so this CREATE runs safely against any
// pre-existing DB. The DDL is byte-identical to what `prisma migrate diff` generates for the
// ComputeHost model (verified in prisma-client.test.ts), keeping the runtime schema compatible with
// the generated client without shipping the migrate engine. Security: only an ssh alias + optional
// non-secret overrides are stored here; no credentials or keys (design.md §1/§3).
const COMPUTE_HOST_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ComputeHost" (
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
    "updatedAt" DATETIME NOT NULL
);`

// The unique index Prisma expects for @unique providerId. Created separately (matching the migrate
// output) and guarded with IF NOT EXISTS so re-running ensure is idempotent.
const COMPUTE_HOST_PROVIDER_ID_INDEX_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS "ComputeHost_providerId_key" ON "ComputeHost"("providerId")`

// Compute jobs (Phase 3a, compute-jobs issue 01). Pure-additive table — references nothing and
// nothing references it. Tracks the full job lifecycle from submitted through terminal states.
// Harvest columns (harvestedAt, outputManifest) are created now but filled in Phase 3b only.
// Security: command stored for audit; commandHash for dedup; no credentials ever stored.
// compute-jobs issue 02: added lastPollError for SSH-connectivity-failure recording (design.md §8).
// compute-harvest issue 01: added harvestError, leftOnRemote, notifiedAt, notificationConsumedAt
//   (pure-additive; null until Phase 3b fills them).
const COMPUTE_JOB_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ComputeJob" (
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
    "harvestedAt" DATETIME
);`

// Migration guard: add lastPollError to ComputeJob for DBs created before compute-jobs issue 02.
const COMPUTE_JOB_ADD_LAST_POLL_ERROR_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "lastPollError" TEXT`

// Migration guards: add the 4 new Phase 3b harvest columns to ComputeJob for DBs created before
// compute-harvest issue 01. Each is nullable and defaults to NULL so existing rows are unaffected.
const COMPUTE_JOB_ADD_HARVEST_ERROR_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "harvestError" TEXT`
const COMPUTE_JOB_ADD_LEFT_ON_REMOTE_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "leftOnRemote" TEXT`
const COMPUTE_JOB_ADD_NOTIFIED_AT_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "notifiedAt" DATETIME`
const COMPUTE_JOB_ADD_NOTIFICATION_CONSUMED_AT_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "notificationConsumedAt" DATETIME`

// Indexes for ComputeJob: by providerId (per-host poller queries), sessionId (UI list), status
// (finding non-terminal jobs on restart). IF NOT EXISTS makes re-runs idempotent.
const COMPUTE_JOB_PROVIDER_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "ComputeJob_providerId_idx" ON "ComputeJob"("providerId")`
const COMPUTE_JOB_SESSION_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "ComputeJob_sessionId_idx" ON "ComputeJob"("sessionId")`
const COMPUTE_JOB_STATUS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "ComputeJob_status_idx" ON "ComputeJob"("status")`

// Builds a client bound to the SQLite file under the given storage root. Not a singleton, so tests can
// point separate clients at temp directories. Backslashes are normalized so the file: URL is valid on
// Windows (Prisma's SQLite connector expects forward slashes).
const createProjectDbClient = (storageRoot: string): PrismaClient => {
  const dbPath = join(storageRoot, PROJECT_DB_FILE).replace(/\\/g, '/')

  return new PrismaClient({
    datasources: {
      db: { url: `file:${dbPath}?connection_limit=${PROJECT_DB_CONNECTION_LIMIT}` }
    }
  })
}

type SqliteTableColumn = { name: string }

const quoteSqliteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`

const hasTableColumn = async (
  client: PrismaClient,
  tableName: string,
  columnName: string
): Promise<boolean> => {
  const columns = await client.$queryRawUnsafe<SqliteTableColumn[]>(
    `PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`
  )
  return columns.some((column) => column.name === columnName)
}

// SQLite does not support ALTER TABLE ... ADD COLUMN IF NOT EXISTS. Prove the desired postcondition
// instead of interpreting an engine-specific error string: a failed ALTER is ignored only when a
// second schema read confirms that another initializer added the exact column concurrently.
const addColumnIfMissing = async (
  client: PrismaClient,
  tableName: string,
  columnName: string,
  ddl: string
): Promise<void> => {
  if (await hasTableColumn(client, tableName, columnName)) return

  try {
    await client.$executeRawUnsafe(ddl)
  } catch (error) {
    if (await hasTableColumn(client, tableName, columnName)) return
    throw error
  }
}

// Creates the schema if missing. Idempotent; no projects are seeded, so a fresh install starts empty.
const ensureProjectSchema = async (client: PrismaClient): Promise<void> => {
  await client.$executeRawUnsafe(PROJECT_TABLE_DDL)
  await client.$executeRawUnsafe(PREVIEW_STATE_TABLE_DDL)
  await client.$executeRawUnsafe(REVIEW_TABLE_DDL)
  await client.$executeRawUnsafe(FINDING_TABLE_DDL)

  // Migration guard: if this is an old DB with `severity` but not `status`, add the status column.
  await addColumnIfMissing(client, 'Finding', 'status', FINDING_ADD_STATUS_COLUMN_DDL)

  // Migration guard: if this is an old DB with `reasoning` but not `reviewerLog`, add the new column.
  await addColumnIfMissing(client, 'Review', 'reviewerLog', REVIEW_ADD_REVIEWER_LOG_DDL)

  // Migration guard: add reflagCount to Finding for DBs created before issue 15.
  await addColumnIfMissing(client, 'Finding', 'reflagCount', FINDING_ADD_REFLAG_COUNT_DDL)
  await addColumnIfMissing(
    client,
    'Finding',
    'artifactBindingState',
    FINDING_ADD_ARTIFACT_BINDING_STATE_DDL
  )

  await client.$executeRawUnsafe(PROJECT_DELETION_INTENT_TABLE_DDL)
  await client.$executeRawUnsafe(MANAGED_FILE_TABLE_DDL)
  await addColumnIfMissing(
    client,
    'ManagedFile',
    'sourceVersionId',
    MANAGED_FILE_ADD_SOURCE_VERSION_ID_DDL
  )
  await addColumnIfMissing(client, 'ManagedFile', 'checksum', MANAGED_FILE_ADD_CHECKSUM_DDL)
  await client.$executeRawUnsafe(MANAGED_FILE_SESSION_SYNC_TABLE_DDL)

  for (const ddl of MANAGED_FILE_INDEX_DDLS) {
    await client.$executeRawUnsafe(ddl)
  }

  await client.$executeRawUnsafe(FILE_ORIGIN_SESSION_TABLE_DDL)
  await client.$executeRawUnsafe(ARTIFACT_LINEAGE_TABLE_DDL)
  await client.$executeRawUnsafe(UPLOAD_FILE_TABLE_DDL)
  await client.$executeRawUnsafe(UPLOAD_VERSION_TABLE_DDL)
  await client.$executeRawUnsafe(ARTIFACT_MESSAGE_SNAPSHOT_TABLE_DDL)
  await addColumnIfMissing(
    client,
    'ArtifactMessageSnapshot',
    'checksum',
    ARTIFACT_MESSAGE_SNAPSHOT_ADD_CHECKSUM_DDL
  )
  await client.$executeRawUnsafe(ARTIFACT_VERSION_TABLE_DDL)
  await client.$executeRawUnsafe(ARTIFACT_VERSION_INPUT_TABLE_DDL)
  await client.$executeRawUnsafe(REVIEW_FINDING_DISPOSITION_TABLE_DDL)
  await client.$executeRawUnsafe(REVIEW_SCOPE_SNAPSHOT_TABLE_DDL)

  await ensureSqliteCheckConstraints(client, PROVENANCE_CHECK_CONSTRAINT_MIGRATIONS)

  for (const ddl of ARTIFACT_PROVENANCE_INDEX_DDLS) {
    await client.$executeRawUnsafe(ddl)
  }

  // Compute hosts (issue 01): pure-additive table + its unique index. Both use IF NOT EXISTS so they
  // are safe to (re)run on any existing DB without disturbing the reviewer/project tables above.
  await client.$executeRawUnsafe(COMPUTE_HOST_TABLE_DDL)
  await client.$executeRawUnsafe(COMPUTE_HOST_PROVIDER_ID_INDEX_DDL)

  // Compute jobs (compute-jobs issue 01, Phase 3a): pure-additive table + three indexes.
  // IF NOT EXISTS makes each statement safe to re-run on any pre-existing DB.
  await client.$executeRawUnsafe(COMPUTE_JOB_TABLE_DDL)
  await client.$executeRawUnsafe(COMPUTE_JOB_PROVIDER_INDEX_DDL)
  await client.$executeRawUnsafe(COMPUTE_JOB_SESSION_INDEX_DDL)
  await client.$executeRawUnsafe(COMPUTE_JOB_STATUS_INDEX_DDL)

  // Migration guard: add lastPollError column for DBs created before compute-jobs issue 02.
  await addColumnIfMissing(
    client,
    'ComputeJob',
    'lastPollError',
    COMPUTE_JOB_ADD_LAST_POLL_ERROR_DDL
  )

  // Migration guards: add Phase 3b harvest columns for DBs created before compute-harvest issue 01.
  // Each column is nullable (default NULL), so existing rows are unaffected (CLAUDE.md requirement).
  await addColumnIfMissing(client, 'ComputeJob', 'harvestError', COMPUTE_JOB_ADD_HARVEST_ERROR_DDL)
  await addColumnIfMissing(client, 'ComputeJob', 'leftOnRemote', COMPUTE_JOB_ADD_LEFT_ON_REMOTE_DDL)
  await addColumnIfMissing(client, 'ComputeJob', 'notifiedAt', COMPUTE_JOB_ADD_NOTIFIED_AT_DDL)
  await addColumnIfMissing(
    client,
    'ComputeJob',
    'notificationConsumedAt',
    COMPUTE_JOB_ADD_NOTIFICATION_CONSUMED_AT_DDL
  )
}

let clientPromise: Promise<PrismaClient> | undefined

// Production singleton: ensures the storage dir exists, connects, and applies the schema.
const getProjectDbClient = (storageRoot: string): Promise<PrismaClient> => {
  if (!clientPromise) {
    const pending = (async () => {
      await mkdir(storageRoot, { recursive: true })

      const client = createProjectDbClient(storageRoot)

      try {
        await ensureProjectSchema(client)
      } catch (error) {
        // Release the connection / query-engine this client opened before the retry cache is cleared,
        // so repeated init failures don't leak a PrismaClient (and its engine subprocess) per attempt.
        await client.$disconnect().catch(() => undefined)
        throw error
      }

      return client
    })()

    clientPromise = pending

    // Do not cache a failed initialization: a transient error (locked db, unwritable dir) would otherwise
    // disable projects for the entire app session. Clearing the cache lets the next call retry. Attaching
    // this handler also keeps an early rejection from becoming an unhandled rejection that could crash the
    // main process at startup — real awaiters still observe it (surfaced via the renderer project store).
    pending.catch(() => {
      if (clientPromise === pending) clientPromise = undefined
    })
  }

  return clientPromise
}

// Releases the process-wide authority-store connection before operations that require an exclusive
// SQLite checkpoint. The next repository read lazily creates a fresh client.
const disconnectProjectDbClient = async (): Promise<void> => {
  const pending = clientPromise
  if (!pending) return

  clientPromise = undefined
  const client = await pending.catch(() => undefined)
  await client?.$disconnect()
}

export { createProjectDbClient, disconnectProjectDbClient, ensureProjectSchema, getProjectDbClient }
