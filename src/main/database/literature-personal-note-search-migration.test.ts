import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, expect, it } from 'vitest'

import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient } from '../projects/prisma-client'
import { LiteratureCatalog } from '../literature/catalog'
import { backfillLiteraturePersonalNoteSearch } from './migrations/0052-literature-personal-note-search'
import {
  MIGRATION_MANIFEST,
  checksumMigrationPayload,
  migrateApplicationDatabase,
  migrateApplicationDatabaseWithManifest,
  verifyCurrentApplicationSchema
} from './migration-service'

const migrationId = '0052_literature_personal_note_search'
const historicalManifest = MIGRATION_MANIFEST.filter(({ id }) => id < migrationId)
let root: string
let client: PrismaClient

afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})

async function seedHistoricalDatabase(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'literature-personal-note-search-'))
  client = createProjectDbClient(root)
  await createDatabaseAtReleasedManifest(client, historicalManifest)
  const note = ' ＲＮＡ\u3000ÉTUDE\n БИОЛОГИЯ 这个方法适合我的数据 '
  // Cross a backfill batch boundary and include inactive records for subsequent restore/unmerge.
  await client.$executeRaw`WITH RECURSIVE rows(n) AS (
    SELECT 0 UNION ALL SELECT n + 1 FROM rows WHERE n < 501
  ) INSERT INTO "LiteratureItem"
    (id, "itemType", title, "personalNote", "metadataRevision", "readingStatus", "createdAt", "updatedAt", "deletedAt")
    SELECT printf('paper-%03d', n), 'book', 'Historical method',
      CASE WHEN n = 501 THEN '' ELSE ${note} END,
      7, 'read', 1700000000000, 1700000001000, CASE WHEN n = 0 THEN 1700000002000 ELSE NULL END
    FROM rows`
  await client.literatureCollection.create({
    data: {
      id: 'collection',
      name: 'Methods',
      nameKey: 'methods',
      items: { create: { itemId: 'paper-001' } }
    }
  })
}

it('backfills existing personal notes in bounded batches without changing source data or history', async () => {
  await seedHistoricalDatabase()
  const items = await client.$queryRaw<
    Array<Record<string, unknown>>
  >`SELECT * FROM "LiteratureItem" ORDER BY id`
  const collections = await client.literatureCollection.findMany({ include: { items: true } })
  const ledger = await client.$queryRaw`SELECT * FROM "_open_science_migrations" ORDER BY id`

  expect(await migrateApplicationDatabase(client)).toMatchObject({
    from: '0051_literature_reading_status',
    to: '0053_literature_doi_identity',
    applied: [migrationId, '0053_literature_doi_identity']
  })
  expect(await client.$queryRaw`SELECT * FROM "LiteratureItem" ORDER BY id`).toEqual(
    items.map((item) => ({
      ...item,
      normalizedPersonalNote: item.personalNote ? 'rna étude биология 这个方法适合我的数据' : ''
    }))
  )
  expect(await client.literatureCollection.findMany({ include: { items: true } })).toEqual(
    collections
  )
  expect(
    await client.$queryRaw`SELECT * FROM "_open_science_migrations" WHERE id < ${migrationId} ORDER BY id`
  ).toEqual(ledger)
  expect(await client.$queryRaw`PRAGMA foreign_key_check`).toEqual([])
  expect(await client.$queryRaw`PRAGMA integrity_check`).toEqual([{ integrity_check: 'ok' }])
  await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  const catalog = new LiteratureCatalog(async () => client)
  expect(await catalog.search({ scope: 'library', query: '适合我的数据' })).toMatchObject({
    totalCount: 500
  })
  await client.$disconnect()
  client = createProjectDbClient(root)
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    from: '0053_literature_doi_identity',
    to: '0053_literature_doi_identity',
    applied: []
  })
  expect(
    await client.literatureItem.findUnique({
      where: { id: 'paper-500' },
      select: { normalizedPersonalNote: true }
    })
  ).toEqual({
    normalizedPersonalNote: 'rna étude биология 这个方法适合我的数据'
  })
})

