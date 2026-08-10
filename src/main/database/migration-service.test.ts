import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { verifyCurrentRuntimeSchema } from './legacy-baseline-adapter'
import {
  BASELINE_CHECKSUM,
  MIGRATION_MANIFEST,
  checksumMigrationPayload,
  classifyDatabaseFailure,
  migrateApplicationDatabase,
  migrateApplicationDatabaseWithManifest,
  type MigrationManifestEntry
} from './migration-service'

const futureTestMigration = (): MigrationManifestEntry => {
  const id = '0002_test_suffix'
  const statements = [
    `CREATE TABLE "MigrationSuffixProbe" ("id" TEXT NOT NULL PRIMARY KEY)`
  ] as const
  const verifiers = [{ kind: 'table-exists', version: 1, table: 'MigrationSuffixProbe' }] as const
  return {
    id,
    statements,
    verifiers,
    checksum: checksumMigrationPayload(id, statements, verifiers)
  }
}

describe('application database migrations', () => {
  let storageRoot: string | undefined
  let client: PrismaClient | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { force: true, recursive: true })
  })

  it.each([
    {
      name: 'missing Prisma engine',
      error: Object.assign(new Error('runtime failed'), {
        name: 'PrismaClientInitializationError',
        code: 'ENOENT'
      }),
      phase: 'open' as const,
      expected: { code: 'database_runtime_unavailable', retryable: false }
    },
    {
      name: 'read-only database',
      error: Object.assign(new Error('attempt to write a readonly database'), { code: 'P2010' }),
      phase: 'migration' as const,
      expected: { code: 'database_migration_failed', retryable: true }
    },
    {
      name: 'locked database',
      error: Object.assign(new Error('write failed'), { code: 'SQLITE_BUSY' }),
      phase: 'migration' as const,
      expected: { code: 'database_migration_failed', retryable: true }
    },
    {
      name: 'full disk',
      error: Object.assign(new Error('database or disk is full'), { code: 'P2010' }),
      phase: 'migration' as const,
      expected: { code: 'database_migration_failed', retryable: true }
    }
  ])('classifies a $name without exposing engine text', ({ error, phase, expected }) => {
    const classified = classifyDatabaseFailure(error, phase)

    expect(classified).toMatchObject(expected)
    expect(classified.message).not.toContain(error.message)
  })

  it('uses a platform-neutral checksum for the frozen baseline payload', () => {
    expect(BASELINE_CHECKSUM).toBe(
      'e29d0483786c3ed2e1c9cd358369b254a54ccf54213931c5ef71a8fd4e161525'
    )
    const verifier = [{ kind: 'table-exists', version: 1, table: 'probe' }] as const
    expect(checksumMigrationPayload('0001_test', ['one\r\ntwo'], verifier)).toBe(
      checksumMigrationPayload('0001_test', ['one\ntwo'], verifier)
    )
    expect(
      checksumMigrationPayload(
        '0001_test',
        [],
        [{ kind: 'table-exists', version: 1, table: 'probe\r\nname' }]
      )
    ).toBe(
      checksumMigrationPayload(
        '0001_test',
        [],
        [{ kind: 'table-exists', version: 1, table: 'probe\nname' }]
      )
    )
  })

  it('records the runtime baseline once for a fresh database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open science 数据 baseline-'))
    client = createProjectDbClient(storageRoot)
    const compatibility: Array<{ sqliteVersion: string }> = []

    await expect(
      migrateApplicationDatabase(client, {
        onCompatibilityVerified: (value) => compatibility.push(value)
      })
    ).resolves.toEqual({
      adoptedLegacy: false,
      applied: ['0001_runtime_schema_baseline'],
      from: null,
      to: '0001_runtime_schema_baseline'
    })
    expect(compatibility).toEqual([{ sqliteVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/) }])
    await expect(
      client.project.create({ data: { id: 'project-1', name: 'Project' } })
    ).resolves.toMatchObject({ id: 'project-1' })

    await client.$disconnect()
    client = createProjectDbClient(storageRoot)

    await expect(migrateApplicationDatabase(client)).resolves.toEqual({
      adoptedLegacy: false,
      applied: [],
      from: '0001_runtime_schema_baseline',
      to: '0001_runtime_schema_baseline'
    })
  })

  it('materializes the generated current target after applying the full manifest', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-current-target-'))
    client = createProjectDbClient(storageRoot)

    await migrateApplicationDatabase(client)

    await expect(verifyCurrentRuntimeSchema(client)).resolves.toBeUndefined()
  })

  it('rejects schema objects outside the generated current target', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-current-drift-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.$executeRawUnsafe('CREATE TABLE "UnversionedDrift" ("id" TEXT PRIMARY KEY)')

    await expect(verifyCurrentRuntimeSchema(client)).rejects.toThrow(/unexpected tables/)
  })

  it('applies a pending manifest suffix after the recorded baseline', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-suffix-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    const future = futureTestMigration()

    await expect(
      migrateApplicationDatabaseWithManifest(client, [...MIGRATION_MANIFEST, future])
    ).resolves.toEqual({
      adoptedLegacy: false,
      applied: ['0002_test_suffix'],
      from: '0001_runtime_schema_baseline',
      to: '0002_test_suffix'
    })
    await expect(
      client.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "_open_science_migrations" ORDER BY "id"
      `
    ).resolves.toEqual([{ id: '0001_runtime_schema_baseline' }, { id: '0002_test_suffix' }])
  })

  it('rolls back a future migration and its ledger row when verification fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-suffix-rollback-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    const futureBase = futureTestMigration()
    const verifiers = [
      { kind: 'table-exists', version: 1, table: 'MissingMigrationSuffixProbe' }
    ] as const
    const future = {
      ...futureBase,
      verifiers,
      checksum: checksumMigrationPayload(futureBase.id, futureBase.statements, verifiers)
    }

    await expect(
      migrateApplicationDatabaseWithManifest(client, [...MIGRATION_MANIFEST, future])
    ).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: '0002_test_suffix'
    })
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "type" = 'table' AND "name" = 'MigrationSuffixProbe'
      `
    ).resolves.toEqual([])
    await expect(
      client.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "_open_science_migrations" ORDER BY "id"
      `
    ).resolves.toEqual([{ id: '0001_runtime_schema_baseline' }])
  })

  it('adopts a pre-ledger database and then applies the full manifest suffix', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-legacy-suffix-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRaw`
      INSERT INTO "Project" ("id", "name", "updatedAt")
      VALUES (${'legacy-project'}, ${'Preserved'}, ${new Date('2026-01-02T03:04:05Z')})
    `
    const future = futureTestMigration()

    await expect(
      migrateApplicationDatabaseWithManifest(client, [...MIGRATION_MANIFEST, future])
    ).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: ['0001_runtime_schema_baseline', '0002_test_suffix'],
      to: '0002_test_suffix'
    })
    await expect(
      client.project.findUniqueOrThrow({ where: { id: 'legacy-project' } })
    ).resolves.toMatchObject({ name: 'Preserved' })
  })

  it('blocks a database containing a migration from a newer application', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-newer-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Preserved' } })
    await client.$executeRaw`
      INSERT INTO "_open_science_migrations" ("id", "checksum")
      VALUES (${'0002_future_schema'}, ${'f'.repeat(64)})
    `

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_newer_than_app',
      retryable: false
    })
    await expect(client.project.count()).resolves.toBe(1)
  })

  it('blocks a migration history whose recorded baseline was changed', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-checksum-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.$executeRaw`
      UPDATE "_open_science_migrations"
      SET "checksum" = ${'0'.repeat(64)}
      WHERE "id" = ${'0001_runtime_schema_baseline'}
    `

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_history_invalid',
      retryable: false
    })
  })

  it('adopts a pre-ledger database without losing existing projects', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-legacy-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRaw`
      INSERT INTO "Project" ("id", "name", "updatedAt")
      VALUES (${'legacy-project'}, ${'Preserved'}, ${new Date('2026-01-02T03:04:05Z')})
    `

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: ['0001_runtime_schema_baseline']
    })
    await expect(
      client.project.findUniqueOrThrow({ where: { id: 'legacy-project' } })
    ).resolves.toMatchObject({ name: 'Preserved', archivedAt: null })
  })

  it('adopts the pre-ledger permission seed table from the final baseline', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-permission-seed-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "PermissionGrantSeed" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "appliedAt" DATETIME NOT NULL
    )`)
    const appliedAt = new Date('2026-08-09T00:00:00.000Z')
    await client.$executeRaw`
      INSERT INTO "PermissionGrantSeed" ("id", "appliedAt")
      VALUES (${'global-customize-v1'}, ${appliedAt})
    `

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      adoptedLegacy: true,
      applied: ['0001_runtime_schema_baseline']
    })
    await expect(
      client.permissionGrantSeed.findUniqueOrThrow({ where: { id: 'global-customize-v1' } })
    ).resolves.toEqual({ id: 'global-customize-v1', appliedAt })
    await expect(verifyCurrentRuntimeSchema(client)).resolves.toBeUndefined()
  })

  it('rejects an unknown pre-ledger table without changing it', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-unknown-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(
      'CREATE TABLE "FutureApplicationTable" ("id" TEXT NOT NULL PRIMARY KEY, "value" TEXT)'
    )
    await client.$executeRaw`
      INSERT INTO "FutureApplicationTable" ("id", "value") VALUES (${'future-1'}, ${'keep-me'})
    `

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      retryable: false
    })
    await expect(
      client.$queryRawUnsafe<Array<{ value: string }>>(
        'SELECT "value" FROM "FutureApplicationTable" WHERE "id" = \'future-1\''
      )
    ).resolves.toEqual([{ value: 'keep-me' }])
    await expect(
      client.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT "name" FROM "sqlite_schema" WHERE "name" = '_open_science_migrations'`
      )
    ).resolves.toEqual([])
  })

  it.each([
    ['view', `CREATE VIEW "future_project_view" AS SELECT "id" FROM "Project"`],
    [
      'trigger',
      `CREATE TRIGGER "future_project_trigger" AFTER INSERT ON "Project"
       BEGIN UPDATE "Project" SET "name" = "name" WHERE "id" = NEW."id"; END`
    ]
  ])('rejects an unknown legacy %s without dropping it', async (kind, ddl) => {
    storageRoot = await mkdtemp(join(tmpdir(), `open-science-database-${kind}-`))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRawUnsafe(ddl)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema" WHERE "type" = ${kind}
      `
    ).resolves.toHaveLength(1)
  })

  it('rejects a same-named index with the wrong uniqueness and columns', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-index-parity-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "UnreadTaskSession" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "sessionId" TEXT NOT NULL
    )`)
    await client.$executeRawUnsafe(
      `CREATE INDEX "UnreadTaskSession_sessionId_key" ON "UnreadTaskSession"("id")`
    )

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
    await expect(
      client.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS "count" FROM "_open_science_migrations"
      `
    ).rejects.toThrow()
  })

  it('rejects a current column name with an incompatible storage definition', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-column-parity-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" INTEGER NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "archivedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
  })

  it.each([
    ['inline CHECK', '"name" TEXT NOT NULL CHECK (length("name") > 0)'],
    ['inline UNIQUE', '"name" TEXT NOT NULL UNIQUE'],
    ['inline COLLATE', '"name" TEXT NOT NULL COLLATE NOCASE'],
    ['unnamed table CHECK', '"name" TEXT NOT NULL', 'CHECK (length("name") > 0)'],
    ['unnamed table UNIQUE', '"name" TEXT NOT NULL', 'UNIQUE ("name")']
  ])('rejects an extra legacy %s constraint', async (_kind, nameDefinition, tableConstraint?) => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-constraint-parity-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      ${nameDefinition},
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "archivedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL${tableConstraint ? `, ${tableConstraint}` : ''}
    )`)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema" WHERE "name" = '_open_science_migrations'
      `
    ).resolves.toEqual([])
  })

  it('rejects unsupported legacy table options', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-table-options-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "archivedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    ) WITHOUT ROWID`)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
  })

  it('rejects an unconsumed inline primary-key modifier', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-column-modifier-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "Project" (
      "id" TEXT NOT NULL PRIMARY KEY DESC,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "archivedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed'
    })
  })

  it('rolls back baseline schema changes when the ledger insert fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-database-rollback-'))
    client = createProjectDbClient(storageRoot)
    await client.$executeRawUnsafe(`CREATE TABLE "_open_science_migrations" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "checksum" TEXT NOT NULL CHECK ("checksum" = 'reject-insert'),
      "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)

    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_migration_failed'
    })
    await expect(
      client.$queryRaw<Array<{ name: string }>>`
        SELECT "name" FROM "sqlite_schema"
        WHERE "type" = 'table' AND "name" = 'Project'
      `
    ).resolves.toEqual([])
    await expect(
      client.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS "count" FROM "_open_science_migrations"
      `
    ).resolves.toEqual([{ count: 0n }])
  })
})
