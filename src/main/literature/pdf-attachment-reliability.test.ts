import { createHash } from 'node:crypto'
import { parseLiteratureDeletionError } from '../../shared/literature-deletion'
import { transactLiterature } from './transact'
import {
  mkdtemp,
  rm,
  writeFile,
  truncate,
  access,
  readFile,
  readdir,
  rename,
  chmod
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createLiteratureAttachmentVersionReference,
  parseLiteratureAttachmentVersionReference,
  literatureCatalogCommandSchema,
  literatureCatalogReceiptSchema,
  literatureItemInputSchema,
  literaturePdfImportRequestSchema,
  type LiteraturePdfImportRequest
} from '../../shared/literature'
import { createTestPdf as pdf } from '../../../test/fixtures/literature-pdf'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage,
  resolveActiveConversationMessages
} from '../../shared/conversation-graph'
import type { PersistedChatMessage } from '../../shared/session-persistence'
import { PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ContentRepository } from '../storage/content-repository'
import { inspectPdfPageCount } from '../uploads/attachment-media'
import { LiteratureAttachmentAuthority } from './attachment-authority'
import { LiteratureCatalog } from './catalog'
import { AgentPdfAcquisition } from './agent-pdf-acquisition'
import { LiteratureFullTextFinder } from './full-text-finder'
import { SessionRepository } from '../session-persistence/repository'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex
} from '../session-persistence/coordinator'
import { LiteraturePdfImporter } from './pdf-importer'
import { LiteratureFullTextIndex } from './full-text-index'
import { NodeVersionFileOperator } from '../managed-file-versions/version-file-operator'
import { LiteratureDocumentReader } from './document-reader'
import { SessionPdfSourceResolver } from './session-pdf-source-resolver'
import { ManagedPreviewResources } from '../managed-preview-resources'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

