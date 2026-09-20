import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { pdfAnnotationsMigration } from './migrations/0042-pdf-annotations'
import { migrateApplicationDatabase } from './migration-service'

it('upgrades an existing database without copying or changing Bookmarks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-annotation-migration-'))
  const client = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'p1', name: 'Research' } })
    await client.bookmark.create({
      data: {
        id: 'saved-location',
        projectId: 'p1',
        sessionId: 's1',
        kind: 'text',
        sourceKind: 'agent-message',
        sourceId: 'message-1',
        sourceJson: '{}',
        selectorJson: '{}',
        quote: 'Original',
        note: 'Keep this'
      }
    })
    const before = await client.bookmark.findMany()
    await client.$executeRawUnsafe('DROP TABLE "pdf_annotations"')
    await client.$executeRawUnsafe(
      'DELETE FROM "_open_science_migrations" WHERE id >= \'0042_pdf_annotations\''
    )
    expect(await migrateApplicationDatabase(client)).toMatchObject({
      applied: [
        '0042_pdf_annotations',
        '0043_pdf_annotation_tags',
        '0044_literature_pdf_annotations',
        '0045_pdf_annotation_origin',
        '0046_pdf_annotation_import_receipt'
      ]
    })
    expect(await client.bookmark.findMany()).toEqual(before)
    expect(await client.pdfAnnotation.count()).toBe(0)
    const columns = await client.$queryRawUnsafe<Array<{ name: string; notnull: bigint }>>(
      'PRAGMA table_info("pdf_annotations")'
    )
    expect(columns.find(({ name }) => name === 'projectId')?.notnull).toBe(0n)
    expect(columns.find(({ name }) => name === 'sessionId')?.notnull).toBe(0n)
    const row = {
      id: 'library-note',
      sourceKind: 'literature-attachment-version',
      sourceFileId: 'file-1',
      versionId: 'version-1',
      checksum: 'a'.repeat(64),
      name: 'paper.pdf',
      path: 'literature-attachment-version:version-1',
      kind: 'document-note',
      selectorJson: '{"version":1,"selector":{"kind":"document-note","coordinateVersion":1}}'
    }
    expect(await client.pdfAnnotation.create({ data: row })).toMatchObject({
      origin: 'user',
      externalSubtype: null
    })
    expect(
      await client.pdfAnnotation.create({
        data: { ...row, id: 'imported-note', origin: 'imported', externalSubtype: 'Text' }
      })
    ).toMatchObject({ origin: 'imported', externalSubtype: 'Text' })
    await expect(
      client.pdfAnnotation.create({ data: { ...row, id: 'invalid-origin', origin: 'unknown' } })
    ).rejects.toThrow()
    await expect(
      client.pdfAnnotation.create({
        data: { ...row, id: 'invalid-subtype', origin: 'user', externalSubtype: 'Text' }
      })
    ).rejects.toThrow()
    await expect(
      client.pdfAnnotation.create({
        data: { ...row, id: 'invalid-upload', sourceKind: 'upload-version' }
      })
    ).rejects.toThrow()
    await expect(
      client.pdfAnnotation.create({ data: { ...row, id: 'invalid-half-scope', projectId: 'p1' } })
    ).rejects.toThrow()
    expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })
    expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('retires test tag names without losing annotation content or creating global Tags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-tag-retirement-'))
  const client = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'p1', name: 'Research' } })
    const tagsBefore = await client.tag.findMany()
    await client.$executeRawUnsafe('DROP TABLE "pdf_annotations"')
    for (const statement of pdfAnnotationsMigration.statements)
      await client.$executeRawUnsafe(statement)
    await client.$executeRawUnsafe(
      'DELETE FROM "_open_science_migrations" WHERE id >= ?',
      '0043_pdf_annotation_tags'
    )
    const selector = JSON.stringify({
      version: 1,
      selector: { kind: 'document-note', coordinateVersion: 1 }
    })
    await client.$executeRawUnsafe(
      `INSERT INTO "pdf_annotations" ("id", "projectId", "sessionId", "sourceKind", "sourceFileId", "versionId", "checksum", "name", "path", "kind", "selectorJson", "tagsJson", "note", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'a1',
      'p1',
      's1',
      'upload-version',
      'f1',
      'v1',
      'a'.repeat(64),
      'paper.pdf',
      'upload-version:v1',
      'document-note',
      selector,
      '["test tag"]',
      'Keep this note',
      new Date()
    )
    expect(await migrateApplicationDatabase(client)).toMatchObject({
      applied: [
        '0043_pdf_annotation_tags',
        '0044_literature_pdf_annotations',
        '0045_pdf_annotation_origin',
        '0046_pdf_annotation_import_receipt'
      ]
    })
    expect(await client.pdfAnnotation.findUnique({ where: { id: 'a1' } })).toMatchObject({
      note: 'Keep this note',
      origin: 'user',
      externalSubtype: null,
      selectorJson: selector,
      versionId: 'v1'
    })
    expect(await client.tag.findMany()).toEqual(tagsBefore)
    expect(await client.tagAssignment.count()).toBe(0)
    const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      'PRAGMA table_info("pdf_annotations")'
    )
    expect(columns.map(({ name }) => name)).not.toContain('tagsJson')
    expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
