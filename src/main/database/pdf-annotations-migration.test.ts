import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase, verifyCurrentApplicationSchema } from './migration-service'
import { PdfAnnotationRepository } from '../pdf-annotations/repository'
import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import { createUploadVersionReference } from '../../shared/uploads'
import type { PdfAnnotationSource } from '../../shared/pdf-annotations'

it('upgrades an existing database without copying or changing Bookmarks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-annotation-migration-'))
  const client = createProjectDbClient(root)
  try {
    await createDatabaseAtReleasedManifest(client)
    await client.project.create({ data: { id: 'p1', name: 'Research' } })
    await client.$executeRaw`INSERT INTO bookmarks (id, projectId, sessionId, kind, sourceKind, sourceId, sourceJson, selectorJson, quote, note, updatedAt)
      VALUES ('saved-location', 'p1', 's1', 'text', 'agent-message', 'message-1', '{}', '{}', 'Original', 'Keep this', 1234567890000)`
    const before = await client.$queryRaw`SELECT * FROM bookmarks`
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
        '0045_literature_smart_pause_run',
        '0046_journal_attributes',
        '0047_session_replay',
        '0048_pdf_annotation_sharing',
        '0049_pascalcase_table_names',
        '0050_literature_translation'
      ]
    })
    expect(await client.$queryRaw`SELECT * FROM "Bookmark"`).toEqual(before)
    expect(await client.pdfAnnotation.count()).toBe(0)
    expect(await client.pdfAnnotationImport.count()).toBe(0)
    const columns = await client.$queryRawUnsafe<Array<{ name: string; notnull: bigint }>>(
      'PRAGMA table_info("PdfAnnotation")'
    )
    expect(columns.find(({ name }) => name === 'projectId')?.notnull).toBe(0n)
    expect(columns.find(({ name }) => name === 'sessionId')?.notnull).toBe(0n)
    expect(columns.map(({ name }) => name)).not.toContain('tagsJson')
    await client.pdfAnnotationDocument.create({
      data: { id: 'fixture-document', checksum: 'a'.repeat(64) }
    })
    const row = {
      documentId: 'fixture-document',
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
        documentId: 'fixture-document',
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

it.each(['upload-version', 'artifact-version'] as const)(
  'migrates isolated historical sources and deletion-only %s receipts without changing user content',
  async (kind) => {
    const { pdfAnnotationsMigration } = await import('./migrations/0043-pdf-annotations')
    const root = await mkdtemp(join(tmpdir(), 'pdf-sharing-upgrade-'))
    const client = createProjectDbClient(root)
    try {
      await createDatabaseAtReleasedManifest(client)
      await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
      for (const table of [
        'pdf_annotations',
        'pdf_annotation_imports',
        'pdf_annotation_sources',
        'pdf_annotation_aliases',
        'pdf_annotation_documents'
      ])
        await client.$executeRawUnsafe(`DROP TABLE "${table}"`)
      for (const statement of pdfAnnotationsMigration.statements)
        await client.$executeRawUnsafe(statement)
      await client.$executeRawUnsafe(
        "DELETE FROM _open_science_migrations WHERE id = '0048_pdf_annotation_sharing'"
      )
      await client.project.createMany({
        data: [
          { id: 'legacy-p', name: 'Legacy' },
          { id: 'independent-p', name: 'Independent' }
        ]
      })
      for (const project of ['legacy-p', 'independent-p'])
        await client.$executeRaw`
      INSERT INTO pdf_annotations (id, projectId, sourceKind, sourceFileId, versionId, checksum, name, path, kind, selectorJson, note, updatedAt)
      VALUES (${project}, ${project}, 'upload-version', 'file', 'v', ${'a'.repeat(64)}, 'paper.pdf', 'upload-version:v', 'document-note', '{"version":1,"selector":{"kind":"document-note","coordinateVersion":1}}', 'Keep my edit', ${new Date('2026-09-01T00:00:00Z')})`
      const receipt = JSON.stringify({
        nativeRefs: [{ pageNumber: 1, id: '12R' }],
        pageCount: 1,
        unsupportedCount: 0,
        truncated: false
      })
      await client.$executeRaw`INSERT INTO pdf_annotation_imports (id, projectId, sessionId, sourceKind, sourceFileId, versionId, checksum, resultJson) VALUES ('deleted-native', 'legacy-p', 'legacy-session', ${kind}, 'deleted-file', 'deleted-v', ${'a'.repeat(64)}, ${receipt})`
      await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
      expect(await migrateApplicationDatabase(client)).toMatchObject({
        applied: [
          '0048_pdf_annotation_sharing',
          '0049_pascalcase_table_names',
          '0050_literature_translation'
        ]
      })
      const rows = await client.pdfAnnotation.findMany({ orderBy: { id: 'asc' } })
      expect(rows.map((row) => row.note)).toEqual(['Keep my edit', 'Keep my edit'])
      expect(new Set(rows.map((row) => row.documentId)).size).toBe(2)
      expect(rows.every((row) => row.updatedAt.toISOString() === '2026-09-01T00:00:00.000Z')).toBe(
        true
      )
      expect(await client.pdfAnnotationDocument.count()).toBe(3)
      expect(await client.pdfAnnotationSourceBinding.count()).toBe(3)
      expect(
        (await client.pdfAnnotationImport.findUniqueOrThrow({ where: { id: 'deleted-native' } }))
          .resultJson
      ).toBe(receipt)
      await expect(verifyCurrentApplicationSchema(client)).resolves.toBeUndefined()
      expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })

      const repository = new PdfAnnotationRepository(async () => client)
      // Migration placeholders cannot offer reconciliation before source authority verifies them.
      expect(
        (await repository.list({ projectId: 'legacy-p' })).reconciliationSources
      ).toBeUndefined()
      const restored: PdfAnnotationSource = {
        kind,
        projectId: 'legacy-p',
        sessionId: 'legacy-session',
        sourceFileId: 'deleted-file',
        versionId: 'deleted-v',
        checksum: 'a'.repeat(64),
        name: 'Restored paper.pdf',
        path:
          kind === 'artifact-version'
            ? createArtifactVersionLocator({
                projectId: 'legacy-p',
                appSessionId: 'legacy-session',
                artifactId: 'deleted-file',
                versionId: 'deleted-v'
              })
            : createUploadVersionReference('deleted-v', {
                projectId: 'legacy-p',
                sessionId: 'legacy-session',
                fileId: 'deleted-file'
              })
      }
      const existing: PdfAnnotationSource = {
        ...restored,
        kind: 'upload-version',
        sourceFileId: 'file',
        versionId: 'v',
        path: createUploadVersionReference('v', {
          projectId: 'legacy-p',
          sessionId: 'legacy-session',
          fileId: 'file'
        })
      }
      await repository.registerVerifiedSource(existing, 100)
      await repository.registerVerifiedSource(restored, 100)
      const pending = await repository.list({ projectId: 'legacy-p' })
      expect(pending.reconciliationSources).toEqual(expect.arrayContaining([restored]))
      expect(
        pending.reconciliationSources?.find((source) => source.versionId === 'deleted-v')
      ).toEqual(restored)
      await expect(repository.reconcileSource(restored, 100, [])).resolves.toBeNull()
      expect(
        (await repository.list({ projectId: 'legacy-p' })).reconciliationSources
      ).toBeUndefined()
      expect(
        (await repository.nativeImportReceipt({ projectId: 'legacy-p' }, restored))?.nativeRefs
      ).toEqual([{ pageNumber: 1, id: '12R' }])
    } finally {
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)
