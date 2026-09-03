import { createHash } from 'node:crypto'
import { access, rename, rm } from 'node:fs/promises'

import type { PrismaClient } from '@prisma/client'
import type { DatabaseStartupErrorCode } from '../../shared/database-startup'

import {
  RUNTIME_SCHEMA_BASELINE_CONTRACT,
  adaptMigrationOperationsForCurrentSchema,
  applyRuntimeSchemaBaseline,
  hasCurrentManagedFileVersionFoundation,
  normalizeSchemaObjectSql,
  prepareRuntimeSchemaBaseline,
  verifyCurrentRuntimeSchema,
  verifyCurrentRuntimeSchemaTables,
  verifyRuntimeSchemaBaseline,
  type AllowedSuffixCheckConstraints
} from './legacy-baseline-adapter'
import { DatabaseValidationError } from './database-validation-error'
import { migrationSqlExecutor } from './migration-sql-executor'
import { runtimeSchemaBaselineMigration } from './migrations/0001-runtime-schema-baseline'
import { projectAgentContextMigration } from './migrations/0002-project-agent-context'
import { grantedLocalRootsMigration } from './migrations/0003-granted-local-roots'
import { reviewAssessmentSnapshotsMigration } from './migrations/0004-review-assessment-snapshots'
import { projectPreviewStateOwnerFkMigration } from './migrations/0005-project-preview-state-owner-fk'
import { databaseDomainConstraintsMigration } from './migrations/0006-database-domain-constraints'
import { notificationAttentionMetadataMigration } from './migrations/0007-notification-attention-metadata'
import { databaseJsonConstraintsMigration } from './migrations/0008-database-json-constraints'
import { visionEvidenceMigration } from './migrations/0009-vision-evidence'
import { computePasswordAuthMigration } from './migrations/0010-compute-password-auth'
import { crossResourceTagsMigration } from './migrations/0011-cross-resource-tags'
import { tagOrderingMigration } from './migrations/0012-tag-ordering'
import { sessionProjectionMigration } from './migrations/0013-session-projection'
import { reviewQueryIndexesMigration } from './migrations/0014-review-query-indexes'
import { sessionModelCallUsageMigration } from './migrations/0015-session-model-call-usage'
import { computeJobSensitiveDataEncryptionMigration } from './migrations/0016-compute-job-sensitive-data-encryption'
import {
  agentMemoryProjectScopeMigration,
  MEMORY_AUXILIARY_SCHEMA_OBJECTS,
  MEMORY_AUXILIARY_TABLE_NAMES
} from './migrations/0017-agent-memory-project-scope'
import { sessionAuxiliaryTurnUsageMigration } from './migrations/0018-session-auxiliary-turn-usage'
import { sessionUsageAttributionMigration } from './migrations/0019-session-usage-attribution'
import { computeJobAnalysisStateMigration } from './migrations/0020-compute-job-analysis-state'
import { computeJobAnalysisConstraintsMigration } from './migrations/0021-compute-job-analysis-constraints'
import { memoryGlobalContentUniqueMigration } from './migrations/0022-memory-global-content-unique'
import { computeJobOperationMigration } from './migrations/0023-compute-job-operation'
import { computeJobFileEvidenceMigration } from './migrations/0024-compute-job-file-evidence'
import {
  managedFileVersionFoundationCurrentSchemaAdoptionStatements,
  managedFileVersionFoundationMigration
} from './migrations/0025-managed-file-version-foundation'
import { computeJobRemoteCleanupMigration } from './migrations/0026-compute-job-remote-cleanup'
import { projectSessionDefaultsMigration } from './migrations/0027-project-session-defaults'
import {
  applySqliteMigrationOperations,
  type SqliteMigrationOperation
} from './sqlite-schema-migrations'

type MigrationVerifierDescriptor =
  | {
      kind: 'runtime-schema-baseline'
      version: 1
      contract: readonly string[]
    }
  | {
      kind: 'table-exists'
      version: 1
      table: string
    }
  | {
      kind: 'column-exists'
      version: 1
      table: string
      column: string
    }
  | {
      kind: 'foreign-key-exists'
      version: 2
      table: string
      column: string
      referencedTable: string
      referencedColumn: string
      onDelete: string
      onUpdate: string
    }
  | {
      kind: 'check-constraints-exist'
      version: 1
      tables: readonly {
        table: string
        constraints: readonly { name: string; expression: string }[]
      }[]
    }
  | {
      kind: 'indexes-exist'
      version: 1
      indexes: readonly { name: string; sql: string }[]
    }
  | { kind: 'foreign-key-integrity'; version: 1 }
  | { kind: 'managed-file-version-domain'; version: 1 }
  | {
      kind: 'sqlite-schema-objects-exist'
      version: 1
      objects: readonly { type: 'table' | 'trigger' | 'view'; name: string; sql: string }[]
    }
  | {
      kind: 'table-value-equals'
      version: 1
      table: string
      keyColumn: string
      keyValue: string
      valueColumn: string
      expectedValue: string | number
    }

type MigrationVerifiers = readonly [MigrationVerifierDescriptor, ...MigrationVerifierDescriptor[]]

const normalizeChecksumText = (value: string): string =>
  value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')

const lengthPrefixedChecksumText = (value: string): string => {
  const normalized = normalizeChecksumText(value)
  return `${Buffer.byteLength(normalized, 'utf8')}:${normalized}`
}

const serializeMigrationVerifier = (verifier: MigrationVerifierDescriptor): string => {
  switch (verifier.kind) {
    case 'runtime-schema-baseline':
      return `runtime-schema-baseline:v${verifier.version}:${verifier.contract
        .map(lengthPrefixedChecksumText)
        .join('')}`
    case 'table-exists':
      return `table-exists:v${verifier.version}:${lengthPrefixedChecksumText(verifier.table)}`
    case 'column-exists':
      return `column-exists:v${verifier.version}:${lengthPrefixedChecksumText(verifier.table)}${lengthPrefixedChecksumText(verifier.column)}`
    case 'foreign-key-exists':
      return `foreign-key-exists:v${verifier.version}:${[
        verifier.table,
        verifier.column,
        verifier.referencedTable,
        verifier.referencedColumn,
        verifier.onDelete,
        verifier.onUpdate
      ]
        .map(lengthPrefixedChecksumText)
        .join('')}`
    case 'check-constraints-exist':
      return `check-constraints-exist:v${verifier.version}:${verifier.tables
        .flatMap(({ table, constraints }) => [
          table,
          ...constraints.flatMap(({ name, expression }) => [name, expression])
        ])
        .map(lengthPrefixedChecksumText)
        .join('')}`
    case 'indexes-exist':
      return `indexes-exist:v${verifier.version}:${verifier.indexes
        .flatMap(({ name, sql }) => [name, sql])
        .map(lengthPrefixedChecksumText)
        .join('')}`
    case 'foreign-key-integrity':
      return `foreign-key-integrity:v${verifier.version}`
    case 'managed-file-version-domain':
      return `managed-file-version-domain:v${verifier.version}`
    case 'sqlite-schema-objects-exist':
      return `sqlite-schema-objects-exist:v${verifier.version}:${verifier.objects
        .flatMap(({ type, name, sql }) => [type, name, sql])
        .map(lengthPrefixedChecksumText)
        .join('')}`
    case 'table-value-equals':
      return `table-value-equals:v${verifier.version}:${[
        verifier.table,
        verifier.keyColumn,
        verifier.keyValue,
        verifier.valueColumn,
        String(verifier.expectedValue)
      ]
        .map(lengthPrefixedChecksumText)
        .join('')}`
  }
}

const BASELINE_ID = runtimeSchemaBaselineMigration.id

const checksumMigrationPayload = (
  id: string,
  statements: readonly string[],
  verifiers: MigrationVerifiers,
  operations: readonly SqliteMigrationOperation[] = []
): string => {
  const hash = createHash('sha256')
  for (const [kind, values] of [
    ['id', [id]],
    ['statement', statements],
    ['verifier', verifiers.map(serializeMigrationVerifier)]
  ] as const) {
    for (const value of values) {
      const normalized = normalizeChecksumText(value)
      hash.update(`${kind}:${Buffer.byteLength(normalized, 'utf8')}:`, 'utf8')
      hash.update(normalized, 'utf8')
    }
  }
  for (const operation of operations) {
    const serialized = JSON.stringify(operation, (_key, value: unknown) =>
      typeof value === 'string' ? normalizeChecksumText(value) : value
    )
    hash.update(`operation:${Buffer.byteLength(serialized, 'utf8')}:`, 'utf8')
    hash.update(serialized, 'utf8')
  }
  return hash.digest('hex')
}