describe('Literature PDF attachment reliability', () => {
  let root: string
  let client: PrismaClient | undefined
  afterEach(async () => {
    vi.mocked(rm).mockImplementation(
      (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm
    )
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })
  const setup = async (
    bytes = pdf()
  ): Promise<{
    catalog: LiteratureCatalog
    changed: ReturnType<typeof vi.fn>
    content: ContentRepository
    importer: LiteraturePdfImporter
    request: LiteraturePdfImportRequest
    path: string
    authority: LiteratureAttachmentAuthority
    sessions: SessionRepository
    coordinator: SessionPersistenceCoordinator
  }> => {
    root = await mkdtemp(join(tmpdir(), 'literature-pdf-reliability-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    const content = new ContentRepository({ storageRoot: root, getClient: async () => client! })
    const sessions = new SessionRepository(join(root, 'sessions'))
    const coordinator = new SessionPersistenceCoordinator(sessions, {
      syncSession: async () => []
    } as unknown as SessionFileIndex)
    const changed = vi.fn()
    const catalog = new LiteratureCatalog(
      async () => client!,
      undefined,
      content,
      (remove) => coordinator.withLiteratureAttachmentRemoval(remove),
      changed
    )
    const item = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({ title: 'Paper', itemType: 'journalArticle' })
    })
    const path = join(root, 'selected.pdf')
    await writeFile(path, bytes)
    const importer = new LiteraturePdfImporter({
      catalog,
      content,
      uploads: { resolveManagedUploadPath: async () => path, deleteUpload: async () => undefined }
    })
    const request = {
      itemId: item.id,
      attachment: {
        id: 'upload',
        sessionId: PENDING_UPLOAD_SESSION_ID,
        name: 'paper.pdf',
        originalName: 'paper.pdf',
        path,
        mimeType: 'application/pdf',
        size: bytes.length
      }
    }
    return {
      changed,
      catalog,
      sessions,
      coordinator,
      content,
      importer,
      request,
      path,
      authority: new LiteratureAttachmentAuthority({ getClient: async () => client!, content })
    }
  }

  it.each(['unlink', 'sweep'] as const)(
    'reports pending cleanup when permanent deletion commits before a %s failure',
    async (failure) => {
      const { importer, request, catalog, content, authority } = await setup()
      const imported = await importer.import(request)
      const version = imported.item.attachments[0].versions[0]
      const resolved = await authority.resolveVersion(version.id)
      const [contentId] = await catalog.contentBlobIdsForItems([request.itemId])
      await catalog.transact({
        kind: 'set-item-lifecycle',
        itemIds: [request.itemId],
        state: 'deleted'
      })
      const actualRm = (
        await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      ).rm
      if (failure === 'unlink') {
        vi.mocked(rm).mockImplementation(async (path, options) => {
          if (String(path) === resolved!.path)
            throw Object.assign(new Error('File is locked'), { code: 'EPERM' })
          return actualRm(path, options)
        })
      } else vi.spyOn(content, 'sweep').mockRejectedValueOnce(new Error('Cleanup unavailable'))
      const receipt = await transactLiterature(catalog, content, {
        kind: 'delete-items-permanently',
        itemIds: [request.itemId]
      })
      expect(await client!.literatureItem.count()).toBe(0)
      expect(await client!.literatureAttachmentVersion.count()).toBe(0)
      expect(await readFile(resolved!.path)).toEqual(pdf())
      if (failure === 'unlink')
        expect(await client!.contentBlob.findUnique({ where: { id: contentId } })).toMatchObject({
          state: 'quarantined'
        })
      expect(literatureCatalogReceiptSchema.parse(receipt)).toMatchObject({
        state: 'deleted-permanently',
        cleanupPending: true
      })
      vi.mocked(rm).mockImplementation(actualRm)
      const restarted = new ContentRepository({ storageRoot: root, getClient: async () => client! })
      expect(
        await restarted.sweep({ createdBefore: new Date(Date.now() + 1), contentIds: [contentId] })
      ).toMatchObject({ removedIds: [contentId], failedIds: [] })
      await expect(access(resolved!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each([false, true])(
    'permanently deletes references while respecting shared content: %s',
    async (shared) => {
      const { importer, request, catalog, content, authority } = await setup()
      const imported = await importer.import(request)
      const version = imported.item.attachments[0].versions[0]
      const resolved = await authority.resolveVersion(version.id)
      if (shared) {
        const other = await catalog.transact({
          kind: 'create-item',
          item: literatureItemInputSchema.parse({
            title: 'Shared reference',
            itemType: 'journalArticle'
          })
        })
        await importer.import({ ...request, itemId: other.id })
      }
      await catalog.transact({
        kind: 'set-item-lifecycle',
        itemIds: [request.itemId],
        state: 'deleted'
      })
      const receipt = await transactLiterature(catalog, content, {
        kind: 'delete-items-permanently',
        itemIds: [request.itemId]
      })
      expect(receipt.state).toBe('deleted-permanently')
      expect(receipt.cleanupPending).not.toBe(true)
      if (shared) expect(await readFile(resolved!.path)).toEqual(pdf())
      else await expect(access(resolved!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('rejects active permanent deletion before attempting cleanup', async () => {
    const { request, catalog, content } = await setup()
    const sweep = vi.spyOn(content, 'sweep')
    await expect(
      transactLiterature(catalog, content, {
        kind: 'delete-items-permanently',
        itemIds: [request.itemId]
      })
    ).rejects.toThrow('Only Literature Items in Trash')
    expect(sweep).not.toHaveBeenCalled()
    expect(await catalog.get(request.itemId)).toBeDefined()
  })
  const saveReadingHistory = async (
    sessions: SessionRepository,
    attachment: Awaited<ReturnType<LiteraturePdfImporter['import']>>['item']['attachments'][number]
  ): Promise<void> => {
    const version = attachment.versions[0]
    await sessions.saveSession({
      id: 'reading-history',
      projectId: 'other-project',
      title: 'Retained reading history',
      cwd: root,
      status: 'idle',
      filesRevision: 0,
      createdAt: 1,
      updatedAt: 1,
      messages: [
        {
          id: 'reading-message',
          role: 'user',
          content: 'Read this PDF',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1,
          pdfContext: {
            version: 1,
            bindings: [
              {
                version: 1,
                bindingId: 'reading-binding',
                sourceKind: 'literature-attachment-version',
                sourceFileId: attachment.id,
                sourceVersionId: version.id,
                name: version.filename,
                mimeType: 'application/pdf',
                sizeBytes: version.sizeBytes,
                checksum: version.checksum,
                linkedAt: 1
              }
            ]
          }
        }
      ]
    })
  }

  it.each(['unrepaired', 'restored without reference'] as const)(
    'protects recoverable PDF history after quarantine: %s',
    async (state) => {
      const { importer, request, catalog, authority, sessions } = await setup()
      const attachment = (await importer.import(request)).item.attachments[0]
      await saveReadingHistory(sessions, attachment)
      const primary = join(sessions.recoveryFolderPath('other-project'), 'reading-history.json')
      const valid = await readFile(primary, 'utf8')
      const original = await authority.resolveVersion(attachment.versions[0].id)
      const remove = {
        kind: 'delete-attachment' as const,
        itemId: request.itemId,
        attachmentId: attachment.id
      }
      await writeFile(primary, valid + 'broken trailing bytes')
      expect((await sessions.loadAllWithDiagnostics({ mode: 'read-only' })).isComplete).toBe(false)
      await expect(catalog.transact(remove)).rejects.toThrow('complete Session catalog')
      await sessions.loadAllWithDiagnostics()
      await expect(access(primary)).rejects.toThrow()
      expect(
        (await readdir(sessions.recoveryFolderPath('other-project'))).some((name) =>
          name.startsWith('reading-history.json.invalid-')
        )
      ).toBe(true)
      const scan = await sessions.loadAllWithDiagnostics({ mode: 'read-only' })
      expect(scan.result.sessions).toEqual([])
      expect(scan.warnings).toContainEqual(
        expect.objectContaining({ kind: 'corrupt', recovered: true })
      )
      if (state === 'restored without reference') {
        const restored = JSON.parse(valid)
        restored.session.messages = []
        delete restored.session.conversationGraph
        await writeFile(primary, JSON.stringify(restored))
        await expect(catalog.transact(remove)).resolves.toMatchObject({ state: 'unlinked' })
        return
      }
      const outcome = await catalog.transact(remove).then(
        () => 'removed',
        (error) => {
          expect(parseLiteratureDeletionError(error)).toMatchObject({
            reason: 'scan-incomplete',
            issues: [
              {
                projectId: 'other-project',
                fileName: 'reading-history.json',
                kind: 'corrupt',
                recovered: true
              }
            ]
          })
          return 'blocked'
        }
      )
      expect.soft(outcome).toBe('blocked')
      expect.soft(await client!.literatureAttachmentVersion.count()).toBe(1)
      expect
        .soft(
          await access(original!.path).then(
            () => true,
            () => false
          )
        )
        .toBe(true)
      await writeFile(primary, valid)
      const restored = await sessions.loadSessionWithDiagnostics('other-project', 'reading-history')
      expect(restored.status).toBe('found')
      if (restored.status !== 'found') throw new Error('Restored history missing')
      expect(restored.session.messages[0].pdfContext!.bindings[0].sourceVersionId).toBe(
        attachment.versions[0].id
      )
      expect(await authority.resolveVersion(attachment.versions[0].id)).toBeDefined()
    }
  )

  it.each(['single', 'batch'] as const)(
    'preserves chat-bound PDF versions during %s permanent deletion',
    async (kind) => {
      const { importer, request, catalog, content, authority, sessions } = await setup()
      const attachment = (await importer.import(request)).item.attachments[0]
      await saveReadingHistory(sessions, attachment)
      const original = await authority.resolveVersion(attachment.versions[0].id)
      await expect(
        catalog.transact({
          kind: 'delete-attachment',
          itemId: request.itemId,
          attachmentId: attachment.id
        })
      ).rejects.toThrow('LITERATURE_ATTACHMENT_IN_USE')
      const itemIds = [request.itemId]
      if (kind === 'batch')
        itemIds.push(
          (
            await catalog.transact({
              kind: 'create-item',
              item: literatureItemInputSchema.parse({
                title: 'Unreferenced control',
                itemType: 'journalArticle'
              })
            })
          ).id
        )
      await catalog.transact({ kind: 'set-item-lifecycle', itemIds, state: 'deleted' })
      const outcome = await transactLiterature(catalog, content, {
        kind: 'delete-items-permanently',
        itemIds
      }).then(
        () => 'removed',
        () => 'blocked'
      )
      expect.soft(outcome).toBe('blocked')
      expect
        .soft(await client!.literatureItem.count({ where: { id: { in: itemIds } } }))
        .toBe(itemIds.length)
      expect.soft(await client!.literatureAttachmentVersion.count()).toBe(1)
      expect
        .soft(
          await access(original!.path).then(
            () => true,
            () => false
          )
        )
        .toBe(true)
      const stored = await sessions.loadSessionWithDiagnostics('other-project', 'reading-history')
      expect(stored.status).toBe('found')
      if (stored.status !== 'found') throw new Error('Reading history missing')
      expect(stored.session.messages[0].pdfContext!.bindings[0].sourceVersionId).toBe(
        attachment.versions[0].id
      )
    }
  )

  it('checks attachments retained on cascade aliases before deleting a trashed survivor', async () => {
    const { importer, request, catalog, content, sessions } = await setup()
    const attachment = (await importer.import(request)).item.attachments[0]
    await saveReadingHistory(sessions, attachment)
    const survivor = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({ title: 'Survivor', itemType: 'journalArticle' })
    })
    // Model the Catalog's supported retained alias relation with its own attachment rows.
    await client!.literatureItem.update({
      where: { id: request.itemId },
      data: { mergedIntoItemId: survivor.id, deletedAt: new Date() }
    })
    await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [survivor.id], state: 'deleted' })
    await expect(
      transactLiterature(catalog, content, {
        kind: 'delete-items-permanently',
        itemIds: [survivor.id]
      })
    ).rejects.toThrow('LITERATURE_ATTACHMENT_IN_USE')
    expect(await client!.literatureItem.count()).toBe(2)
    expect(await client!.literatureAttachmentVersion.count()).toBe(1)
  })

  it('fails closed for attachment deletion when the Catalog has no session guard', async () => {
    const { importer, request, content } = await setup()
    await importer.import(request)
    const unguarded = new LiteratureCatalog(async () => client!, undefined, content)
    await unguarded.transact({
      kind: 'set-item-lifecycle',
      itemIds: [request.itemId],
      state: 'deleted'
    })
    await expect(
      unguarded.transact({ kind: 'delete-items-permanently', itemIds: [request.itemId] })
    ).rejects.toThrow('attachment removal is unavailable')
    expect(await client!.literatureAttachmentVersion.count()).toBe(1)
  })

  // Valid equal-length PDFs keep size checks from masking the content-identity race.
  const textPdf = (label: string): Buffer => {
    const stream = `BT /F1 12 Tf 10 50 Td (${label}) Tj ET`
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      ...[1, 2].map(
        () =>
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>'
      ),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
    ]
    let text = '%PDF-1.4\n'
    const offsets: number[] = []
    objects.forEach((body, index) => {
      offsets.push(Buffer.byteLength(text))
      text += `${index + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = Buffer.byteLength(text)
    text += `xref\n0 7\n0000000000 65535 f \n`
    text += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    text += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(text)
  }

  it('keeps replacement text out of extraction caches and persistent search results', async () => {
    const original = textPdf('ORIGINAL')
    const replacement = textPdf('REPLACED')
    expect(replacement.length).toBe(original.length)
    const { importer, request, catalog, authority } = await setup(original)
    const imported = await importer.import(request)
    const attachment = imported.item.attachments[0]
    const version = attachment.versions[0]
    expect(version.pageCount).toBe(2)
    const sources = new SessionPdfSourceResolver({
      literature: authority,
      inputs: {
        resolveVersion: async () => undefined,
        openContent: async () => {
          throw new Error('Unexpected upload')
        }
      }
    })
    const makeReader = (): LiteratureDocumentReader =>
      new LiteratureDocumentReader({
        storageRoot: root,
        sources,
        sessions: {
          loadSessionForContinuation: async () => {
            throw new Error('Unexpected session')
          }
        }
      })
    const search = {
      projectId: 'project',
      attachmentId: attachment.id,
      attachmentVersionId: version.id,
      filename: version.filename,
      sizeBytes: version.sizeBytes,
      checksum: version.checksum,
      query: 'REPLACED'
    }
    const resolved = await authority.resolveVersion(version.id)
    const resolve = sources.resolveVersion.bind(sources)
    vi.spyOn(sources, 'resolveVersion').mockImplementationOnce(async (input) => {
      const verified = await resolve(input)
      await writeFile(resolved!.path, replacement)
      return verified
    })
    const reader = makeReader()
    const raced = await reader.searchAttachment(search).catch(() => undefined)
    if (raced !== undefined) expect.soft(raced).toMatchObject({ passages: [] })
    await expect(authority.resolveVersion(version.id)).rejects.toThrow('unavailable')
    await writeFile(resolved!.path, original)
    await catalog.transact({
      kind: 'verify-attachment',
      itemId: request.itemId,
      versionId: version.id
    })
    const cached = await reader.searchAttachment(search)
    const persisted = await makeReader().searchAttachment(search)
    // Inspect returned passages independently of response metadata.
    for (const result of [cached, persisted]) {
      expect.soft(result).toMatchObject({ passages: [] })
    }
    const control = await makeReader().searchAttachment({ ...search, query: 'ORIGINAL' })
    expect.soft(control).toMatchObject({
      passages: expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('ORIGINAL') })
      ])
    })
  })

  it('rebuilds pre-verification derived indexes from the current verified bytes', async () => {
    const { importer, request, authority } = await setup(textPdf('ORIGINAL'))
    const attachment = (await importer.import(request)).item.attachments[0]
    const version = attachment.versions[0]
    const fingerprint = createHash('sha256')
      .update('open-science-pdfjs-selectable-text-v1')
      .digest('hex')
    const extractionId = createHash('sha256')
      .update(`${version.checksum}:${fingerprint}`)
      .digest('hex')
    const index = await LiteratureFullTextIndex.open(root)
    try {
      await index.replace({
        extractionId,
        documentChecksum: version.checksum,
        extractorFingerprint: fingerprint,
        chunks: [{ pageStart: 1, pageEnd: 1, textStart: 0, textEnd: 8, content: 'REPLACED' }]
      })
    } finally {
      await index.close()
    }
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sources: new SessionPdfSourceResolver({
        literature: authority,
        inputs: { resolveVersion: vi.fn(), openContent: vi.fn() }
      }),
      sessions: { loadSessionForContinuation: vi.fn() }
    })
    const search = {
      projectId: 'project',
      attachmentId: attachment.id,
      attachmentVersionId: version.id,
      filename: version.filename,
      sizeBytes: version.sizeBytes,
      checksum: version.checksum
    }
    expect(await reader.searchAttachment({ ...search, query: 'REPLACED' })).toMatchObject({
      passages: []
    })
    expect(await reader.searchAttachment({ ...search, query: 'ORIGINAL' })).toMatchObject({
      retrievalMode: 'bm25',
      passages: expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('ORIGINAL') })
      ])
    })
  })

  it.skipIf(process.platform === 'win32')(
    'counts pages from the held bytes rather than a replacement pathname',
    async () => {
      const original = textPdf('ORIGINAL')
      const { importer, request, authority } = await setup(original)
      const version = (await importer.import(request)).item.attachments[0].versions[0]
      const resolved = (await authority.resolveVersion(version.id))!
      const lease = await new NodeVersionFileOperator({ storageRoot: root }).openImmutable(
        resolved.storageKey,
        { checksum: version.checksum, sizeBytes: version.sizeBytes }
      )
      try {
        const replacement = join(root, 'one-page.pdf')
        await writeFile(replacement, pdf())
        await rename(replacement, resolved.path)
        expect(
          await inspectPdfPageCount(lease.localPath, {
            size: lease.sizeBytes,
            readBytes: () => lease.readRange(0, lease.sizeBytes)
          })
        ).toBe(2)
      } finally {
        await lease.close()
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'extracts from the held lease when its pathname is atomically replaced',
    async () => {
      const original = textPdf('ORIGINAL')
      const { importer, request, authority } = await setup(original)
      const attachment = (await importer.import(request)).item.attachments[0]
      const version = attachment.versions[0]
      const sources = new SessionPdfSourceResolver({
        literature: authority,
        inputs: { resolveVersion: vi.fn(), openContent: vi.fn() }
      })
      const resolved = await authority.resolveVersion(version.id)
      const resolve = sources.resolveVersion.bind(sources)
      const close = vi.fn()
      vi.spyOn(sources, 'resolveVersion').mockImplementationOnce(async (input) => ({
        ...(await resolve(input))!,
        openContent: async () => {
          const lease = await new NodeVersionFileOperator({ storageRoot: root }).openImmutable(
            resolved!.storageKey,
            { checksum: version.checksum, sizeBytes: version.sizeBytes }
          )
          const replaced = join(root, 'replacement.pdf')
          try {
            await writeFile(replaced, textPdf('REPLACED'))
            await rename(replaced, resolved!.path)
          } catch (error) {
            await lease.close()
            throw error
          }
          return {
            path: lease.localPath,
            size: lease.sizeBytes,
            readRange: lease.readRange,
            verifyUnchanged: lease.verifyUnchanged,
            close: async () => {
              close()
              await lease.close()
            }
          }
        }
      }))
      const reader = new LiteratureDocumentReader({
        storageRoot: root,
        sources,
        sessions: { loadSessionForContinuation: vi.fn() }
      })
      expect(
        await reader.searchAttachment({
          projectId: 'project',
          attachmentId: attachment.id,
          attachmentVersionId: version.id,
          filename: version.filename,
          sizeBytes: version.sizeBytes,
          checksum: version.checksum,
          query: 'REPLACED'
        })
      ).toMatchObject({ passages: [] })
      expect(close).toHaveBeenCalledOnce()
    }
  )

  it('refuses old preview resources after their attachment is quarantined', async () => {
    const original = textPdf('ORIGINAL')
    const replacement = textPdf('REPLACED')
    const { importer, request, authority, catalog } = await setup(original)
    const version = (await importer.import(request)).item.attachments[0].versions[0]
    const resolved = await authority.resolveVersion(version.id)
    const resources = new ManagedPreviewResources({
      openLiterature: (reference) => authority.openReference(reference),
      resolvePath: async (_source, input) => {
        const id = parseLiteratureAttachmentVersionReference(input.path)
        if (!id) throw new Error('Invalid attachment reference')
        const value = await authority.resolveVersion(id)
        if (!value) throw new Error('Unavailable attachment')
        return value.path
      }
    })
    const input = {
      source: 'literature' as const,
      path: createLiteratureAttachmentVersionReference(version.id),
      mimeType: 'application/pdf'
    }
    const resource = await resources.acquire(17, input)
    const protocol = await resources.resolveProtocolResource(resource.id)
    try {
      expect(
        Buffer.from(
          (
            await resources.readRange(17, {
              resourceId: resource.id,
              begin: 0,
              end: original.length
            })
          ).data
        )
      ).toEqual(original)
      await writeFile(resolved!.path, replacement)
      await expect(authority.resolveVersion(version.id)).rejects.toThrow('unavailable')
      await expect(resources.acquire(17, input)).rejects.toThrow('unavailable')
      await expect(
        resources.readRange(17, { resourceId: resource.id, begin: 0, end: replacement.length })
      ).rejects.toThrow()
      expect(protocol).toHaveProperty('fileHandle')
      if (!('fileHandle' in protocol)) throw new Error('Expected a trusted protocol lease')
      await expect(
        protocol.fileHandle.read(Buffer.alloc(original.length), 0, original.length, 0)
      ).rejects.toThrow()
      await writeFile(resolved!.path, original)
      await catalog.transact({
        kind: 'verify-attachment',
        itemId: request.itemId,
        versionId: version.id
      })
      // A rejected resource cannot be resurrected by restoring its path.
      await expect(
        resources.readRange(17, { resourceId: resource.id, begin: 0, end: original.length })
      ).rejects.toThrow()
      const recovered = await resources.acquire(17, input)
      try {
        expect(
          Buffer.from(
            (
              await resources.readRange(17, {
                resourceId: recovered.id,
                begin: 0,
                end: original.length
              })
            ).data
          )
        ).toEqual(original)
      } finally {
        resources.release(17, { resourceId: recovered.id })
      }
    } finally {
      if ('fileHandle' in protocol) await protocol.fileHandle.close()
      resources.release(17, { resourceId: resource.id })
    }
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'records a permission-denied verification attempt and recovers after permission restoration',
    async () => {
      const { importer, request, catalog, authority, changed } = await setup()
      const version = (await importer.import(request)).item.attachments[0].versions[0]
      const resolved = await authority.resolveVersion(version.id)
      const row = await client!.literatureAttachmentVersion.findUniqueOrThrow({
        where: { id: version.id }
      })
      const retry = {
        kind: 'verify-attachment' as const,
        itemId: request.itemId,
        versionId: version.id
      }
      // Persist an old timestamp to make the attempt observation deterministic without sleeps.
      await client!.contentBlob.update({
        where: { id: row.contentBlobId },
        data: { lastVerificationAttemptAt: new Date(1) }
      })
      try {
        await chmod(resolved!.path, 0o000)
        await expect(readFile(resolved!.path)).rejects.toMatchObject({ code: 'EACCES' })
        changed.mockClear()
        await expect(catalog.transact(retry)).rejects.toThrow()
        expect
          .soft(changed)
          .toHaveBeenCalledWith(expect.objectContaining({ itemIds: [request.itemId] }))
        const after = (await catalog.get(request.itemId))!.attachments[0].versions[0]
        expect.soft(after.availability).toBe('unavailable')
        expect.soft(after.verificationFailure).toBeTruthy()
        expect.soft(after.verificationAttemptAt).toBeGreaterThan(1)
        expect(
          (await client!.contentBlob.findUniqueOrThrow({ where: { id: row.contentBlobId } })).state
        ).toBe('available')
      } finally {
        await chmod(resolved!.path, 0o644)
      }
      await catalog.transact(retry)
      expect((await catalog.get(request.itemId))!.attachments[0].versions[0]).toMatchObject({
        availability: 'available',
        verificationFailure: undefined
      })
    }
  )

  it('does not notify when the verification observation cannot be persisted', async () => {
    const { catalog, importer, request, changed } = await setup()
    const version = (await importer.import(request)).item.attachments[0].versions[0]
    const failure = new Error('Observation write failed')
    const persist = vi.spyOn(client!.contentBlob, 'updateMany').mockRejectedValueOnce(failure)
    changed.mockClear()
    try {
      await expect(
        catalog.transact({
          kind: 'verify-attachment',
          itemId: request.itemId,
          versionId: version.id
        })
      ).rejects.toBe(failure)
      expect(changed).not.toHaveBeenCalled()
    } finally {
      persist.mockRestore()
    }
  })

  it('invalidates other clients after attachment verification persists a changed observation', async () => {
    const { catalog, importer, request, authority, changed } = await setup()
    const imported = await importer.import(request)
    const version = imported.item.attachments[0].versions[0]
    const resolved = await authority.resolveVersion(version.id)
    await rm(resolved!.path)
    changed.mockClear()
    await expect(
      catalog.transact({ kind: 'verify-attachment', itemId: request.itemId, versionId: version.id })
    ).rejects.toThrow()
    expect((await catalog.get(request.itemId))!.attachments[0].versions[0].availability).toBe(
      'unavailable'
    )
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ itemIds: [request.itemId] }))
    changed.mockClear()
    await writeFile(resolved!.path, pdf())
    await catalog.transact({
      kind: 'verify-attachment',
      itemId: request.itemId,
      versionId: version.id
    })
    expect(changed).toHaveBeenCalledTimes(1)
    expect((await catalog.get(request.itemId))!.attachments[0].versions[0].availability).toBe(
      'available'
    )
  })

  it('rejects a header-only corrupt PDF before creating an attachment', async () => {
    const { importer, request, path } = await setup(Buffer.from('%PDF-1.7\nnot a document'))
    await expect(inspectPdfPageCount(path)).rejects.toThrow()
    await expect(importer.import(request)).rejects.toThrow()
    expect(await client!.literatureAttachment.count()).toBe(0)
  })

  it('records the page count of a successfully parsed local PDF', async () => {
    const { importer, request, path } = await setup()
    expect(await inspectPdfPageCount(path)).toBe(1)
    const result = await importer.import(request)
    expect(result.item.attachments[0].versions[0].pageCount).toBe(1)
  })

  it.each(['missing', 'corrupt'] as const)(
    'makes a confirmed %s file observable in the attachment view',
    async (failure) => {
      const { importer, request, path, content, catalog, authority } = await setup()
      expect(await inspectPdfPageCount(path)).toBe(1)
      const imported = await importer.import(request)
      const version = imported.item.attachments[0].versions[0]
      const resolved = await authority.resolveVersion(version.id)
      expect(resolved).toBeDefined()
      if (failure === 'missing') await rm(resolved!.path)
      else await writeFile(resolved!.path, 'broken')
      const row = await client!.literatureAttachmentVersion.findUniqueOrThrow({
        where: { id: version.id }
      })
      expect(await content.verify(row.contentBlobId)).toMatchObject({ state: 'unavailable' })
      expect(
        await client!.contentBlob.findUniqueOrThrow({ where: { id: row.contentBlobId } })
      ).toMatchObject({ state: 'quarantined' })
      await expect(authority.resolveVersion(version.id)).rejects.toThrow('unavailable')
      const after = await catalog.get(request.itemId)
      expect(after!.attachments[0].versions[0]).toMatchObject({
        availability: 'unavailable',
        verificationFailure: failure === 'missing' ? 'missing' : 'size-mismatch',
        verificationAttemptAt: expect.any(Number)
      })
      await client!.$disconnect()
      client = createProjectDbClient(root)
      expect((await catalog.get(request.itemId))!.attachments[0].versions[0]).toMatchObject({
        availability: 'unavailable'
      })
      const withPdf = await catalog.search({ scope: 'library', filter: { hasFullText: true } })
      expect(withPdf.entries.flatMap((entry) => ('id' in entry ? [entry.id] : []))).toContain(
        request.itemId
      )
      expect(
        (await catalog.search({ scope: 'library', filter: { hasFullText: false } })).entries
      ).toHaveLength(0)
      const verify = vi.spyOn(content, 'verify')
      await catalog.get(request.itemId)
      await catalog.search({ scope: 'library' })
      expect(verify).not.toHaveBeenCalled()
      await writeFile(resolved!.path, pdf())
      await catalog.transact({
        kind: 'verify-attachment',
        itemId: request.itemId,
        versionId: version.id
      })
      expect((await catalog.get(request.itemId))!.attachments[0].versions[0]).toMatchObject({
        availability: 'available',
        verificationFailure: undefined
      })
      await expect(authority.resolveVersion(version.id)).resolves.toBeDefined()
    }
  )

  it('quarantines missing bytes and rejects an unsuccessful attachment verification', async () => {
    const { importer, request, content, catalog, authority } = await setup()
    const imported = await importer.import(request)
    const version = imported.item.attachments[0].versions[0]
    const resolved = await authority.resolveVersion(version.id)
    await rm(resolved!.path)
    await expect(
      catalog.transact({
        kind: 'verify-attachment',
        itemId: request.itemId,
        versionId: version.id
      })
    ).rejects.toThrow()
    const row = await client!.literatureAttachmentVersion.findUniqueOrThrow({
      where: { id: version.id }
    })
    expect(
      await client!.contentBlob.findUniqueOrThrow({ where: { id: row.contentBlobId } })
    ).toMatchObject({
      state: 'quarantined',
      lastVerificationFailure: 'missing'
    })
    await expect(content.open(row.contentBlobId)).rejects.toThrow()
  })

  it.each(['local', 'full-text', 'agent'] as const)(
    'preserves published bytes while %s acquisition awaits its reference',
    async (kind) => {
      const { importer, request, content, catalog } = await setup()
      const imported = await importer.import(request)
      let resume!: () => void
      let reached!: () => void
      const paused = new Promise<void>((resolve) => {
        reached = resolve
      })
      const release = new Promise<void>((resolve) => {
        resume = resolve
      })
      const attach = catalog.attachContent.bind(catalog)
      const stage = catalog.stageAcquiredPdf.bind(catalog)
      if (kind === 'agent')
        vi.spyOn(catalog, 'stageAcquiredPdf').mockImplementationOnce(async (...args) => {
          reached()
          await release
          return stage(...args)
        })
      else
        vi.spyOn(catalog, 'attachContent').mockImplementationOnce(async (input) => {
          reached()
          await release
          return attach(input)
        })
      let acquire: () => Promise<unknown> = () => importer.import(request)
      if (kind === 'full-text') {
        const finder = new LiteratureFullTextFinder({
          catalog: {
            get: async (id) => {
              const item = await catalog.get(id)
              return (
                item && {
                  ...item,
                  item: {
                    ...item.item,
                    identifiers: [
                      { scheme: 'arxiv' as const, value: '2401.12345', isPrimary: true }
                    ]
                  }
                }
              )
            },
            attachContent: (input) => catalog.attachContent(input)
          },
          content,
          openAlexKey: async () => undefined,
          fetch: async () => Response.json({}),
          download: async () => pdf()
        })
        const found = await finder.run({ mode: 'search', itemId: request.itemId })
        if (found.mode !== 'search' || !found.candidates[0]) throw new Error('No PDF candidate')
        acquire = () =>
          finder.run({
            mode: 'attach',
            itemId: request.itemId,
            candidateId: found.candidates[0].id
          })
      } else if (kind === 'agent') {
        const service = new AgentPdfAcquisition({
          catalog,
          content,
          fullText: { discover: async () => ({ mode: 'search', candidates: [], notices: [] }) },
          download: async () => pdf()
        })
        acquire = () =>
          service.acquire({
            candidate: {
              item: imported.item.item,
              source: { provider: 'crossref', rawMetadata: {} }
            },
            origin: { kind: 'agent', projectId: 'project', sessionId: 'session' },
            pdfUrl: 'https://example.org/paper.pdf'
          })
      }
      const outcome = acquire().then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      await paused
      let sweepStarted!: () => void
      const sweeping = new Promise<void>((resolve) => {
        sweepStarted = resolve
      })
      const sweep = content.sweep.bind(content)
      vi.spyOn(content, 'sweep').mockImplementationOnce((request) => {
        sweepStarted()
        return sweep(request)
      })
      const removal = catalog.transact({
        kind: 'delete-attachment',
        itemId: request.itemId,
        attachmentId: imported.item.attachments[0].id
      })
      try {
        await sweeping
      } finally {
        resume()
      }
      await removal
      expect(await outcome).toHaveProperty('value')
    }
  )

  it('preserves an attachment referenced by a saved session until that context is unlinked', async () => {
    const { importer, request, catalog, authority, sessions, coordinator } = await setup()
    const imported = await importer.import(request)
    const attachment = imported.item.attachments[0]
    const version = attachment.versions[0]
    await sessions.saveSession({
      id: 'reading-session',
      projectId: 'project',
      title: 'Reading paper',
      cwd: root,
      status: 'idle',
      messages: [],
      filesRevision: 0,
      createdAt: 1,
      updatedAt: 1,
      runtimeContext: {
        version: 1,
        revision: 0,
        pdfContext: {
          version: 1,
          bindings: [
            {
              version: 1,
              bindingId: 'binding',
              sourceKind: 'literature-attachment-version',
              sourceFileId: attachment.id,
              sourceVersionId: version.id,
              name: version.filename,
              mimeType: 'application/pdf',
              sizeBytes: version.sizeBytes,
              checksum: version.checksum,
              linkedAt: 1
            }
          ]
        }
      }
    })
    const remove = {
      kind: 'delete-attachment' as const,
      itemId: request.itemId,
      attachmentId: attachment.id
    }
    await expect(catalog.transact(remove)).rejects.toThrow('LITERATURE_ATTACHMENT_IN_USE')
    await expect(authority.resolveVersion(version.id)).resolves.toBeDefined()
    await coordinator.patchSessionRuntimeContext({
      projectId: 'project',
      sessionId: 'reading-session',
      expectedRevision: 0,
      patch: { pdfContext: undefined }
    })
    await expect(catalog.transact(remove)).resolves.toMatchObject({ state: 'unlinked' })
    await expect(authority.resolveVersion(version.id)).resolves.toBeUndefined()
  })

  it.each(['legacy message', 'inactive branch'] as const)(
    'preserves a PDF referenced by a retained %s after the live context is unlinked',
    async (kind) => {
      const { importer, request, catalog, authority, sessions } = await setup()
      const imported = await importer.import(request)
      const attachment = imported.item.attachments[0]
      const version = attachment.versions[0]
      const message: PersistedChatMessage = {
        id: 'prompt',
        role: 'user',
        content: 'Read this paper',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        pdfContext: {
          version: 1,
          bindings: [
            {
              version: 1,
              bindingId: 'binding',
              sourceKind: 'literature-attachment-version',
              sourceFileId: attachment.id,
              sourceVersionId: version.id,
              name: version.filename,
              mimeType: 'application/pdf',
              sizeBytes: version.sizeBytes,
              checksum: version.checksum,
              linkedAt: 1
            }
          ]
        }
      }
      const graph =
        kind === 'inactive branch'
          ? forkEditedConversationMessage(
              createLinearConversationGraph({
                sessionId: 'history-session',
                messages: [message],
                createdAt: 1,
                updatedAt: 1
              }),
              message.id,
              'edited-branch',
              2
            )
          : undefined
      await sessions.saveSession({
        id: 'history-session',
        projectId: 'project',
        title: 'Reading history',
        cwd: root,
        status: 'idle',
        filesRevision: 0,
        createdAt: 1,
        updatedAt: 2,
        runtimeContext: { version: 1, revision: 1 },
        messages: graph ? resolveActiveConversationMessages(graph) : [message],
        ...(graph ? { conversationGraph: graph } : {})
      })
      const stored = await sessions.loadSessionWithDiagnostics('project', 'history-session')
      if (stored.status !== 'found') throw new Error('Saved session missing')
      const history = stored.session.conversationGraph?.messages ?? stored.session.messages
      expect(
        history.find(({ id }) => id === message.id)?.pdfContext?.bindings[0].sourceVersionId
      ).toBe(version.id)
      if (kind === 'inactive branch')
        expect(resolveActiveConversationMessages(stored.session.conversationGraph!)).toEqual([])
      await expect(authority.resolveVersion(version.id)).resolves.toBeDefined()
      await expect(
        catalog.transact({
          kind: 'delete-attachment',
          itemId: request.itemId,
          attachmentId: attachment.id
        })
      ).rejects.toThrow('LITERATURE_ATTACHMENT_IN_USE')
      await expect(authority.resolveVersion(version.id)).resolves.toBeDefined()
      const error = await catalog
        .transact({
          kind: 'delete-attachment',
          itemId: request.itemId,
          attachmentId: attachment.id
        })
        .catch((error) => error)
      expect(parseLiteratureDeletionError(error)).toMatchObject({
        reason: 'referenced',
        references: [
          {
            location: 'message-history',
            sessionId: 'history-session',
            projectId: 'project',
            messageId: message.id,
            versionId: version.id,
            ...(kind === 'inactive branch'
              ? { frameId: expect.any(String), branchId: expect.any(String) }
              : {})
          }
        ]
      })
    }
  )

  it('keeps different same-named PDFs as independent attachments without an explicit version target', async () => {
    const { importer, request, path } = await setup()
    expect(await inspectPdfPageCount(path)).toBe(1)
    await importer.import(request)
    await writeFile(path, pdf('second'))
    expect(await inspectPdfPageCount(path)).toBe(1)
    const result = await importer.import(request)
    expect(
      result.item.attachments.map((entry) => entry.versions.map((version) => version.versionNumber))
    ).toEqual([[1], [1]])
  })

  it('keeps old versions resolvable and removes the entire version chain without trashing the reference', async () => {
    const { importer, request, path, catalog, content, authority } = await setup()
    const first = await importer.import(request)
    const attachment = first.item.attachments[0]
    const oldVersion = attachment.versions[0]
    const oldContent = await authority.resolveVersion(oldVersion.id)
    expect(
      literaturePdfImportRequestSchema.safeParse({ ...request, attachmentId: attachment.id })
        .success
    ).toBe(false)

    // Version chains currently require the internal Catalog boundary, not normal local import.
    await writeFile(path, pdf('second'))
    await content.withPublishedContent(
      { sourcePath: path, contentType: 'application/pdf' },
      async (blob) => {
        await catalog.attachContent({
          itemId: request.itemId,
          attachmentId: attachment.id,
          contentBlobId: blob.id,
          filename: 'second.pdf',
          contentType: 'application/pdf',
          checksum: blob.checksum,
          sizeBytes: Number(blob.sizeBytes),
          pageCount: 1
        })
      }
    )
    const versions = (await catalog.get(request.itemId))!.attachments[0].versions
    expect(versions.map((entry) => entry.versionNumber)).toEqual([2, 1])
    const latestContent = await authority.resolveVersion(versions[0].id)
    await expect(authority.resolveVersion(oldVersion.id)).resolves.toMatchObject({
      path: oldContent!.path
    })
    await writeFile(path, pdf())
    const deduplicated = await importer.import(request)
    expect(deduplicated.item.attachments).toHaveLength(1)
    expect(deduplicated.item.attachments[0].versions.map((entry) => entry.id)).toEqual(
      versions.map((entry) => entry.id)
    )

    await catalog.transact({
      kind: 'delete-attachment',
      itemId: request.itemId,
      attachmentId: attachment.id
    })
    expect(await client!.literatureAttachmentVersion.count()).toBe(0)
    expect(await client!.contentBlob.count()).toBe(0)
    await expect(access(oldContent!.path)).rejects.toThrow()
    await expect(access(latestContent!.path)).rejects.toThrow()
    await expect(access(path)).resolves.toBeUndefined()
    expect((await catalog.get(request.itemId))!.deletedAt).toBeUndefined()
    expect((await catalog.search({ scope: 'library', lifecycle: 'deleted' })).entries).toHaveLength(
      0
    )
  })

  it('retains a PDF above the automatic processing limit without claiming a page count', async () => {
    const { importer, request, path } = await setup()
    await truncate(path, 50 * 1024 * 1024 + 1)
    const imported = await importer.import(request)
    expect(imported.item.attachments[0].versions[0]).toMatchObject({
      sizeBytes: 50 * 1024 * 1024 + 1,
      pageCount: undefined
    })
  })

  it('rejects an attachment removal with the wrong item owner', async () => {
    const { importer, request, catalog } = await setup()
    const imported = await importer.import(request)
    await expect(
      catalog.transact({
        kind: 'delete-attachment',
        itemId: 'different-item',
        attachmentId: imported.item.attachments[0].id
      })
    ).rejects.toThrow('unavailable')
    expect((await catalog.get(request.itemId))!.attachments).toHaveLength(1)
  })

  it('retains shared bytes when another reference still owns the same PDF', async () => {
    const { importer, request, catalog, authority } = await setup()
    const first = await importer.import(request)
    const other = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({ title: 'Other', itemType: 'journalArticle' })
    })
    const second = await importer.import({ ...request, itemId: other.id })
    await catalog.transact({
      kind: 'delete-attachment',
      itemId: request.itemId,
      attachmentId: first.item.attachments[0].id
    })
    await expect(
      authority.resolveVersion(second.item.attachments[0].versions[0].id)
    ).resolves.toBeDefined()
    expect(await client!.contentBlob.count()).toBe(1)
  })

  it('allows another project to read its session after attachment deletion commits while cleanup waits', async () => {
    const { importer, request, catalog, content, sessions, coordinator } = await setup()
    const imported = await importer.import(request)
    const attachment = imported.item.attachments[0]
    const version = attachment.versions[0]
    const pdfContext = {
      version: 1 as const,
      bindings: [
        {
          version: 1 as const,
          bindingId: 'stale-binding',
          sourceKind: 'literature-attachment-version' as const,
          sourceFileId: attachment.id,
          sourceVersionId: version.id,
          name: version.filename,
          mimeType: 'application/pdf' as const,
          sizeBytes: version.sizeBytes,
          checksum: version.checksum,
          linkedAt: 1
        }
      ]
    }
    const stale = await sessions.saveSession({
      id: 'reading-session',
      projectId: 'project',
      title: 'Reading paper',
      cwd: root,
      status: 'idle',
      filesRevision: 0,
      createdAt: 1,
      updatedAt: 1,
      messages: [
        {
          id: 'read-paper',
          role: 'user',
          content: 'Read this paper',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1,
          pdfContext
        }
      ],
      runtimeContext: { version: 1, revision: 0, pdfContext }
    })
    const current = await sessions.saveSession({
      ...stale,
      messages: [],
      conversationGraph: undefined,
      runtimeContext: { version: 1, revision: 1 }
    })
    await sessions.saveSession({
      id: 'other-session',
      projectId: 'other-project',
      title: 'Other project',
      cwd: root,
      status: 'idle',
      messages: [],
      filesRevision: 0,
      createdAt: 1,
      updatedAt: 1,
      runtimeContext: { version: 1, revision: 7 }
    })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const sweep = content.sweep.bind(content)
    vi.spyOn(content, 'sweep').mockImplementationOnce(async (input) => {
      entered()
      await gate
      return sweep(input)
    })
    const removal = catalog.transact({
      kind: 'delete-attachment',
      itemId: request.itemId,
      attachmentId: attachment.id
    })
    let read: ReturnType<typeof coordinator.readSessionRuntimeContext> | undefined
    try {
      await started
      expect(
        await client!.literatureAttachmentVersion.count({
          where: { attachmentId: attachment.id }
        })
      ).toBe(0)
      let completed = false
      read = coordinator.readSessionRuntimeContext('other-project', 'other-session')
      void read.then(() => {
        completed = true
      })
      // The gate stays closed throughout this assertion; the timeout is a deadlock guard,
      // not a disk-performance threshold.
      await vi.waitFor(() => expect(completed).toBe(true), { timeout: 2000 })
      await expect(read).resolves.toMatchObject({ revision: 7 })
      // A real stale transcript cannot reintroduce deleted bindings after the barrier releases.
      await expect(coordinator.saveSession(stale)).rejects.toMatchObject({
        code: 'session-revision-conflict'
      })
      // Even a current-revision renderer save cannot restore its stale main-owned PDF context.
      const saved = await coordinator.saveSession({
        ...current,
        runtimeContext: stale.runtimeContext
      })
      expect(saved.runtimeContext?.pdfContext).toBeUndefined()
      expect(saved.messages).toEqual([])
      const stored = await sessions.loadSessionWithDiagnostics('project', 'reading-session')
      expect(stored.status).toBe('found')
      if (stored.status !== 'found') throw new Error('Saved session missing')
      expect(stored.session.runtimeContext?.pdfContext).toBeUndefined()
      expect(stored.session.conversationGraph?.messages ?? stored.session.messages).toEqual([])
    } finally {
      release()
      await removal
      await read
    }
  })

  it('reports incomplete cleanup without undoing the committed attachment removal', async () => {
    const { importer, request, catalog, content } = await setup()
    const first = await importer.import(request)
    vi.spyOn(content, 'sweep').mockRejectedValueOnce(new Error('disk failure'))
    await expect(
      catalog.transact({
        kind: 'delete-attachment',
        itemId: request.itemId,
        attachmentId: first.item.attachments[0].id
      })
    ).resolves.toMatchObject({ cleanupPending: true, state: 'unlinked' })
    expect((await catalog.get(request.itemId))!.attachments).toHaveLength(0)
    expect(await client!.contentBlob.count()).toBe(1)
  })

  it('removes only the selected attachment through the public catalog command', async () => {
    const { importer, request, path, catalog, authority } = await setup()
    await client!.project.create({ data: { id: 'project', name: 'Research' } })
    await catalog.transact({
      kind: 'set-project-item',
      projectId: 'project',
      itemId: request.itemId,
      included: true,
      source: 'user'
    })
    const collection = await catalog.transact({
      kind: 'create-collection',
      name: 'Reading',
      description: ''
    })
    await catalog.transact({
      kind: 'set-collection-item',
      collectionId: collection.id,
      itemId: request.itemId,
      included: true
    })
    const first = await importer.import(request)
    const attachmentId = first.item.attachments[0].id
    const original = await authority.resolveVersion(first.item.attachments[0].versions[0].id)
    await writeFile(path, pdf('second'))
    const before = (await importer.import(request)).item
    const command = literatureCatalogCommandSchema.parse({
      kind: 'delete-attachment',
      itemId: request.itemId,
      attachmentId
    })
    await catalog.transact(command)
    const after = await catalog.get(request.itemId)
    expect(after!.item).toEqual(before.item)
    expect(after!.projectIds).toEqual(before.projectIds)
    expect(after!.collectionIds).toEqual(before.collectionIds)
    expect(after!.attachments.map((entry) => entry.id)).toEqual(
      before.attachments.filter((entry) => entry.id !== attachmentId).map((entry) => entry.id)
    )
    expect(await client!.literatureAttachmentVersion.count({ where: { attachmentId } })).toBe(0)
    await expect(access(original!.path)).rejects.toThrow()
  })
})
