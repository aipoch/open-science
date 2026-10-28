import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, expect, it } from 'vitest'
import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient } from '../projects/prisma-client'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'

const researchId = '0051_session_research_membership'
const readingId = '0051_literature_reading_status'
let root: string
let client: PrismaClient

afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})

const seedHistoricalDatabase = async (variant: 'upstream' | 'research'): Promise<void> => {
  root = await mkdtemp(join(tmpdir(), 'research-membership-migration-'))
  client = createProjectDbClient(root)
  await createDatabaseAtReleasedManifest(
    client,
    MIGRATION_MANIFEST.filter(({ id }) => id !== (variant === 'upstream' ? researchId : readingId))
  )
  await client.project.create({ data: { id: 'p', name: 'Project' } })
  // The generated client selects the research columns that the upstream fixture lacks.
  await client.$executeRaw`INSERT INTO "Session"
    ("id", "number", "projectId", "title", "status", "presentedStatus", "archivedAtMs",
      "revision", "createdAtMs", "updatedAtMs")
    VALUES ('s', 1, 'p', 'Historical discussion', 'idle', 'idle', 3, 5, 1, 2)`
}

const readLedger = (): Promise<unknown> =>
  client.$queryRaw`SELECT * FROM "_open_science_migrations" ORDER BY id`

const expectReadingStatusAbsent = async (): Promise<void> => {
  expect(await client.$queryRaw`PRAGMA table_info("LiteratureItem")`).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'readingStatus' })])
  )
}

it('adds nullable research projections without changing existing Session or PDF translation records', async () => {
  await seedHistoricalDatabase('upstream')
  const [before] = await client.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "Session" WHERE id = 's'
  `
  const ledger = await readLedger()
  await client.pdfDocument.create({
    data: { id: 'document', checksum: 'a'.repeat(64), sizeBytes: 10n }
  })
  const translation = await client.pdfTranslation.create({
    data: {
      id: 'translation',
      pdfDocumentId: 'document',
      checksum: 'a'.repeat(64),
      sizeBytes: 10n,
      revision: 1,
      payloadJson: '{}'
    }
  })
  await expect(
    migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
  ).resolves.toMatchObject({ from: readingId, to: researchId, applied: [researchId] })
  expect(await client.$queryRaw`SELECT * FROM "Session" WHERE id = 's'`).toEqual([
    { ...before, researchMembershipJson: null, importedResearchId: null }
  ])
  expect(await client.pdfTranslation.findUnique({ where: { id: 'translation' } })).toEqual(
    translation
  )
  expect(
    await client.$queryRaw`SELECT * FROM "_open_science_migrations" WHERE id <> ${researchId} ORDER BY id`
  ).toEqual(ledger)
  expect(await client.$queryRaw`PRAGMA foreign_key_check`).toEqual([])
  await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
})

it('bridges the released research ledger without renaming it or replaying its populated columns', async () => {
  await seedHistoricalDatabase('research')
  await client.$executeRaw`UPDATE "Session" SET "researchMembershipJson" = '{"researchId":"r"}',
    "importedResearchId" = 'imported-r' WHERE id = 's'`
  await client.$executeRaw`INSERT INTO "LiteratureItem" (id, "itemType", title, "updatedAt")
    VALUES ('paper', 'journalArticle', 'Existing paper', CURRENT_TIMESTAMP)`
  const session = await client.session.findUnique({ where: { id: 's' } })
  const ledger = await readLedger()
  const backups: string[] = []
  await expect(
    migrateApplicationDatabase(client, {
      databasePath: join(root, 'open-science.db'),
      onBackupReady: ({ migrationId }) => backups.push(migrationId)
    })
  ).resolves.toMatchObject({ from: researchId, to: researchId, applied: [readingId] })
  expect(backups).toEqual([readingId])
  await expect(
    access(join(root, `open-science.db.before-${readingId}.backup`))
  ).resolves.toBeUndefined()
  expect(await client.session.findUnique({ where: { id: 's' } })).toEqual(session)
  expect(await client.literatureItem.findUnique({ where: { id: 'paper' } })).toMatchObject({
    title: 'Existing paper',
    readingStatus: 'unread'
  })
  expect(
    await client.$queryRaw`SELECT * FROM "_open_science_migrations" WHERE id <> ${readingId} ORDER BY id`
  ).toEqual(ledger)
  expect(await client.$queryRaw`PRAGMA foreign_key_check`).toEqual([])
  await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
})

it.each(['research checksum', 'historical checksum', 'missing predecessor'])(
  'rejects a research ledger with %s before applying reading status',
  async (corruption) => {
    await seedHistoricalDatabase('research')
    if (corruption === 'missing predecessor') {
      await client.$executeRaw`DELETE FROM "_open_science_migrations" WHERE id = '0050_literature_translation'`
    } else {
      await client.$executeRaw`UPDATE "_open_science_migrations" SET checksum = ${'a'.repeat(64)}
        WHERE id = ${corruption === 'research checksum' ? researchId : '0050_literature_translation'}`
    }
    const ledger = await readLedger()
    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_history_invalid'
    })
    expect(await readLedger()).toEqual(ledger)
    await expectReadingStatusAbsent()
    await expect(
      access(join(root, `open-science.db.before-${readingId}.backup`))
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
  }
)

it('rejects a research ledger whose recorded projection columns are missing', async () => {
  await seedHistoricalDatabase('research')
  await client.$executeRaw`ALTER TABLE "Session" DROP COLUMN "importedResearchId"`
  const ledger = await readLedger()
  await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
    code: 'database_validation_failed',
    migrationId: researchId
  })
  expect(await readLedger()).toEqual(ledger)
  await expectReadingStatusAbsent()
})

it('rolls back a failed bridge and can retry without altering the released research history', async () => {
  await seedHistoricalDatabase('research')
  const ledger = await readLedger()
  const session = await client.session.findUnique({ where: { id: 's' } })
  await client.$executeRawUnsafe(`CREATE TEMP TRIGGER reject_reading_status_ledger
    BEFORE INSERT ON "_open_science_migrations" WHEN NEW.id = '${readingId}'
    BEGIN SELECT RAISE(ABORT, 'synthetic ledger write failure'); END`)
  await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
    code: 'database_migration_failed',
    migrationId: readingId
  })
  expect(await readLedger()).toEqual(ledger)
  expect(await client.session.findUnique({ where: { id: 's' } })).toEqual(session)
  await expectReadingStatusAbsent()
  await client.$executeRaw`DROP TRIGGER reject_reading_status_ledger`
  const reusedBackups: boolean[] = []
  await expect(
    migrateApplicationDatabase(client, {
      onBackupReady: ({ reused }) => reusedBackups.push(reused)
    })
  ).resolves.toMatchObject({ applied: [readingId] })
  expect(reusedBackups).toEqual([true])
  expect(
    await client.$queryRaw`SELECT * FROM "_open_science_migrations" WHERE id <> ${readingId} ORDER BY id`
  ).toEqual(ledger)
})