const BASELINE_CHECKSUM = checksumMigrationPayload(
  BASELINE_ID,
  runtimeSchemaBaselineMigration.statements,
  runtimeSchemaBaselineMigration.verifiers
)
const PROJECT_AGENT_CONTEXT_CHECKSUM = checksumMigrationPayload(
  projectAgentContextMigration.id,
  projectAgentContextMigration.statements,
  projectAgentContextMigration.verifiers
)
const GRANTED_LOCAL_ROOTS_CHECKSUM = checksumMigrationPayload(
  grantedLocalRootsMigration.id,
  grantedLocalRootsMigration.statements,
  grantedLocalRootsMigration.verifiers
)
const REVIEW_ASSESSMENT_SNAPSHOTS_CHECKSUM = checksumMigrationPayload(
  reviewAssessmentSnapshotsMigration.id,
  reviewAssessmentSnapshotsMigration.statements,
  reviewAssessmentSnapshotsMigration.verifiers
)
const PROJECT_PREVIEW_STATE_OWNER_FK_CHECKSUM = checksumMigrationPayload(
  projectPreviewStateOwnerFkMigration.id,
  projectPreviewStateOwnerFkMigration.statements,
  projectPreviewStateOwnerFkMigration.verifiers
)
const DATABASE_DOMAIN_CONSTRAINTS_CHECKSUM = checksumMigrationPayload(
  databaseDomainConstraintsMigration.id,
  databaseDomainConstraintsMigration.statements,
  databaseDomainConstraintsMigration.verifiers,
  databaseDomainConstraintsMigration.operations
)
const NOTIFICATION_ATTENTION_METADATA_CHECKSUM = checksumMigrationPayload(
  notificationAttentionMetadataMigration.id,
  notificationAttentionMetadataMigration.statements,
  notificationAttentionMetadataMigration.verifiers,
  notificationAttentionMetadataMigration.operations
)
const DATABASE_JSON_CONSTRAINTS_CHECKSUM = checksumMigrationPayload(
  databaseJsonConstraintsMigration.id,
  databaseJsonConstraintsMigration.statements,
  databaseJsonConstraintsMigration.verifiers,
  databaseJsonConstraintsMigration.operations
)
const MANAGED_FILE_VERSION_FOUNDATION_CHECKSUM = checksumMigrationPayload(
  managedFileVersionFoundationMigration.id,
  managedFileVersionFoundationMigration.statements,
  managedFileVersionFoundationMigration.verifiers
)
const VISION_EVIDENCE_CHECKSUM = checksumMigrationPayload(
  visionEvidenceMigration.id,
  visionEvidenceMigration.statements,
  visionEvidenceMigration.verifiers,
  visionEvidenceMigration.operations
)
const COMPUTE_PASSWORD_AUTH_CHECKSUM = checksumMigrationPayload(
  computePasswordAuthMigration.id,
  computePasswordAuthMigration.statements,
  computePasswordAuthMigration.verifiers,
  computePasswordAuthMigration.operations
)
const CROSS_RESOURCE_TAGS_CHECKSUM = checksumMigrationPayload(
  crossResourceTagsMigration.id,
  crossResourceTagsMigration.statements,
  crossResourceTagsMigration.verifiers,
  crossResourceTagsMigration.operations
)
const TAG_ORDERING_CHECKSUM = checksumMigrationPayload(
  tagOrderingMigration.id,
  tagOrderingMigration.statements,
  tagOrderingMigration.verifiers,
  tagOrderingMigration.operations
)
const SESSION_PROJECTION_CHECKSUM = checksumMigrationPayload(
  sessionProjectionMigration.id,
  sessionProjectionMigration.statements,
  sessionProjectionMigration.verifiers,
  sessionProjectionMigration.operations
)
const REVIEW_QUERY_INDEXES_CHECKSUM = checksumMigrationPayload(
  reviewQueryIndexesMigration.id,
  reviewQueryIndexesMigration.statements,
  reviewQueryIndexesMigration.verifiers,
  reviewQueryIndexesMigration.operations
)
const SESSION_MODEL_CALL_USAGE_CHECKSUM = checksumMigrationPayload(
  sessionModelCallUsageMigration.id,
  sessionModelCallUsageMigration.statements,
  sessionModelCallUsageMigration.verifiers,
  sessionModelCallUsageMigration.operations
)
const AGENT_MEMORY_PROJECT_SCOPE_CHECKSUM = checksumMigrationPayload(
  agentMemoryProjectScopeMigration.id,
  agentMemoryProjectScopeMigration.statements,
  agentMemoryProjectScopeMigration.verifiers,
  agentMemoryProjectScopeMigration.operations
)
const SESSION_AUXILIARY_TURN_USAGE_CHECKSUM = checksumMigrationPayload(
  sessionAuxiliaryTurnUsageMigration.id,
  sessionAuxiliaryTurnUsageMigration.statements,
  sessionAuxiliaryTurnUsageMigration.verifiers,
  sessionAuxiliaryTurnUsageMigration.operations
)
const SESSION_USAGE_ATTRIBUTION_CHECKSUM = checksumMigrationPayload(
  sessionUsageAttributionMigration.id,
  sessionUsageAttributionMigration.statements,
  sessionUsageAttributionMigration.verifiers,
  sessionUsageAttributionMigration.operations
)
const COMPUTE_JOB_ANALYSIS_STATE_CHECKSUM = checksumMigrationPayload(
  computeJobAnalysisStateMigration.id,
  computeJobAnalysisStateMigration.statements,
  computeJobAnalysisStateMigration.verifiers,
  computeJobAnalysisStateMigration.operations
)
const COMPUTE_JOB_ANALYSIS_CONSTRAINTS_CHECKSUM = checksumMigrationPayload(
  computeJobAnalysisConstraintsMigration.id,
  computeJobAnalysisConstraintsMigration.statements,
  computeJobAnalysisConstraintsMigration.verifiers,
  computeJobAnalysisConstraintsMigration.operations
)
const MEMORY_GLOBAL_CONTENT_UNIQUE_CHECKSUM = checksumMigrationPayload(
  memoryGlobalContentUniqueMigration.id,
  memoryGlobalContentUniqueMigration.statements,
  memoryGlobalContentUniqueMigration.verifiers,
  memoryGlobalContentUniqueMigration.operations
)
const COMPUTE_JOB_FILE_EVIDENCE_CHECKSUM = checksumMigrationPayload(
  computeJobFileEvidenceMigration.id,
  computeJobFileEvidenceMigration.statements,
  computeJobFileEvidenceMigration.verifiers,
  computeJobFileEvidenceMigration.operations
)
const COMPUTE_JOB_REMOTE_CLEANUP_CHECKSUM = checksumMigrationPayload(
  computeJobRemoteCleanupMigration.id,
  computeJobRemoteCleanupMigration.statements,
  computeJobRemoteCleanupMigration.verifiers,
  computeJobRemoteCleanupMigration.operations
)
const PROJECT_SESSION_DEFAULTS_CHECKSUM = checksumMigrationPayload(
  projectSessionDefaultsMigration.id,
  projectSessionDefaultsMigration.statements,
  projectSessionDefaultsMigration.verifiers,
  projectSessionDefaultsMigration.operations
)
const COMPUTE_JOB_SENSITIVE_DATA_ENCRYPTION_CHECKSUM = checksumMigrationPayload(
  computeJobSensitiveDataEncryptionMigration.id,
  computeJobSensitiveDataEncryptionMigration.statements,
  computeJobSensitiveDataEncryptionMigration.verifiers,
  computeJobSensitiveDataEncryptionMigration.operations
)
const COMPUTE_JOB_OPERATION_CHECKSUM = checksumMigrationPayload(
  computeJobOperationMigration.id,
  computeJobOperationMigration.statements,
  computeJobOperationMigration.verifiers,
  computeJobOperationMigration.operations
)
const DATABASE_DOMAIN_ALLOWED_SUFFIX_CHECKS: AllowedSuffixCheckConstraints = Object.fromEntries(
  databaseDomainConstraintsMigration.verifiers[0].tables.map(({ table, constraints }) => [
    table,
    Object.fromEntries(constraints.map(({ name, expression }) => [name, expression]))
  ])
)
const NOTIFICATION_ATTENTION_ALLOWED_SUFFIX_CHECKS: AllowedSuffixCheckConstraints =
  Object.fromEntries(
    notificationAttentionMetadataMigration.verifiers
      .filter((verifier) => verifier.kind === 'check-constraints-exist')
      .flatMap((verifier) => verifier.tables)
      .map(({ table, constraints }) => [
        table,
        Object.fromEntries(constraints.map(({ name, expression }) => [name, expression]))
      ])
  )
