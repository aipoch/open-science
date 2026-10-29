// Immutable schema snapshot for Slurm result and cancellation diagnostics.
const slurmJobReliabilityMigration = {
  id: '0054_slurm_job_reliability',
  statements: [],
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 2,
      tables: [
        {
          tableName: 'ComputeJob',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ComputeJob" (
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
    "errorMessage" TEXT,
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
    CONSTRAINT "ComputeJob_errorCode_check" CHECK ("errorCode" IS NULL OR "errorCode" IN ('approval_denied', 'credential_required', 'credential_conflict', 'credential_unavailable', 'secure_storage_unavailable', 'authentication_failed', 'host_key_unknown', 'host_key_changed', 'host_unreachable', 'unsupported_auth_configuration', 'dispatch_failed', 'job_failed', 'timeout', 'process_vanished', 'job_cancelled', 'job_status_unavailable')),
    CONSTRAINT "ComputeJob_timeoutSeconds_check" CHECK ("timeoutSeconds" IS NULL OR "timeoutSeconds" BETWEEN 1 AND 604800),
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
);`,
          columns: [
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
          ],
          optionalLegacyColumns: [{ name: 'errorMessage', definition: '"errorMessage" TEXT' }]
        },
        {
          tableName: 'ComputeJobOperation',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ComputeJobOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'active',
    "outcome" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
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
    CONSTRAINT "ComputeJobOperation_lifecycle_check" CHECK (("phase" = 'active' AND "outcome" IS NULL AND "settledAt" IS NULL) OR ("phase" = 'settled' AND "outcome" IS NOT NULL AND "outcome" IN ('fulfilled', 'superseded', 'failed') AND "settledAt" IS NOT NULL)),
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
          ],
          optionalLegacyColumns: [
            { name: 'errorCode', definition: '"errorCode" TEXT' },
            { name: 'errorMessage', definition: '"errorMessage" TEXT' }
          ]
        },
        {
          tableName: 'BackgroundResultDelivery',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "BackgroundResultDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceSnapshot" TEXT,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "agentFrameId" TEXT,
    "state" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "claimToken" TEXT,
    "claimExpiresAt" DATETIME,
    "continuationMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BackgroundResultDelivery_sourceKind_check" CHECK ("sourceKind" IN ('local-run', 'compute-job', 'compute-cancellation')),
    CONSTRAINT "BackgroundResultDelivery_state_check" CHECK ("state" IN ('waiting-result', 'pending', 'claimed', 'dispatching', 'consumed', 'needs-attention')),
    CONSTRAINT "BackgroundResultDelivery_identity_check" CHECK (length(trim("id")) > 0 AND length(trim("sourceId")) > 0 AND length(trim("projectId")) > 0 AND length(trim("sessionId")) > 0),
    CONSTRAINT "BackgroundResultDelivery_attemptCount_check" CHECK ("attemptCount" >= 0),
    CONSTRAINT "BackgroundResultDelivery_claimLifecycle_check" CHECK ((("state" IN ('claimed', 'dispatching') AND "claimToken" IS NOT NULL AND length(trim("claimToken")) > 0 AND "claimExpiresAt" IS NOT NULL) OR ("state" NOT IN ('claimed', 'dispatching') AND "claimToken" IS NULL AND "claimExpiresAt" IS NULL))),
    CONSTRAINT "BackgroundResultDelivery_continuation_check" CHECK (("continuationMessageId" IS NULL OR length(trim("continuationMessageId")) > 0) AND ("state" <> 'dispatching' OR "continuationMessageId" IS NOT NULL) AND ("state" <> 'waiting-result' OR "continuationMessageId" IS NULL))
);`,
          columns: [
            'id',
            'sourceKind',
            'sourceId',
            'projectId',
            'sessionId',
            'agentFrameId',
            'state',
            'attemptCount',
            'claimToken',
            'claimExpiresAt',
            'continuationMessageId',
            'createdAt',
            'updatedAt'
          ],
          optionalLegacyColumns: [{ name: 'sourceSnapshot', definition: '"sourceSnapshot" TEXT' }]
        }
      ],
      dropOrder: ['ComputeJobOperation', 'ComputeJob', 'BackgroundResultDelivery'],
      indexes: [
        'CREATE INDEX IF NOT EXISTS "ComputeJob_providerId_idx" ON "ComputeJob"("providerId");',
        'CREATE INDEX IF NOT EXISTS "ComputeJob_sessionId_idx" ON "ComputeJob"("sessionId");',
        'CREATE INDEX IF NOT EXISTS "ComputeJob_status_idx" ON "ComputeJob"("status");',
        'CREATE INDEX IF NOT EXISTS "ComputeJobOperation_kind_phase_eligibleAt_createdAt_idx" ON "ComputeJobOperation"("kind", "phase", "eligibleAt", "createdAt");',
        'CREATE INDEX IF NOT EXISTS "ComputeJobOperation_kind_phase_claimExpiresAt_idx" ON "ComputeJobOperation"("kind", "phase", "claimExpiresAt");',
        'CREATE UNIQUE INDEX IF NOT EXISTS "ComputeJobOperation_jobId_kind_key" ON "ComputeJobOperation"("jobId", "kind");',
        'CREATE INDEX IF NOT EXISTS "BackgroundResultDelivery_sessionId_state_createdAt_id_idx" ON "BackgroundResultDelivery"("sessionId", "state", "createdAt", "id");',
        'CREATE INDEX IF NOT EXISTS "BackgroundResultDelivery_sourceKind_state_createdAt_id_idx" ON "BackgroundResultDelivery"("sourceKind", "state", "createdAt", "id");',
        'CREATE UNIQUE INDEX IF NOT EXISTS "BackgroundResultDelivery_sourceKind_sourceId_key" ON "BackgroundResultDelivery"("sourceKind", "sourceId");',
        'CREATE INDEX IF NOT EXISTS "BackgroundResultDelivery_project_visible_idx" ON "BackgroundResultDelivery"("projectId", "updatedAt" DESC, "id") WHERE "state" IN (\'waiting-result\', \'pending\', \'claimed\', \'dispatching\', \'needs-attention\')',
        'CREATE INDEX IF NOT EXISTS "BackgroundResultDelivery_recoverable_claim_idx" ON "BackgroundResultDelivery"("claimExpiresAt", "id") WHERE "state" IN (\'claimed\', \'dispatching\')'
      ]
    }
  ],
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'ComputeJob', column: 'errorMessage' },
    { kind: 'column-exists', version: 1, table: 'ComputeJobOperation', column: 'errorCode' },
    { kind: 'column-exists', version: 1, table: 'ComputeJobOperation', column: 'errorMessage' },
    {
      kind: 'column-exists',
      version: 1,
      table: 'BackgroundResultDelivery',
      column: 'sourceSnapshot'
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'ComputeJob',
          constraints: [
            {
              name: 'ComputeJob_errorCode_check',
              expression:
                "\"errorCode\" IS NULL OR \"errorCode\" IN ('approval_denied', 'credential_required', 'credential_conflict', 'credential_unavailable', 'secure_storage_unavailable', 'authentication_failed', 'host_key_unknown', 'host_key_changed', 'host_unreachable', 'unsupported_auth_configuration', 'dispatch_failed', 'job_failed', 'timeout', 'process_vanished', 'job_cancelled', 'job_status_unavailable')"
            }
          ]
        },
        {
          table: 'ComputeJobOperation',
          constraints: [
            {
              name: 'ComputeJobOperation_lifecycle_check',
              expression:
                '("phase" = \'active\' AND "outcome" IS NULL AND "settledAt" IS NULL) OR ("phase" = \'settled\' AND "outcome" IS NOT NULL AND "outcome" IN (\'fulfilled\', \'superseded\', \'failed\') AND "settledAt" IS NOT NULL)'
            }
          ]
        },
        {
          table: 'BackgroundResultDelivery',
          constraints: [
            {
              name: 'BackgroundResultDelivery_sourceKind_check',
              expression: "\"sourceKind\" IN ('local-run', 'compute-job', 'compute-cancellation')"
            }
          ]
        }
      ]
    }
  ]
} as const

