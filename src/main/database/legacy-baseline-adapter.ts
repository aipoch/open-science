import { Prisma, type PrismaClient } from '@prisma/client'

import {
  RUNTIME_SCHEMA_TABLES as CURRENT_RUNTIME_SCHEMA_TABLES,
  RUNTIME_SCHEMA_TARGET_SQL as CURRENT_RUNTIME_SCHEMA_TARGET_SQL
} from './generated/runtime-schema'
import {
  RUNTIME_SCHEMA_BASELINE_CONTRACT,
  RUNTIME_SCHEMA_INDEX_DDLS,
  RUNTIME_SCHEMA_LEGACY_CHECK_REBUILDS,
  RUNTIME_SCHEMA_TABLES,
  RUNTIME_SCHEMA_TABLE_DDLS,
  RUNTIME_SCHEMA_TABLE_DDL_BY_NAME,
  RUNTIME_SCHEMA_TARGET_SQL
} from './migrations/0001-runtime-schema-baseline'
import {
  applySqliteCheckConstraints,
  findPendingSqliteCheckConstraints,
  type SqliteCheckConstraintMigration
} from './sqlite-schema-migrations'
import { DatabaseValidationError } from './database-validation-error'
import { migrationSqlExecutor } from './migration-sql-executor'

// schema-locality: begin frozen-0001-repairs
// Frozen legacy repair routes into the generated 0001 target. New schema changes must add a
// versioned migration instead of extending this list.
const REVIEW_ADD_REVIEWER_LOG_DDL = `ALTER TABLE "Review" ADD COLUMN "reviewerLog" TEXT NOT NULL DEFAULT '[]'`
const FINDING_ADD_STATUS_COLUMN_DDL = `ALTER TABLE "Finding" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pass'`
const FINDING_ADD_REFLAG_COUNT_DDL = `ALTER TABLE "Finding" ADD COLUMN "reflagCount" INTEGER NOT NULL DEFAULT 0`
const FINDING_ADD_ARTIFACT_BINDING_STATE_DDL = `ALTER TABLE "Finding" ADD COLUMN "artifactBindingState" TEXT NOT NULL DEFAULT 'legacy_unverified'`
const PROJECT_ADD_ARCHIVED_AT_DDL = `ALTER TABLE "Project" ADD COLUMN "archivedAt" DATETIME`
const PROJECT_ADD_PINNED_DDL = `ALTER TABLE "Project" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false`
const MANAGED_FILE_ADD_SOURCE_VERSION_ID_DDL = `ALTER TABLE "ManagedFile" ADD COLUMN "sourceVersionId" TEXT`
const MANAGED_FILE_ADD_CHECKSUM_DDL = `ALTER TABLE "ManagedFile" ADD COLUMN "checksum" TEXT`
const ARTIFACT_MESSAGE_SNAPSHOT_ADD_CHECKSUM_DDL = `ALTER TABLE "ArtifactMessageSnapshot" ADD COLUMN "checksum" TEXT NOT NULL DEFAULT '';`
const ARTIFACT_VERSION_ADD_FILENAME_DDL = `ALTER TABLE "ArtifactVersion" ADD COLUMN "filename" TEXT`
const COMPUTE_JOB_ADD_LAST_POLL_ERROR_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "lastPollError" TEXT`
const COMPUTE_JOB_ADD_HARVEST_ERROR_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "harvestError" TEXT`
const COMPUTE_JOB_ADD_LEFT_ON_REMOTE_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "leftOnRemote" TEXT`
const COMPUTE_JOB_ADD_NOTIFIED_AT_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "notifiedAt" DATETIME`
const COMPUTE_JOB_ADD_NOTIFICATION_CONSUMED_AT_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "notificationConsumedAt" DATETIME`
// schema-locality: end frozen-0001-repairs

const RUNTIME_SCHEMA_BASELINE_TABLES = RUNTIME_SCHEMA_TABLES
const RUNTIME_SCHEMA_BASELINE_TARGET_SQL = RUNTIME_SCHEMA_TARGET_SQL

const PROVENANCE_CHECK_CONSTRAINT_MIGRATIONS: readonly SqliteCheckConstraintMigration[] =
  RUNTIME_SCHEMA_LEGACY_CHECK_REBUILDS.map((migration) => ({
    ...migration,
    canonicalTableDdl: RUNTIME_SCHEMA_TABLE_DDL_BY_NAME[migration.tableName]
  }))

const RETIRED_LEGACY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Review: ['summary', 'checks', 'reasoning'],
  Finding: ['severity']
}

const CURRENT_TABLE_COLUMNS = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.dbName ?? model.name,
    new Set(
      model.fields
        .filter((field) => field.kind !== 'object')
        .map((field) => field.dbName ?? field.name)
    )
  ])
)

type TargetColumn = {
  name: string
  type: string
  notNull: boolean
  defaultValue: string | null
  primaryKeyOrder: number
  autoIncrement: boolean
}
type TargetForeignKey = {
  name: string
  columns: readonly string[]
  targetColumns: readonly string[]
  targetTable: string
  onDelete: string
  onUpdate: string
}
type TargetTable = {
  columns: ReadonlyMap<string, TargetColumn>
  checks: ReadonlyMap<string, string>
  foreignKeys: readonly TargetForeignKey[]
  unsupportedDefinitions: readonly string[]
}
type TargetIndex = {
  name: string
  tableName: string
  columns: readonly string[]
  unique: boolean
}
type AllowedSuffixCheckConstraints = Readonly<Record<string, Readonly<Record<string, string>>>>

const splitSqlDefinitions = (ddl: string): string[] => {
  const open = ddl.indexOf('(')
  const close = ddl.lastIndexOf(')')
  if (open === -1 || close <= open) return []

  const definitions: string[] = []
  let current = ''
  let depth = 0
  let quote: '"' | "'" | undefined
  const body = ddl.slice(open + 1, close)
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    current += char
    if (quote) {
      if (char !== quote) continue
      if (body[index + 1] === quote) {
        current += body[index + 1]
        index += 1
      } else {
        quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      definitions.push(current.slice(0, -1).trim())
      current = ''
    }
  }
  if (current.trim()) definitions.push(current.trim())
  return definitions
}

const readQuotedIdentifiers = (value: string): string[] =>
  [...value.matchAll(/"((?:[^"]|"")+)"/g)].map((match) => match[1]!.replaceAll('""', '"'))

const hasRedundantOuterParentheses = (value: string): boolean => {
  if (value[0] !== '(' || value.at(-1) !== ')') return false

  let depth = 0
  let quote: '"' | "'" | undefined
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!
    if (quote) {
      if (char !== quote) continue
      if (value[index + 1] === quote) index += 1
      else quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1

    if (depth === 0 && index < value.length - 1) return false
    if (depth < 0) return false
  }
  return depth === 0 && quote === undefined
}

const stripRedundantOuterParentheses = (value: string): string => {
  let normalized = value
  while (hasRedundantOuterParentheses(normalized)) normalized = normalized.slice(1, -1).trim()
  return normalized
}

const normalizeSqlFragment = (value: string | null): string | null => {
  if (value === null) return null
  const literals: string[] = []
  const protectedValue = value.replaceAll(/'(?:''|[^'])*'/g, (literal) => {
    const token = `__open_science_sql_literal_${literals.length}__`
    literals.push(literal)
    return token
  })
  let normalized = protectedValue
    .trim()
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/\s*([(),=<>])\s*/g, '$1')
    .toLowerCase()
  normalized = stripRedundantOuterParentheses(normalized)
  literals.forEach((literal, index) => {
    normalized = normalized.replace(`__open_science_sql_literal_${index}__`, literal)
  })
  return normalized
}

type KnownEquivalentCheckExpression = {
  actual: string
  expected: string
}

// Pre-ledger runtime DDL sometimes emitted an equivalent boolean expression in a different order.
// Pair each accepted legacy form with the exact frozen target so a future contract change still fails
// closed instead of inheriting this compatibility allowance.
const KNOWN_EQUIVALENT_CHECK_EXPRESSIONS: ReadonlyMap<
  string,
  readonly KnownEquivalentCheckExpression[]
> = new Map([
  [
    'ArtifactVersionInput.ArtifactVersionInput_sourceIdentity_check',
    [
      {
        actual: normalizeSqlFragment(`
          ("sourceKind" = 'artifact-version' AND "sourceArtifactVersionId" IS NOT NULL AND "sourceUploadVersionId" IS NULL AND "inputFileVersionId" = "sourceArtifactVersionId") OR
          ("sourceKind" = 'upload-version' AND "sourceUploadVersionId" IS NOT NULL AND "sourceArtifactVersionId" IS NULL AND "inputFileVersionId" = "sourceUploadVersionId")
        `)!,
        expected: normalizeSqlFragment(`
          (("sourceKind" = 'artifact-version' AND "sourceArtifactVersionId" IS NOT NULL AND "sourceUploadVersionId" IS NULL AND "inputFileVersionId" = "sourceArtifactVersionId") OR
          ("sourceKind" = 'upload-version' AND "sourceArtifactVersionId" IS NULL AND "sourceUploadVersionId" IS NOT NULL AND "inputFileVersionId" = "sourceUploadVersionId"))
        `)!
      }
    ]
  ]
])

const checkExpressionsMatch = (
  tableName: string,
  constraintName: string,
  actual: string | undefined,
  expected: string
): boolean => {
  if (actual === expected) return true
  return Boolean(
    actual &&
    KNOWN_EQUIVALENT_CHECK_EXPRESSIONS.get(`${tableName}.${constraintName}`)?.some(
      (equivalent) => equivalent.actual === actual && equivalent.expected === expected
    )
  )
}

const parseTargetTable = (ddl: string): readonly [string, TargetTable] | undefined => {
  const tableName = ddl.match(/CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/i)?.[1]
  if (!tableName) return undefined

  const definitions = splitSqlDefinitions(ddl)
  const columns = new Map<string, TargetColumn>()
  const checks = new Map<string, string>()
  const foreignKeys: TargetForeignKey[] = []
  const unsupportedDefinitions: string[] = []
  let compositePrimaryKey: readonly string[] = []
  const closingParenthesis = ddl.lastIndexOf(')')
  const tableOptions = ddl
    .slice(closingParenthesis + 1)
    .replace(/;\s*$/, '')
    .trim()
  if (tableOptions) unsupportedDefinitions.push(tableOptions)

  for (const definition of definitions) {
    const column = definition.match(/^"([^"]+)"\s+([A-Z]+)([\s\S]*)$/i)
    if (column) {
      const remainder = column[3]!
      const defaultClause = remainder.match(
        /\bDEFAULT\s+(.+?)(?=\s+(?:NOT\s+NULL|PRIMARY\s+KEY|AUTOINCREMENT|UNIQUE|CHECK|REFERENCES|COLLATE|GENERATED|CONSTRAINT)\b|$)/i
      )
      const defaultValue = defaultClause?.[1] ?? null
      columns.set(column[1]!, {
        name: column[1]!,
        type: column[2]!.toUpperCase(),
        notNull: /\bNOT NULL\b/i.test(remainder),
        defaultValue: normalizeSqlFragment(defaultValue),
        primaryKeyOrder: /\bPRIMARY KEY\b/i.test(remainder) ? 1 : 0,
        autoIncrement: /\bAUTOINCREMENT\b/i.test(remainder)
      })
      const unconsumed = remainder
        .replace(defaultClause?.[0] ?? '', '')
        .replace(/\bNOT\s+NULL\b|\bPRIMARY\s+KEY\b|\bAUTOINCREMENT\b/gi, '')
        .trim()
      if (unconsumed) {
        unsupportedDefinitions.push(definition)
      }
      continue
    }

    const primaryKey = definition.match(/^PRIMARY KEY\s*\(([^)]+)\)$/i)
    if (primaryKey) {
      const identifiers = primaryKey[1]!
      const unconsumed = identifiers.replace(/"(?:[^"]|"")*"/g, '').replace(/[\s,]/g, '')
      if (unconsumed) unsupportedDefinitions.push(definition)
      else compositePrimaryKey = readQuotedIdentifiers(identifiers)
      continue
    }

    const check = definition.match(/^CONSTRAINT "([^"]+)"\s+CHECK\s*\(([\s\S]*)\)$/i)
    if (check) {
      checks.set(check[1]!, normalizeSqlFragment(check[2]!)!)
      continue
    }

    const foreignKey = definition.match(
      /^CONSTRAINT "([^"]+)"\s+FOREIGN KEY\s*\(([^)]+)\)\s+REFERENCES\s+"([^"]+)"\s*\(([^)]+)\)\s+ON DELETE\s+([A-Z ]+?)\s+ON UPDATE\s+([A-Z ]+)$/i
    )
    if (foreignKey) {
      foreignKeys.push({
        name: foreignKey[1]!,
        columns: readQuotedIdentifiers(foreignKey[2]!),
        targetTable: foreignKey[3]!,
        targetColumns: readQuotedIdentifiers(foreignKey[4]!),
        onDelete: foreignKey[5]!.trim().toUpperCase(),
        onUpdate: foreignKey[6]!.trim().toUpperCase()
      })
      continue
    }

    unsupportedDefinitions.push(definition)
  }

  compositePrimaryKey.forEach((columnName, index) => {
    const column = columns.get(columnName)
    if (column) columns.set(columnName, { ...column, primaryKeyOrder: index + 1 })
  })
  return [tableName, { columns, checks, foreignKeys, unsupportedDefinitions }]
}

const createTargetTables = (statements: readonly string[]): ReadonlyMap<string, TargetTable> =>
  new Map(
    statements.flatMap((statement) => {
      const parsed = parseTargetTable(statement)
      return parsed ? [parsed] : []
    })
  )

const createTargetIndexes = (statements: readonly string[]): ReadonlyMap<string, TargetIndex> =>
  new Map(
    statements.flatMap((statement) => {
      const match = statement.match(
        /^CREATE (UNIQUE )?INDEX IF NOT EXISTS "([^"]+)" ON "([^"]+)"\s*\(([^)]+)\)/i
      )
      if (!match) return []
      const index: TargetIndex = {
        name: match[2]!,
        tableName: match[3]!,
        columns: readQuotedIdentifiers(match[4]!),
        unique: Boolean(match[1])
      }
      return [[index.name, index] as const]
    })
  )

const TARGET_TABLES = createTargetTables(RUNTIME_SCHEMA_BASELINE_TARGET_SQL)
const TARGET_INDEXES = createTargetIndexes(RUNTIME_SCHEMA_BASELINE_TARGET_SQL)
const CURRENT_TARGET_TABLES = createTargetTables(CURRENT_RUNTIME_SCHEMA_TARGET_SQL)
const CURRENT_TARGET_INDEXES = createTargetIndexes(CURRENT_RUNTIME_SCHEMA_TARGET_SQL)
// Non-exact baseline adoption may recognize only released suffix FKs named here. Do not derive this
// list from the generated current target: doing so would silently admit every future suffix FK.
const NON_EXACT_BASELINE_FOREIGN_KEY_ALLOWLIST: ReadonlyMap<string, readonly TargetForeignKey[]> =
  new Map([
    [
      'ProjectPreviewState',
      [
        {
          name: 'ProjectPreviewState_projectId_fkey',
          columns: ['projectId'],
          targetColumns: ['id'],
          targetTable: 'Project',
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        }
      ]
    ]
  ])
// Post-baseline migrations can add indexes (e.g. 0003's GrantedLocalRoot_path_key), so a pre-ledger
// database carrying them must still classify: known indexes are the baseline ∪ current target union,
// mirroring the unknown-table check, which already classifies against the current target.
const TARGET_INDEX_NAMES = new Set([...TARGET_INDEXES.keys(), ...CURRENT_TARGET_INDEXES.keys()])

type RuntimeSchemaTarget = {
  tableNames: readonly string[]
  tables: ReadonlyMap<string, TargetTable>
  indexes: ReadonlyMap<string, TargetIndex>
}

type RuntimeSchemaExtensions = Readonly<{
  tableNames?: readonly string[]
  triggerNames?: readonly string[]
}>

const BASELINE_SCHEMA_TARGET: RuntimeSchemaTarget = {
  tableNames: RUNTIME_SCHEMA_BASELINE_TABLES,
  tables: TARGET_TABLES,
  indexes: TARGET_INDEXES
}
const CURRENT_SCHEMA_TARGET: RuntimeSchemaTarget = {
  tableNames: CURRENT_RUNTIME_SCHEMA_TABLES,
  tables: CURRENT_TARGET_TABLES,
  indexes: CURRENT_TARGET_INDEXES
}

type SqliteTableColumn = {
  name: string
  type: string
  notnull: bigint | number
  dflt_value: string | null
  pk: bigint | number
}
type SqliteSchemaName = { name: string }
type SqliteIndexListRow = { name: string; unique: bigint | number }
type SqliteIndexColumnRow = { seqno: bigint | number; name: string }
type SqliteForeignKeyRow = {
  id: bigint | number
  seq: bigint | number
  table: string
  from: string
  to: string
  on_update: string
  on_delete: string
}

const quoteSqliteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`