const DATABASE_JSON_ALLOWED_SUFFIX_CHECKS: AllowedSuffixCheckConstraints = Object.fromEntries(
  databaseJsonConstraintsMigration.verifiers
    .filter((verifier) => verifier.kind === 'check-constraints-exist')
    .flatMap((verifier) => verifier.tables)
    .map(({ table, constraints }) => [
      table,
      Object.fromEntries(constraints.map(({ name, expression }) => [name, expression]))
    ])
)
const VISION_EVIDENCE_ALLOWED_SUFFIX_CHECKS: AllowedSuffixCheckConstraints = Object.fromEntries(
  visionEvidenceMigration.verifiers
    .filter((verifier) => verifier.kind === 'check-constraints-exist')
    .flatMap((verifier) => verifier.tables)
    .map(({ table, constraints }) => [
      table,
      Object.fromEntries(constraints.map(({ name, expression }) => [name, expression]))
    ])
)
const COMPUTE_PASSWORD_AUTH_ALLOWED_SUFFIX_CHECKS: AllowedSuffixCheckConstraints =
  Object.fromEntries(
    computePasswordAuthMigration.verifiers
      .filter((verifier) => verifier.kind === 'check-constraints-exist')
      .flatMap((verifier) => verifier.tables)
      .map(({ table, constraints }) => [
        table,
        Object.fromEntries(constraints.map(({ name, expression }) => [name, expression]))
      ])
  )
const CROSS_RESOURCE_TAGS_ALLOWED_SUFFIX_CHECKS: AllowedSuffixCheckConstraints = Object.fromEntries(
  crossResourceTagsMigration.verifiers
    .filter((verifier) => verifier.kind === 'check-constraints-exist')
    .flatMap((verifier) => verifier.tables)
    .map(({ table, constraints }) => [
      table,
      Object.fromEntries(constraints.map(({ name, expression }) => [name, expression]))
    ])
)
const AGENT_MEMORY_PROJECT_SCOPE_ALLOWED_SUFFIX_CHECKS: AllowedSuffixCheckConstraints =
  Object.fromEntries(
    agentMemoryProjectScopeMigration.verifiers
      .filter((verifier) => verifier.kind === 'check-constraints-exist')
      .flatMap((verifier) => verifier.tables)
      .map(({ table, constraints }) => [
        table,
        Object.fromEntries(constraints.map(({ name, expression }) => [name, expression]))
      ])
  )
const SESSION_AUXILIARY_TURN_USAGE_ALLOWED_SUFFIX_CHECKS: AllowedSuffixCheckConstraints =
  Object.fromEntries(
    sessionAuxiliaryTurnUsageMigration.verifiers
      .filter((verifier) => verifier.kind === 'check-constraints-exist')
      .flatMap((verifier) => verifier.tables)
      .map(({ table, constraints }) => [
        table,
        Object.fromEntries(constraints.map(({ name, expression }) => [name, expression]))
      ])
  )
const COMPUTE_JOB_OPERATION_ALLOWED_SUFFIX_CHECKS: AllowedSuffixCheckConstraints =
  Object.fromEntries(
    computeJobOperationMigration.verifiers
      .filter((verifier) => verifier.kind === 'check-constraints-exist')
      .flatMap((verifier) => verifier.tables)
      .map(({ table, constraints }) => [
        table,
        Object.fromEntries(constraints.map(({ name, expression }) => [name, expression]))
      ])
  )
