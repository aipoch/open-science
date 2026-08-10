import { createHash } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type { DatabaseStartupErrorCode } from '../../shared/database-startup'

import {
  RUNTIME_SCHEMA_BASELINE_CONTRACT,
  applyRuntimeSchemaBaseline,
  prepareRuntimeSchemaBaseline,
  verifyRuntimeSchemaBaseline
} from './legacy-baseline-adapter'
import { migrationSqlExecutor } from './migration-sql-executor'
import { runtimeSchemaBaselineMigration } from './migrations/0001-runtime-schema-baseline'

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
  }
}

const BASELINE_ID = runtimeSchemaBaselineMigration.id

const checksumMigrationPayload = (
  id: string,
  statements: readonly string[],
  verifiers: MigrationVerifiers
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
  return hash.digest('hex')
}

const BASELINE_CHECKSUM = checksumMigrationPayload(
  BASELINE_ID,
  runtimeSchemaBaselineMigration.statements,
  runtimeSchemaBaselineMigration.verifiers
)
const MIGRATION_MANIFEST = [
  { ...runtimeSchemaBaselineMigration, checksum: BASELINE_CHECKSUM }
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

type SchemaMigrationOptions = {
  onProgress?: (progress: SchemaMigrationProgress) => void
  onCompatibilityVerified?: (compatibility: DatabaseCompatibility) => void
}

type MigrationManifestEntry = {
  id: string
  checksum: string
  statements: readonly string[]
  verifiers: MigrationVerifiers
}

const runMigrationVerifiers = async (
  client: PrismaClient,
  verifiers: MigrationVerifiers
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
        await verifyRuntimeSchemaBaseline(client)
        break
      case 'table-exists': {
        const rows = await client.$queryRaw<Array<{ name: string }>>`
          SELECT "name" FROM "sqlite_schema"
          WHERE "type" = 'table' AND "name" = ${verifier.table}
        `
        if (rows.length !== 1) {
          throw new Error(`Migration verification found missing table ${verifier.table}.`)
        }
        break
      }
    }
  }
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

const applyBaselineMigration = async (
  client: PrismaClient,
  migration: MigrationManifestEntry
): Promise<void> => {
  let prepared: Awaited<ReturnType<typeof prepareRuntimeSchemaBaseline>>
  try {
    prepared = await prepareRuntimeSchemaBaseline(client)
  } catch (error) {
    throw classifyDatabaseFailure(error, 'validation', migration.id)
  }
  const disableForeignKeys = prepared.pendingCheckConstraints.length > 0
  let foreignKeysWereEnabled = false
  let migrationFailure: unknown
  try {
    foreignKeysWereEnabled = disableForeignKeys && (await readForeignKeyState(client)) === 1
    if (foreignKeysWereEnabled) await setForeignKeys(client, false)
    await client.$transaction(async (transaction) => {
      const transactionClient = transaction as unknown as PrismaClient
      await applyRuntimeSchemaBaseline(transactionClient, prepared)
      await runMigrationVerifiers(transactionClient, migration.verifiers)
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
  migration: MigrationManifestEntry
): Promise<void> => {
  try {
    await client.$transaction(async (transaction) => {
      const transactionClient = transaction as unknown as PrismaClient
      for (const statement of migration.statements) {
        await migrationSqlExecutor.execute(transaction, statement)
      }
      try {
        await runMigrationVerifiers(transactionClient, migration.verifiers)
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
    throw classifyDatabaseFailure(error, 'migration', migration.id)
  }
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
  const appliedCount = validateLedger(ledger, manifest)
  const latest = manifest.at(-1)!
  const from = ledger.at(-1)?.id ?? null
  if (appliedCount === manifest.length) {
    await reportDatabaseCompatibility(client, options)
    return { adoptedLegacy: false, applied: [], from, to: latest.id }
  }

  const applied: string[] = []
  let adoptedLegacy = false
  let nextIndex = appliedCount
  if (nextIndex === 0) {
    const baseline = manifest[0]!
    options.onProgress?.({ phase: 'migrating', migrationId: baseline.id })
    try {
      adoptedLegacy = await hasApplicationTables(client)
    } catch (error) {
      throw classifyDatabaseFailure(error, 'open')
    }
    await applyBaselineMigration(client, baseline)
    applied.push(baseline.id)
    nextIndex = 1
  }

  for (const migration of manifest.slice(nextIndex)) {
    options.onProgress?.({ phase: 'migrating', migrationId: migration.id })
    await applyManifestMigration(client, migration)
    applied.push(migration.id)
  }

  await reportDatabaseCompatibility(client, options)
  return { adoptedLegacy, applied, from, to: latest.id }
}

const migrateApplicationDatabase = (
  client: PrismaClient,
  options: SchemaMigrationOptions = {}
): Promise<SchemaMigrationResult> =>
  migrateApplicationDatabaseWithManifest(client, MIGRATION_MANIFEST, options)

export {
  BASELINE_CHECKSUM,
  DatabaseMigrationError,
  checksumMigrationPayload,
  classifyDatabaseFailure,
  migrateApplicationDatabase,
  migrateApplicationDatabaseWithManifest,
  MIGRATION_MANIFEST
}
export type {
  DatabaseCompatibility,
  DatabaseMigrationErrorCode,
  MigrationManifestEntry,
  MigrationVerifierDescriptor,
  MigrationVerifiers,
  SchemaMigrationOptions,
  SchemaMigrationProgress,
  SchemaMigrationResult
}
