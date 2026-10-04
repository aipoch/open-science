/* Expands the storage-level timeout bound for scheduler-owned walltime. Direct SSH keeps its
 * 7-day application limit; Slurm allows up to one year while still bounding persisted values. */
const computeJobColumns = [
  'id',
  'providerId',
  'shape',
  'executionMode',
  'sessionId',
  'projectId',
  'status',
  'intent',
  'command',
  'commandHash',
  'sensitiveDataEncrypted',
  'environment',
  'resourceRequest',
  'inputManifest',
  'producerRunId',
  'fileEvidence',
  'outputManifest',
  'harvestConfig',
  'timeoutSeconds',
  'remoteWorkdir',
  'remoteHandle',
  'remoteCleanupDisposition',
  'exitCode',
  'stdoutTail',
  'stderrTail',
  'errorCode',
  'lastPollError',
  'harvestError',
  'leftOnRemote',
  'notifiedAt',
  'notificationConsumedAt',
  'analysisState',
  'analysisMessageId',
  'analysisUpdatedAt',
  'createdAt',
  'submittedAt',
  'startedAt',
  'finishedAt',
  'harvestedAt'
] as const

const computeJobOperationColumns = [
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
] as const

const quotedColumns = (columns: readonly string[]): string =>
  columns.map((column) => `"${column}"`).join(', ')