const hasTableColumn = async (
  client: PrismaClient,
  tableName: string,
  columnName: string
): Promise<boolean> => {
  const columns = await migrationSqlExecutor.query<SqliteTableColumn[]>(
    client,
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
    await migrationSqlExecutor.execute(client, ddl)
  } catch (error) {
    if (await hasTableColumn(client, tableName, columnName)) return
    throw error
  }
}

// Creates the schema if missing. Idempotent; no projects are seeded, so a fresh install starts empty.
type PreparedRuntimeSchemaBaseline = {
  pendingCheckConstraints: readonly SqliteCheckConstraintMigration[]
}

const classifyLegacySchema = async (client: PrismaClient): Promise<void> => {
  const unsupportedObjects = await migrationSqlExecutor.query<
    Array<{ name: string; type: string }>
  >(
    client,
    `SELECT "type", "name" FROM "sqlite_schema"
     WHERE "type" IN ('trigger', 'view') AND "name" NOT LIKE 'sqlite_%'
     ORDER BY "type", "name"`
  )
  if (unsupportedObjects.length > 0) {
    throw new DatabaseValidationError(
      `Legacy database classification blocked by unsupported schema objects.`,
      { kind: 'unsupported-schema-objects', actual: unsupportedObjects }
    )
  }

  const tables = await migrationSqlExecutor.query<SqliteSchemaName[]>(
    client,
    `SELECT "name" FROM "sqlite_schema"
     WHERE "type" = 'table'
       AND "name" NOT LIKE 'sqlite_%'
       AND "name" <> '_open_science_migrations'
     ORDER BY "name"`
  )
  const unknownTables = tables
    .map((table) => table.name)
    .filter((tableName) => !CURRENT_TABLE_COLUMNS.has(tableName))
  if (unknownTables.length > 0) {
    throw new DatabaseValidationError(`Legacy database classification found unknown tables.`, {
      kind: 'unknown-tables',
      actual: unknownTables
    })
  }

  for (const { name: tableName } of tables) {
    const currentColumns = CURRENT_TABLE_COLUMNS.get(tableName)!
    const allowedColumns = new Set([
      ...currentColumns,
      ...(RETIRED_LEGACY_COLUMNS[tableName] ?? [])
    ])
    const columns = await migrationSqlExecutor.query<SqliteTableColumn[]>(
      client,
      `PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`
    )
    const unknownColumns = columns
      .map((column) => column.name)
      .filter((columnName) => !allowedColumns.has(columnName))
    if (unknownColumns.length > 0) {
      throw new DatabaseValidationError(
        `Legacy database classification found unknown columns in ${tableName}.`,
        { kind: 'unknown-columns', table: tableName, actual: unknownColumns }
      )
    }
  }

  const indexes = await migrationSqlExecutor.query<SqliteSchemaName[]>(
    client,
    `SELECT "name" FROM "sqlite_schema"
     WHERE "type" = 'index' AND "name" NOT LIKE 'sqlite_autoindex_%'
     ORDER BY "name"`
  )
  const unknownIndexes = indexes
    .map((index) => index.name)
    .filter((indexName) => !TARGET_INDEX_NAMES.has(indexName))
  if (unknownIndexes.length > 0) {
    throw new DatabaseValidationError(`Legacy database classification found unknown indexes.`, {
      kind: 'unknown-indexes',
      actual: unknownIndexes
    })
  }
}

