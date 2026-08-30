const analysisStateExpression = `"analysisState" IS NULL OR "analysisState" IN ('dispatched', 'succeeded', 'failed', 'cancelled')`
const analysisBundleExpression = `(("analysisState" IS NULL AND "analysisMessageId" IS NULL AND "analysisUpdatedAt" IS NULL) OR ("analysisState" IS NOT NULL AND "analysisMessageId" IS NOT NULL AND length(trim("analysisMessageId")) > 0 AND "analysisUpdatedAt" IS NOT NULL))`
const analysisConsumptionExpression = `"analysisState" IS NULL OR "analysisState" <> 'succeeded' OR "notificationConsumedAt" IS NOT NULL`

const computeJobDdl = `CREATE TABLE IF NOT EXISTS "ComputeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
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
    CONSTRAINT "ComputeJob_errorCode_check" CHECK ("errorCode" IS NULL OR "errorCode" IN ('approval_denied', 'credential_required', 'credential_conflict', 'credential_unavailable', 'secure_storage_unavailable', 'authentication_failed', 'host_key_unknown', 'host_key_changed', 'host_unreachable', 'unsupported_auth_configuration', 'dispatch_failed', 'job_failed', 'timeout', 'process_vanished')),
    CONSTRAINT "ComputeJob_timeoutSeconds_check" CHECK ("timeoutSeconds" IS NULL OR "timeoutSeconds" BETWEEN 1 AND 604800),
    CONSTRAINT "ComputeJob_notification_check" CHECK ("notificationConsumedAt" IS NULL OR "notifiedAt" IS NOT NULL),
    CONSTRAINT "ComputeJob_analysisState_check" CHECK (${analysisStateExpression}),
    CONSTRAINT "ComputeJob_analysisBundle_check" CHECK (${analysisBundleExpression}),
    CONSTRAINT "ComputeJob_analysisConsumption_check" CHECK (${analysisConsumptionExpression}),
    CONSTRAINT "ComputeJob_harvestPayload_check" CHECK (("harvestError" IS NULL AND "leftOnRemote" IS NULL) OR "harvestedAt" IS NOT NULL),
    CONSTRAINT "ComputeJob_harvestState_check" CHECK ("harvestedAt" IS NULL OR "status" IN ('success', 'failed', 'timeout')),
    CONSTRAINT "ComputeJob_errorState_check" CHECK ((("errorCode" IS NULL OR "status" IN ('failed', 'timeout', 'error')) AND ("status" <> 'error' OR "errorCode" IS NOT NULL))),
    CONSTRAINT "ComputeJob_resourceRequestJson_check" CHECK ("resourceRequest" IS NULL OR (json_valid("resourceRequest") AND json_type("resourceRequest") = 'object')),
    CONSTRAINT "ComputeJob_inputManifestJson_check" CHECK ("inputManifest" IS NULL OR (json_valid("inputManifest") AND json_type("inputManifest") = 'array')),
    CONSTRAINT "ComputeJob_outputManifestJson_check" CHECK ("outputManifest" IS NULL OR (json_valid("outputManifest") AND json_type("outputManifest") = 'array')),
    CONSTRAINT "ComputeJob_harvestConfigJson_check" CHECK ("harvestConfig" IS NULL OR (json_valid("harvestConfig") AND json_type("harvestConfig") = 'object')),
    CONSTRAINT "ComputeJob_remoteHandleJson_check" CHECK ("remoteHandle" IS NULL OR (json_valid("remoteHandle") AND json_type("remoteHandle") = 'object')),
    CONSTRAINT "ComputeJob_leftOnRemoteJson_check" CHECK ("leftOnRemote" IS NULL OR (json_valid("leftOnRemote") AND json_type("leftOnRemote") = 'array'))
)`

const computeJobIndexDdls = [
  `CREATE INDEX IF NOT EXISTS "ComputeJob_providerId_idx" ON "ComputeJob"("providerId")`,
  `CREATE INDEX IF NOT EXISTS "ComputeJob_sessionId_idx" ON "ComputeJob"("sessionId")`,
  `CREATE INDEX IF NOT EXISTS "ComputeJob_status_idx" ON "ComputeJob"("status")`
] as const

const computeJobAnalysisConstraintsMigration = {
  id: '0021_compute_job_analysis_constraints',
  statements: [] as const,
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'ComputeJob',
          canonicalTableDdl: computeJobDdl,
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
            'sensitiveDataEncrypted',
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
            'analysisState',
            'analysisMessageId',
            'analysisUpdatedAt',
            'createdAt',
            'submittedAt',
            'startedAt',
            'finishedAt',
            'harvestedAt'
          ]
        }
      ],
      dropOrder: ['ComputeJob'],
      indexes: computeJobIndexDdls
    }
  ] as const,
  verifiers: [
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'ComputeJob',
          constraints: [
            { name: 'ComputeJob_analysisState_check', expression: analysisStateExpression },
            { name: 'ComputeJob_analysisBundle_check', expression: analysisBundleExpression },
            {
              name: 'ComputeJob_analysisConsumption_check',
              expression: analysisConsumptionExpression
            }
          ]
        }
      ]
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: computeJobIndexDdls.map((sql) => ({
        name: sql.match(/INDEX IF NOT EXISTS "([^"]+)"/)![1]!,
        sql
      }))
    }
  ] as const
}

export { computeJobAnalysisConstraintsMigration }
