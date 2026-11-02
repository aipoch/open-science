import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PrismaClient,
  type LiteratureIdentifier,
  type LiteratureItem,
  type LiteratureSourceRecord
} from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient } from '../projects/prisma-client'
import { LiteratureCatalog } from '../literature/catalog'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'

const DOI_MIGRATION_ID = '0053_literature_doi_identity'
const CURRENT_MIGRATION_ID = '0055_project_optimization_prompt'

describe('DOI identity migration', () => {
  let root: string | undefined
  let client: PrismaClient

  afterEach(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  const releasedDatabase = async (): Promise<void> => {
    root = await mkdtemp(join(tmpdir(), 'literature-doi-upgrade-'))
    client = createProjectDbClient(root)
    // Exercise the actual immutable released ledger, with no feature-owned historical DDL.
    await createDatabaseAtReleasedManifest(
      client,
      MIGRATION_MANIFEST.filter(({ id }) => id < DOI_MIGRATION_ID)
    )
    expect(
      await client.$queryRaw`SELECT id FROM "_open_science_migrations" ORDER BY id DESC LIMIT 1`
    ).toEqual([{ id: '0052_literature_personal_note_search' }])
    // The DOI backfill runs after the released physical-table rename, never against legacy PDF names.
    expect(
      await client.$queryRaw`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('PdfDocument', 'pdf_documents')`
    ).toEqual([{ name: 'PdfDocument' }])
  }

  const item = (id: string): Promise<LiteratureItem> =>
    client.literatureItem.create({
      data: {
        id,
        itemType: 'journalArticle',
        title: `Historical ${id}`,
        normalizedTitle: `historical ${id}`,
        metadataRevision: 7,
        createdAt: new Date(123456789),
        updatedAt: new Date(123456789)
      }
    })

  const identifier = (
    id: string,
    itemId: string,
    rawValue: string,
    normalizedValue: string
  ): Promise<LiteratureIdentifier> =>
    client.literatureIdentifier.create({
      data: {
        id,
        itemId,
        scheme: 'doi',
        rawValue,
        normalizedValue,
        isPrimary: true,
        createdAt: new Date(123456789)
      }
    })

  const snapshot = async (
    databaseClient: PrismaClient = client
  ): Promise<{
    items: LiteratureItem[]
    identifiers: LiteratureIdentifier[]
    sources: LiteratureSourceRecord[]
  }> => ({
    items: await databaseClient.literatureItem.findMany({ orderBy: { id: 'asc' } }),
    identifiers: await databaseClient.literatureIdentifier.findMany({ orderBy: { id: 'asc' } }),
    sources: await databaseClient.literatureSourceRecord.findMany({ orderBy: { id: 'asc' } })
  })

  it('upgrades historical DOI keys through the published PascalCase table migration', async () => {
    root = await mkdtemp(join(tmpdir(), 'literature-doi-pre-rename-'))
    client = createProjectDbClient(root)
    await createDatabaseAtReleasedManifest(
      client,
      MIGRATION_MANIFEST.filter(({ id }) => id < '0041_bookmarks')
    )
    // Seed through the historical table's actual columns; the current Prisma view includes fields
    // added after this released ledger, such as readingStatus, which do not exist yet.
    await client.$executeRaw`INSERT INTO "LiteratureItem"
      (id, "itemType", title, "metadataRevision", "updatedAt")
      VALUES ('before-pascalcase', 'journalArticle', 'Historical Unicode DOI', 7, 123456789)`
    await client.$executeRaw`INSERT INTO "LiteratureIdentifier"
      (id, "itemId", scheme, "rawValue", "normalizedValue", "isPrimary")
      VALUES ('historical-doi', 'before-pascalcase', 'doi', '10.1234/Ａ', '10.1234/a', true)`
    const before = await client.literatureIdentifier.findUniqueOrThrow({
      where: { id: 'historical-doi' }
    })
    expect(await migrateApplicationDatabase(client)).toMatchObject({
      from: '0040_literature_collection_revision',
      to: CURRENT_MIGRATION_ID,
      applied: expect.arrayContaining(['0049_pascalcase_table_names', DOI_MIGRATION_ID])
    })
    expect(
      await client.literatureIdentifier.findUniqueOrThrow({ where: { id: 'historical-doi' } })
    ).toEqual({ ...before, normalizedValue: '10.1234/Ａ' })
    expect(
      await client.literatureItem.findUniqueOrThrow({ where: { id: 'before-pascalcase' } })
    ).toMatchObject({
      title: 'Historical Unicode DOI',
      metadataRevision: 7,
      updatedAt: new Date(123456789),
      readingStatus: 'unread'
    })
    expect(
      await client.$queryRaw`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('PdfDocument', 'pdf_documents')`
    ).toEqual([{ name: 'PdfDocument' }])
    expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
  })

  it('retains committed personal-note backfill when the following DOI migration rolls back', async () => {
    root = await mkdtemp(join(tmpdir(), 'literature-note-doi-upgrade-'))
    client = createProjectDbClient(root)
    await createDatabaseAtReleasedManifest(
      client,
      MIGRATION_MANIFEST.filter(({ id }) => id < '0052_literature_personal_note_search')
    )
    await client.$executeRaw`INSERT INTO "LiteratureItem"
      (id, "itemType", title, "personalNote", "metadataRevision", "updatedAt")
      VALUES ('note-alias', 'journalArticle', 'Retained source', ' ＲＮＡ evidence ', 7, 123456789)`
    await identifier('alias-upper', 'note-alias', '10.1234/A', '10.1234/old-upper')
    await identifier('alias-lower', 'note-alias', '10.1234/a', '10.1234/old-lower')
    const identifiers = await client.literatureIdentifier.findMany({ orderBy: { id: 'asc' } })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
        migrationId: DOI_MIGRATION_ID
      })
      expect(
        await client.literatureItem.findUniqueOrThrow({ where: { id: 'note-alias' } })
      ).toMatchObject({
        personalNote: ' ＲＮＡ evidence ',
        normalizedPersonalNote: 'rna evidence',
        metadataRevision: 7,
        updatedAt: new Date(123456789)
      })
      expect(await client.literatureIdentifier.findMany({ orderBy: { id: 'asc' } })).toEqual(
        identifiers
      )
      expect(
        await client.$queryRaw`SELECT id FROM "_open_science_migrations" WHERE id >= '0052' ORDER BY id`
      ).toEqual([{ id: '0052_literature_personal_note_search' }])
    }
  })

  it('rebuilds DOI keys from retained Unicode raw values without changing metadata or sources', async () => {
    await releasedDatabase()
    const cases = [
      ['accent-upper', '10.1234/Á', '10.1234/á', '10.1234/Á'],
      ['accent-lower', '10.1234/á', '10.1234/á', '10.1234/á'],
      ['width', '10.1234/Ａ', '10.1234/a', '10.1234/Ａ'],
      ['ascii', '10.1234/A', '10.1234/a', '10.1234/a'],
      ['ascii-alias', '10.1234/a', '10.1234/a', '10.1234/a'],
      ['composed', '10.1234/é', '10.1234/é', '10.1234/é'],
      ['decomposed', '10.1234/e\u0301', '10.1234/é', '10.1234/e\u0301'],
      ['literal', '10.1234/A%23.;Copyright', '10.1234/a%23.;copyright', '10.1234/a%23.;copyright'],
      ['resolver', 'https://doi.org/10.1234/A%2523?download=1', '10.1234/a%23', '10.1234/a%23']
    ]
    for (const [id, raw, oldKey] of cases) {
      await item(id)
      await identifier(id, id, raw, oldKey)
    }
    await client.literatureIdentifier.create({
      data: {
        id: 'pmid',
        itemId: 'ascii',
        scheme: 'pmid',
        rawValue: '１２３',
        normalizedValue: '123'
      }
    })
    await client.literatureSourceRecord.create({
      data: {
        id: 'source',
        itemId: 'width',
        provider: 'zotero',
        externalId: 'original-key',
        rawMetadataJson: '{"DOI":"10.1234/Ａ"}',
        metadataChecksum: 'source-checksum'
      }
    })
    await client.literatureItem.update({
      where: { id: 'width' },
      data: {
        personalNote: 'Preserved note evidence',
        normalizedPersonalNote: 'preserved note evidence'
      }
    })
    const before = await snapshot()

    expect(await migrateApplicationDatabase(client)).toMatchObject({
      from: '0052_literature_personal_note_search',
      to: CURRENT_MIGRATION_ID,
      applied: [DOI_MIGRATION_ID, '0054_slurm_job_reliability', CURRENT_MIGRATION_ID]
    })
    const after = await snapshot()
    expect(after).toEqual({
      ...before,
      identifiers: before.identifiers.map((row) => ({
        ...row,
        normalizedValue: cases.find(([id]) => id === row.id)?.[3] ?? row.normalizedValue
      }))
    })
    expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
    expect(
      await client.$queryRaw`SELECT name FROM sqlite_temp_schema WHERE name LIKE '_literature_doi_identity_v1%'`
    ).toEqual([])
    expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })
    expect(await snapshot()).toEqual(after)
    const catalog = new LiteratureCatalog(async () => client)
    expect(
      await catalog.search({ scope: 'library', query: 'preserved note evidence' })
    ).toMatchObject({
      totalCount: 1
    })
  })

  it('rejects a canonical DOI database without its migration ledger', async () => {
    await releasedDatabase()
    await item('adopted')
    await identifier('adopted', 'adopted', '10.1234/Á', '10.1234/á')
    const before = await snapshot()
    await client.$executeRaw`DELETE FROM "_open_science_migrations"`
    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      cause: { message: 'A database with canonical table names requires its migration ledger.' }
    })
    expect(await snapshot()).toEqual(before)
    expect(await client.$queryRaw`SELECT id FROM "_open_science_migrations"`).toEqual([])
  })

  it('backfills DOI keys when adopting a real pre-bookmark schema with no ledger', async () => {
    root = await mkdtemp(join(tmpdir(), 'literature-doi-legacy-adoption-'))
    client = createProjectDbClient(root)
    await createDatabaseAtReleasedManifest(
      client,
      MIGRATION_MANIFEST.filter(({ id }) => id < '0041_bookmarks')
    )
    await client.$executeRaw`INSERT INTO "LiteratureItem"
      (id, "itemType", title, "metadataRevision", "updatedAt")
      VALUES ('legacy-adopted', 'journalArticle', 'Unledgered Unicode DOI', 7, 123456789)`
    const original = await identifier('legacy-adopted', 'legacy-adopted', '10.1234/Á', '10.1234/á')
    await client.$executeRaw`DELETE FROM "_open_science_migrations"`
    expect(await migrateApplicationDatabase(client)).toMatchObject({
      adoptedLegacy: true,
      to: CURRENT_MIGRATION_ID,
      applied: expect.arrayContaining([DOI_MIGRATION_ID])
    })
    expect(
      await client.literatureIdentifier.findUniqueOrThrow({ where: { id: 'legacy-adopted' } })
    ).toEqual({ ...original, normalizedValue: '10.1234/Á' })
    expect(
      await client.literatureItem.findUniqueOrThrow({ where: { id: 'legacy-adopted' } })
    ).toMatchObject({
      title: 'Unledgered Unicode DOI',
      metadataRevision: 7,
      updatedAt: new Date(123456789)
    })
    const after = await snapshot()
    expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })
    expect(await snapshot()).toEqual(after)
  })

  it('moves DOI keys without transient collisions with historical or staging-shaped keys', async () => {
    await releasedDatabase()
    await item('swap')
    await identifier('a', 'swap', '10.1234/Á', '10.1234/á')
    await identifier('b', 'swap', '10.1234/á', '10.1234/Á')
    await identifier(
      'c',
      'swap',
      '__open_science_doi_v1_migration__:a',
      '__open_science_doi_v1_migration__:a'
    )
    await identifier('d', 'swap', '__open_science_doi_v1_migration__:#a', 'historical-other-key')
    await migrateApplicationDatabase(client)
    expect(
      (await snapshot()).identifiers.map(({ id, normalizedValue }) => [id, normalizedValue])
    ).toEqual([
      ['a', '10.1234/Á'],
      ['b', '10.1234/á'],
      ['c', '__open_science_doi_v1_migration__:a'],
      ['d', '__open_science_doi_v1_migration__:#a']
    ])
  })

  it('rejects conflicting DOI aliases atomically while retaining every raw identifier', async () => {
    await releasedDatabase()
    await item('a-valid')
    await identifier('changed-first', 'a-valid', '10.1234/Á', '10.1234/á')
    await item('z-conflict')
    await identifier('alias-upper', 'z-conflict', '10.1234/A', '10.1234/A')
    await identifier('alias-lower', 'z-conflict', '10.1234/a', '10.1234/a')
    await client.literatureIdentifier.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        id: `alias-middle-${index}`,
        itemId: 'z-conflict',
        scheme: 'doi',
        rawValue: `10.1234/other${index}`,
        normalizedValue: `10.1234/other${index}`
      }))
    })
    const before = await snapshot()
    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: DOI_MIGRATION_ID,
      message: expect.stringContaining('duplicate DOI aliases'),
      cause: {
        data: {
          kind: 'literature-doi-identity-alias-conflict',
          actual: { itemId: 'z-conflict', identifierIds: ['alias-lower', 'alias-upper'] }
        }
      }
    })
    expect(await snapshot()).toEqual(before)
    expect(
      await client.$queryRaw`SELECT name FROM sqlite_temp_schema WHERE name LIKE '_literature_doi_identity_v1%'`
    ).toEqual([])
    expect(
      await client.$queryRaw`SELECT id FROM "_open_science_migrations" WHERE id = ${DOI_MIGRATION_ID}`
    ).toEqual([])
  })

  it('rolls back the entire DOI batch and retries after a failed update', async () => {
    await releasedDatabase()
    await item('rollback')
    await identifier('a-first', 'rollback', '10.1234/Á', '10.1234/á')
    await identifier('z-fail', 'rollback', '10.1234/Ａ', '10.1234/a')
    await client.literatureIdentifier.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        id: `batch-${index}`,
        itemId: 'rollback',
        scheme: 'doi',
        rawValue: `10.1234/Á${index}`,
        normalizedValue: `10.1234/á${index}`
      }))
    })
    const before = await snapshot()
    await client.$executeRawUnsafe(`CREATE TEMP TRIGGER refuse_doi_backfill BEFORE UPDATE OF "normalizedValue" ON "LiteratureIdentifier"
      WHEN OLD.id = 'z-fail' AND NEW."normalizedValue" = '10.1234/Ａ'
      BEGIN SELECT RAISE(ABORT, 'DOI backfill blocked'); END`)
    await expect(migrateApplicationDatabase(client)).rejects.toBeDefined()
    expect(await snapshot()).toEqual(before)
    expect(
      await client.$queryRaw`SELECT id FROM "_open_science_migrations" WHERE id = ${DOI_MIGRATION_ID}`
    ).toEqual([])
    await client.$executeRawUnsafe('DROP TRIGGER refuse_doi_backfill')
    expect(await migrateApplicationDatabase(client)).toMatchObject({
      applied: [DOI_MIGRATION_ID, '0054_slurm_job_reliability', CURRENT_MIGRATION_ID]
    })
    expect(
      (await snapshot()).identifiers
        .filter(({ id }) => !id.startsWith('batch-'))
        .map(({ normalizedValue }) => normalizedValue)
    ).toEqual(['10.1234/Á', '10.1234/Ａ'])
    expect(
      await client.literatureIdentifier.count({
        where: { normalizedValue: { startsWith: '10.1234/Á' } }
      })
    ).toBe(502)
  })

  it('recovers a DOI alias conflict with an archived original and a repaired recovery point', async () => {
    await releasedDatabase()
    const databasePath = join(root!, 'open-science.db')
    const backupPath = `${databasePath}.before-${DOI_MIGRATION_ID}.backup`
    const archivePath = `${backupPath}.original-alias-conflict-archive`
    await item('verified-repair')
    await identifier('ascii-original', 'verified-repair', '10.1234/A', '10.1234/A')
    await identifier('misrecorded-unicode', 'verified-repair', '10.1234/a', '10.1234/a')
    // The source supplies independent repair evidence; do not invent a different DOI to bypass aliases.
    await client.literatureSourceRecord.create({
      data: {
        id: 'repair-evidence',
        itemId: 'verified-repair',
        provider: 'zotero',
        externalId: 'misrecorded-unicode',
        rawMetadataJson: '{"DOI":"10.1234/Á"}',
        metadataChecksum: 'original-source-evidence'
      }
    })
    const original = await snapshot()
    const originalLedger = await client.$queryRaw<{ id: string; checksum: string }[]>`
      SELECT id, checksum FROM "_open_science_migrations" ORDER BY id`
    const ready: { path: string; reused: boolean }[] = []
    const options = {
      databasePath,
      onBackupReady: (event: { path: string; reused: boolean }): void => {
        ready.push(event)
      }
    }
    const conflict: unknown = await migrateApplicationDatabase(client, options).catch(
      (error: unknown) => error
    )
    expect(conflict).toMatchObject({
      code: 'database_validation_failed',
      migrationId: DOI_MIGRATION_ID,
      cause: { data: { kind: 'literature-doi-identity-alias-conflict' } }
    })
    expect(await snapshot()).toEqual(original)
    expect(ready).toMatchObject([{ path: backupPath, reused: false }])
    await client.$disconnect()
    const originalBytes = await readFile(backupPath)

    // Negative control: omit archiving, make the source-verified persistent correction while the
    // application is closed, and prove that the original canonical backup blocks the next start.
    client = createProjectDbClient(root!)
    await client.literatureIdentifier.update({
      where: { id: 'misrecorded-unicode' },
      data: { rawValue: '10.1234/Á' }
    })
    const repaired = await snapshot()
    await client.$disconnect()
    client = createProjectDbClient(root!)
    await expect(migrateApplicationDatabase(client, options)).rejects.toMatchObject({
      code: 'database_validation_failed',
      migrationId: DOI_MIGRATION_ID,
      cause: { data: { kind: 'backup-content-mismatch', table: 'LiteratureIdentifier' } }
    })
    expect(await snapshot()).toEqual(repaired)
    expect(
      await client.$queryRaw`SELECT id, checksum FROM "_open_science_migrations" ORDER BY id`
    ).toEqual(originalLedger)
    expect(await readFile(backupPath)).toEqual(originalBytes)
    expect(ready).toHaveLength(1)
    await client.$disconnect()

    // An unused archive name preserves the old snapshot; the service owns creating the fresh one.
    await rename(backupPath, archivePath)
    expect(await readFile(archivePath)).toEqual(originalBytes)
    client = createProjectDbClient(root!)
    expect(await migrateApplicationDatabase(client, options)).toMatchObject({
      applied: [DOI_MIGRATION_ID, '0054_slurm_job_reliability', CURRENT_MIGRATION_ID]
    })
    expect(ready).toMatchObject([
      { path: backupPath, reused: false },
      { path: backupPath, reused: false }
    ])
    expect(await snapshot()).toEqual({
      ...repaired,
      identifiers: repaired.identifiers.map((row) => ({
        ...row,
        normalizedValue: row.id === 'ascii-original' ? '10.1234/a' : '10.1234/Á'
      }))
    })
    expect(
      await client.$queryRaw`SELECT id FROM "_open_science_migrations" WHERE id = ${DOI_MIGRATION_ID}`
    ).toEqual([{ id: DOI_MIGRATION_ID }])
    await client.$disconnect()

    for (const [path, expected] of [
      [archivePath, original],
      [backupPath, repaired]
    ] as const) {
      const backup = new PrismaClient({
        datasources: { db: { url: `file:${path.replaceAll('\\', '/')}?connection_limit=1` } }
      })
      try {
        expect(await snapshot(backup)).toEqual(expected)
        expect(
          await backup.$queryRaw`SELECT id, checksum FROM "_open_science_migrations" ORDER BY id`
        ).toEqual(originalLedger)
      } finally {
        await backup.$disconnect()
      }
    }
    expect(await readFile(archivePath)).toEqual(originalBytes)
    expect(await readFile(backupPath)).not.toEqual(originalBytes)
    const message = (conflict as Error).message
    expect(message).toContain('Close Open Science and all database connections')
    expect(message).toContain(
      'If open-science.db.before-0053_literature_doi_identity.backup exists'
    )
    expect(message).toContain('distinct unused archive name')
    expect(message).toContain('verify the archived bytes')
    expect(message).toContain('before making verified corrections')
    expect(message).toContain('create a fresh backup')
  })

  it('skips already correct ASCII DOI rows rather than rewriting them', async () => {
    await releasedDatabase()
    await item('unchanged')
    await identifier('unchanged', 'unchanged', '10.1234/ALREADY', '10.1234/already')
    await client.$executeRawUnsafe(`CREATE TEMP TRIGGER refuse_unchanged_doi BEFORE UPDATE ON "LiteratureIdentifier"
      BEGIN SELECT RAISE(ABORT, 'unchanged DOI was rewritten'); END`)
    expect(await migrateApplicationDatabase(client)).toMatchObject({
      applied: [DOI_MIGRATION_ID, '0054_slurm_job_reliability', CURRENT_MIGRATION_ID]
    })
  })
})