const columnDiagnostic = (column: SqliteTableColumn): Record<string, unknown> => ({
  type: column.type.toUpperCase(),
  notNull: Boolean(Number(column.notnull)),
  defaultValue: normalizeSqlFragment(column.dflt_value),
  primaryKeyOrder: Number(column.pk)
})

const targetColumnDiagnostic = (column: TargetColumn): Record<string, unknown> => ({
  type: column.type,
  notNull: column.notNull,
  defaultValue: column.defaultValue,
  primaryKeyOrder: column.primaryKeyOrder,
  autoIncrement: column.autoIncrement
})

const prepareRuntimeSchemaBaseline = async (
  client: PrismaClient
): Promise<PreparedRuntimeSchemaBaseline> => {
  await classifyLegacySchema(client)
  return {
    pendingCheckConstraints: await findPendingSqliteCheckConstraints(
      client,
      PROVENANCE_CHECK_CONSTRAINT_MIGRATIONS
    )
  }
}

const verifyRuntimeSchemaTarget = async (
  client: PrismaClient,
  target: RuntimeSchemaTarget,
  exact: boolean = false,
  allowedSuffixChecks: AllowedSuffixCheckConstraints = {},
  extensions: RuntimeSchemaExtensions = {}
): Promise<void> => {
  const tables = await migrationSqlExecutor.query<SqliteSchemaName[]>(
    client,
    `SELECT "name" FROM "sqlite_schema"
     WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'
       AND "name" <> '_open_science_migrations'
     ORDER BY "name"`
  )
  const actualTables = new Set(tables.map((table) => table.name))
  const expectedTables = new Set([...target.tableNames, ...(extensions.tableNames ?? [])])
  const missingTables = target.tableNames.filter((tableName) => !actualTables.has(tableName))
  if (missingTables.length > 0) {
    throw new DatabaseValidationError(`Database baseline verification found missing tables.`, {
      kind: 'missing-tables',
      expected: missingTables
    })
  }
  const unexpectedTables = exact
    ? [...actualTables].filter((tableName) => !expectedTables.has(tableName))
    : []
  if (unexpectedTables.length > 0) {
    throw new DatabaseValidationError(`Database baseline verification found unexpected tables.`, {
      kind: 'unexpected-tables',
      actual: unexpectedTables
    })
  }

  if (exact) {
    const triggers = await migrationSqlExecutor.query<SqliteSchemaName[]>(
      client,
      `SELECT "name" FROM "sqlite_schema" WHERE "type" = 'trigger' ORDER BY "name"`
    )
    const expectedTriggers = new Set(extensions.triggerNames ?? [])
    const unexpectedTriggers = triggers
      .map(({ name }) => name)
      .filter((name) => !expectedTriggers.has(name))
    if (unexpectedTriggers.length > 0) {
      throw new DatabaseValidationError(
        'Database baseline verification found unexpected triggers.',
        { kind: 'unexpected-triggers', actual: unexpectedTriggers }
      )
    }
  }

  const foreignKeyKey = (foreignKey: TargetForeignKey): string =>
    [
      foreignKey.name,
      foreignKey.columns.join(','),
      foreignKey.targetTable,
      foreignKey.targetColumns.join(','),
      foreignKey.onDelete,
      foreignKey.onUpdate
    ].join('|')
  const findUnmatchedOccurrences = (
    candidates: readonly string[],
    available: readonly string[]
  ): string[] => {
    const remaining = new Map<string, number>()
    for (const value of available) remaining.set(value, (remaining.get(value) ?? 0) + 1)

    return candidates.filter((candidate) => {
      const count = remaining.get(candidate) ?? 0
      if (count === 0) return true
      remaining.set(candidate, count - 1)
      return false
    })
  }

  for (const [tableName, expectedTable] of target.tables) {
    const columns = await migrationSqlExecutor.query<SqliteTableColumn[]>(
      client,
      `PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`
    )
    const actualColumns = new Map(columns.map((column) => [column.name, column]))
    const missingColumns = [...expectedTable.columns.keys()].filter(
      (columnName) => !actualColumns.has(columnName)
    )
    if (missingColumns.length > 0) {
      throw new DatabaseValidationError(
        `Database baseline verification found missing columns in ${tableName}.`,
        { kind: 'missing-columns', table: tableName, expected: missingColumns }
      )
    }
    const retiredColumns = new Set(RETIRED_LEGACY_COLUMNS[tableName] ?? [])
    const unexpectedColumns = exact
      ? [...actualColumns.keys()].filter(
          (columnName) => !expectedTable.columns.has(columnName) && !retiredColumns.has(columnName)
        )
      : []
    if (unexpectedColumns.length > 0) {
      throw new DatabaseValidationError(
        `Database baseline verification found unexpected columns in ${tableName}.`,
        { kind: 'unexpected-columns', table: tableName, actual: unexpectedColumns }
      )
    }

    for (const [columnName, expected] of expectedTable.columns) {
      const actual = actualColumns.get(columnName)!
      const actualDefault = normalizeSqlFragment(actual.dflt_value)
      if (
        actual.type.toUpperCase() !== expected.type ||
        Number(actual.notnull) !== Number(expected.notNull) ||
        actualDefault !== expected.defaultValue ||
        Number(actual.pk) !== expected.primaryKeyOrder
      ) {
        throw new DatabaseValidationError(
          `Database baseline verification found an incompatible column definition for ${tableName}.${columnName}.`,
          {
            kind: 'column-definition-mismatch',
            table: tableName,
            column: columnName,
            expected: targetColumnDiagnostic(expected),
            actual: columnDiagnostic(actual)
          }
        )
      }
    }

    const rows = await migrationSqlExecutor.query<Array<{ sql: string | null }>>(
      client,
      `SELECT "sql" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" = ?`,
      tableName
    )
    const actualTable = rows[0]?.sql ? parseTargetTable(rows[0].sql)?.[1] : undefined
    if (!actualTable) {
      throw new DatabaseValidationError(
        `Database baseline verification could not inspect constraints for ${tableName}.`,
        { kind: 'constraint-inspection-failed', table: tableName }
      )
    }
    if (actualTable.unsupportedDefinitions.length > 0) {
      throw new DatabaseValidationError(
        `Database baseline verification found unsupported constraints for ${tableName}.`,
        {
          kind: 'unsupported-constraints',
          table: tableName,
          actual: { count: actualTable.unsupportedDefinitions.length }
        }
      )
    }
    const incompatibleAutoIncrement = [...expectedTable.columns].find(
      ([columnName, expected]) =>
        actualTable.columns.get(columnName)?.autoIncrement !== expected.autoIncrement
    )
    if (incompatibleAutoIncrement) {
      const [columnName, expected] = incompatibleAutoIncrement
      throw new DatabaseValidationError(
        `Database baseline verification found an incompatible AUTOINCREMENT constraint for ${tableName}.${columnName}.`,
        {
          kind: 'autoincrement-mismatch',
          table: tableName,
          column: columnName,
          expected: expected.autoIncrement,
          actual: actualTable.columns.get(columnName)?.autoIncrement ?? null
        }
      )
    }
    const incompatibleCheck = [...expectedTable.checks.entries()].find(
      ([name, expression]) =>
        !checkExpressionsMatch(tableName, name, actualTable.checks.get(name), expression)
    )
    if (incompatibleCheck) {
      const [constraint, expected] = incompatibleCheck
      throw new DatabaseValidationError(
        `Database baseline verification found an incompatible CHECK constraint for ${tableName}.${constraint}.`,
        {
          kind: 'check-constraint-mismatch',
          table: tableName,
          constraint,
          expected,
          actual: actualTable.checks.get(constraint) ?? null
        }
      )
    }
    const allowedChecks = allowedSuffixChecks[tableName] ?? {}
    const incompatibleSuffixCheck = [...actualTable.checks].find(
      ([name, expression]) =>
        !expectedTable.checks.has(name) &&
        (!Object.hasOwn(allowedChecks, name) ||
          !checkExpressionsMatch(
            tableName,
            name,
            expression,
            normalizeSqlFragment(allowedChecks[name]!)!
          ))
    )
    if (incompatibleSuffixCheck) {
      throw new DatabaseValidationError(
        `Database baseline verification found an incompatible CHECK constraint set for ${tableName}.`,
        {
          kind: 'check-constraint-set-mismatch',
          table: tableName,
          expected: [...expectedTable.checks.keys(), ...Object.keys(allowedChecks)],
          actual: [...actualTable.checks.keys()]
        }
      )
    }
    const expectedForeignKeys = expectedTable.foreignKeys.map(foreignKeyKey).sort()
    // A pre-ledger database can already contain an explicitly released suffix FK. Require every
    // baseline FK, admit only the narrow allowlist above, and keep exact current verification.
    const allowedSuffixForeignKeys = exact
      ? []
      : (NON_EXACT_BASELINE_FOREIGN_KEY_ALLOWLIST.get(tableName) ?? [])
    const knownForeignKeys = [
      ...expectedForeignKeys,
      ...allowedSuffixForeignKeys.map(foreignKeyKey)
    ]
    const parsedForeignKeys = actualTable.foreignKeys.map(foreignKeyKey).sort()
    const missingForeignKeys = findUnmatchedOccurrences(expectedForeignKeys, parsedForeignKeys)
    const unknownForeignKeys = findUnmatchedOccurrences(parsedForeignKeys, knownForeignKeys)
    if (missingForeignKeys.length > 0 || unknownForeignKeys.length > 0) {
      throw new DatabaseValidationError(
        `Database baseline verification found incompatible foreign-key definitions for ${tableName}.`,
        {
          kind: 'foreign-key-definition-mismatch',
          table: tableName,
          expected: expectedForeignKeys,
          actual: parsedForeignKeys
        }
      )
    }

    const actualForeignKeyRows = await migrationSqlExecutor.query<SqliteForeignKeyRow[]>(
      client,
      `PRAGMA foreign_key_list(${quoteSqliteIdentifier(tableName)})`
    )
    const pragmaForeignKeys = actualForeignKeyRows
      .map(
        (row) =>
          `${row.from}|${row.table}|${row.to}|${row.on_delete.toUpperCase()}|${row.on_update.toUpperCase()}`
      )
      .sort()
    const pragmaForeignKeyKey = (
      foreignKey: TargetForeignKey,
      column: string,
      index: number
    ): string =>
      `${column}|${foreignKey.targetTable}|${foreignKey.targetColumns[index]}|${foreignKey.onDelete}|${foreignKey.onUpdate}`
    const targetPragmaForeignKeys = expectedTable.foreignKeys
      .flatMap((foreignKey) =>
        foreignKey.columns.map((column, index) => pragmaForeignKeyKey(foreignKey, column, index))
      )
      .sort()
    const knownPragmaForeignKeys = [
      ...targetPragmaForeignKeys,
      ...allowedSuffixForeignKeys.flatMap((foreignKey) =>
        foreignKey.columns.map((column, index) => pragmaForeignKeyKey(foreignKey, column, index))
      )
    ]
    const missingPragmaForeignKeys = findUnmatchedOccurrences(
      targetPragmaForeignKeys,
      pragmaForeignKeys
    )
    const unknownPragmaForeignKeys = findUnmatchedOccurrences(
      pragmaForeignKeys,
      knownPragmaForeignKeys
    )
    if (missingPragmaForeignKeys.length > 0 || unknownPragmaForeignKeys.length > 0) {
      throw new DatabaseValidationError(
        `Database baseline verification found incompatible foreign-key metadata for ${tableName}.`,
        {
          kind: 'foreign-key-metadata-mismatch',
          table: tableName,
          expected: targetPragmaForeignKeys,
          actual: pragmaForeignKeys
        }
      )
    }
  }

  for (const expected of target.indexes.values()) {
    const indexes = await migrationSqlExecutor.query<SqliteIndexListRow[]>(
      client,
      `PRAGMA index_list(${quoteSqliteIdentifier(expected.tableName)})`
    )
    const actualIndex = indexes.find((index) => index.name === expected.name)
    if (!actualIndex || Number(actualIndex.unique) !== Number(expected.unique)) {
      throw new DatabaseValidationError(
        `Database baseline verification found an incompatible index definition for ${expected.name}.`,
        {
          kind: 'index-definition-mismatch',
          table: expected.tableName,
          constraint: expected.name,
          expected: { unique: expected.unique, columns: expected.columns },
          actual: actualIndex ? { unique: Boolean(Number(actualIndex.unique)) } : null
        }
      )
    }
    const indexColumns = await migrationSqlExecutor.query<SqliteIndexColumnRow[]>(
      client,
      `PRAGMA index_info(${quoteSqliteIdentifier(expected.name)})`
    )
    const actualColumnNames = indexColumns
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((column) => column.name)
    if (actualColumnNames.join('\n') !== expected.columns.join('\n')) {
      throw new DatabaseValidationError(
        `Database baseline verification found incompatible index columns for ${expected.name}.`,
        {
          kind: 'index-column-mismatch',
          table: expected.tableName,
          constraint: expected.name,
          expected: expected.columns,
          actual: actualColumnNames
        }
      )
    }
  }
  if (exact) {
    const indexes = await migrationSqlExecutor.query<SqliteSchemaName[]>(
      client,
      `SELECT "name" FROM "sqlite_schema"
       WHERE "type" = 'index' AND "name" NOT LIKE 'sqlite_autoindex_%'
       ORDER BY "name"`
    )
    const expectedIndexes = new Set(target.indexes.keys())
    const unexpectedIndexes = indexes
      .map((index) => index.name)
      .filter((indexName) => !expectedIndexes.has(indexName))
    if (unexpectedIndexes.length > 0) {
      throw new DatabaseValidationError(
        `Database baseline verification found unexpected indexes.`,
        {
          kind: 'unexpected-indexes',
          actual: unexpectedIndexes
        }
      )
    }
  }

  const integrityRows = await migrationSqlExecutor.query<Array<{ integrity_check: string }>>(
    client,
    'PRAGMA integrity_check'
  )
  if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
    throw new DatabaseValidationError(
      'Database baseline verification failed SQLite integrity_check.',
      { kind: 'integrity-check-failed', actual: integrityRows }
    )
  }
}