const SLURM_JOB_RELIABILITY_ALLOWED_SUFFIX_CHECKS = {
  ComputeJob: {
    ComputeJob_errorCode_check:
      "\"errorCode\" IS NULL OR \"errorCode\" IN ('approval_denied', 'credential_required', 'credential_conflict', 'credential_unavailable', 'secure_storage_unavailable', 'authentication_failed', 'host_key_unknown', 'host_key_changed', 'host_unreachable', 'unsupported_auth_configuration', 'dispatch_failed', 'job_failed', 'timeout', 'process_vanished', 'job_cancelled', 'job_status_unavailable')"
  },
  ComputeJobOperation: {
    ComputeJobOperation_lifecycle_check:
      '("phase" = \'active\' AND "outcome" IS NULL AND "settledAt" IS NULL) OR ("phase" = \'settled\' AND "outcome" IS NOT NULL AND "outcome" IN (\'fulfilled\', \'superseded\', \'failed\') AND "settledAt" IS NOT NULL)'
  },
  BackgroundResultDelivery: {
    BackgroundResultDelivery_sourceKind_check:
      "\"sourceKind\" IN ('local-run', 'compute-job', 'compute-cancellation')"
  }
} as const
const SLURM_JOB_RELIABILITY_ADDED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ComputeJob: ['errorMessage'],
  ComputeJobOperation: ['errorCode', 'errorMessage'],
  BackgroundResultDelivery: ['sourceSnapshot']
}
export {
  slurmJobReliabilityMigration,
  SLURM_JOB_RELIABILITY_ALLOWED_SUFFIX_CHECKS,
  SLURM_JOB_RELIABILITY_ADDED_COLUMNS
}
