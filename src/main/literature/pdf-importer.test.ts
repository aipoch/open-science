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
    if (root) await rm(root, { recursive: true, force: true })
  })

  const setup = async (
    bytes = Buffer.from('%PDF-1.7\nbody')
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
        publish: vi.fn(async () => ({
          id: 'blob-1',
          path: join(root!, 'published.pdf'),
          storageKey: 'content/blobs/aa/blob-1',
          checksum: 'a'.repeat(64),
          sizeBytes: BigInt(bytes.byteLength),
          contentType: 'application/pdf'
        }))
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
    expect(options.content.publish).toHaveBeenCalledWith({
      sourcePath: path,
      contentType: 'application/pdf'
    })
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

  it('rejects non-PDF bytes and still releases their staging copy', async () => {
    const { importer, options, path } = await setup(Buffer.from('not a pdf'))

    await expect(
      importer.import({ itemId: item.id, attachment: attachment(path) })
    ).rejects.toThrow('Selected file is not a PDF.')
    expect(options.content.publish).not.toHaveBeenCalled()
    expect(options.uploads.deleteUpload).toHaveBeenCalledWith({ path })
  })
})