const verifyRuntimeSchemaBaseline = (
  client: PrismaClient,
  allowedSuffixChecks: AllowedSuffixCheckConstraints = {}
): Promise<void> =>
  verifyRuntimeSchemaTarget(client, BASELINE_SCHEMA_TARGET, false, allowedSuffixChecks)

const normalizeSchemaObjectSql = (value: string | null): string | null =>
  normalizeSqlFragment(value)
    ?.replace(/\bif not exists\b/gu, '')
    .replaceAll(/\s+/gu, ' ') ?? null

const verifyCurrentRuntimeSchema = (
  client: PrismaClient,
  extensions: RuntimeSchemaExtensions = {}
): Promise<void> => verifyRuntimeSchemaTarget(client, CURRENT_SCHEMA_TARGET, true, {}, extensions)

const applyRuntimeSchemaBaseline = async (
  client: PrismaClient,
  prepared: PreparedRuntimeSchemaBaseline
): Promise<void> => {
  for (const ddl of RUNTIME_SCHEMA_TABLE_DDLS) {
    await migrationSqlExecutor.execute(client, ddl)
  }

  await addColumnIfMissing(client, 'Project', 'archivedAt', PROJECT_ADD_ARCHIVED_AT_DDL)
  await addColumnIfMissing(client, 'Project', 'pinned', PROJECT_ADD_PINNED_DDL)
  await addColumnIfMissing(client, 'Finding', 'status', FINDING_ADD_STATUS_COLUMN_DDL)
  await addColumnIfMissing(client, 'Review', 'reviewerLog', REVIEW_ADD_REVIEWER_LOG_DDL)
  await addColumnIfMissing(client, 'Finding', 'reflagCount', FINDING_ADD_REFLAG_COUNT_DDL)
  await addColumnIfMissing(
    client,
    'Finding',
    'artifactBindingState',
    FINDING_ADD_ARTIFACT_BINDING_STATE_DDL
  )
  await addColumnIfMissing(
    client,
    'ManagedFile',
    'sourceVersionId',
    MANAGED_FILE_ADD_SOURCE_VERSION_ID_DDL
  )
  await addColumnIfMissing(client, 'ManagedFile', 'checksum', MANAGED_FILE_ADD_CHECKSUM_DDL)
  await addColumnIfMissing(
    client,
    'ArtifactMessageSnapshot',
    'checksum',
    ARTIFACT_MESSAGE_SNAPSHOT_ADD_CHECKSUM_DDL
  )
  await addColumnIfMissing(client, 'ArtifactVersion', 'filename', ARTIFACT_VERSION_ADD_FILENAME_DDL)
  await migrationSqlExecutor.execute(
    client,
    `UPDATE "ArtifactVersion" SET "filename" = (SELECT "filename" FROM "ArtifactLineage" WHERE "ArtifactLineage"."id" = "ArtifactVersion"."artifactId") WHERE "filename" IS NULL OR "filename" = ''`
  )
  await addColumnIfMissing(
    client,
    'ComputeJob',
    'lastPollError',
    COMPUTE_JOB_ADD_LAST_POLL_ERROR_DDL
  )
  await addColumnIfMissing(client, 'ComputeJob', 'harvestError', COMPUTE_JOB_ADD_HARVEST_ERROR_DDL)
  await addColumnIfMissing(client, 'ComputeJob', 'leftOnRemote', COMPUTE_JOB_ADD_LEFT_ON_REMOTE_DDL)
  await addColumnIfMissing(client, 'ComputeJob', 'notifiedAt', COMPUTE_JOB_ADD_NOTIFIED_AT_DDL)
  await addColumnIfMissing(
    client,
    'ComputeJob',
    'notificationConsumedAt',
    COMPUTE_JOB_ADD_NOTIFICATION_CONSUMED_AT_DDL
  )

  await applySqliteCheckConstraints(client, prepared.pendingCheckConstraints)
  for (const ddl of RUNTIME_SCHEMA_INDEX_DDLS) {
    await migrationSqlExecutor.execute(client, ddl)
  }
}

export {
  RUNTIME_SCHEMA_BASELINE_CONTRACT,
  RUNTIME_SCHEMA_BASELINE_TARGET_SQL,
  applyRuntimeSchemaBaseline,
  prepareRuntimeSchemaBaseline,
  normalizeSchemaObjectSql,
  verifyCurrentRuntimeSchema,
  verifyRuntimeSchemaBaseline
}
export type { AllowedSuffixCheckConstraints, PreparedRuntimeSchemaBaseline }
