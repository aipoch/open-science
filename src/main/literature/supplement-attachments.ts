import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { unzipSync } from 'fflate'
import type { LiteratureSupplementFinder } from '@aipoch/literature-discovery'
import {
  getSupplementDoi,
  literatureSupplementAttachmentRequestSchema,
  type LiteratureSupplementAttachmentRequest,
  type LiteratureFullTextProgress,
  type LiteratureSupplementAttachmentResult
} from '@aipoch/literature-discovery/contracts'
import type { downloadFullText } from '@aipoch/literature-discovery/download'
import type { LiteratureCatalog } from './catalog'
import type { ContentRepository } from '../storage/content-repository'

const MAX_BYTES = 50 * 1024 * 1024
const contentTypes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

// Never unpack an archive onto disk; select exactly one source-declared file under a size cap.
export function extractSupplementFile(bytes: Buffer, filename: string): Buffer {
  let matches = 0
  const files = unzipSync(bytes, {
    filter: (entry) => {
      const parts = entry.name.replaceAll('\\', '/').split('/')
      if (entry.name.startsWith('/') || parts.includes('..') || parts.at(-1) !== filename)
        return false
      matches++
      if (matches > 1 || entry.originalSize > MAX_BYTES)
        throw new Error('Invalid supplementary archive entry.')
      return true
    }
  })
  const file = Object.values(files)[0]
  if (matches !== 1 || !file?.length || file.length > MAX_BYTES)
    throw new Error('Supplementary file is absent or too large.')
  return Buffer.from(file)
}

export class LiteratureSupplementAttachments {
  private readonly transfers = new Map<string, LiteratureFullTextProgress>()
  private readonly pending = new Map<string, Promise<LiteratureSupplementAttachmentResult>>()
  constructor(
    private readonly options: {
      finder: Pick<LiteratureSupplementFinder, 'getDownload'>
      catalog: Pick<LiteratureCatalog, 'get' | 'attachContent'>
      content: Pick<ContentRepository, 'withPublishedContent'>
      download: typeof downloadFullText
      pageCount: (path: string) => Promise<number>
    }
  ) {}

  progress(input: LiteratureSupplementAttachmentRequest): LiteratureFullTextProgress | null {
    const request = literatureSupplementAttachmentRequestSchema.parse(input)
    const value = this.transfers.get(
      `${request.itemId}:${request.expectedMetadataRevision}:${request.downloadId}`
    )
    return value ? { ...value } : null
  }

  run(
    input: LiteratureSupplementAttachmentRequest,
    signal: AbortSignal
  ): Promise<LiteratureSupplementAttachmentResult> {
    const request = literatureSupplementAttachmentRequestSchema.parse(input)
    const key = `${request.itemId}:${request.expectedMetadataRevision}:${request.downloadId}`
    const existing = this.pending.get(key)
    if (existing) return existing
    this.transfers.set(key, { phase: 'downloading', receivedBytes: 0, bytesPerSecond: 0 })
    const operation = this.attach(request, signal, (progress) =>
      this.transfers.set(key, { ...progress })
    ).finally(() => {
      this.pending.delete(key)
      this.transfers.delete(key)
    })
    this.pending.set(key, operation)
    return operation
  }

  private async attach(
    request: LiteratureSupplementAttachmentRequest,
    signal: AbortSignal,
    onProgress: (progress: LiteratureFullTextProgress) => void
  ): Promise<LiteratureSupplementAttachmentResult> {
    const selected = this.options.finder.getDownload(
      request.downloadId,
      request.itemId,
      request.expectedMetadataRevision
    )
    const check = async (): Promise<void> => {
      signal.throwIfAborted()
      const item = await this.options.catalog.get(request.itemId)
      if (
        !item ||
        item.deletedAt !== undefined ||
        item.metadataRevision !== request.expectedMetadataRevision ||
        getSupplementDoi(item.item.identifiers) !== selected.doi
      )
        throw new Error('The reference changed. Search for supplementary materials again.')
    }
    await check()
    const filename = selected.filename
      .replaceAll('\\', '/')
      .split('/')
      .at(-1)!
      .replace(/[<>:"|?*\p{Cc}]/gu, '_')
      .slice(0, 240)
    const extension = extname(filename).toLowerCase()
    const contentType = contentTypes[extension] ?? 'application/octet-stream'
    let bytes = await this.options.download(
      selected.url,
      MAX_BYTES,
      onProgress,
      undefined,
      signal,
      undefined,
      { accept: selected.archiveEntry ? 'application/zip' : '*/*', timeoutMs: 180_000 }
    )
    onProgress({
      phase: 'saving',
      receivedBytes: bytes.length,
      totalBytes: bytes.length,
      bytesPerSecond: 0
    })
    if (bytes.length > MAX_BYTES) throw new Error('Supplementary file exceeds 50 MB.')
    if (selected.archiveEntry) bytes = extractSupplementFile(bytes, selected.archiveEntry)
    if (
      !bytes.length ||
      /^\s*(?:<!doctype html|<html)/iu.test(bytes.subarray(0, 256).toString('utf8'))
    )
      throw new Error('The source did not return a supplementary file.')
    if (extension === '.pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-')
      throw new Error('Invalid supplementary PDF.')
    if (
      ['.docx', '.xlsx', '.pptx', '.zip'].includes(extension) &&
      (bytes.length < 2 || bytes.readUInt16LE(0) !== 0x4b50)
    )
      throw new Error('Invalid supplementary document.')
    const directory = await mkdtemp(join(tmpdir(), 'open-science-supplement-'))
    try {
      const path = join(directory, `attachment${extension.replace(/[^.a-z0-9]/gu, '')}`)
      await writeFile(path, bytes, { mode: 0o600 })
      const pageCount = extension === '.pdf' ? await this.options.pageCount(path) : undefined
      await check()
      return await this.options.content.withPublishedContent(
        { sourcePath: path, contentType },
        async (content) => {
          await check()
          return this.options.catalog.attachContent({
            itemId: request.itemId,
            expectedMetadataRevision: request.expectedMetadataRevision,
            kind: 'supplementary',
            title: filename,
            contentBlobId: content.id,
            filename,
            contentType,
            sizeBytes: Number(content.sizeBytes),
            checksum: content.checksum,
            pageCount,
            provenance: {
              provider: selected.provider,
              source: selected.provider,
              sourceUrl: selected.sourceUrl,
              acquiredAt: Date.now()
            }
          })
        }
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