const mergeAllowedSuffixChecks = (
  ...contracts: readonly AllowedSuffixCheckConstraints[]
): AllowedSuffixCheckConstraints => {
  const merged: Record<string, Record<string, string>> = {}
  for (const contract of contracts) {
    for (const [table, constraints] of Object.entries(contract)) {
      merged[table] = { ...merged[table], ...constraints }
    }
  }
  return merged
}
const MIGRATION_MANIFEST = [
  {
    ...runtimeSchemaBaselineMigration,
    checksum: BASELINE_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...projectAgentContextMigration,
    checksum: PROJECT_AGENT_CONTEXT_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...grantedLocalRootsMigration,
    checksum: GRANTED_LOCAL_ROOTS_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...reviewAssessmentSnapshotsMigration,
    checksum: REVIEW_ASSESSMENT_SNAPSHOTS_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...projectPreviewStateOwnerFkMigration,
    checksum: PROJECT_PREVIEW_STATE_OWNER_FK_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...databaseDomainConstraintsMigration,
    checksum: DATABASE_DOMAIN_CONSTRAINTS_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...notificationAttentionMetadataMigration,
    checksum: NOTIFICATION_ATTENTION_METADATA_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...databaseJsonConstraintsMigration,
    checksum: DATABASE_JSON_CONSTRAINTS_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...visionEvidenceMigration,
    checksum: VISION_EVIDENCE_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...computePasswordAuthMigration,
    checksum: COMPUTE_PASSWORD_AUTH_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...crossResourceTagsMigration,
    checksum: CROSS_RESOURCE_TAGS_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...tagOrderingMigration,
    checksum: TAG_ORDERING_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...sessionProjectionMigration,
    checksum: SESSION_PROJECTION_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...reviewQueryIndexesMigration,
    checksum: REVIEW_QUERY_INDEXES_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...sessionModelCallUsageMigration,
    checksum: SESSION_MODEL_CALL_USAGE_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...computeJobSensitiveDataEncryptionMigration,
    checksum: COMPUTE_JOB_SENSITIVE_DATA_ENCRYPTION_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...agentMemoryProjectScopeMigration,
    checksum: AGENT_MEMORY_PROJECT_SCOPE_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...sessionAuxiliaryTurnUsageMigration,
    checksum: SESSION_AUXILIARY_TURN_USAGE_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...sessionUsageAttributionMigration,
    checksum: SESSION_USAGE_ATTRIBUTION_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...computeJobAnalysisStateMigration,
    checksum: COMPUTE_JOB_ANALYSIS_STATE_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...computeJobAnalysisConstraintsMigration,
    checksum: COMPUTE_JOB_ANALYSIS_CONSTRAINTS_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...memoryGlobalContentUniqueMigration,
    checksum: MEMORY_GLOBAL_CONTENT_UNIQUE_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...computeJobOperationMigration,
    checksum: COMPUTE_JOB_OPERATION_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...computeJobFileEvidenceMigration,
    checksum: COMPUTE_JOB_FILE_EVIDENCE_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...managedFileVersionFoundationMigration,
    checksum: MANAGED_FILE_VERSION_FOUNDATION_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain',
    foreignKeysDuringApply: 'disabled'
  },
  {
    ...computeJobRemoteCleanupMigration,
    checksum: COMPUTE_JOB_REMOTE_CLEANUP_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  },
  {
    ...projectSessionDefaultsMigration,
    checksum: PROJECT_SESSION_DEFAULTS_CHECKSUM,
    backupOnApply: 'required',
    backupRetention: 'retain'
  }
] as const satisfies readonly MigrationManifestEntry[]
// schema-locality: begin frozen-0001-repairs
const LEDGER_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "_open_science_migrations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checksum" TEXT NOT NULL,
    "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "_open_science_migrations_checksum_check"
      CHECK (length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*')
);`
// schema-locality: end frozen-0001-repairs

type LedgerRow = { id: string; checksum: string }
type SqliteForeignKeyStateRow = { foreign_keys: bigint | number }
type SqliteDatabaseListRow = { name: string; file: string }
type SqliteIntegrityCheckRow = { integrity_check: string }
type SqliteForeignKeyListRow = {
  table: string
  from: string
  to: string
  on_delete: string
  on_update: string
}
type SqliteForeignKeyViolationRow = {
  table: string
  parent: string
}
type SqliteSchemaObjectRow = { type: string; name: string; tableName: string; sql: string | null }
type SqliteDifferenceRow = { different: bigint | number }
type DatabaseMigrationErrorCode = DatabaseStartupErrorCode

class DatabaseMigrationError extends Error {
  readonly name = 'DatabaseMigrationError'

  constructor(
    readonly code: DatabaseStartupErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly migrationId?: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

type SchemaMigrationResult = {
  from: string | null
  to: string
  applied: readonly string[]
  adoptedLegacy: boolean
}

type SchemaMigrationProgress = { phase: 'checking' } | { phase: 'migrating'; migrationId: string }

type DatabaseCompatibility = { sqliteVersion: string }

type DatabaseMigrationBackup = {
  migrationId: string
  path: string
  reused: boolean
}

type DatabaseMigrationBackupRetirement = {
  migrationId: string
  path?: string
  error?: unknown
}

type SchemaMigrationOptions = {
  databasePath?: string
  onProgress?: (progress: SchemaMigrationProgress) => void
  onCompatibilityVerified?: (compatibility: DatabaseCompatibility) => void
  onBackupReady?: (backup: DatabaseMigrationBackup) => void
  onBackupRetired?: (backup: DatabaseMigrationBackupRetirement) => void
  onBackupRetirementFailed?: (backup: DatabaseMigrationBackupRetirement) => void
  onCompleted?: (result: SchemaMigrationResult) => void
}

type MigrationManifestEntry = {
  id: string
  checksum: string
  statements: readonly string[]
  operations?: readonly SqliteMigrationOperation[]
  verifiers: MigrationVerifiers
  backupOnApply: 'required' | 'none'
  backupRetention: 'retain' | 'delete-after-success'
  foreignKeysDuringApply?: 'enabled' | 'disabled'
}

const verifyForeignKeyIntegrity = async (client: PrismaClient): Promise<void> => {
  const violations = await migrationSqlExecutor.query<SqliteForeignKeyViolationRow[]>(
    client,
    'PRAGMA foreign_key_check'
  )
  if (violations.length > 0) {
    throw new Error(
      `Database foreign-key integrity audit found orphaned relations: ${violations
        .map((violation) => `${violation.table}->${violation.parent}`)
        .join(', ')}.`
    )
  }
}

const verifyManagedFileVersionDomain = async (client: PrismaClient): Promise<void> => {
  await verifyForeignKeyIntegrity(client)
  const violations = await migrationSqlExecutor.query<Array<{ kind: string; id: string }>>(
    client,
    `
    SELECT 'artifact-head' AS "kind", "lineage"."id" AS "id"
    FROM "ArtifactLineage" AS "lineage"
    WHERE "lineage"."currentVersionId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "ArtifactVersion" AS "version"
        WHERE "version"."id" = "lineage"."currentVersionId"
          AND "version"."artifactId" = "lineage"."id"
          AND "version"."state" = 'finalized'
      )
    UNION ALL
    SELECT 'upload-head', "file"."id"
    FROM "UploadFile" AS "file"
    WHERE "file"."currentVersionId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "UploadVersion" AS "version"
        WHERE "version"."id" = "file"."currentVersionId"
          AND "version"."uploadFileId" = "file"."id"
          AND "version"."state" = 'ready'
      )
    UNION ALL
    SELECT 'artifact-based-on', "version"."id"
    FROM "ArtifactVersion" AS "version"
    WHERE "version"."basedOnVersionId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "ArtifactVersion" AS "parent"
        WHERE "parent"."id" = "version"."basedOnVersionId"
          AND "parent"."artifactId" = "version"."artifactId"
          AND "parent"."state" = 'finalized'
          AND "parent"."versionNumber" < "version"."versionNumber"
      )
    UNION ALL
    SELECT 'upload-based-on', "version"."id"
    FROM "UploadVersion" AS "version"
    WHERE "version"."basedOnVersionId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "UploadVersion" AS "parent"
        WHERE "parent"."id" = "version"."basedOnVersionId"
          AND "parent"."uploadFileId" = "version"."uploadFileId"
          AND "parent"."state" = 'ready'
          AND "parent"."versionNumber" < "version"."versionNumber"
      )
    LIMIT 1
  `
  )
  if (violations.length > 0) {
    throw new Error(
      `Managed file version domain audit failed for ${violations[0]!.kind}: ${violations[0]!.id}`
    )
  }
}

const RETAINED_DATABASE_MIGRATION_BACKUP_LIMIT = 2

type DatabaseMigrationBackupRetirementScope = {
  throughMigrationId: string
  includeDeleteAfterSuccess: boolean
}

const runMigrationVerifiers = async (
  client: PrismaClient,
  verifiers: MigrationVerifiers,
  allowedSuffixChecks: AllowedSuffixCheckConstraints = {},
  currentTableNames: ReadonlySet<string> = new Set()
): Promise<void> => {
  for (const verifier of verifiers) {
    switch (verifier.kind) {
      case 'runtime-schema-baseline':
        if (
          verifier.contract.length !== RUNTIME_SCHEMA_BASELINE_CONTRACT.length ||
          verifier.contract.some((item, index) => item !== RUNTIME_SCHEMA_BASELINE_CONTRACT[index])
        ) {
          throw new Error('Migration verification found an unsupported baseline contract.')
        }
        await verifyRuntimeSchemaBaseline(client, allowedSuffixChecks)
        break
      case 'table-exists': {
        if (currentTableNames.has(verifier.table)) break
        const rows = await client.$queryRaw<Array<{ name: string }>>`
          SELECT "name" FROM "sqlite_schema"
          WHERE "type" = 'table' AND "name" = ${verifier.table}
        `
        if (rows.length !== 1) {
          throw new Error(`Migration verification found missing table ${verifier.table}.`)
        }
        break
      }
      case 'column-exists': {
        if (currentTableNames.has(verifier.table)) break
        const quotedTable = `"${verifier.table.replaceAll('"', '""')}"`
        const columns = await migrationSqlExecutor.query<Array<{ name: string }>>(
          client,
          `PRAGMA table_info(${quotedTable})`
        )
        if (!columns.some((column) => column.name === verifier.column)) {
          throw new Error(
            `Migration verification found missing column ${verifier.table}.${verifier.column}.`
          )
        }
        break
      }
      case 'foreign-key-exists': {
        if (currentTableNames.has(verifier.table)) break
        const quotedTable = `"${verifier.table.replaceAll('"', '""')}"`
        const foreignKeys = await migrationSqlExecutor.query<SqliteForeignKeyListRow[]>(
          client,
          `PRAGMA foreign_key_list(${quotedTable})`
        )
        const exists = foreignKeys.some(
          (foreignKey) =>
            foreignKey.from === verifier.column &&
            foreignKey.table === verifier.referencedTable &&
            foreignKey.to === verifier.referencedColumn &&
            foreignKey.on_delete.toUpperCase() === verifier.onDelete.toUpperCase() &&
            foreignKey.on_update.toUpperCase() === verifier.onUpdate.toUpperCase()
        )
        if (!exists) {
          throw new Error(
            `Migration verification found missing foreign key ${verifier.table}.${verifier.column} -> ${verifier.referencedTable}.${verifier.referencedColumn}.`
          )
        }
        const violations = await migrationSqlExecutor.query<Array<{ table: string }>>(
          client,
          `PRAGMA foreign_key_check(${quotedTable})`
        )
        if (violations.length > 0) {
          throw new Error(
            `Migration verification found foreign-key violations in ${verifier.table}.`
          )
        }
        break
      }
      case 'check-constraints-exist': {
        for (const table of verifier.tables) {
          if (currentTableNames.has(table.table)) continue
          const rows = await migrationSqlExecutor.query<Array<{ sql: string | null }>>(
            client,
            `SELECT "sql" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" = ?`,
            table.table
          )
          const tableSql = rows[0]?.sql
          if (
            !tableSql ||
            table.constraints.some(
              ({ name, expression }) =>
                !tableSql.includes(`CONSTRAINT "${name}" CHECK (${expression})`)
            )
          ) {
            throw new Error(
              `Migration verification found missing CHECK constraints in ${table.table}.`
            )
          }
        }
        break
      }
      case 'indexes-exist': {
        const normalizeIndexSql = (value: string): string =>
          value
            .replace(
              /^CREATE (UNIQUE )?INDEX IF NOT EXISTS /i,
              (_match, unique: string | undefined) => `CREATE ${unique ?? ''}INDEX `
            )
            .replaceAll(/\s+/g, ' ')
            .replace(/;$/, '')
            .trim()
        for (const index of verifier.indexes) {
          const tableName = index.sql.match(/\bON\s+"([^"]+)"/i)?.[1]
          if (tableName && currentTableNames.has(tableName)) continue
          const rows = await migrationSqlExecutor.query<Array<{ sql: string | null }>>(
            client,
            `SELECT "sql" FROM "sqlite_schema" WHERE "type" = 'index' AND "name" = ?`,
            index.name
          )
          if (!rows[0]?.sql || normalizeIndexSql(rows[0].sql) !== normalizeIndexSql(index.sql)) {
            throw new Error(`Migration verification found missing index ${index.name}.`)
          }
        }
        break
      }
      case 'foreign-key-integrity':
        await verifyForeignKeyIntegrity(client)
        break
      case 'managed-file-version-domain':
        await verifyManagedFileVersionDomain(client)
        break
      case 'sqlite-schema-objects-exist': {
        const rows = await migrationSqlExecutor.query<
          Array<{ type: string; name: string; sql: string | null }>
        >(
          client,
          `SELECT "type", "name", "sql" FROM "sqlite_schema"
           WHERE "name" IN (${verifier.objects.map(() => '?').join(', ')})`,
          ...verifier.objects.map(({ name }) => name)
        )
        const actual = new Map(rows.map((row) => [row.name, row]))
        for (const expected of verifier.objects) {
          const row = actual.get(expected.name)
          if (
            !row ||
            row.type !== expected.type ||
            normalizeSchemaObjectSql(row.sql) !== normalizeSchemaObjectSql(expected.sql)
          ) {
            throw new Error(
              `Migration verification found missing or incompatible schema object ${expected.name}.`
            )
          }
        }
        break
      }
      case 'table-value-equals': {
        const table = quoteSqliteIdentifier(verifier.table)
        const keyColumn = quoteSqliteIdentifier(verifier.keyColumn)
        const valueColumn = quoteSqliteIdentifier(verifier.valueColumn)
        const rows = await migrationSqlExecutor.query<
          Array<{ value: bigint | number | string | null }>
        >(
          client,
          `SELECT ${valueColumn} AS "value" FROM ${table} WHERE ${keyColumn} = ? LIMIT 2`,
          verifier.keyValue
        )
        if (rows.length !== 1 || String(rows[0]?.value) !== String(verifier.expectedValue)) {
          throw new Error(
            `Migration verification found an incompatible value in ${verifier.table}.${verifier.valueColumn}.`
          )
        }
        break
      }
    }
  }
}

