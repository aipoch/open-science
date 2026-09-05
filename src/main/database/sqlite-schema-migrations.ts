import {
  migrationSqlExecutor,
  type MigrationSqlClient as SqliteExecutor
} from './migration-sql-executor'
import { DatabaseValidationError, summarizeDatabaseValue } from './database-validation-error'

type SqliteTableInfoRow = { name: string }
type SqliteTableSqlRow = { sql: string | null }
type SqliteSequenceRow = { seq: bigint | number | null }
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

type SqliteMigrationTable = {
  tableName: string
  canonicalTableDdl: string
  columns: readonly string[]
  optionalLegacyColumns?: readonly { name: string; definition: string }[]
}

type SqliteRebuildTableSetOperation = {
  kind: 'rebuild-table-set'
  version: 1 | 2
  tables: readonly SqliteMigrationTable[]
  dropOrder: readonly string[]
  indexes: readonly string[]
  triggers?: readonly string[]
}

type SqliteMigrationOperation = SqliteRebuildTableSetOperation

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

const readAutoincrementSequence = async (
  client: SqliteExecutor,
  tableName: string,
  targetDdl: string
): Promise<bigint | number | undefined> => {
  if (!/\bAUTOINCREMENT\b/i.test(targetDdl)) return undefined
  const sequenceTable = await migrationSqlExecutor.query<Array<{ present: number }>>(
    client,
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`
  )
  if (sequenceTable.length === 0) return undefined
  const rows = await migrationSqlExecutor.query<SqliteSequenceRow[]>(
    client,
    `SELECT seq FROM sqlite_sequence WHERE name = ? LIMIT 1`,
    tableName
  )
  return rows[0]?.seq ?? undefined
}

const restoreAutoincrementSequence = async (
  client: SqliteExecutor,
  tableName: string,
  sequence: bigint | number
): Promise<void> => {
  await migrationSqlExecutor.execute(
    client,
    `DELETE FROM sqlite_sequence WHERE name = ?`,
    tableName
  )
  await migrationSqlExecutor.execute(
    client,
    `INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`,
    tableName,
    sequence
  )
}

const withOptionalLegacyColumns = (
  canonicalTableDdl: string,
  columns: readonly { name: string; definition: string }[]
): string => {
  if (columns.length === 0) return canonicalTableDdl
  const constraintMarker = '\n    CONSTRAINT '
  const markerIndex = canonicalTableDdl.indexOf(constraintMarker)
  if (markerIndex === -1) {
    throw new Error('Canonical SQLite DDL cannot preserve optional columns without constraints.')
  }
  const definitions = columns.map(({ definition }) => `    ${definition},`).join('\n')
  return `${canonicalTableDdl.slice(0, markerIndex)}\n${definitions}${canonicalTableDdl.slice(markerIndex)}`
}

const applyRebuildTableSet = async (
  client: SqliteExecutor,
  operation: SqliteRebuildTableSetOperation
): Promise<void> => {
  const tableNames = new Set(operation.tables.map(({ tableName }) => tableName))
  if (
    tableNames.size !== operation.tables.length ||
    operation.dropOrder.length !== tableNames.size ||
    new Set(operation.dropOrder).size !== tableNames.size ||
    operation.dropOrder.some((tableName) => !tableNames.has(tableName))
  ) {
    throw new Error('SQLite rebuild-table-set operation has an invalid table order.')
  }

  const prepared: Array<{
    tableName: string
    backupTableName: string
    targetDdl: string
    copyColumns: string[]
    sourceRowCount: bigint
    autoincrementSequence: bigint | number | undefined
  }> = []
  for (const table of operation.tables) {
    const sourceColumns = new Set(await readTableColumns(client, table.tableName))
    const missingColumns = table.columns.filter((column) => !sourceColumns.has(column))
    if (missingColumns.length > 0) {
      throw new DatabaseValidationError(
        `SQLite schema migration found missing columns in ${table.tableName}.`,
        { kind: 'missing-columns', table: table.tableName, expected: missingColumns }
      )
    }
    const optionalColumns = (table.optionalLegacyColumns ?? []).filter(({ name }) =>
      sourceColumns.has(name)
    )
    const allowedColumns = new Set([
      ...table.columns,
      ...(table.optionalLegacyColumns ?? []).map(({ name }) => name)
    ])
    const unknownColumns = [...sourceColumns].filter((column) => !allowedColumns.has(column))
    if (unknownColumns.length > 0) {
      throw new DatabaseValidationError(
        `SQLite schema migration blocked by unknown columns in ${table.tableName}.`,
        { kind: 'unknown-columns', table: table.tableName, actual: unknownColumns }
      )
    }
    const targetDdl = withOptionalLegacyColumns(table.canonicalTableDdl, optionalColumns)
    prepared.push({
      tableName: table.tableName,
      backupTableName: `__open_science_rebuild_${table.tableName}`,
      targetDdl,
      copyColumns: [...table.columns, ...optionalColumns.map(({ name }) => name)],
      sourceRowCount: await countRows(client, table.tableName),
      autoincrementSequence: await readAutoincrementSequence(client, table.tableName, targetDdl)
    })
  }

  // Version 1 is frozen for released migrations. Version 2 copies into replacement tables
  // first, preserving inbound references without rebuilding unrelated child tables.
  const replacementFirst = operation.version === 2
  for (const table of prepared) {
    await migrationSqlExecutor.execute(
      client,
      replacementFirst
        ? table.targetDdl.replace(
            `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.tableName)}`,
            `CREATE TABLE ${quoteIdentifier(table.backupTableName)}`
          )
        : `ALTER TABLE ${quoteIdentifier(table.tableName)} RENAME TO ${quoteIdentifier(table.backupTableName)}`
    )
  }
  if (!replacementFirst) {
    for (const table of prepared) await migrationSqlExecutor.execute(client, table.targetDdl)
  }

  for (const table of prepared) {
    const quotedColumns = table.copyColumns.map(quoteIdentifier).join(', ')
    const sourceName = replacementFirst ? table.tableName : table.backupTableName
    const targetName = replacementFirst ? table.backupTableName : table.tableName
    try {
      await migrationSqlExecutor.execute(
        client,
        `INSERT INTO ${quoteIdentifier(targetName)} (${quotedColumns}) SELECT ${quotedColumns} FROM ${quoteIdentifier(sourceName)}`
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!/CHECK constraint failed/i.test(detail)) throw error
      throw new DatabaseValidationError(
        `SQLite schema migration blocked by a CHECK constraint in ${table.tableName}.`,
        {
          kind: 'check-constraint-violation',
          table: table.tableName
        }
      )
    }
    const targetRowCount = await countRows(client, targetName)
    if (targetRowCount !== table.sourceRowCount) {
      throw new DatabaseValidationError(
        `SQLite schema migration found a row-count mismatch for ${table.tableName}.`,
        {
          kind: 'row-count-mismatch',
          table: table.tableName,
          expected: table.sourceRowCount,
          actual: targetRowCount
        }
      )
    }
  }

  const preparedByName = new Map(prepared.map((table) => [table.tableName, table]))
  for (const tableName of operation.dropOrder) {
    const table = preparedByName.get(tableName)!
    await migrationSqlExecutor.execute(
      client,
      `DROP TABLE ${quoteIdentifier(replacementFirst ? table.tableName : table.backupTableName)}`
    )
  }
  if (replacementFirst) {
    for (const table of prepared)
      await migrationSqlExecutor.execute(
        client,
        `ALTER TABLE ${quoteIdentifier(table.backupTableName)} RENAME TO ${quoteIdentifier(table.tableName)}`
      )
  }
  for (const table of prepared) {
    if (table.autoincrementSequence === undefined) continue
    await restoreAutoincrementSequence(client, table.tableName, table.autoincrementSequence)
  }
  for (const index of operation.indexes) await migrationSqlExecutor.execute(client, index)
  for (const trigger of operation.triggers ?? [])
    await migrationSqlExecutor.execute(client, trigger)

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

const applySqliteMigrationOperations = async (
  client: SqliteExecutor,
  operations: readonly SqliteMigrationOperation[]
): Promise<void> => {
  for (const operation of operations) {
    switch (operation.kind) {
      case 'rebuild-table-set':
        await applyRebuildTableSet(client, operation)
        break
    }
  }
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
  pending: readonly SqliteCheckConstraintMigration[],
  postRebuildStatements: readonly string[] = []
): Promise<void> => {
  for (const migration of pending) await validateExistingValues(client, migration)
  for (const migration of pending) await rebuildTable(client, migration)
  for (const statement of postRebuildStatements) {
    await migrationSqlExecutor.execute(client, statement)
  }

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

export {
  applySqliteCheckConstraints,
  applySqliteMigrationOperations,
  findPendingSqliteCheckConstraints
}
export type { SqliteCheckConstraintMigration, SqliteMigrationOperation }
