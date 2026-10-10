import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient } from '../projects/prisma-client'
import {
  MIGRATION_MANIFEST,
  migrateApplicationDatabase,
  verifyCurrentApplicationSchema
} from './migration-service'
import { migrationSqlExecutor } from './migration-sql-executor'

const names = [
  ['bookmarks', 'Bookmark'],
  ['pdf_documents', 'PdfDocument'],
  ['pdf_annotation_documents', 'PdfAnnotationDocument'],
  ['pdf_annotation_sources', 'PdfAnnotationSourceBinding'],
  ['pdf_annotation_aliases', 'PdfAnnotationAlias'],
  ['pdf_annotations', 'PdfAnnotation'],
  ['pdf_annotation_imports', 'PdfAnnotationImport']
] as const
const checksum = 'a'.repeat(64)
let root: string
let client: ReturnType<typeof createProjectDbClient>

afterEach(async () => {
  vi.restoreAllMocks()
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})

const open = async (): Promise<void> => {
  root = await mkdtemp(join(tmpdir(), 'pascalcase-migration-'))
  client = createProjectDbClient(root)
}

const seedReleasedDatabase = async (): Promise<void> => {
  await open()
  await createDatabaseAtReleasedManifest(client)
  await client.project.create({ data: { id: 'project', name: 'Research' } })
  await client.$executeRaw`INSERT INTO bookmarks (id, projectId, sessionId, kind, sourceKind, sourceId, sourceJson, selectorJson, quote, note, createdAt, updatedAt)
    VALUES ('bookmark', 'project', 'historical-session', 'text', 'agent-message', 'message', '{}', '{}', 'Saved text', 'Keep note', 1234567890000, 1234567891000)`
  await client.$executeRaw`INSERT INTO pdf_documents (id, checksum, sizeBytes) VALUES ('pdf', ${checksum}, 42)`
  await client.contentBlob.create({
    data: {
      id: 'blob',
      pdfDocumentId: 'pdf',
      checksum,
      storageKey: 'test.pdf',
      sizeBytes: 42,
      state: 'available'
    }
  })
  await client.$executeRaw`INSERT INTO pdf_annotation_documents (id, pdfDocumentId, checksum, sizeBytes, revision) VALUES ('document', 'pdf', ${checksum}, 42, 17)`
  await client.$executeRaw`INSERT INTO pdf_annotation_sources (id, documentId, projectId, sourceSessionId, sourceKind, sourceFileId, versionId, checksum, name, path)
    VALUES ('source', 'document', 'project', 'historical-session', 'upload-version', 'file', 'version', ${checksum}, 'Paper.pdf', 'upload-version:version')`
  await client.$executeRaw`INSERT INTO pdf_annotations (id, documentId, nativeKey, nativeBaselineJson, projectId, sessionId, sourceSessionId, sourceKind, sourceFileId, versionId, checksum, name, path, kind, selectorJson, color, origin, externalSubtype, note, createdAt, updatedAt)
    VALUES ('annotation', 'document', '1:12R', '{"text":"Original"}', 'project', 'historical-session', 'historical-session', 'upload-version', 'file', 'version', ${checksum}, 'Paper.pdf', 'upload-version:version', 'highlight', '{"version":1,"selector":{"exact":"Evidence"}}', 'yellow', 'imported', 'Highlight', 'Edited note', 1234567890000, 1234567891000)`
  await client.$executeRaw`INSERT INTO pdf_annotation_aliases (id, documentId, annotationId) VALUES ('redirect', 'document', 'annotation'), ('tombstone', 'document', NULL)`
  await client.$executeRaw`INSERT INTO pdf_annotation_imports (id, documentId, projectId, sessionId, sourceKind, sourceFileId, versionId, checksum, resultJson)
    VALUES ('receipt', 'document', 'project', 'historical-session', 'upload-version', 'file', 'version', ${checksum}, '{"nativeRefs":[{"pageNumber":1,"id":"12R"}],"truncated":false}')`
}

it('initializes only canonical table names and reopens without another migration', async () => {
  await open()
  await migrateApplicationDatabase(client)
  const tables = await client.$queryRaw<
    Array<{ name: string }>
  >`SELECT name FROM sqlite_schema WHERE type = 'table'`
  for (const [oldName, newName] of names) {
    expect(tables.some(({ name }) => name === oldName)).toBe(false)
    expect(tables.some(({ name }) => name === newName)).toBe(true)
  }
  await client.$disconnect()
  client = createProjectDbClient(root)
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    applied: [],
    to: '0051_session_research_membership'
  })
  await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
})

