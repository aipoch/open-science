const authenticationModeExpression = `"authenticationMode" IN ('ssh_config', 'password')`
const authenticationRevisionExpression = `"authenticationRevision" >= 1`
const resultRevisionExpression = `"resultRevision" >= 1`
const operationKindExpression = `"operationKind" IN ('create_password', 'reset_password', 'change_authentication')`

const computeAuthenticationJobErrors = [
  'approval_denied',
  'credential_required',
  'credential_conflict',
  'credential_unavailable',
  'secure_storage_unavailable',
  'authentication_failed',
  'host_key_unknown',
  'host_key_changed',
  'host_unreachable',
  'unsupported_auth_configuration',
  'dispatch_failed',
  'job_failed',
  'timeout',
  'process_vanished'
] as const

const errorCodeExpression = `"errorCode" IS NULL OR "errorCode" IN (${computeAuthenticationJobErrors
  .map((value) => `'${value}'`)
  .join(', ')})`

const computePasswordAuthMigration = {
  id: '0010_compute_password_auth',
  statements: [
    `ALTER TABLE "ComputeHost" ADD COLUMN "authenticationMode" TEXT NOT NULL DEFAULT 'ssh_config'`,
    `ALTER TABLE "ComputeHost" ADD COLUMN "authenticationRevision" INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE "ComputeHost" ADD COLUMN "lastVerifiedAt" DATETIME`,
    `CREATE TABLE IF NOT EXISTS "ComputeCredential" (
      "computeHostId" TEXT NOT NULL PRIMARY KEY,
      "ciphertext" BLOB NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "ComputeCredential_computeHostId_fkey" FOREIGN KEY ("computeHostId") REFERENCES "ComputeHost" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS "ComputeAuthOperation" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "providerId" TEXT NOT NULL,
      "operationKind" TEXT NOT NULL,
      "requestFingerprint" TEXT NOT NULL,
      "resultRevision" INTEGER NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ComputeAuthOperation_resultRevision_check" CHECK (${resultRevisionExpression}),
      CONSTRAINT "ComputeAuthOperation_operationKind_check" CHECK (${operationKindExpression})
    )`
  ] as const,
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'ComputeHost',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ComputeHost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "shape" TEXT NOT NULL DEFAULT 'direct_ssh',
    "sshAlias" TEXT NOT NULL,
    "sshOverrides" TEXT,
    "authenticationMode" TEXT NOT NULL DEFAULT 'ssh_config',
    "authenticationRevision" INTEGER NOT NULL DEFAULT 1,
    "lastVerifiedAt" DATETIME,
    "scratchRoot" TEXT,
    "scratchPinned" BOOLEAN NOT NULL DEFAULT false,
    "concurrencyLimit" INTEGER,
    "probeResult" TEXT,
    "detailsDoc" TEXT NOT NULL DEFAULT '',
    "detailsUpdatedAt" DATETIME,
    "detailsUpdatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ComputeHost_authenticationMode_check" CHECK (${authenticationModeExpression}),
    CONSTRAINT "ComputeHost_authenticationRevision_check" CHECK (${authenticationRevisionExpression}),
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
            'authenticationMode',
            'authenticationRevision',
            'lastVerifiedAt',
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
          tableName: 'ComputeCredential',
          canonicalTableDdl: `CREATE TABLE IF NOT EXISTS "ComputeCredential" (
    "computeHostId" TEXT NOT NULL PRIMARY KEY,
    "ciphertext" BLOB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ComputeCredential_computeHostId_fkey" FOREIGN KEY ("computeHostId") REFERENCES "ComputeHost" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
          columns: ['computeHostId', 'ciphertext', 'createdAt', 'updatedAt']
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
    CONSTRAINT "ComputeJob_errorCode_check" CHECK (${errorCodeExpression}),
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
        }
      ],
      dropOrder: ['ComputeCredential', 'ComputeJob', 'ComputeHost'],
      indexes: [
        `CREATE UNIQUE INDEX IF NOT EXISTS "ComputeHost_providerId_key" ON "ComputeHost"("providerId");`,
        `CREATE INDEX IF NOT EXISTS "ComputeAuthOperation_providerId_idx" ON "ComputeAuthOperation"("providerId");`,
        `CREATE INDEX IF NOT EXISTS "ComputeJob_providerId_idx" ON "ComputeJob"("providerId");`,
        `CREATE INDEX IF NOT EXISTS "ComputeJob_sessionId_idx" ON "ComputeJob"("sessionId");`,
        `CREATE INDEX IF NOT EXISTS "ComputeJob_status_idx" ON "ComputeJob"("status");`
      ]
    }
  ] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'ComputeHost', column: 'authenticationMode' },
    { kind: 'column-exists', version: 1, table: 'ComputeHost', column: 'authenticationRevision' },
    { kind: 'table-exists', version: 1, table: 'ComputeCredential' },
    { kind: 'table-exists', version: 1, table: 'ComputeAuthOperation' },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'ComputeCredential',
      column: 'computeHostId',
      referencedTable: 'ComputeHost',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'ComputeHost',
          constraints: [
            {
              name: 'ComputeHost_authenticationMode_check',
              expression: authenticationModeExpression
            },
            {
              name: 'ComputeHost_authenticationRevision_check',
              expression: authenticationRevisionExpression
            }
          ]
        },
        {
          table: 'ComputeAuthOperation',
          constraints: [
            {
              name: 'ComputeAuthOperation_resultRevision_check',
              expression: resultRevisionExpression
            },
            {
              name: 'ComputeAuthOperation_operationKind_check',
              expression: operationKindExpression
            }
          ]
        },
        {
          table: 'ComputeJob',
          constraints: [{ name: 'ComputeJob_errorCode_check', expression: errorCodeExpression }]
        }
      ]
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'ComputeHost_providerId_key',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "ComputeHost_providerId_key" ON "ComputeHost"("providerId")`
        },
        {
          name: 'ComputeAuthOperation_providerId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ComputeAuthOperation_providerId_idx" ON "ComputeAuthOperation"("providerId")`
        },
        {
          name: 'ComputeJob_providerId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ComputeJob_providerId_idx" ON "ComputeJob"("providerId")`
        },
        {
          name: 'ComputeJob_sessionId_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ComputeJob_sessionId_idx" ON "ComputeJob"("sessionId")`
        },
        {
          name: 'ComputeJob_status_idx',
          sql: `CREATE INDEX IF NOT EXISTS "ComputeJob_status_idx" ON "ComputeJob"("status")`
        }
      ]
    }
  ] as const
}

export { computePasswordAuthMigration }