it('bounds actual backfill read results while processing all historical notes', async () => {
  await seedHistoricalDatabase()
  await client.$executeRaw`ALTER TABLE "LiteratureItem" ADD COLUMN "normalizedPersonalNote" TEXT NOT NULL DEFAULT ''`
  const batchSizes: number[] = []
  const observed = client.$extends({
    query: {
      $queryRaw: async ({ args, query }) => {
        const result = await query(args)
        if (Array.isArray(result)) batchSizes.push(result.length)
        return result
      }
    }
  })
  await observed.$transaction((transaction) => backfillLiteraturePersonalNoteSearch(transaction))
  expect(batchSizes.length).toBeGreaterThan(1)
  expect(Math.max(...batchSizes)).toBeLessThanOrEqual(500)
  expect(batchSizes.reduce((sum, size) => sum + size, 0)).toBe(502)
  expect(
    await client.literatureItem.count({ where: { normalizedPersonalNote: { not: '' } } })
  ).toBe(501)
})

it('rolls back the column and ledger when verification fails', async () => {
  await seedHistoricalDatabase()
  const migration = MIGRATION_MANIFEST.find(({ id }) => id === migrationId)!
  const verifiers = [
    ...migration.verifiers,
    { kind: 'column-exists', version: 1, table: 'LiteratureItem', column: 'missingProbe' }
  ] as const
  const failingMigration = {
    ...migration,
    verifiers,
    checksum: checksumMigrationPayload(
      migration.id,
      migration.statements,
      verifiers,
      'operations' in migration ? migration.operations : undefined
    )
  }
  const items = await client.$queryRaw`SELECT * FROM "LiteratureItem" ORDER BY id`
  const ledger = await client.$queryRaw`SELECT * FROM "_open_science_migrations" ORDER BY id`
  await expect(
    migrateApplicationDatabaseWithManifest(client, [...historicalManifest, failingMigration])
  ).rejects.toMatchObject({
    code: 'database_validation_failed',
    migrationId
  })
  expect(await client.$queryRaw`SELECT * FROM "LiteratureItem" ORDER BY id`).toEqual(items)
  expect(await client.$queryRaw`SELECT * FROM "_open_science_migrations" ORDER BY id`).toEqual(
    ledger
  )
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    applied: [migrationId, '0053_literature_doi_identity']
  })
})

it('backfills an existing target column when its migration has not been recorded', async () => {
  await seedHistoricalDatabase()
  await client.$executeRaw`ALTER TABLE "LiteratureItem" ADD COLUMN "normalizedPersonalNote" TEXT NOT NULL DEFAULT ''`
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    applied: [migrationId, '0053_literature_doi_identity']
  })
  expect(
    await client.literatureItem.findUnique({
      where: { id: 'paper-001' },
      select: { normalizedPersonalNote: true, metadataRevision: true }
    })
  ).toEqual({
    normalizedPersonalNote: 'rna étude биология 这个方法适合我的数据',
    metadataRevision: 7
  })
})

it('rolls back earlier backfill batches when a later batch fails', async () => {
  await seedHistoricalDatabase()
  await client.$executeRaw`CREATE TRIGGER "fail_note_backfill" BEFORE UPDATE ON "LiteratureItem"
    WHEN NEW.id = 'paper-501' AND NEW."personalNote" = ''
    BEGIN SELECT RAISE(ABORT, 'forced note backfill failure'); END`
  const items = await client.$queryRaw`SELECT * FROM "LiteratureItem" ORDER BY id`
  const ledger = await client.$queryRaw`SELECT * FROM "_open_science_migrations" ORDER BY id`
  await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({ migrationId })
  expect(await client.$queryRaw`SELECT * FROM "LiteratureItem" ORDER BY id`).toEqual(items)
  expect(await client.$queryRaw`SELECT * FROM "_open_science_migrations" ORDER BY id`).toEqual(
    ledger
  )
})