it('preserves every value, ID, relationship, receipt and unrelated trigger across a released upgrade', async () => {
  await seedReleasedDatabase()
  const before = await Promise.all(
    names.map(([oldName]) => client.$queryRawUnsafe(`SELECT * FROM "${oldName}" ORDER BY id`))
  )
  const blob = await client.contentBlob.findMany()
  const triggers =
    await client.$queryRaw`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name`
  const ledger = await client.$queryRaw`SELECT * FROM _open_science_migrations ORDER BY id`
  const backups: string[] = []
  expect(
    await migrateApplicationDatabase(client, {
      onBackupReady: (backup) => {
        backups.push(backup.path)
      }
    })
  ).toMatchObject({
    applied: [
      '0049_pascalcase_table_names',
      '0050_literature_translation',
      '0051_session_research_membership'
    ]
  })
  for (const [index, [, table]] of names.entries())
    expect(await client.$queryRawUnsafe(`SELECT * FROM "${table}" ORDER BY id`)).toEqual(
      before[index]
    )
  expect(await client.contentBlob.findMany()).toEqual(blob)
  expect(
    await client.$queryRaw`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name`
  ).toEqual(triggers)
  expect(
    await client.$queryRaw`SELECT * FROM _open_science_migrations WHERE id < '0049_pascalcase_table_names' ORDER BY id`
  ).toEqual(ledger)
  expect(backups).toHaveLength(1)
  expect(
    (await readdir(root)).some((name) => name.includes('before-0049_pascalcase_table_names'))
  ).toBe(true)
  expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
  await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
  expect(await client.bookmark.findUnique({ where: { id: 'bookmark' } })).toMatchObject({
    note: 'Keep note'
  })
  expect(await client.pdfAnnotationAlias.findUnique({ where: { id: 'tombstone' } })).toMatchObject({
    annotationId: null
  })
  await expect(client.pdfDocument.delete({ where: { id: 'pdf' } })).rejects.toThrow()
  await client.project.delete({ where: { id: 'project' } })
  expect(await client.bookmark.count()).toBe(0)
  expect(await client.pdfAnnotation.count()).toBe(1)
  await client.contentBlob.delete({ where: { id: 'blob' } })
  await client.pdfDocument.delete({ where: { id: 'pdf' } })
  for (const [, table] of names.slice(2))
    expect(await client.$queryRawUnsafe(`SELECT * FROM "${table}"`)).toEqual([])
  expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
})

it('rolls back names, records and the ledger on failure and restores FK enforcement before retry', async () => {
  await seedReleasedDatabase()
  const execute = migrationSqlExecutor.execute.bind(migrationSqlExecutor)
  const spy = vi
    .spyOn(migrationSqlExecutor, 'execute')
    .mockImplementation(async (target, sql, ...values) => {
      if (sql === 'DROP TABLE "Bookmark"') throw new Error('injected rebuild failure')
      return execute(target, sql, ...values)
    })
  await expect(migrateApplicationDatabase(client)).rejects.toThrow()
  spy.mockRestore()
  for (const [oldName, newName] of names) {
    expect(await client.$queryRawUnsafe(`SELECT COUNT(*) AS count FROM "${oldName}"`)).not.toEqual([
      { count: 0n }
    ])
    expect(await client.$queryRaw`SELECT name FROM sqlite_schema WHERE name = ${newName}`).toEqual(
      []
    )
  }
  expect(await client.$queryRawUnsafe('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1n }])
  expect(
    await client.$queryRaw`SELECT id FROM _open_science_migrations WHERE id = '0049_pascalcase_table_names'`
  ).toEqual([])
  expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    applied: [
      '0049_pascalcase_table_names',
      '0050_literature_translation',
      '0051_session_research_membership'
    ]
  })
})

it('refuses mixed names without rewriting existing rows or recording success', async () => {
  await seedReleasedDatabase()
  await client.$executeRawUnsafe('CREATE TABLE "Bookmark" (id TEXT PRIMARY KEY)')
  await expect(migrateApplicationDatabase(client)).rejects.toThrow()
  expect(await client.$queryRaw`SELECT note FROM bookmarks WHERE id = 'bookmark'`).toEqual([
    { note: 'Keep note' }
  ])
  expect(
    await client.$queryRaw`SELECT id FROM _open_science_migrations WHERE id = '0049_pascalcase_table_names'`
  ).toEqual([])
})

it('keeps the released ledger identities immutable', () => {
  expect(MIGRATION_MANIFEST.find(({ id }) => id === '0048_pdf_annotation_sharing')).toMatchObject({
    id: '0048_pdf_annotation_sharing',
    checksum: '4d346933fd6779e0e7b15e1c51bb97043690230b40d29fb2d7c9dacc19f25e52'
  })
})

it('refuses a current database with a missing ledger before replaying or changing user data', async () => {
  await seedReleasedDatabase()
  await migrateApplicationDatabase(client)
  const before = await client.pdfAnnotation.findMany()
  await client.$executeRawUnsafe('DROP TABLE "_open_science_migrations"')
  await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
    code: 'database_validation_failed'
  })
  expect(await client.pdfAnnotation.findMany()).toEqual(before)
  expect(await client.contentBlob.findUnique({ where: { id: 'blob' } })).toMatchObject({
    pdfDocumentId: 'pdf'
  })
  expect(
    await client.$queryRaw`SELECT name FROM sqlite_schema WHERE name = '_open_science_migrations'`
  ).toEqual([])
  for (const [oldName] of names)
    expect(await client.$queryRaw`SELECT name FROM sqlite_schema WHERE name = ${oldName}`).toEqual(
      []
    )
})