const schedulerWalltimeMigration = {
  id: '0048_scheduler_walltime',
  statements: [
    `CREATE TABLE "__open_science_ComputeJobOperationBackup" AS SELECT ${quotedColumns(computeJobOperationColumns)} FROM "ComputeJobOperation"`,
    `CREATE TABLE "__open_science_ComputeJobNew" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "executionMode" TEXT NOT NULL DEFAULT 'direct_ssh',
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "intent" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "commandHash" TEXT NOT NULL,
    "sensitiveDataEncrypted" BOOLEAN,
    "environment" TEXT,
    "resourceRequest" TEXT,
    "inputManifest" TEXT,
    "producerRunId" TEXT,
    "fileEvidence" TEXT,
    "outputManifest" TEXT,
    "harvestConfig" TEXT,
    "timeoutSeconds" INTEGER,
    "remoteWorkdir" TEXT,
    "remoteHandle" TEXT,
    "remoteCleanupDisposition" TEXT NOT NULL DEFAULT 'pending',
    "exitCode" INTEGER,
    "stdoutTail" TEXT,
    "stderrTail" TEXT,
    "errorCode" TEXT,
    "lastPollError" TEXT,
    "harvestError" TEXT,
    "leftOnRemote" TEXT,
    "notifiedAt" DATETIME,
    "notificationConsumedAt" DATETIME,
    "analysisState" TEXT,
    "analysisMessageId" TEXT,
    "analysisUpdatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "harvestedAt" DATETIME,
    CONSTRAINT "ComputeJob_shape_check" CHECK ("shape" IN ('direct_ssh', 'scheduler_cluster', 'bridge_runner')),
    CONSTRAINT "ComputeJob_status_check" CHECK ("status" IN ('queued', 'submitted', 'running', 'success', 'failed', 'timeout', 'error')),
    CONSTRAINT "ComputeJob_remoteCleanupDisposition_check" CHECK ("remoteCleanupDisposition" IN ('pending', 'cleaned', 'abandoned')),
    CONSTRAINT "ComputeJob_errorCode_check" CHECK ("errorCode" IS NULL OR "errorCode" IN ('approval_denied', 'credential_required', 'credential_conflict', 'credential_unavailable', 'secure_storage_unavailable', 'authentication_failed', 'host_key_unknown', 'host_key_changed', 'host_unreachable', 'unsupported_auth_configuration', 'dispatch_failed', 'job_failed', 'timeout', 'process_vanished')),
    CONSTRAINT "ComputeJob_timeoutSeconds_check" CHECK ("timeoutSeconds" IS NULL OR "timeoutSeconds" BETWEEN 1 AND 31536000),
    CONSTRAINT "ComputeJob_notification_check" CHECK ("notificationConsumedAt" IS NULL OR "notifiedAt" IS NOT NULL),
    CONSTRAINT "ComputeJob_analysisState_check" CHECK ("analysisState" IS NULL OR "analysisState" IN ('dispatched', 'succeeded', 'failed', 'cancelled')),
    CONSTRAINT "ComputeJob_analysisBundle_check" CHECK ((("analysisState" IS NULL AND "analysisMessageId" IS NULL AND "analysisUpdatedAt" IS NULL) OR ("analysisState" IS NOT NULL AND "analysisMessageId" IS NOT NULL AND length(trim("analysisMessageId")) > 0 AND "analysisUpdatedAt" IS NOT NULL))),
    CONSTRAINT "ComputeJob_analysisConsumption_check" CHECK ("analysisState" IS NULL OR "analysisState" <> 'succeeded' OR "notificationConsumedAt" IS NOT NULL),
    CONSTRAINT "ComputeJob_harvestPayload_check" CHECK ("leftOnRemote" IS NULL OR "harvestedAt" IS NOT NULL),
    CONSTRAINT "ComputeJob_harvestState_check" CHECK ("harvestedAt" IS NULL OR "status" IN ('success', 'failed', 'timeout')),
    CONSTRAINT "ComputeJob_errorState_check" CHECK ((("errorCode" IS NULL OR "status" IN ('failed', 'timeout', 'error')) AND ("status" <> 'error' OR "errorCode" IS NOT NULL))),
    CONSTRAINT "ComputeJob_resourceRequestJson_check" CHECK ("resourceRequest" IS NULL OR (json_valid("resourceRequest") AND json_type("resourceRequest") = 'object')),
    CONSTRAINT "ComputeJob_inputManifestJson_check" CHECK ("inputManifest" IS NULL OR (json_valid("inputManifest") AND json_type("inputManifest") = 'array')),
    CONSTRAINT "ComputeJob_outputManifestJson_check" CHECK ("outputManifest" IS NULL OR (json_valid("outputManifest") AND json_type("outputManifest") = 'array')),
    CONSTRAINT "ComputeJob_harvestConfigJson_check" CHECK ("harvestConfig" IS NULL OR (json_valid("harvestConfig") AND json_type("harvestConfig") = 'object')),
    CONSTRAINT "ComputeJob_remoteHandleJson_check" CHECK ("remoteHandle" IS NULL OR (json_valid("remoteHandle") AND json_type("remoteHandle") = 'object')),
    CONSTRAINT "ComputeJob_leftOnRemoteJson_check" CHECK ("leftOnRemote" IS NULL OR (json_valid("leftOnRemote") AND json_type("leftOnRemote") = 'array'))
)`,
    `INSERT INTO "__open_science_ComputeJobNew" (${quotedColumns(computeJobColumns)}) SELECT ${quotedColumns(computeJobColumns)} FROM "ComputeJob"`,
    `DROP TABLE "ComputeJob"`,
    `ALTER TABLE "__open_science_ComputeJobNew" RENAME TO "ComputeJob"`,
    `DELETE FROM "ComputeJobOperation"`,
    `INSERT INTO "ComputeJobOperation" (${quotedColumns(computeJobOperationColumns)}) SELECT ${quotedColumns(computeJobOperationColumns)} FROM "__open_science_ComputeJobOperationBackup"`,
    `DROP TABLE "__open_science_ComputeJobOperationBackup"`,
    `CREATE INDEX "ComputeJob_providerId_idx" ON "ComputeJob"("providerId")`,
    `CREATE INDEX "ComputeJob_sessionId_idx" ON "ComputeJob"("sessionId")`,
    `CREATE INDEX "ComputeJob_status_idx" ON "ComputeJob"("status")`
  ] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'ComputeJob',
          constraints: [
            {
              name: 'ComputeJob_timeoutSeconds_check',
              expression: '"timeoutSeconds" IS NULL OR "timeoutSeconds" BETWEEN 1 AND 31536000'
            }
          ]
        }
      ]
    },
    { kind: 'foreign-key-integrity', version: 1 }
  ] as const
}

export { schedulerWalltimeMigration }
