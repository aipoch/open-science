import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, expect, it } from 'vitest'

import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient } from '../projects/prisma-client'
import {
  MIGRATION_MANIFEST,
  checksumMigrationPayload,
  migrateApplicationDatabase,
  migrateApplicationDatabaseWithManifest,
  verifyCurrentApplicationSchema
} from './migration-service'

const migrationId = '0051_literature_reading_status'
const currentMigrationId = '0052_session_research_membership'
const historicalManifest = MIGRATION_MANIFEST.filter(({ id }) => id < migrationId)
let root: string
let client: PrismaClient

afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})

async function seedHistoricalDatabase(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'literature-reading-status-migration-'))
  client = createProjectDbClient(root)
  await createDatabaseAtReleasedManifest(client, historicalManifest)
  // Use the historical columns explicitly: the current Prisma client also selects readingStatus.
  await client.$executeRaw`INSERT INTO "LiteratureItem"
    ("id", "itemType", "title", "abstract", "metadataRevision", "createdAt", "updatedAt")
    VALUES ('paper', 'journalArticle', 'Existing paper', 'Preserved abstract', 7,
      1700000000000, 1700000001000)`
  await client.literatureCollection.create({
    data: {
      id: 'collection',
      name: 'Existing collection',
      nameKey: 'existing collection',
      items: { create: { itemId: 'paper', sortOrder: 3 } }
    }
  })
}

it('upgrades the 0050 schema with unread defaults while preserving items, relationships and history', async () => {
  await seedHistoricalDatabase()
  expect(historicalManifest.at(-1)?.id).toBe('0050_literature_translation')
  const [item] = await client.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "LiteratureItem" WHERE id = 'paper'
  `
  const collections = await client.literatureCollection.findMany({ include: { items: true } })
  const ledger = await client.$queryRaw`SELECT * FROM "_open_science_migrations" ORDER BY id`

  expect(await migrateApplicationDatabase(client)).toMatchObject({
    from: '0050_literature_translation',
    to: currentMigrationId,
    applied: [migrationId, currentMigrationId]
  })
  expect(await client.$queryRaw`SELECT * FROM "LiteratureItem" WHERE id = 'paper'`).toEqual([
    { ...item, readingStatus: 'unread' }
  ])
  expect(await client.literatureCollection.findMany({ include: { items: true } })).toEqual(
    collections
  )
  expect(
    await client.$queryRaw`SELECT * FROM "_open_science_migrations" WHERE id < ${migrationId} ORDER BY id`
  ).toEqual(ledger)
  expect(await client.$queryRaw`PRAGMA foreign_key_check`).toEqual([])
  expect(await client.$queryRaw`PRAGMA integrity_check`).toEqual([{ integrity_check: 'ok' }])
  await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  expect(
    await client.literatureItem.create({
      data: { itemType: 'book', title: 'New paper' },
      select: { readingStatus: true }
    })
  ).toEqual({ readingStatus: 'unread' })
})

it('persists read status after reconnecting and leaves it unchanged on repeated migration', async () => {
  await seedHistoricalDatabase()
  await migrateApplicationDatabase(client)
  const item = await client.literatureItem.update({
    where: { id: 'paper' },
    data: { readingStatus: 'read' }
  })
  const ledger = await client.$queryRaw`SELECT * FROM "_open_science_migrations" ORDER BY id`
  await client.$disconnect()
  client = createProjectDbClient(root)

  expect(await client.literatureItem.findUnique({ where: { id: 'paper' } })).toEqual(item)
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    from: currentMigrationId,
    to: currentMigrationId,
    applied: []
  })
  expect(await client.literatureItem.findUnique({ where: { id: 'paper' } })).toEqual(item)
  expect(await client.$queryRaw`SELECT * FROM "_open_science_migrations" ORDER BY id`).toEqual(
    ledger
  )
})

it('rolls back the added column and ledger entry if migration verification fails', async () => {
  await seedHistoricalDatabase()
  const migration = MIGRATION_MANIFEST.find(({ id }) => id === migrationId)
  if (!migration) throw new Error('Reading status migration is unavailable.')
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
  ).rejects.toMatchObject({ code: 'database_validation_failed', migrationId })
  expect(await client.$queryRaw`PRAGMA table_info("LiteratureItem")`).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'readingStatus' })])
  )
  expect(await client.$queryRaw`SELECT * FROM "LiteratureItem" ORDER BY id`).toEqual(items)
  expect(await client.$queryRaw`SELECT * FROM "_open_science_migrations" ORDER BY id`).toEqual(
    ledger
  )
  expect(await client.$queryRaw`PRAGMA foreign_key_check`).toEqual([])
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    applied: [migrationId, currentMigrationId]
  })
  expect(await client.literatureItem.findUnique({ where: { id: 'paper' } })).toMatchObject({
    readingStatus: 'unread',
    title: 'Existing paper',
    metadataRevision: 7
  })
})