const verifyCurrentApplicationSchema = async (client: PrismaClient): Promise<void> => {
  const memoryTriggerNames = MEMORY_AUXILIARY_SCHEMA_OBJECTS.flatMap(({ type, name }) =>
    type === 'trigger' ? [name] : []
  )
  await verifyCurrentRuntimeSchema(client, {
    tableNames: MEMORY_AUXILIARY_TABLE_NAMES,
    triggerNames: memoryTriggerNames
  })
  await runMigrationVerifiers(client, agentMemoryProjectScopeMigration.verifiers)
  await runMigrationVerifiers(client, sessionAuxiliaryTurnUsageMigration.verifiers)
  await runMigrationVerifiers(client, sessionUsageAttributionMigration.verifiers)
  await runMigrationVerifiers(client, computeJobAnalysisStateMigration.verifiers)
  await runMigrationVerifiers(client, computeJobAnalysisConstraintsMigration.verifiers)
  await runMigrationVerifiers(client, memoryGlobalContentUniqueMigration.verifiers)
  await runMigrationVerifiers(client, computeJobFileEvidenceMigration.verifiers)
}

const readLedger = async (client: PrismaClient): Promise<LedgerRow[]> => {
  const table = await client.$queryRaw<Array<{ name: string }>>`
    SELECT "name" FROM "sqlite_schema"
    WHERE "type" = 'table' AND "name" = '_open_science_migrations'
  `
  if (table.length === 0) return []
  return client.$queryRaw<LedgerRow[]>`
    SELECT "id", "checksum" FROM "_open_science_migrations" ORDER BY "id"
  `
}

const hasApplicationTables = async (client: PrismaClient): Promise<boolean> => {
  const rows = await client.$queryRaw<Array<{ name: string }>>`
    SELECT "name" FROM "sqlite_schema"
    WHERE "type" = 'table'
      AND "name" NOT LIKE 'sqlite_%'
      AND "name" <> '_open_science_migrations'
    LIMIT 1
  `
  return rows.length > 0
}

