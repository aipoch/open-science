import {
  migrationSqlExecutor,
  type MigrationSqlClient as SqliteExecutor
} from './migration-sql-executor'
import { DatabaseValidationError, summarizeDatabaseValue } from './database-validation-error'

type SqliteTableInfoRow = { name: string }
type SqliteTableSqlRow = { sql: string | null }
type SqliteForeignKeyViolationRow = {
  table: string
  rowid: bigint | number | null
  parent: string
  fkid: bigint | number
}

type SqliteCheckConstraintMigration = {
  tableName: string
  columnName: string
  constraintNames: readonly string[]
  allowedValues: readonly string[]
  canonicalTableDdl: string
}

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`
const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`

const readTableSql = async (client: SqliteExecutor, tableName: string): Promise<string | null> => {
  const rows = await migrationSqlExecutor.query<SqliteTableSqlRow[]>(
    client,
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    tableName
  )
  return rows[0]?.sql ?? null
}

const readTableColumns = async (client: SqliteExecutor, tableName: string): Promise<string[]> => {
  const rows = await migrationSqlExecutor.query<SqliteTableInfoRow[]>(
    client,
    `PRAGMA table_info(${quoteIdentifier(tableName)})`
  )
  return rows.map((row) => row.name)
}

const validateExistingValues = async (
  client: SqliteExecutor,
  migration: SqliteCheckConstraintMigration
): Promise<void> => {
  const table = quoteIdentifier(migration.tableName)
  const column = quoteIdentifier(migration.columnName)
  const allowedValues = migration.allowedValues.map(quoteLiteral).join(', ')
  const invalidRows = await migrationSqlExecutor.query<Array<{ value: string | null }>>(
    client,
    `SELECT CAST(${column} AS TEXT) AS value FROM ${table} WHERE ${column} IS NULL OR ${column} NOT IN (${allowedValues}) LIMIT 1`
  )
  const invalidValue = invalidRows[0]?.value
  if (invalidRows.length === 0) return

  throw new DatabaseValidationError(
    `SQLite schema migration blocked: ${migration.tableName}.${migration.columnName} contains an unsupported value.`,
    {
      kind: 'unsupported-value',
      table: migration.tableName,
      column: migration.columnName,
      expected: migration.allowedValues,
      actual: summarizeDatabaseValue(invalidValue ?? null)
    }
  )
}

const createReplacementDdl = (
  migration: SqliteCheckConstraintMigration,
  replacementTableName: string
): string => {
  const canonicalPrefix = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(migration.tableName)}`
  if (!migration.canonicalTableDdl.startsWith(canonicalPrefix)) {
    throw new Error(
      `Canonical SQLite DDL for ${migration.tableName} does not start with the expected table declaration.`
    )
  }
  return migration.canonicalTableDdl.replace(
    canonicalPrefix,
    `CREATE TABLE ${quoteIdentifier(replacementTableName)}`
  )
}

const countRows = async (client: SqliteExecutor, tableName: string): Promise<bigint> => {
  const rows = await migrationSqlExecutor.query<Array<{ count: bigint | number }>>(
    client,
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`
  )
  return BigInt(rows[0]?.count ?? 0)
}

const rebuildTable = async (
  client: SqliteExecutor,
  migration: SqliteCheckConstraintMigration
): Promise<void> => {
  const replacementTableName = `__open_science_migrate_${migration.tableName}`
  await migrationSqlExecutor.execute(
    client,
    `DROP TABLE IF EXISTS ${quoteIdentifier(replacementTableName)}`
  )
  await migrationSqlExecutor.execute(client, createReplacementDdl(migration, replacementTableName))

  const sourceColumns = new Set(await readTableColumns(client, migration.tableName))
  const targetColumns = await readTableColumns(client, replacementTableName)
  const targetColumnSet = new Set(targetColumns)
  const unknownSourceColumns = [...sourceColumns].filter((column) => !targetColumnSet.has(column))
  if (unknownSourceColumns.length > 0) {
    throw new DatabaseValidationError(
      `SQLite schema migration blocked by unknown columns in ${migration.tableName}.`,
      { kind: 'unknown-columns', table: migration.tableName, actual: unknownSourceColumns }
    )
  }
  const copyColumns = targetColumns.filter((column) => sourceColumns.has(column))
  if (copyColumns.length === 0) {
    throw new DatabaseValidationError(
      `SQLite schema migration found no compatible columns for ${migration.tableName}.`,
      {
        kind: 'no-compatible-columns',
        table: migration.tableName,
        expected: targetColumns,
        actual: [...sourceColumns]
      }
    )
  }

  const quotedColumns = copyColumns.map(quoteIdentifier).join(', ')
  const sourceRowCount = await countRows(client, migration.tableName)
  await migrationSqlExecutor.execute(
    client,
    `INSERT INTO ${quoteIdentifier(replacementTableName)} (${quotedColumns}) SELECT ${quotedColumns} FROM ${quoteIdentifier(migration.tableName)}`
  )
  const replacementRowCount = await countRows(client, replacementTableName)
  if (replacementRowCount !== sourceRowCount) {
    throw new DatabaseValidationError(
      `SQLite schema migration found a row-count mismatch for ${migration.tableName}.`,
      {
        kind: 'row-count-mismatch',
        table: migration.tableName,
        expected: sourceRowCount,
        actual: replacementRowCount
      }
    )
  }

  await migrationSqlExecutor.execute(client, `DROP TABLE ${quoteIdentifier(migration.tableName)}`)
  await migrationSqlExecutor.execute(
    client,
    `ALTER TABLE ${quoteIdentifier(replacementTableName)} RENAME TO ${quoteIdentifier(migration.tableName)}`
  )
}

const findPendingSqliteCheckConstraints = async (
  client: SqliteExecutor,
  migrations: readonly SqliteCheckConstraintMigration[]
): Promise<SqliteCheckConstraintMigration[]> => {
  const pending: SqliteCheckConstraintMigration[] = []
  for (const migration of migrations) {
    const tableSql = await readTableSql(client, migration.tableName)
    if (!tableSql) continue
    if (
      migration.constraintNames.some(
        (constraintName) => !tableSql.includes(`CONSTRAINT "${constraintName}"`)
      )
    ) {
      pending.push(migration)
    }
  }
  return pending
}

const applySqliteCheckConstraints = async (
  client: SqliteExecutor,
  pending: readonly SqliteCheckConstraintMigration[]
): Promise<void> => {
  for (const migration of pending) await validateExistingValues(client, migration)
  for (const migration of pending) await rebuildTable(client, migration)

  const violations = await migrationSqlExecutor.query<SqliteForeignKeyViolationRow[]>(
    client,
    'PRAGMA foreign_key_check'
  )
  if (violations.length > 0) {
    const violation = violations[0]!
    throw new DatabaseValidationError(
      `SQLite schema migration introduced a foreign-key violation in ${violation.table}.`,
      {
        kind: 'foreign-key-violation',
        table: violation.table,
        constraint: String(violation.fkid),
        expected: { parent: violation.parent },
        actual: { rowid: violation.rowid }
      }
    )
  }
}

export { applySqliteCheckConstraints, findPendingSqliteCheckConstraints }
export type { SqliteCheckConstraintMigration }
