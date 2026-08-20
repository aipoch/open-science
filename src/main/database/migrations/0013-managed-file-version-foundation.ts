const managedFileVersionFoundationStatements = [
  `ALTER TABLE "ArtifactVersionInput" RENAME TO "_0009_old_ArtifactVersionInput";`,
  `ALTER TABLE "ArtifactVersion" RENAME TO "_0009_old_ArtifactVersion";`,
  `ALTER TABLE "UploadVersion" RENAME TO "_0009_old_UploadVersion";`,
  `ALTER TABLE "ArtifactLineage" RENAME TO "_0009_old_ArtifactLineage";`,
  `ALTER TABLE "UploadFile" RENAME TO "_0009_old_UploadFile";`,
  `CREATE TABLE "ArtifactLineage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "normalizedFilename" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactLineage_id_currentVersionId_fkey" FOREIGN KEY ("id", "currentVersionId") REFERENCES "ArtifactVersion" ("artifactId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactLineage_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
  );`,
  `INSERT INTO "ArtifactLineage" (
     "id", "projectId", "sessionId", "normalizedFilename", "filename", "createdAt", "updatedAt"
   )
   SELECT "id", "projectId", "sessionId", "normalizedFilename", "filename", "createdAt", "updatedAt"
   FROM "_0009_old_ArtifactLineage";`,
  `CREATE TABLE "UploadFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadFile_id_currentVersionId_fkey" FOREIGN KEY ("id", "currentVersionId") REFERENCES "UploadVersion" ("uploadFileId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UploadFile_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
  );`,
  `INSERT INTO "UploadFile" (
     "id", "projectId", "sessionId", "filename", "originalFilename", "createdAt", "updatedAt"
   )
   SELECT "id", "projectId", "sessionId", "filename", "originalFilename", "createdAt", "updatedAt"
   FROM "_0009_old_UploadFile";`,
  `CREATE TABLE "UploadVersion" (
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
    CONSTRAINT "UploadVersion_userEdit_check" CHECK (("originKind" <> 'user_edit' OR ("state" = 'ready' AND "basedOnVersionId" IS NOT NULL AND "storageTag" IS NOT NULL AND "storedFilename" IS NOT NULL)))
  );`,
  `INSERT INTO "UploadVersion" (
     "id", "uploadFileId", "versionNumber", "state", "originKind", "contentStorageKey",
     "filename", "originalFilename", "contentType", "sizeBytes", "checksum", "createdAt",
     "registeredAt", "updatedAt"
   )
   SELECT "id", "uploadFileId", "versionNumber", "state", 'user_upload', "contentStorageKey",
     "filename", "originalFilename", "contentType", "sizeBytes", "checksum", "createdAt",
     "registeredAt", "updatedAt"
   FROM "_0009_old_UploadVersion";`,
  `UPDATE "UploadVersion" AS "current"
   SET "basedOnVersionId" = (
     SELECT "previous"."id"
     FROM "UploadVersion" AS "previous"
     WHERE "previous"."uploadFileId" = "current"."uploadFileId"
       AND "previous"."versionNumber" < "current"."versionNumber"
       AND "previous"."state" = 'ready'
     ORDER BY "previous"."versionNumber" DESC
     LIMIT 1
   );`,
  `CREATE TABLE "ArtifactVersion" (
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
    CONSTRAINT "ArtifactVersion_executionSnapshotBundle_check" CHECK ((("executionSnapshotJson" IS NULL AND "executionSnapshotChecksum" IS NULL AND "executionSnapshotStorageKey" IS NULL AND "executionSnapshotSchemaVersion" IS NULL) OR ("executionSnapshotJson" IS NOT NULL AND "executionSnapshotChecksum" IS NOT NULL AND "executionSnapshotStorageKey" IS NOT NULL AND "executionSnapshotSchemaVersion" IS NOT NULL)))
  );`,
  `INSERT INTO "ArtifactVersion" (
     "id", "artifactId", "versionNumber", "filename", "originKind", "artifactRunId",
     "writeOperationId", "writeRequestChecksum", "rootFrameId", "agentFrameId", "messageBranchId",
     "runtimeSegmentId", "promptMessageId", "notebookSessionId", "producerRunId",
     "producerRunIndex", "messageId", "messageSnapshotId", "state", "managedVisibleAt", "contentStorageKey",
     "evidenceStorageKey", "contentType", "sizeBytes", "checksum", "evidenceJson",
     "evidenceChecksum", "evidenceSchemaVersion", "executionSnapshotJson",
     "executionSnapshotChecksum", "executionSnapshotStorageKey", "executionSnapshotSchemaVersion",
     "createdAt", "updatedAt"
   )
   SELECT
     "id", "artifactId", "versionNumber", "filename", 'agent_generated', "artifactRunId",
     "writeOperationId", "writeRequestChecksum", "rootFrameId", "agentFrameId", "messageBranchId",
     "runtimeSegmentId", "promptMessageId", "notebookSessionId", "producerRunId",
     "producerRunIndex", "messageId", "messageSnapshotId", "state",
     CASE WHEN "state" = 'finalized' THEN "createdAt" ELSE NULL END, "contentStorageKey",
     "evidenceStorageKey", "contentType", "sizeBytes", "checksum", "evidenceJson",
     "evidenceChecksum", "evidenceSchemaVersion", "executionSnapshotJson",
     "executionSnapshotChecksum", "executionSnapshotStorageKey", "executionSnapshotSchemaVersion",
     "createdAt", "updatedAt"
   FROM "_0009_old_ArtifactVersion"
   ORDER BY "artifactId", "versionNumber";`,
  `UPDATE "ArtifactVersion" AS "current"
   SET "basedOnVersionId" = (
     SELECT "previous"."id"
     FROM "ArtifactVersion" AS "previous"
     WHERE "previous"."artifactId" = "current"."artifactId"
       AND "previous"."versionNumber" < "current"."versionNumber"
       AND "previous"."state" = 'finalized'
     ORDER BY "previous"."versionNumber" DESC
     LIMIT 1
   );`,
  `CREATE TABLE "ArtifactVersionInput" (
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
  `INSERT INTO "ArtifactVersionInput" SELECT * FROM "_0009_old_ArtifactVersionInput";`,
  `DROP TABLE "_0009_old_ArtifactVersionInput";`,
  `DROP TABLE "_0009_old_ArtifactVersion";`,
  `DROP TABLE "_0009_old_UploadVersion";`,
  `DROP TABLE "_0009_old_ArtifactLineage";`,
  `DROP TABLE "_0009_old_UploadFile";`,
  `UPDATE "ArtifactLineage" AS "lineage"
   SET "currentVersionId" = (
     SELECT "version"."id"
     FROM "ArtifactVersion" AS "version"
     WHERE "version"."artifactId" = "lineage"."id" AND "version"."state" = 'finalized'
     ORDER BY "version"."versionNumber" DESC
     LIMIT 1
   );`,
  `UPDATE "UploadFile" AS "file"
   SET "currentVersionId" = (
     SELECT "version"."id"
     FROM "UploadVersion" AS "version"
     WHERE "version"."uploadFileId" = "file"."id" AND "version"."state" = 'ready'
     ORDER BY "version"."versionNumber" DESC
     LIMIT 1
   );`,
  `UPDATE "ManagedFileSessionSync" AS "sync"
   SET "filesRevision" = -1, "syncedAt" = CURRENT_TIMESTAMP
   WHERE "sync"."deletedAt" IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM "ProjectDeletionIntent" AS "intent"
       WHERE "intent"."projectId" = "sync"."projectId"
     )
     AND EXISTS (
       SELECT 1
       FROM "ManagedFile" AS "managed"
       WHERE "managed"."projectId" = "sync"."projectId"
         AND "managed"."sessionId" = "sync"."sessionId"
         AND "managed"."source" = 'upload'
         AND "managed"."deletedAt" IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM "UploadFile" AS "file"
           JOIN "UploadVersion" AS "version"
             ON "version"."uploadFileId" = "file"."id"
            AND "version"."id" = "file"."currentVersionId"
            AND "version"."state" = 'ready'
           WHERE "file"."id" = "managed"."sourceFileId"
             AND "file"."projectId" = "managed"."projectId"
         )
     );`,
  `DELETE FROM "ManagedFile"
   WHERE "source" = 'artifact'
     AND NOT EXISTS (
       SELECT 1
       FROM "ArtifactLineage" AS "lineage"
       JOIN "ArtifactVersion" AS "version"
         ON "version"."artifactId" = "lineage"."id"
        AND "version"."id" = "lineage"."currentVersionId"
        AND "version"."state" = 'finalized'
       WHERE "lineage"."id" = "ManagedFile"."sourceFileId"
         AND "lineage"."projectId" = "ManagedFile"."projectId"
     );`,
  `DELETE FROM "ManagedFile"
   WHERE "source" = 'upload'
     AND NOT EXISTS (
       SELECT 1
       FROM "UploadFile" AS "file"
       JOIN "UploadVersion" AS "version"
         ON "version"."uploadFileId" = "file"."id"
        AND "version"."id" = "file"."currentVersionId"
        AND "version"."state" = 'ready'
       WHERE "file"."id" = "ManagedFile"."sourceFileId"
         AND "file"."projectId" = "ManagedFile"."projectId"
     );`,
  `UPDATE "ManagedFile"
   SET ("sourceVersionId", "checksum", "projectId", "sessionId", "messageId", "displayName",
        "storageKey", "mimeType", "sizeBytes", "mtimeMs", "sortAtMs", "updatedAt") = (
     SELECT "version"."id", "version"."checksum", "lineage"."projectId", "lineage"."sessionId",
       "version"."messageId", "version"."filename", "version"."contentStorageKey",
       "version"."contentType", "version"."sizeBytes",
       CASE WHEN typeof("version"."createdAt") IN ('integer', 'real')
         THEN CAST("version"."createdAt" AS INTEGER)
         ELSE CAST(strftime('%s', "version"."createdAt") AS INTEGER) * 1000 END,
       CASE WHEN typeof("version"."createdAt") IN ('integer', 'real')
         THEN CAST("version"."createdAt" AS INTEGER)
         ELSE CAST(strftime('%s', "version"."createdAt") AS INTEGER) * 1000 END,
       CURRENT_TIMESTAMP
     FROM "ArtifactLineage" AS "lineage"
     JOIN "ArtifactVersion" AS "version"
       ON "version"."artifactId" = "lineage"."id"
      AND "version"."id" = "lineage"."currentVersionId"
      AND "version"."state" = 'finalized'
     WHERE "lineage"."id" = "ManagedFile"."sourceFileId"
       AND "lineage"."projectId" = "ManagedFile"."projectId"
   )
   WHERE "source" = 'artifact';`,
  `UPDATE "ManagedFile"
   SET ("sourceVersionId", "checksum", "projectId", "sessionId", "displayName",
        "storageKey", "mimeType", "sizeBytes", "mtimeMs", "updatedAt") = (
     SELECT "version"."id", "version"."checksum", "file"."projectId", "file"."sessionId",
       COALESCE(NULLIF("version"."originalFilename", ''), "version"."filename"),
       "version"."contentStorageKey", "version"."contentType",
       "version"."sizeBytes",
       CASE WHEN typeof(COALESCE("version"."createdAt", "version"."registeredAt")) IN ('integer', 'real')
         THEN CAST(COALESCE("version"."createdAt", "version"."registeredAt") AS INTEGER)
         ELSE CAST(strftime('%s', COALESCE("version"."createdAt", "version"."registeredAt")) AS INTEGER) * 1000 END,
       CURRENT_TIMESTAMP
     FROM "UploadFile" AS "file"
     JOIN "UploadVersion" AS "version"
       ON "version"."uploadFileId" = "file"."id"
      AND "version"."id" = "file"."currentVersionId"
      AND "version"."state" = 'ready'
     WHERE "file"."id" = "ManagedFile"."sourceFileId"
       AND "file"."projectId" = "ManagedFile"."projectId"
   )
   WHERE "source" = 'upload';`,
  `UPDATE "ManagedFileSessionSync" AS "sync"
   SET "filesRevision" = -1, "syncedAt" = CURRENT_TIMESTAMP
   WHERE "sync"."deletedAt" IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM "ProjectDeletionIntent" AS "intent"
       WHERE "intent"."projectId" = "sync"."projectId"
     )
     AND (
       EXISTS (
         SELECT 1
         FROM "ArtifactLineage" AS "lineage"
         JOIN "ArtifactVersion" AS "version"
           ON "version"."artifactId" = "lineage"."id"
          AND "version"."id" = "lineage"."currentVersionId"
          AND "version"."state" = 'finalized'
         WHERE "lineage"."projectId" = "sync"."projectId"
           AND "lineage"."sessionId" = "sync"."sessionId"
           AND NOT EXISTS (
             SELECT 1 FROM "ManagedFile"
             WHERE "projectId" = "lineage"."projectId"
               AND "source" = 'artifact'
               AND "sourceFileId" = "lineage"."id"
           )
       )
       OR EXISTS (
         SELECT 1
         FROM "UploadFile" AS "file"
         JOIN "UploadVersion" AS "version"
           ON "version"."uploadFileId" = "file"."id"
          AND "version"."id" = "file"."currentVersionId"
          AND "version"."state" = 'ready'
         WHERE "file"."projectId" = "sync"."projectId"
           AND "file"."sessionId" = "sync"."sessionId"
           AND NOT EXISTS (
             SELECT 1 FROM "ManagedFile"
             WHERE "projectId" = "file"."projectId"
               AND "source" = 'upload'
               AND "sourceFileId" = "file"."id"
           )
       )
     );`,
  `INSERT INTO "ManagedFile"
     ("source", "sourceFileId", "sourceVersionId", "checksum", "projectId", "sessionId",
      "messageId", "displayName", "storageKey", "mimeType", "sizeBytes", "mtimeMs", "sortAtMs",
      "createdAt", "updatedAt")
   SELECT 'artifact', "lineage"."id", "version"."id", "version"."checksum",
     "lineage"."projectId", "lineage"."sessionId", "version"."messageId", "version"."filename",
     "version"."contentStorageKey", "version"."contentType", "version"."sizeBytes",
     CASE WHEN typeof("version"."createdAt") IN ('integer', 'real')
       THEN CAST("version"."createdAt" AS INTEGER)
       ELSE CAST(strftime('%s', "version"."createdAt") AS INTEGER) * 1000 END,
     CASE WHEN typeof("version"."createdAt") IN ('integer', 'real')
       THEN CAST("version"."createdAt" AS INTEGER)
       ELSE CAST(strftime('%s', "version"."createdAt") AS INTEGER) * 1000 END,
     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
   FROM "ArtifactLineage" AS "lineage"
   JOIN "ArtifactVersion" AS "version"
     ON "version"."artifactId" = "lineage"."id"
    AND "version"."id" = "lineage"."currentVersionId"
    AND "version"."state" = 'finalized'
   WHERE NOT EXISTS (
     SELECT 1 FROM "ManagedFile"
     WHERE "projectId" = "lineage"."projectId"
       AND "source" = 'artifact'
       AND "sourceFileId" = "lineage"."id"
   )
   AND NOT EXISTS (
     SELECT 1 FROM "ManagedFileSessionSync" AS "sync"
     WHERE "sync"."projectId" = "lineage"."projectId"
       AND "sync"."sessionId" = "lineage"."sessionId"
       AND "sync"."deletedAt" IS NOT NULL
   )
   AND NOT EXISTS (
     SELECT 1 FROM "ProjectDeletionIntent" AS "intent"
     WHERE "intent"."projectId" = "lineage"."projectId"
   );`,
  `INSERT INTO "ManagedFile"
     ("source", "sourceFileId", "sourceVersionId", "checksum", "projectId", "sessionId",
      "messageId", "displayName", "storageKey", "mimeType", "sizeBytes", "mtimeMs", "sortAtMs",
      "createdAt", "updatedAt")
     SELECT 'upload', "file"."id", "version"."id", "version"."checksum", "file"."projectId",
       "file"."sessionId", NULL,
       COALESCE(NULLIF("version"."originalFilename", ''), "version"."filename"),
       "version"."contentStorageKey",
     "version"."contentType", "version"."sizeBytes",
     CASE WHEN typeof(COALESCE("version"."createdAt", "version"."registeredAt")) IN ('integer', 'real')
       THEN CAST(COALESCE("version"."createdAt", "version"."registeredAt") AS INTEGER)
       ELSE CAST(strftime('%s', COALESCE("version"."createdAt", "version"."registeredAt")) AS INTEGER) * 1000 END,
     CASE WHEN typeof(COALESCE("version"."createdAt", "version"."registeredAt")) IN ('integer', 'real')
       THEN CAST(COALESCE("version"."createdAt", "version"."registeredAt") AS INTEGER)
       ELSE CAST(strftime('%s', COALESCE("version"."createdAt", "version"."registeredAt")) AS INTEGER) * 1000 END,
     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
   FROM "UploadFile" AS "file"
   JOIN "UploadVersion" AS "version"
     ON "version"."uploadFileId" = "file"."id"
    AND "version"."id" = "file"."currentVersionId"
    AND "version"."state" = 'ready'
   WHERE NOT EXISTS (
     SELECT 1 FROM "ManagedFile"
     WHERE "projectId" = "file"."projectId"
       AND "source" = 'upload'
       AND "sourceFileId" = "file"."id"
   )
   AND NOT EXISTS (
     SELECT 1 FROM "ManagedFileSessionSync" AS "sync"
     WHERE "sync"."projectId" = "file"."projectId"
       AND "sync"."sessionId" = "file"."sessionId"
       AND "sync"."deletedAt" IS NOT NULL
   )
   AND NOT EXISTS (
     SELECT 1 FROM "ProjectDeletionIntent" AS "intent"
     WHERE "intent"."projectId" = "file"."projectId"
   );`,
  `CREATE TABLE "ManagedFileVersionWriteOperation" (
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
    CONSTRAINT "ManagedFileVersionWriteOperation_state_check" CHECK ("state" IN ('staging', 'file_ready', 'published', 'conflict', 'failed'))
  );`,
  `CREATE UNIQUE INDEX "ArtifactLineage_currentVersionId_key" ON "ArtifactLineage"("currentVersionId");`,
  `CREATE UNIQUE INDEX "ArtifactLineage_id_currentVersionId_key" ON "ArtifactLineage"("id", "currentVersionId");`,
  `CREATE INDEX "ArtifactLineage_projectId_sessionId_idx" ON "ArtifactLineage"("projectId", "sessionId");`,
  `CREATE UNIQUE INDEX "ArtifactLineage_projectId_sessionId_normalizedFilename_key" ON "ArtifactLineage"("projectId", "sessionId", "normalizedFilename");`,
  `CREATE UNIQUE INDEX "UploadFile_currentVersionId_key" ON "UploadFile"("currentVersionId");`,
  `CREATE UNIQUE INDEX "UploadFile_id_currentVersionId_key" ON "UploadFile"("id", "currentVersionId");`,
  `CREATE INDEX "UploadFile_projectId_sessionId_idx" ON "UploadFile"("projectId", "sessionId");`,
  `CREATE UNIQUE INDEX "UploadVersion_writeOperationId_key" ON "UploadVersion"("writeOperationId");`,
  `CREATE UNIQUE INDEX "UploadVersion_contentStorageKey_key" ON "UploadVersion"("contentStorageKey");`,
  `CREATE INDEX "UploadVersion_uploadFileId_state_registeredAt_idx" ON "UploadVersion"("uploadFileId", "state", "registeredAt");`,
  `CREATE UNIQUE INDEX "UploadVersion_uploadFileId_versionNumber_key" ON "UploadVersion"("uploadFileId", "versionNumber");`,
  `CREATE UNIQUE INDEX "UploadVersion_uploadFileId_id_key" ON "UploadVersion"("uploadFileId", "id");`,
  `CREATE UNIQUE INDEX "ArtifactVersion_writeOperationId_key" ON "ArtifactVersion"("writeOperationId");`,
  `CREATE UNIQUE INDEX "ArtifactVersion_contentStorageKey_key" ON "ArtifactVersion"("contentStorageKey");`,
  `CREATE INDEX "ArtifactVersion_artifactId_createdAt_idx" ON "ArtifactVersion"("artifactId", "createdAt");`,
  `CREATE INDEX "ArtifactVersion_artifactRunId_state_idx" ON "ArtifactVersion"("artifactRunId", "state");`,
  `CREATE INDEX "ArtifactVersion_rootFrameId_agentFrameId_messageBranchId_promptMessageId_idx" ON "ArtifactVersion"("rootFrameId", "agentFrameId", "messageBranchId", "promptMessageId");`,
  `CREATE INDEX "ArtifactVersion_messageId_idx" ON "ArtifactVersion"("messageId");`,
  `CREATE INDEX "ArtifactVersion_messageSnapshotId_idx" ON "ArtifactVersion"("messageSnapshotId");`,
  `CREATE UNIQUE INDEX "ArtifactVersion_artifactId_versionNumber_key" ON "ArtifactVersion"("artifactId", "versionNumber");`,
  `CREATE UNIQUE INDEX "ArtifactVersion_artifactId_id_key" ON "ArtifactVersion"("artifactId", "id");`,
  `CREATE INDEX "ArtifactVersionInput_sourceKind_inputFileVersionId_idx" ON "ArtifactVersionInput"("sourceKind", "inputFileVersionId");`,
  `CREATE INDEX "ArtifactVersionInput_sourceArtifactVersionId_idx" ON "ArtifactVersionInput"("sourceArtifactVersionId");`,
  `CREATE INDEX "ArtifactVersionInput_sourceUploadVersionId_idx" ON "ArtifactVersionInput"("sourceUploadVersionId");`,
  `CREATE INDEX "ArtifactVersionInput_sourceProjectId_sourceSessionId_idx" ON "ArtifactVersionInput"("sourceProjectId", "sourceSessionId");`,
  `CREATE UNIQUE INDEX "ArtifactVersionInput_artifactVersionId_sourceKind_inputFileVersionId_key" ON "ArtifactVersionInput"("artifactVersionId", "sourceKind", "inputFileVersionId");`,
  `CREATE UNIQUE INDEX "ArtifactVersionInput_artifactVersionId_ordinal_key" ON "ArtifactVersionInput"("artifactVersionId", "ordinal");`,
  `CREATE UNIQUE INDEX "ManagedFileVersionWriteOperation_contentStorageKey_key" ON "ManagedFileVersionWriteOperation"("contentStorageKey");`,
  `CREATE UNIQUE INDEX "ManagedFileVersionWriteOperation_resultVersionId_key" ON "ManagedFileVersionWriteOperation"("resultVersionId");`,
  `CREATE INDEX "ManagedFileVersionWriteOperation_source_sourceFileId_state_idx" ON "ManagedFileVersionWriteOperation"("source", "sourceFileId", "state");`,
  `CREATE INDEX "ManagedFileVersionWriteOperation_projectId_state_createdAt_idx" ON "ManagedFileVersionWriteOperation"("projectId", "state", "createdAt");`
] as const

const managedFileVersionFoundationMigration = {
  id: '0013_managed_file_version_foundation',
  statements: managedFileVersionFoundationStatements,
  verifiers: [
    {
      kind: 'table-exists',
      version: 1,
      table: 'ManagedFileVersionWriteOperation'
    },
    {
      kind: 'foreign-key-integrity',
      version: 1
    },
    {
      kind: 'managed-file-version-domain',
      version: 1
    }
  ]
} as const

// These statements are idempotent against an already-current schema. They let a pre-ledger
// current database refresh its derived heads and ManagedFile projection without replaying DDL.
const currentSchemaAdoptionStart = managedFileVersionFoundationStatements.findIndex((statement) =>
  statement.startsWith('UPDATE "ArtifactLineage" AS "lineage"')
)
const currentSchemaAdoptionEnd = managedFileVersionFoundationStatements.findIndex((statement) =>
  statement.startsWith('CREATE TABLE "ManagedFileVersionWriteOperation"')
)
if (currentSchemaAdoptionStart < 0 || currentSchemaAdoptionEnd <= currentSchemaAdoptionStart) {
  throw new Error('Managed file version migration adoption boundaries are invalid.')
}
const managedFileVersionFoundationCurrentSchemaAdoptionStatements =
  managedFileVersionFoundationStatements.slice(currentSchemaAdoptionStart, currentSchemaAdoptionEnd)

export {
  managedFileVersionFoundationCurrentSchemaAdoptionStatements,
  managedFileVersionFoundationMigration
}