const readMainDatabasePath = async (client: PrismaClient): Promise<string | undefined> => {
  const databases = await migrationSqlExecutor.query<SqliteDatabaseListRow[]>(
    client,
    'PRAGMA database_list'
  )
  const path = databases.find((database) => database.name === 'main')?.file.trim()
  return path || undefined
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const quoteSqliteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`

const readSnapshotTableNames = (
  client: PrismaClient,
  schema: 'main' | '_open_science_backup'
): Promise<Array<{ name: string }>> =>
  migrationSqlExecutor.query(
    client,
    `SELECT "name" FROM "${schema}"."sqlite_schema"
     WHERE "type" = 'table'
       AND ("name" NOT LIKE 'sqlite_%' OR "name" = 'sqlite_sequence')
     ORDER BY "name"`
  )

const readSnapshotSchema = (
  client: PrismaClient,
  schema: 'main' | '_open_science_backup'
): Promise<SqliteSchemaObjectRow[]> =>
  migrationSqlExecutor.query(
    client,
    `SELECT "type", "name", "tbl_name" AS "tableName", "sql"
     FROM "${schema}"."sqlite_schema"
     WHERE "name" NOT LIKE 'sqlite_%' OR "name" = 'sqlite_sequence'
     ORDER BY "type", "name"`
  )

const snapshotTableDiffers = async (client: PrismaClient, tableName: string): Promise<boolean> => {
  const table = quoteSqliteIdentifier(tableName)
  const columns = await migrationSqlExecutor.query<Array<{ name: string }>>(
    client,
    `PRAGMA "main".table_xinfo(${table})`
  )
  if (columns.length === 0) return true
  const projection = columns.map(({ name }) => quoteSqliteIdentifier(name)).join(', ')
  const rows = await migrationSqlExecutor.query<SqliteDifferenceRow[]>(
    client,
    `WITH "current_rows" AS (
       SELECT ${projection}, COUNT(*) FROM "main".${table} GROUP BY ${projection}
     ), "backup_rows" AS (
       SELECT ${projection}, COUNT(*) FROM "_open_science_backup".${table} GROUP BY ${projection}
     )
     SELECT (
       EXISTS(SELECT * FROM "current_rows" EXCEPT SELECT * FROM "backup_rows")
       OR EXISTS(SELECT * FROM "backup_rows" EXCEPT SELECT * FROM "current_rows")
     ) AS "different"`
  )
  return Number(rows[0]?.different ?? 1) !== 0
}

const verifyDatabaseMigrationBackup = async (client: PrismaClient, path: string): Promise<void> => {
  let attached = false
  let failure: unknown
  try {
    await migrationSqlExecutor.execute(client, 'ATTACH DATABASE ? AS "_open_science_backup"', path)
    attached = true
    const [integrity, currentTables, backupTables, currentSchema, backupSchema] = await Promise.all(
      [
        migrationSqlExecutor.query<SqliteIntegrityCheckRow[]>(
          client,
          'PRAGMA "_open_science_backup".integrity_check'
        ),
        readSnapshotTableNames(client, 'main'),
        readSnapshotTableNames(client, '_open_science_backup'),
        readSnapshotSchema(client, 'main'),
        readSnapshotSchema(client, '_open_science_backup')
      ]
    )
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new DatabaseValidationError(
        'The existing database migration backup failed SQLite integrity_check.',
        { kind: 'backup-integrity-check-failed', actual: integrity }
      )
    }
    if (JSON.stringify(currentSchema) !== JSON.stringify(backupSchema)) {
      throw new DatabaseValidationError(
        'The existing database migration backup does not match the current schema.',
        { kind: 'backup-schema-mismatch', expected: currentSchema, actual: backupSchema }
      )
    }
    if (
      currentTables.map(({ name }) => name).join('\n') !==
      backupTables.map(({ name }) => name).join('\n')
    ) {
      throw new DatabaseValidationError(
        'The existing database migration backup does not contain the current tables.',
        { kind: 'backup-table-set-mismatch', expected: currentTables, actual: backupTables }
      )
    }
    for (const { name } of currentTables) {
      if (await snapshotTableDiffers(client, name)) {
        throw new DatabaseValidationError(
          `The existing database migration backup does not match the current contents of ${name}.`,
          { kind: 'backup-content-mismatch', table: name }
        )
      }
    }
  } catch (error) {
    failure = error
  }
  if (attached) {
    try {
      await migrationSqlExecutor.execute(client, 'DETACH DATABASE "_open_science_backup"')
    } catch (error) {
      failure ??= error
    }
  }
  if (failure) throw failure
}

const createDatabaseMigrationBackup = async (
  client: PrismaClient,
  databasePath: string,
  migrationId: string
): Promise<DatabaseMigrationBackup> => {
  const path = `${databasePath}.before-${migrationId}.backup`
  if (await pathExists(path)) {
    await verifyDatabaseMigrationBackup(client, path)
    return { migrationId, path, reused: true }
  }

  const temporaryPath = `${path}.tmp`
  await rm(temporaryPath, { force: true })
  try {
    // SQLite owns the snapshot so WAL contents are included; rename publishes only a complete backup.
    await migrationSqlExecutor.execute(client, 'VACUUM INTO ?', temporaryPath)
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
  return { migrationId, path, reused: false }
}

const retireDatabaseMigrationBackups = async (
  client: PrismaClient,
  manifest: readonly MigrationManifestEntry[],
  options: SchemaMigrationOptions,
  scope: DatabaseMigrationBackupRetirementScope
): Promise<void> => {
  const boundaryIndex = manifest.findIndex((migration) => migration.id === scope.throughMigrationId)
  if (boundaryIndex < 0) {
    throw new Error(`Unknown database backup retention boundary ${scope.throughMigrationId}.`)
  }
  const retainedCandidates = manifest
    .slice(0, boundaryIndex + 1)
    .filter(
      (migration) =>
        migration.backupOnApply === 'required' && migration.backupRetention === 'retain'
    )
  const manifestRetainedMigrationIds = new Set(
    retainedCandidates
      .slice(-RETAINED_DATABASE_MIGRATION_BACKUP_LIMIT)
      .map((migration) => migration.id)
  )
  const retirementCandidates = (
    retainedMigrationIds: ReadonlySet<string>
  ): readonly MigrationManifestEntry[] =>
    manifest
      .slice(0, boundaryIndex + 1)
      .filter(
        (migration) =>
          (scope.includeDeleteAfterSuccess &&
            migration.backupRetention === 'delete-after-success') ||
          (migration.backupOnApply === 'required' &&
            migration.backupRetention === 'retain' &&
            !retainedMigrationIds.has(migration.id))
      )
  const manifestRetired = retirementCandidates(manifestRetainedMigrationIds)
  if (manifestRetired.length === 0) return

  let databasePath: string
  try {
    const resolvedDatabasePath = options.databasePath ?? (await readMainDatabasePath(client))
    if (!resolvedDatabasePath) {
      throw new Error('The database backup retention path is unavailable.')
    }
    databasePath = resolvedDatabasePath
  } catch (error) {
    for (const migration of manifestRetired) {
      try {
        options.onBackupRetirementFailed?.({ migrationId: migration.id, error })
      } catch {
        // A diagnostic sink failure must not block an otherwise valid database.
      }
    }
    return
  }

  // Retain the newest backups that actually exist. A history bridge may create an older backup
  // after newer ledger entries are already present, and that recovery point must survive startup.
  const existingRetainedCandidates: MigrationManifestEntry[] = []
  for (const migration of retainedCandidates) {
    if (await pathExists(`${databasePath}.before-${migration.id}.backup`)) {
      existingRetainedCandidates.push(migration)
    }
  }
  const retainedMigrationIds = new Set(
    existingRetainedCandidates
      .slice(-RETAINED_DATABASE_MIGRATION_BACKUP_LIMIT)
      .map((migration) => migration.id)
  )
  const retired = retirementCandidates(retainedMigrationIds)
  if (retired.length === 0) return
  for (const migration of retired) {
    const path = `${databasePath}.before-${migration.id}.backup`
    try {
      await rm(path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      try {
        options.onBackupRetirementFailed?.({ migrationId: migration.id, path, error })
      } catch {
        // A diagnostic sink failure must not block an otherwise valid database.
      }
      continue
    }
    try {
      options.onBackupRetired?.({ migrationId: migration.id, path })
    } catch {
      // A diagnostic sink failure must not invalidate completed backup retirement.
    }
  }
}

const validateLedger = (
  ledger: readonly LedgerRow[],
  manifest: readonly MigrationManifestEntry[]
): number => {
  if (manifest.length === 0 || manifest[0]?.id !== BASELINE_ID) {
    throw new Error(`The application migration manifest must start with ${BASELINE_ID}.`)
  }
  for (let index = 1; index < manifest.length; index += 1) {
    if (manifest[index - 1]!.id >= manifest[index]!.id) {
      throw new Error('The application migration manifest is not strictly ordered.')
    }
  }

  const sharedLength = Math.min(ledger.length, manifest.length)
  for (let index = 0; index < sharedLength; index += 1) {
    const applied = ledger[index]!
    const expected = manifest[index]!
    if (applied.id !== expected.id) {
      throw new DatabaseMigrationError(
        'database_history_invalid',
        'The database migration history is missing, reordered, or foreign to this application.',
        false,
        applied.id
      )
    }
    if (applied.checksum !== expected.checksum) {
      throw new DatabaseMigrationError(
        'database_history_invalid',
        'An applied database migration does not match this application.',
        false,
        applied.id
      )
    }
  }
  if (ledger.length > manifest.length) {
    const newerMigration = ledger[manifest.length]!
    throw new DatabaseMigrationError(
      'database_newer_than_app',
      'The database was updated by a newer version of Open Science.',
      false,
      newerMigration.id
    )
  }

  return ledger.length
}

const readForeignKeyState = async (client: PrismaClient): Promise<number> => {
  const rows = await migrationSqlExecutor.query<SqliteForeignKeyStateRow[]>(
    client,
    'PRAGMA foreign_keys'
  )
  return Number(rows[0]?.foreign_keys ?? 0)
}

const setForeignKeys = async (client: PrismaClient, enabled: boolean): Promise<void> => {
  await migrationSqlExecutor.execute(client, `PRAGMA foreign_keys = ${enabled ? 'ON' : 'OFF'}`)
  if ((await readForeignKeyState(client)) !== Number(enabled)) {
    throw new Error(
      `SQLite schema migration could not ${enabled ? 'restore' : 'disable'} foreign-key enforcement.`
    )
  }
}

type DatabaseFailurePhase = 'open' | 'migration' | 'validation'

const classifyDatabaseFailure = (
  error: unknown,
  phase: DatabaseFailurePhase,
  migrationId: string = BASELINE_ID
): DatabaseMigrationError => {
  if (error instanceof DatabaseMigrationError) return error

  let engineCode = ''
  let engineName = ''
  try {
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
      const code = Reflect.get(error, 'code')
      const name = Reflect.get(error, 'name')
      if (typeof code === 'string') engineCode = code
      if (typeof name === 'string') engineName = name
    }
  } catch {
    // Classification remains fail-closed when a hostile error object cannot be inspected.
  }
  const detail = `${error instanceof Error ? error.message : String(error)} ${engineCode} ${engineName}`
  const transient =
    /SQLITE_(?:BUSY|LOCKED|IOERR|FULL|READONLY)|database is locked|database or disk is full|attempt to write a readonly database|disk I\/O|EACCES|EPERM|permission denied/i.test(
      detail
    )
  const runtimeUnavailable =
    /query engine|libquery_engine|PrismaClientInitializationError|dynamic librar|shared object|dlopen/i.test(
      detail
    )
  const validationFailure =
    phase === 'validation' ||
    (error instanceof DatabaseValidationError &&
      error.data.kind === 'check-constraint-violation') ||
    /classification blocked|unsupported value|unknown columns?|row-count mismatch|foreign-key violation|baseline verification/i.test(
      detail
    )

  if (runtimeUnavailable) {
    return new DatabaseMigrationError(
      'database_runtime_unavailable',
      'This installation cannot load its database runtime.',
      false,
      migrationId,
      { cause: error }
    )
  }
  if (validationFailure) {
    return new DatabaseMigrationError(
      'database_validation_failed',
      'The existing database does not satisfy the required schema contract.',
      false,
      migrationId,
      { cause: error }
    )
  }
  if (phase === 'open') {
    return new DatabaseMigrationError(
      'database_open_failed',
      'Open Science could not open its database.',
      transient,
      undefined,
      { cause: error }
    )
  }
  return new DatabaseMigrationError(
    'database_migration_failed',
    'Open Science could not update its database. Existing data was not reset.',
    transient,
    migrationId,
    { cause: error }
  )
}

const insertLedgerRow = async (
  client: PrismaClient,
  migration: MigrationManifestEntry
): Promise<void> => {
  await migrationSqlExecutor.execute(client, LEDGER_TABLE_DDL)
  await client.$executeRaw`
    INSERT INTO "_open_science_migrations" ("id", "checksum")
    VALUES (${migration.id}, ${migration.checksum})
  `
}

const hasOnlyDeferredPreviewStateForeignKeyViolations = async (
  client: PrismaClient,
  error: unknown
): Promise<boolean> => {
  // This is a one-off bridge to the checksum-pinned 0005 repair below. Future suffix FKs must not
  // copy this deferral: they need their own explicit migration and fail-closed adoption contract.
  if (
    !(error instanceof DatabaseValidationError) ||
    error.data.kind !== 'foreign-key-violation' ||
    error.data.table !== 'ProjectPreviewState'
  ) {
    return false
  }
  const violations = await migrationSqlExecutor.query<SqliteForeignKeyViolationRow[]>(
    client,
    'PRAGMA foreign_key_check'
  )
  return (
    violations.length > 0 &&
    violations.every(
      (violation) => violation.table === 'ProjectPreviewState' && violation.parent === 'Project'
    )
  )
}

const applyBaselineMigration = async (
  client: PrismaClient,
  migration: MigrationManifestEntry,
  deferPreviewStateForeignKeyViolations: boolean,
  allowedSuffixChecks: AllowedSuffixCheckConstraints,
  canAdoptCurrentSchema: boolean,
  legacySchemaExtensions: Parameters<typeof prepareRuntimeSchemaBaseline>[1] = {}
): Promise<void> => {
  let prepared: Awaited<ReturnType<typeof prepareRuntimeSchemaBaseline>>
  try {
    prepared = await prepareRuntimeSchemaBaseline(client, legacySchemaExtensions)
  } catch (error) {
    throw classifyDatabaseFailure(error, 'validation', migration.id)
  }
  if (prepared.verificationTarget === 'current' && !canAdoptCurrentSchema) {
    throw classifyDatabaseFailure(
      new Error('Current schema adoption requires its versioned migration manifest.'),
      'validation',
      migration.id
    )
  }
  const disableForeignKeys = prepared.pendingCheckConstraints.length > 0
  let foreignKeysWereEnabled = false
  let migrationFailure: unknown
  try {
    foreignKeysWereEnabled = disableForeignKeys && (await readForeignKeyState(client)) === 1
    if (foreignKeysWereEnabled) await setForeignKeys(client, false)
    await client.$transaction(async (transaction) => {
      const transactionClient = transaction as unknown as PrismaClient
      try {
        await applyRuntimeSchemaBaseline(transactionClient, prepared)
      } catch (error) {
        if (
          !deferPreviewStateForeignKeyViolations ||
          !(await hasOnlyDeferredPreviewStateForeignKeyViolations(transactionClient, error))
        ) {
          throw error
        }
        // The pinned 0005 suffix owns pruning these rows before the migration run completes.
      }
      if (prepared.verificationTarget === 'baseline') {
        await runMigrationVerifiers(transactionClient, migration.verifiers, allowedSuffixChecks)
      }
      await insertLedgerRow(transactionClient, migration)
    })
  } catch (error) {
    migrationFailure = error
  }

  let restoreFailure: unknown
  try {
    if (foreignKeysWereEnabled) await setForeignKeys(client, true)
  } catch (error) {
    restoreFailure = error
  }

  if (migrationFailure && restoreFailure) {
    throw classifyDatabaseFailure(
      new AggregateError(
        [migrationFailure, restoreFailure],
        `Database migration failed and foreign-key enforcement could not be restored: ${migrationFailure instanceof Error ? migrationFailure.message : String(migrationFailure)}`
      ),
      'migration',
      migration.id
    )
  }
  if (migrationFailure) {
    throw classifyDatabaseFailure(migrationFailure, 'migration', migration.id)
  }
  if (restoreFailure) throw classifyDatabaseFailure(restoreFailure, 'migration', migration.id)
}

const applyManifestMigration = async (
  client: PrismaClient,
  migration: MigrationManifestEntry,
  options: {
    repairVisionEvidenceReference?: boolean
  } = {}
): Promise<void> => {
  const preserveCurrentSchema = await hasCurrentManagedFileVersionFoundation(client)
  const canAdaptCurrentSchema =
    preserveCurrentSchema &&
    migration.id !== managedFileVersionFoundationMigration.id &&
    migration.id < managedFileVersionFoundationMigration.id &&
    MIGRATION_MANIFEST.some(
      (candidate) => candidate.id === migration.id && candidate.checksum === migration.checksum
    )
  const canVerifyAsCurrentSchema = canAdaptCurrentSchema
  const adapted = canAdaptCurrentSchema
    ? await adaptMigrationOperationsForCurrentSchema(client, migration.operations ?? [])
    : { operations: migration.operations ?? [], currentTableNames: [] }
  const currentTableNames = new Set(adapted.currentTableNames)
  const verifyMigrationTarget = async (targetClient: PrismaClient): Promise<void> => {
    if (!canVerifyAsCurrentSchema) {
      await runMigrationVerifiers(targetClient, migration.verifiers)
      return
    }
    await verifyCurrentRuntimeSchemaTables(targetClient, adapted.currentTableNames)
    await runMigrationVerifiers(targetClient, migration.verifiers, {}, currentTableNames)
    if (migration.id === projectPreviewStateOwnerFkMigration.id) {
      await runMigrationVerifiers(targetClient, migration.verifiers)
    }
  }
  const disableForeignKeys =
    migration.foreignKeysDuringApply === 'disabled' ||
    (canAdaptCurrentSchema && (migration.operations?.length ?? 0) > 0)
  let foreignKeysWereEnabled = false
  let migrationFailure: unknown
  try {
    foreignKeysWereEnabled = disableForeignKeys && (await readForeignKeyState(client)) === 1
    if (foreignKeysWereEnabled) await setForeignKeys(client, false)
    await client.$transaction(async (transaction) => {
      const transactionClient = transaction as unknown as PrismaClient
      // A pre-ledger build may already have emitted the current generated schema. When this
      // migration's complete verifier contract is already satisfied, adopt its immutable ledger
      // identity without replaying non-idempotent SQLite ALTER TABLE statements.
      let contractAlreadySatisfied = false
      try {
        await verifyMigrationTarget(transactionClient)
        contractAlreadySatisfied = true
      } catch {
        // The migration statements below own bringing this schema suffix into compliance.
      }
      if (
        contractAlreadySatisfied &&
        migration.id === managedFileVersionFoundationMigration.id &&
        migration.checksum === MANAGED_FILE_VERSION_FOUNDATION_CHECKSUM
      ) {
        for (const statement of managedFileVersionFoundationCurrentSchemaAdoptionStatements) {
          await migrationSqlExecutor.execute(transaction, statement)
        }
      }
      if (!contractAlreadySatisfied) {
        if (canVerifyAsCurrentSchema && migration.id === projectPreviewStateOwnerFkMigration.id) {
          await migrationSqlExecutor.execute(
            transaction,
            `DELETE FROM "ProjectPreviewState"
             WHERE NOT EXISTS (
               SELECT 1 FROM "Project" WHERE "Project"."id" = "ProjectPreviewState"."projectId"
             )`
          )
        } else {
          for (const statement of migration.statements) {
            await migrationSqlExecutor.execute(transaction, statement)
          }
        }
        await applySqliteMigrationOperations(transactionClient, adapted.operations)
      }
      if (options.repairVisionEvidenceReference && !contractAlreadySatisfied) {
        // The upstream history created VisionEvidence before this immutable migration. Rebuild it
        // after UploadVersion so SQLite does not retain the temporary rename as its FK target.
        await applySqliteMigrationOperations(transactionClient, visionEvidenceMigration.operations)
      }
      try {
        await verifyMigrationTarget(transactionClient)
      } catch (error) {
        throw new DatabaseMigrationError(
          'database_validation_failed',
          'The existing database does not satisfy the required schema contract.',
          false,
          migration.id,
          { cause: error }
        )
      }
      await insertLedgerRow(transactionClient, migration)
    })
  } catch (error) {
    migrationFailure = error
  }

  let restoreFailure: unknown
  try {
    if (foreignKeysWereEnabled) await setForeignKeys(client, true)
  } catch (error) {
    restoreFailure = error
  }

  if (migrationFailure && restoreFailure) {
    throw classifyDatabaseFailure(
      new AggregateError(
        [migrationFailure, restoreFailure],
        `Database migration failed and foreign-key enforcement could not be restored: ${migrationFailure instanceof Error ? migrationFailure.message : String(migrationFailure)}`
      ),
      'migration',
      migration.id
    )
  }
  if (migrationFailure) throw classifyDatabaseFailure(migrationFailure, 'migration', migration.id)
  if (restoreFailure) throw classifyDatabaseFailure(restoreFailure, 'migration', migration.id)
}

const reportDatabaseCompatibility = async (
  client: PrismaClient,
  options: SchemaMigrationOptions
): Promise<void> => {
  let rows: Array<{ sqliteVersion: string }>
  try {
    rows = await client.$queryRaw<Array<{ sqliteVersion: string }>>`
      SELECT sqlite_version() AS "sqliteVersion"
    `
  } catch (error) {
    throw classifyDatabaseFailure(error, 'open')
  }
  const sqliteVersion = rows[0]?.sqliteVersion
  if (!/^\d+\.\d+\.\d+$/.test(sqliteVersion ?? '')) {
    throw new DatabaseMigrationError(
      'database_runtime_unavailable',
      'This installation returned an unsupported SQLite runtime version.',
      false
    )
  }
  try {
    options.onCompatibilityVerified?.({ sqliteVersion })
  } catch {
    // A diagnostic sink failure must not invalidate an already verified database.
  }
}

const migrateApplicationDatabaseWithManifest = async (
  client: PrismaClient,
  manifest: readonly MigrationManifestEntry[],
  options: SchemaMigrationOptions = {}
): Promise<SchemaMigrationResult> => {
  options.onProgress?.({ phase: 'checking' })
  let ledger: LedgerRow[]
  try {
    ledger = await readLedger(client)
  } catch (error) {
    throw classifyDatabaseFailure(error, 'open')
  }
  validateLedger([], manifest)
  const adoptsManagedFileVersionFoundation = manifest.some(
    (migration) =>
      migration.id === managedFileVersionFoundationMigration.id &&
      migration.checksum === MANAGED_FILE_VERSION_FOUNDATION_CHECKSUM
  )
  const from = ledger.at(-1)?.id ?? null
  const latest = manifest.at(-1)!
  const complete = async (result: SchemaMigrationResult): Promise<SchemaMigrationResult> => {
    try {
      await verifyCurrentApplicationSchema(client)
      if (adoptsManagedFileVersionFoundation) {
        await verifyManagedFileVersionDomain(client)
      }
    } catch (error) {
      throw classifyDatabaseFailure(error, 'validation', latest.id)
    }
    await reportDatabaseCompatibility(client, options)
    await retireDatabaseMigrationBackups(client, manifest, options, {
      throughMigrationId: latest.id,
      includeDeleteAfterSuccess: true
    })
    try {
      options.onCompleted?.(result)
    } catch {
      // A diagnostic sink failure must not invalidate a completed migration.
    }
    return result
  }

  let hadApplicationTablesAtStart: boolean | undefined
  const readHadApplicationTablesAtStart = async (): Promise<boolean> => {
    if (hadApplicationTablesAtStart !== undefined) return hadApplicationTablesAtStart
    try {
      hadApplicationTablesAtStart = await hasApplicationTables(client)
      return hadApplicationTablesAtStart
    } catch (error) {
      throw classifyDatabaseFailure(error, 'open')
    }
  }

  // ponytail: one snapshot per invocation bounds upgrade I/O; add explicit checkpoints only if
  // recovery replay from the batch start is measured to be too slow.
  let migrationBatchBackedUp = false
  const ensureBackupBeforeMigration = async (migration: MigrationManifestEntry): Promise<void> => {
    if (migrationBatchBackedUp || migration.backupOnApply !== 'required') return
    const migrationId = migration.id
    if (!(await readHadApplicationTablesAtStart())) return
    let backup: DatabaseMigrationBackup
    try {
      const databasePath = options.databasePath ?? (await readMainDatabasePath(client))
      if (!databasePath) {
        throw new Error('A database path is required before this migration can create its backup.')
      }
      backup = await createDatabaseMigrationBackup(client, databasePath, migrationId)
    } catch (error) {
      throw classifyDatabaseFailure(error, 'migration', migrationId)
    }
    try {
      options.onBackupReady?.(backup)
    } catch {
      // A diagnostic sink failure must not invalidate a durable database backup.
    }
    await retireDatabaseMigrationBackups(client, manifest, options, {
      throughMigrationId: migrationId,
      includeDeleteAfterSuccess: false
    })
    migrationBatchBackedUp = true
  }

  const applied: string[] = []
  const appliedCount = validateLedger(ledger, manifest)
  if (appliedCount === manifest.length) {
    return complete({ adoptedLegacy: false, applied, from, to: latest.id })
  }

  const hasExistingApplicationTables = await readHadApplicationTablesAtStart()
  const repairsPreviewStateForeignKeyViolations = manifest.some(
    (candidate) =>
      candidate.id === projectPreviewStateOwnerFkMigration.id &&
      candidate.checksum === PROJECT_PREVIEW_STATE_OWNER_FK_CHECKSUM
  )
  const adoptsDatabaseDomainConstraints = manifest.some(
    (candidate) =>
      candidate.id === databaseDomainConstraintsMigration.id &&
      candidate.checksum === DATABASE_DOMAIN_CONSTRAINTS_CHECKSUM
  )
  const adoptsNotificationAttentionMetadata = manifest.some(
    (candidate) =>
      candidate.id === notificationAttentionMetadataMigration.id &&
      candidate.checksum === NOTIFICATION_ATTENTION_METADATA_CHECKSUM
  )
  const adoptsDatabaseJsonConstraints = manifest.some(
    (candidate) =>
      candidate.id === databaseJsonConstraintsMigration.id &&
      candidate.checksum === DATABASE_JSON_CONSTRAINTS_CHECKSUM
  )
  const adoptsVisionEvidence = manifest.some(
    (candidate) =>
      candidate.id === visionEvidenceMigration.id && candidate.checksum === VISION_EVIDENCE_CHECKSUM
  )
  const adoptsComputePasswordAuth = manifest.some(
    (candidate) =>
      candidate.id === computePasswordAuthMigration.id &&
      candidate.checksum === COMPUTE_PASSWORD_AUTH_CHECKSUM
  )
  const adoptsCrossResourceTags = manifest.some(
    (candidate) =>
      candidate.id === crossResourceTagsMigration.id &&
      candidate.checksum === CROSS_RESOURCE_TAGS_CHECKSUM
  )
  const adoptsAgentMemoryProjectScope = manifest.some(
    (candidate) =>
      candidate.id === agentMemoryProjectScopeMigration.id &&
      candidate.checksum === AGENT_MEMORY_PROJECT_SCOPE_CHECKSUM
  )
  const adoptsSessionAuxiliaryTurnUsage = manifest.some(
    (candidate) =>
      candidate.id === sessionAuxiliaryTurnUsageMigration.id &&
      candidate.checksum === SESSION_AUXILIARY_TURN_USAGE_CHECKSUM
  )
  const adoptsComputeJobOperation = manifest.some(
    (candidate) =>
      candidate.id === computeJobOperationMigration.id &&
      candidate.checksum === COMPUTE_JOB_OPERATION_CHECKSUM
  )
  const adoptsComputeJobFileEvidence = manifest.some(
    (candidate) =>
      candidate.id === computeJobFileEvidenceMigration.id &&
      candidate.checksum === COMPUTE_JOB_FILE_EVIDENCE_CHECKSUM
  )
  const adoptedLegacy = appliedCount === 0 && hasExistingApplicationTables
  const allowedSuffixChecks = mergeAllowedSuffixChecks(
    adoptsDatabaseDomainConstraints ? DATABASE_DOMAIN_ALLOWED_SUFFIX_CHECKS : {},
    adoptsNotificationAttentionMetadata ? NOTIFICATION_ATTENTION_ALLOWED_SUFFIX_CHECKS : {},
    adoptsDatabaseJsonConstraints ? DATABASE_JSON_ALLOWED_SUFFIX_CHECKS : {},
    adoptsVisionEvidence ? VISION_EVIDENCE_ALLOWED_SUFFIX_CHECKS : {},
    adoptsComputePasswordAuth ? COMPUTE_PASSWORD_AUTH_ALLOWED_SUFFIX_CHECKS : {},
    adoptsCrossResourceTags ? CROSS_RESOURCE_TAGS_ALLOWED_SUFFIX_CHECKS : {},
    adoptsAgentMemoryProjectScope ? AGENT_MEMORY_PROJECT_SCOPE_ALLOWED_SUFFIX_CHECKS : {},
    adoptsSessionAuxiliaryTurnUsage ? SESSION_AUXILIARY_TURN_USAGE_ALLOWED_SUFFIX_CHECKS : {},
    adoptsComputeJobOperation ? COMPUTE_JOB_OPERATION_ALLOWED_SUFFIX_CHECKS : {}
  )

  let nextIndex = appliedCount
  if (nextIndex === 0) {
    const baseline = manifest[0]!
    options.onProgress?.({ phase: 'migrating', migrationId: baseline.id })
    await ensureBackupBeforeMigration(baseline)
    await applyBaselineMigration(
      client,
      baseline,
      repairsPreviewStateForeignKeyViolations,
      allowedSuffixChecks,
      adoptsManagedFileVersionFoundation,
      {
        ...(adoptsAgentMemoryProjectScope
          ? {
              tableNames: MEMORY_AUXILIARY_TABLE_NAMES,
              schemaObjects: MEMORY_AUXILIARY_SCHEMA_OBJECTS.flatMap(({ type, name }) =>
                type === 'trigger' ? [{ type, name }] : []
              )
            }
          : {}),
        ...(adoptsComputeJobFileEvidence
          ? { columns: { ComputeJob: ['producerRunId', 'fileEvidence'] } }
          : {})
      }
    )
    applied.push(baseline.id)
    nextIndex = 1
  }

  for (const migration of manifest.slice(nextIndex)) {
    options.onProgress?.({ phase: 'migrating', migrationId: migration.id })
    await ensureBackupBeforeMigration(migration)
    await applyManifestMigration(client, migration, {
      repairVisionEvidenceReference:
        migration.id === managedFileVersionFoundationMigration.id &&
        migration.checksum === MANAGED_FILE_VERSION_FOUNDATION_CHECKSUM
    })
    applied.push(migration.id)
  }

  return complete({ adoptedLegacy, applied, from, to: latest.id })
}

const migrateApplicationDatabase = (
  client: PrismaClient,
  options: SchemaMigrationOptions = {}
): Promise<SchemaMigrationResult> =>
  migrateApplicationDatabaseWithManifest(client, MIGRATION_MANIFEST, options)

export {
  BASELINE_CHECKSUM,
  PROJECT_AGENT_CONTEXT_CHECKSUM,
  DATABASE_DOMAIN_CONSTRAINTS_CHECKSUM,
  NOTIFICATION_ATTENTION_METADATA_CHECKSUM,
  DATABASE_JSON_CONSTRAINTS_CHECKSUM,
  MANAGED_FILE_VERSION_FOUNDATION_CHECKSUM,
  VISION_EVIDENCE_CHECKSUM,
  COMPUTE_PASSWORD_AUTH_CHECKSUM,
  TAG_ORDERING_CHECKSUM,
  COMPUTE_JOB_OPERATION_CHECKSUM,
  REVIEW_QUERY_INDEXES_CHECKSUM,
  AGENT_MEMORY_PROJECT_SCOPE_CHECKSUM,
  COMPUTE_JOB_ANALYSIS_CONSTRAINTS_CHECKSUM,
  MEMORY_GLOBAL_CONTENT_UNIQUE_CHECKSUM,
  DatabaseMigrationError,
  checksumMigrationPayload,
  classifyDatabaseFailure,
  migrateApplicationDatabase,
  migrateApplicationDatabaseWithManifest,
  verifyCurrentApplicationSchema,
  MIGRATION_MANIFEST
}
export type {
  DatabaseCompatibility,
  DatabaseMigrationBackup,
  DatabaseMigrationBackupRetirement,
  DatabaseMigrationErrorCode,
  MigrationManifestEntry,
  MigrationVerifierDescriptor,
  MigrationVerifiers,
  SchemaMigrationOptions,
  SchemaMigrationProgress,
  SchemaMigrationResult
}
