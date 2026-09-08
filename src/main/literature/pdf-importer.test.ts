import * as attachmentMedia from '../uploads/attachment-media'
import { createTestPdf } from '../../../test/fixtures/literature-pdf'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PENDING_UPLOAD_SESSION_ID, type UploadedAttachment } from '../../shared/uploads'
import type { LiteratureItemView } from '../../shared/literature'
import { LiteraturePdfImporter, type LiteraturePdfImporterOptions } from './pdf-importer'

const attachment = (path: string): UploadedAttachment => ({
  id: 'upload-1',
  sessionId: PENDING_UPLOAD_SESSION_ID,
  name: 'paper.pdf',
  originalName: 'Research paper.pdf',
  path,
  mimeType: 'application/pdf',
  size: 12
})

const item: LiteratureItemView = {
  id: 'item-1',
  item: {
    itemType: 'journalArticle',
    title: 'Research paper',
    abstract: '',
    issuedText: '',
    containerTitle: '',
    shortTitle: '',
    language: '',
    rights: '',
    url: '',
    extra: '',
    typeFields: {},
    creators: [],
    identifiers: []
  },
  attachments: [],
  projectIds: [],
  collectionIds: [],
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1
}

describe('LiteraturePdfImporter', () => {
  let root: string | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (root) await rm(root, { recursive: true, force: true })
  })

  const setup = async (
    bytes = createTestPdf()
  ): Promise<{
    importer: LiteraturePdfImporter
    options: LiteraturePdfImporterOptions
    path: string
  }> => {
    root = await mkdtemp(join(tmpdir(), 'open-science-literature-import-'))
    const path = join(root, 'staged.pdf')
    await writeFile(path, bytes)
    const options: LiteraturePdfImporterOptions = {
      uploads: {
        resolveManagedUploadPath: vi.fn(async () => path),
        deleteUpload: vi.fn(async () => undefined)
      },
      content: {
        verify: vi.fn(async () => ({
          state: 'available' as const,
          content: {
            id: 'blob-1',
            path,
            storageKey: 'content/blobs/aa/blob-1',
            checksum: 'a'.repeat(64),
            sizeBytes: BigInt(bytes.length),
            contentType: 'application/pdf'
          }
        })),
        sweep: vi.fn(async () => ({ removedIds: [], retainedIds: [], failedIds: [] })),
        withPublishedContent: vi.fn(async (_request, acquire) =>
          acquire({
            id: 'blob-1',
            path,
            storageKey: 'content/blobs/aa/blob-1',
            checksum: 'a'.repeat(64),
            sizeBytes: BigInt(bytes.byteLength),
            contentType: 'application/pdf'
          })
        )
      },
      catalog: {
        attachContent: vi.fn(async () => ({
          attachmentId: 'attachment-1',
          versionId: 'version-1'
        })),
        get: vi.fn(async () => item)
      }
    }
    return { importer: new LiteraturePdfImporter(options), options, path }
  }

  it('publishes a managed pending PDF and attaches its immutable content', async () => {
    const { importer, options, path } = await setup()

    await expect(
      importer.import({ itemId: item.id, attachment: attachment(path) })
    ).resolves.toEqual({ item })

    expect(options.uploads.resolveManagedUploadPath).toHaveBeenCalledWith(
      { path },
      { projectId: 'default-project', sessionId: PENDING_UPLOAD_SESSION_ID }
    )
    expect(options.content.withPublishedContent).toHaveBeenCalledWith(
      {
        sourcePath: path,
        contentType: 'application/pdf'
      },
      expect.any(Function)
    )
    expect(options.catalog.attachContent).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: item.id,
        contentBlobId: 'blob-1',
        filename: 'Research paper.pdf',
        contentType: 'application/pdf'
      })
    )
    expect(options.uploads.deleteUpload).toHaveBeenCalledWith({ path })
  })

  it.each([
    ['PasswordException', '[pdf-password]'],
    ['InvalidPDFException', '[pdf-invalid]'],
    ['UnknownErrorException', '[pdf-unreadable]']
  ])('reports %s distinctly and cleans up unattached publication', async (name, code) => {
    const { importer, options, path } = await setup()
    vi.spyOn(attachmentMedia, 'inspectPdfPageCount').mockRejectedValueOnce(
      Object.assign(new Error('parse failure'), { name })
    )
    await expect(
      importer.import({ itemId: item.id, attachment: attachment(path) })
    ).rejects.toThrow(code)
    expect(options.catalog.attachContent).not.toHaveBeenCalled()
    expect(options.content.sweep).toHaveBeenCalledWith({
      contentIds: ['blob-1'],
      createdBefore: expect.any(Date)
    })
    expect(options.uploads.deleteUpload).toHaveBeenCalledWith({ path })
  })

  it('rejects published bytes that change during parsing', async () => {
    const { importer, options, path } = await setup()
    vi.mocked(options.content.verify).mockResolvedValueOnce({
      state: 'unavailable',
      reason: 'checksum-mismatch'
    })
    await expect(
      importer.import({ itemId: item.id, attachment: attachment(path) })
    ).rejects.toThrow('[pdf-invalid]')
    expect(options.catalog.attachContent).not.toHaveBeenCalled()
    expect(options.content.sweep).toHaveBeenCalled()
  })

  it('rejects non-PDF bytes and still releases their staging copy', async () => {
    const { importer, options, path } = await setup(Buffer.from('not a pdf'))

    await expect(
      importer.import({ itemId: item.id, attachment: attachment(path) })
    ).rejects.toThrow('Selected file is not a PDF.')
    expect(options.content.withPublishedContent).not.toHaveBeenCalled()
    expect(options.uploads.deleteUpload).toHaveBeenCalledWith({ path })
  })
})
