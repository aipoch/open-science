import type { Prisma, PrismaClient } from '@prisma/client'

type SqliteExecutor = Prisma.TransactionClient

type SqliteTableInfoRow = { name: string }
type SqliteTableSqlRow = { sql: string | null }
type SqliteForeignKeyStateRow = { foreign_keys: bigint | number }
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
  const rows = await client.$queryRawUnsafe<SqliteTableSqlRow[]>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    tableName
  )
  return rows[0]?.sql ?? null
}

const readTableColumns = async (client: SqliteExecutor, tableName: string): Promise<string[]> => {
  const rows = await client.$queryRawUnsafe<SqliteTableInfoRow[]>(
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
  const invalidRows = await client.$queryRawUnsafe<Array<{ value: string | null }>>(
    `SELECT CAST(${column} AS TEXT) AS value FROM ${table} WHERE ${column} IS NULL OR ${column} NOT IN (${allowedValues}) LIMIT 1`
  )
  const invalidValue = invalidRows[0]?.value
  if (invalidRows.length === 0) return

  throw new Error(
    `SQLite schema migration blocked: ${migration.tableName}.${migration.columnName} contains unsupported value ${JSON.stringify(invalidValue)}.`
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
  const rows = await client.$queryRawUnsafe<Array<{ count: bigint | number }>>(
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`
  )
  return BigInt(rows[0]?.count ?? 0)
}

const rebuildTable = async (
  client: SqliteExecutor,
  migration: SqliteCheckConstraintMigration
): Promise<void> => {
  const replacementTableName = `__open_science_migrate_${migration.tableName}`
  await client.$executeRawUnsafe(`DROP TABLE IF EXISTS ${quoteIdentifier(replacementTableName)}`)
  await client.$executeRawUnsafe(createReplacementDdl(migration, replacementTableName))

  const sourceColumns = new Set(await readTableColumns(client, migration.tableName))
  const targetColumns = await readTableColumns(client, replacementTableName)
  const targetColumnSet = new Set(targetColumns)
  const unknownSourceColumns = [...sourceColumns].filter((column) => !targetColumnSet.has(column))
  if (unknownSourceColumns.length > 0) {
    throw new Error(
      `SQLite schema migration blocked: ${migration.tableName} contains unknown columns ${unknownSourceColumns.join(', ')}.`
    )
  }
  const copyColumns = targetColumns.filter((column) => sourceColumns.has(column))
  if (copyColumns.length === 0) {
    throw new Error(
      `SQLite schema migration found no compatible columns for ${migration.tableName}.`
    )
  }

  const quotedColumns = copyColumns.map(quoteIdentifier).join(', ')
  const sourceRowCount = await countRows(client, migration.tableName)
  await client.$executeRawUnsafe(
    `INSERT INTO ${quoteIdentifier(replacementTableName)} (${quotedColumns}) SELECT ${quotedColumns} FROM ${quoteIdentifier(migration.tableName)}`
  )
  const replacementRowCount = await countRows(client, replacementTableName)
  if (replacementRowCount !== sourceRowCount) {
    throw new Error(
      `SQLite schema migration row-count mismatch for ${migration.tableName}: expected ${sourceRowCount}, copied ${replacementRowCount}.`
    )
  }

  await client.$executeRawUnsafe(`DROP TABLE ${quoteIdentifier(migration.tableName)}`)
  await client.$executeRawUnsafe(
    `ALTER TABLE ${quoteIdentifier(replacementTableName)} RENAME TO ${quoteIdentifier(migration.tableName)}`
  )
}

const readForeignKeyState = async (client: SqliteExecutor): Promise<number> => {
  const rows = await client.$queryRawUnsafe<SqliteForeignKeyStateRow[]>('PRAGMA foreign_keys')
  return Number(rows[0]?.foreign_keys ?? 0)
}

const ensureSqliteCheckConstraints = async (
  client: PrismaClient,
  migrations: readonly SqliteCheckConstraintMigration[]
): Promise<void> => {
  const pending: SqliteCheckConstraintMigration[] = []
  for (const migration of migrations) {
    const tableSql = await readTableSql(client, migration.tableName)
    if (!tableSql) throw new Error(`SQLite table is unavailable: ${migration.tableName}.`)
    if (
      migration.constraintNames.some(
        (constraintName) => !tableSql.includes(`CONSTRAINT "${constraintName}"`)
      )
    ) {
      pending.push(migration)
    }
  }
  if (pending.length === 0) return

  // createProjectDbClient deliberately uses connection_limit=1. That invariant keeps this
  // connection-scoped PRAGMA on the same physical SQLite connection as the transaction below.
  const foreignKeysWereEnabled = (await readForeignKeyState(client)) === 1
  if (foreignKeysWereEnabled) {
    await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
    if ((await readForeignKeyState(client)) !== 0) {
      throw new Error('SQLite schema migration could not disable foreign-key enforcement.')
    }
  }

  let migrationFailure: unknown
  try {
    await client.$transaction(async (transaction) => {
      for (const migration of pending) await validateExistingValues(transaction, migration)
      for (const migration of pending) await rebuildTable(transaction, migration)

      const violations = await transaction.$queryRawUnsafe<SqliteForeignKeyViolationRow[]>(
        'PRAGMA foreign_key_check'
      )
      if (violations.length > 0) {
        const violation = violations[0]!
        throw new Error(
          `SQLite schema migration introduced a foreign-key violation in ${violation.table} row ${String(violation.rowid)} referencing ${violation.parent}.`
        )
      }
    })
  } catch (error) {
    migrationFailure = error
  }

  let restoreFailure: unknown
  try {
    if (foreignKeysWereEnabled) {
      await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
      if ((await readForeignKeyState(client)) !== 1) {
        throw new Error('SQLite schema migration could not restore foreign-key enforcement.')
      }
    }
  } catch (error) {
    restoreFailure = error
  }

  if (migrationFailure && restoreFailure) {
    throw new AggregateError(
      [migrationFailure, restoreFailure],
      `SQLite schema migration failed and foreign-key enforcement could not be restored: ${migrationFailure instanceof Error ? migrationFailure.message : String(migrationFailure)}`
    )
  }
  if (migrationFailure) throw migrationFailure
  if (restoreFailure) throw restoreFailure
}

export { ensureSqliteCheckConstraints }
export type { SqliteCheckConstraintMigration }
