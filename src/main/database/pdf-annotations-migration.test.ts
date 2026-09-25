import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase, verifyCurrentApplicationSchema } from './migration-service'

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
    for (const table of [
      'ClassificationUsage',
      'LiteratureSmartRunItem',
      'LiteratureSmartRun',
      'LiteratureSmartRuleRevision',
      'LiteratureSmartOverride',
      'LiteratureSmartAssessment',
      'LiteratureSmartCollection'
    ]) {
      await client.$executeRawUnsafe(`DROP TABLE "${table}"`)
    }
    await client.$executeRawUnsafe('DROP TABLE "pdf_annotations"')
    await client.$executeRawUnsafe('DROP TABLE "pdf_annotation_imports"')
    await client.$executeRawUnsafe(
      'DELETE FROM "_open_science_migrations" WHERE id >= \'0043_pdf_annotations\''
    )
    expect(await migrateApplicationDatabase(client)).toMatchObject({
      applied: [
        '0043_pdf_annotations',
        '0044_literature_smart_collections',
        '0045_literature_smart_pause_run'
      ]
    })
    expect(await client.bookmark.findMany()).toEqual(before)
    expect(await client.pdfAnnotation.count()).toBe(0)
    expect(await client.pdfAnnotationImport.count()).toBe(0)
    const columns = await client.$queryRawUnsafe<Array<{ name: string; notnull: bigint }>>(
      'PRAGMA table_info("pdf_annotations")'
    )
    expect(columns.find(({ name }) => name === 'projectId')?.notnull).toBe(0n)
    expect(columns.find(({ name }) => name === 'sessionId')?.notnull).toBe(0n)
    expect(columns.map(({ name }) => name)).not.toContain('tagsJson')
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
      client.pdfAnnotation.create({ data: { ...row, id: 'invalid-half-scope', sessionId: 's1' } })
    ).rejects.toThrow()
    await expect(
      client.pdfAnnotation.create({
        data: { ...row, id: 'project-note', projectId: 'p1', sourceKind: 'upload-version' }
      })
    ).resolves.toMatchObject({ sessionId: null })
    await expect(
      client.pdfAnnotation.create({ data: { ...row, id: 'invalid-mixed-scope', projectId: 'p1' } })
    ).rejects.toThrow()
    await client.pdfAnnotationImport.create({
      data: {
        id: 'receipt-1',
        sourceKind: row.sourceKind,
        sourceFileId: row.sourceFileId,
        versionId: row.versionId,
        checksum: row.checksum,
        resultJson: JSON.stringify({
          nativeRefs: [],
          pageCount: 1,
          unsupportedCount: 0,
          truncated: false
        })
      }
    })
    await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
    expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })
    expect(await client.pdfAnnotationImport.count()).toBe(1)
    expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
