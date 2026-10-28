import { access, mkdtemp, rm } from 'node:fs/promises'
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
  type MigrationManifestEntry
} from './migration-service'

const researchId = '0052_session_research_membership'
const legacyResearchId = '0051_session_research_membership'
const legacyResearchChecksum = 'fbba1e83ef4fb800b7713330a1c1f34e1a758017236ec8fac9bf5cd7eac746db'
const readingId = '0051_literature_reading_status'
const researchMigration: MigrationManifestEntry = MIGRATION_MANIFEST.find(
  ({ id }) => id === researchId
)!
let root: string
let client: PrismaClient

afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})

const seedHistoricalDatabase = async (
  variant: 'upstream' | 'research' | 'research-with-reading'
): Promise<void> => {
  root = await mkdtemp(join(tmpdir(), 'research-membership-migration-'))
  client = createProjectDbClient(root)
  await createDatabaseAtReleasedManifest(
    client,
    MIGRATION_MANIFEST.filter(
      ({ id }) =>
        id !== (variant === 'upstream' ? researchId : variant === 'research' ? readingId : '')
    ).map((migration) =>
      variant !== 'upstream' && migration.id === researchId
        ? { ...migration, id: legacyResearchId, checksum: legacyResearchChecksum }
        : migration
    )
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

it('pins the old research identity to exactly the canonical projection payload', () => {
  expect(
    checksumMigrationPayload(
      legacyResearchId,
      researchMigration.statements,
      researchMigration.verifiers,
      researchMigration.operations
    )
  ).toBe(legacyResearchChecksum)
})

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
  ).resolves.toMatchObject({ from: legacyResearchId, to: researchId, applied: [readingId] })
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
  const upgradedLedger = await readLedger()
  await client.$disconnect()
  client = createProjectDbClient(root)
  await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
    from: legacyResearchId,
    to: researchId,
    applied: []
  })
  expect(await readLedger()).toEqual(upgradedLedger)
  expect(await client.session.findUnique({ where: { id: 's' } })).toEqual(session)
})

it.each(['research checksum', 'historical checksum', 'missing predecessor'])(
  'rejects a research ledger with %s before applying reading status',
  async (corruption) => {
    await seedHistoricalDatabase('research')
    if (corruption === 'missing predecessor') {
      await client.$executeRaw`DELETE FROM "_open_science_migrations" WHERE id = '0050_literature_translation'`
    } else {
      await client.$executeRaw`UPDATE "_open_science_migrations" SET checksum = ${'a'.repeat(64)}
        WHERE id = ${corruption === 'research checksum' ? legacyResearchId : '0050_literature_translation'}`
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

it.each(['research', 'research-with-reading'] as const)(
  'rejects %s history whose recorded projection columns are missing',
  async (variant) => {
    await seedHistoricalDatabase(variant)
    await client.$executeRaw`ALTER TABLE "Session" DROP COLUMN "importedResearchId"`
    const ledger = await readLedger()
    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: legacyResearchId
    })
    expect(await readLedger()).toEqual(ledger)
    if (variant === 'research') await expectReadingStatusAbsent()
  }
)

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

const futureMigration = (): MigrationManifestEntry => {
  const id = '0053_research_test_marker'
  const statements = ['UPDATE "Project" SET "name" = "name" WHERE 0'] as const
  const verifiers = [{ kind: 'table-exists', version: 1, table: 'Project' }] as const
  return {
    id,
    statements,
    verifiers,
    checksum: checksumMigrationPayload(id, statements, verifiers),
    backupOnApply: 'none',
    backupRetention: 'retain'
  }
}

it('reopens both released 0051 rows and accepts only a verified future canonical suffix', async () => {
  await seedHistoricalDatabase('research-with-reading')
  const oldLedger = await readLedger()
  await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
    from: legacyResearchId,
    to: researchId,
    applied: []
  })
  expect(await readLedger()).toEqual(oldLedger)
  const future = futureMigration()
  const manifest = [...MIGRATION_MANIFEST, future]
  await expect(migrateApplicationDatabaseWithManifest(client, manifest)).resolves.toMatchObject({
    from: legacyResearchId,
    to: future.id,
    applied: [future.id]
  })
  expect(
    await client.$queryRaw`SELECT * FROM "_open_science_migrations" WHERE id <> ${future.id} ORDER BY id`
  ).toEqual(oldLedger)
  const upgradedLedger = await readLedger()
  await client.$disconnect()
  client = createProjectDbClient(root)
  await expect(migrateApplicationDatabaseWithManifest(client, manifest)).resolves.toMatchObject({
    from: future.id,
    to: future.id,
    applied: []
  })
  await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
    code: 'database_newer_than_app'
  })
  await expect(
    migrateApplicationDatabaseWithManifest(client, [
      ...MIGRATION_MANIFEST,
      { ...future, checksum: 'b'.repeat(64) }
    ])
  ).rejects.toMatchObject({ code: 'database_history_invalid' })
  expect(await readLedger()).toEqual(upgradedLedger)
})

it.each(['research', 'research-with-reading'] as const)(
  'rejects simultaneous legacy and canonical research rows in %s history',
  async (variant) => {
    await seedHistoricalDatabase(variant)
    await client.$executeRaw`INSERT INTO "_open_science_migrations" (id, checksum)
      VALUES (${researchId}, ${researchMigration.checksum})`
    const ledger = await readLedger()
    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_history_invalid'
    })
    expect(await readLedger()).toEqual(ledger)
  }
)

it('does not bridge missing reading status for a canonical 0052 history', async () => {
  await seedHistoricalDatabase('research')
  await client.$executeRaw`UPDATE "_open_science_migrations"
    SET id = ${researchId}, checksum = ${researchMigration.checksum} WHERE id = ${legacyResearchId}`
  const ledger = await readLedger()
  await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
    code: 'database_history_invalid'
  })
  expect(await readLedger()).toEqual(ledger)
  await expectReadingStatusAbsent()
})

it('does not bridge a missing reading predecessor beneath an otherwise valid future suffix', async () => {
  await seedHistoricalDatabase('research')
  const future = futureMigration()
  await client.$executeRaw`INSERT INTO "_open_science_migrations" (id, checksum)
    VALUES (${future.id}, ${future.checksum})`
  const ledger = await readLedger()
  await expect(
    migrateApplicationDatabaseWithManifest(client, [...MIGRATION_MANIFEST, future])
  ).rejects.toMatchObject({ code: 'database_history_invalid' })
  expect(await readLedger()).toEqual(ledger)
  await expectReadingStatusAbsent()
})

it.each([readingId, researchId])(
  'does not alias against a modified canonical %s payload',
  async (id) => {
    await seedHistoricalDatabase('research')
    const ledger = await readLedger()
    await expect(
      migrateApplicationDatabaseWithManifest(
        client,
        MIGRATION_MANIFEST.map((migration) =>
          migration.id === id ? { ...migration, checksum: 'c'.repeat(64) } : migration
        )
      )
    ).rejects.toMatchObject({ code: 'database_history_invalid' })
    expect(await readLedger()).toEqual(ledger)
    await expectReadingStatusAbsent()
  }
)
