/* Immutable 0006 migration snapshot. Do not regenerate after release. */

const databaseDomainConstraintsMigration = {
  id: '0006_database_domain_constraints',
  statements: [] as const,
  operations: [
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
    CONSTRAINT "Review_state_check" CHECK ((("lifecycle" = 'running' AND "outcome" IS NULL AND "errorMessage" IS NULL) OR ("lifecycle" = 'complete' AND "outcome" IS NOT NULL AND "errorMessage" IS NULL) OR ("lifecycle" = 'error' AND "outcome" IS NULL AND "errorMessage" IS NOT NULL)))
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
    CONSTRAINT "Finding_artifactBinding_check" CHECK ("artifactBindingState" <> 'scope_validated' OR "artifactVersionId" IS NOT NULL)
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
    CONSTRAINT "ReviewFindingDisposition_state_check" CHECK ((("trigger" = 'review_submission' AND "causeReviewId" IS NOT NULL AND "outcome" IN ('still_open', 'resolved')) OR ("trigger" IN ('loop_terminated', 'correction_failed', 'aborted') AND "causeReviewId" IS NULL AND "outcome" = 'unaddressed')))
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
    CONSTRAINT "ReviewScopeSnapshot_state_check" CHECK ("state" IN ('staging', 'ready'))
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
        },
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
    CONSTRAINT "ComputeJob_errorState_check" CHECK ((("errorCode" IS NULL OR "status" IN ('failed', 'timeout', 'error')) AND ("status" <> 'error' OR "errorCode" IS NOT NULL)))
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
    CONSTRAINT "ComputeHost_scratchRoot_check" CHECK ("scratchPinned" = false OR "scratchRoot" IS NOT NULL)
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
        },
        {
          tableName: 'GrantedLocalRoot',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "GrantedLocalRoot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GrantedLocalRoot_access_check" CHECK ("access" IN ('ro', 'rw'))
);`,
          columns: ['id', 'path', 'name', 'access', 'createdAt', 'updatedAt']
        }
      ],
      dropOrder: [
        'ReviewFindingDisposition',
        'ReviewScopeSnapshot',
        'Finding',
        'Review',
        'ComputeJob',
        'ComputeHost',
        'GrantedLocalRoot'
      ],
      indexes: [
        `CREATE INDEX IF NOT EXISTS "ReviewFindingDisposition_causeReviewId_createdAt_idx" ON "ReviewFindingDisposition"("causeReviewId", "createdAt");`,
        `CREATE INDEX IF NOT EXISTS "ReviewFindingDisposition_assessedArtifactVersionId_idx" ON "ReviewFindingDisposition"("assessedArtifactVersionId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ReviewFindingDisposition_sourceFindingId_sequence_key" ON "ReviewFindingDisposition"("sourceFindingId", "sequence");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ReviewScopeSnapshot_reviewId_key" ON "ReviewScopeSnapshot"("reviewId");`,
        `CREATE INDEX IF NOT EXISTS "ReviewScopeSnapshot_projectId_sessionId_state_idx" ON "ReviewScopeSnapshot"("projectId", "sessionId", "state");`,
        `CREATE INDEX IF NOT EXISTS "ComputeJob_providerId_idx" ON "ComputeJob"("providerId");`,
        `CREATE INDEX IF NOT EXISTS "ComputeJob_sessionId_idx" ON "ComputeJob"("sessionId");`,
        `CREATE INDEX IF NOT EXISTS "ComputeJob_status_idx" ON "ComputeJob"("status");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "ComputeHost_providerId_key" ON "ComputeHost"("providerId");`,
        `CREATE UNIQUE INDEX IF NOT EXISTS "GrantedLocalRoot_path_key" ON "GrantedLocalRoot"("path");`
      ]
    }
  ] as const,
  verifiers: [
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'Review',
          constraints: [
            {
              name: 'Review_lifecycle_check',
              expression: `"lifecycle" IN ('running', 'complete', 'error')`
            },
            {
              name: 'Review_outcome_check',
              expression: `"outcome" IS NULL OR "outcome" IN ('pass', 'flagged')`
            },
            {
              name: 'Review_state_check',
              expression: `(("lifecycle" = 'running' AND "outcome" IS NULL AND "errorMessage" IS NULL) OR ("lifecycle" = 'complete' AND "outcome" IS NOT NULL AND "errorMessage" IS NULL) OR ("lifecycle" = 'error' AND "outcome" IS NULL AND "errorMessage" IS NOT NULL))`
            }
          ]
        },
        {
          table: 'Finding',
          constraints: [
            {
              name: 'Finding_status_check',
              expression: `"status" IN ('pass', 'warn', 'fail')`
            },
            {
              name: 'Finding_resolution_check',
              expression: `"resolution" IN ('open', 'resolved', 'unaddressed')`
            },
            {
              name: 'Finding_artifactBindingState_check',
              expression: `"artifactBindingState" IN ('scope_validated', 'legacy_unverified')`
            },
            { name: 'Finding_sortIndex_check', expression: `"sortIndex" >= 0` },
            { name: 'Finding_reflagCount_check', expression: `"reflagCount" >= 0` },
            {
              name: 'Finding_statusResolution_check',
              expression: `"status" <> 'pass' OR "resolution" = 'open'`
            },
            {
              name: 'Finding_artifactBinding_check',
              expression: `"artifactBindingState" <> 'scope_validated' OR "artifactVersionId" IS NOT NULL`
            }
          ]
        },
        {
          table: 'ReviewFindingDisposition',
          constraints: [
            {
              name: 'ReviewFindingDisposition_sequence_check',
              expression: `"sequence" >= 1`
            },
            {
              name: 'ReviewFindingDisposition_trigger_check',
              expression: `"trigger" IN ('review_submission', 'loop_terminated', 'correction_failed', 'aborted')`
            },
            {
              name: 'ReviewFindingDisposition_outcome_check',
              expression: `"outcome" IN ('still_open', 'resolved', 'unaddressed')`
            },
            {
              name: 'ReviewFindingDisposition_state_check',
              expression: `(("trigger" = 'review_submission' AND "causeReviewId" IS NOT NULL AND "outcome" IN ('still_open', 'resolved')) OR ("trigger" IN ('loop_terminated', 'correction_failed', 'aborted') AND "causeReviewId" IS NULL AND "outcome" = 'unaddressed'))`
            }
          ]
        },
        {
          table: 'ComputeJob',
          constraints: [
            {
              name: 'ComputeJob_shape_check',
              expression: `"shape" IN ('direct_ssh', 'scheduler_cluster', 'bridge_runner')`
            },
            {
              name: 'ComputeJob_status_check',
              expression: `"status" IN ('queued', 'submitted', 'running', 'success', 'failed', 'timeout', 'error')`
            },
            {
              name: 'ComputeJob_errorCode_check',
              expression: `"errorCode" IS NULL OR "errorCode" IN ('approval_denied', 'host_unreachable', 'dispatch_failed', 'job_failed', 'timeout', 'process_vanished')`
            },
            {
              name: 'ComputeJob_timeoutSeconds_check',
              expression: `"timeoutSeconds" IS NULL OR "timeoutSeconds" BETWEEN 1 AND 604800`
            },
            {
              name: 'ComputeJob_notification_check',
              expression: `"notificationConsumedAt" IS NULL OR "notifiedAt" IS NOT NULL`
            },
            {
              name: 'ComputeJob_harvestPayload_check',
              expression: `("harvestError" IS NULL AND "leftOnRemote" IS NULL) OR "harvestedAt" IS NOT NULL`
            },
            {
              name: 'ComputeJob_harvestState_check',
              expression: `"harvestedAt" IS NULL OR "status" IN ('success', 'failed', 'timeout')`
            },
            {
              name: 'ComputeJob_errorState_check',
              expression: `(("errorCode" IS NULL OR "status" IN ('failed', 'timeout', 'error')) AND ("status" <> 'error' OR "errorCode" IS NOT NULL))`
            }
          ]
        },
        {
          table: 'ComputeHost',
          constraints: [
            {
              name: 'ComputeHost_shape_check',
              expression: `"shape" IN ('direct_ssh', 'scheduler_cluster', 'bridge_runner')`
            },
            {
              name: 'ComputeHost_scratchPinned_check',
              expression: `"scratchPinned" IN (false, true)`
            },
            {
              name: 'ComputeHost_concurrencyLimit_check',
              expression: `"concurrencyLimit" IS NULL OR "concurrencyLimit" BETWEEN 1 AND 500`
            },
            {
              name: 'ComputeHost_detailsUpdatedBy_check',
              expression: `"detailsUpdatedBy" IS NULL OR "detailsUpdatedBy" IN ('user', 'agent')`
            },
            {
              name: 'ComputeHost_detailsUpdate_check',
              expression: `("detailsUpdatedAt" IS NULL AND "detailsUpdatedBy" IS NULL) OR ("detailsUpdatedAt" IS NOT NULL AND "detailsUpdatedBy" IS NOT NULL)`
            },
            {
              name: 'ComputeHost_scratchRoot_check',
              expression: `"scratchPinned" = false OR "scratchRoot" IS NOT NULL`
            }
          ]
        },
        {
          table: 'GrantedLocalRoot',
          constraints: [
            {
              name: 'GrantedLocalRoot_access_check',
              expression: `"access" IN ('ro', 'rw')`
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
        },
        {
          name: 'GrantedLocalRoot_path_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "GrantedLocalRoot_path_key" ON "GrantedLocalRoot"("path");`
        }
      ]
    }
  ] as const
}

export { databaseDomainConstraintsMigration }
