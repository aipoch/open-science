import type { PrismaClient } from '@prisma/client'

import { parseLiteratureAttachmentVersionReference } from '../../shared/literature-attachment-reference'
import type { ContentReadLease, ContentRepository } from '../storage/content-repository'

type ResolvedLiteratureAttachmentVersion = Readonly<{
  itemId: string
  attachmentId: string
  versionId: string
  versionNumber: number
  filename: string
  contentType: string
  sizeBytes: number
  checksum: string
  pageCount?: number
  storageKey: string
  path: string
}>
type ResolvedCachedLiteratureAttachmentVersion = Omit<ResolvedLiteratureAttachmentVersion, 'path'>

type LiteratureAttachmentAuthorityOptions = Readonly<{
  getClient: () => Promise<PrismaClient>
  content: Pick<ContentRepository, 'verify' | 'openLease'>
  packages?: {
    resolveVersion: (versionId: string) => Promise<ResolvedLiteratureAttachmentVersion | undefined>
    openContent: (versionId: string) => Promise<ContentReadLease>
  }
}>

class LiteratureAttachmentUnavailableError extends Error {}

class LiteratureAttachmentAuthority {
  constructor(private readonly options: LiteratureAttachmentAuthorityOptions) {}

  /** Metadata admission for cached evidence; this never verifies or opens the original blob. */
  async resolveCachedVersion(
    versionId: string,
    signal?: AbortSignal
  ): Promise<ResolvedCachedLiteratureAttachmentVersion | undefined> {
    signal?.throwIfAborted()
    const client = await this.options.getClient()
    signal?.throwIfAborted()
    const version = await client.literatureAttachmentVersion.findUnique({
      where: { id: versionId },
      include: {
        attachment: {
          select: {
            itemId: true,
            item: { select: { deletedAt: true, mergedIntoItemId: true } },
            versions: { select: { id: true }, orderBy: { versionNumber: 'desc' }, take: 1 }
          }
        },
        contentBlob: {
          select: {
            id: true,
            state: true,
            checksum: true,
            sizeBytes: true,
            contentType: true,
            storageKey: true
          }
        }
      }
    })
    signal?.throwIfAborted()
    if (
      !version ||
      version.id !== versionId ||
      version.attachment.item.deletedAt ||
      version.attachment.item.mergedIntoItemId ||
      version.attachment.versions[0]?.id !== versionId
    )
      return undefined
    const blob = version.contentBlob
    if (
      blob.state !== 'available' ||
      blob.id !== version.contentBlobId ||
      blob.checksum !== version.checksum ||
      blob.sizeBytes !== version.sizeBytes ||
      (blob.contentType !== null && blob.contentType !== version.contentType) ||
      !blob.storageKey ||
      !/^[a-f0-9]{64}$/.test(version.checksum) ||
      !Number.isSafeInteger(Number(version.sizeBytes)) ||
      version.sizeBytes <= 0n
    )
      return undefined
    return {
      itemId: version.attachment.itemId,
      attachmentId: version.attachmentId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      filename: version.filename,
      contentType: version.contentType,
      sizeBytes: Number(version.sizeBytes),
      checksum: version.checksum,
      ...(version.pageCount === null ? {} : { pageCount: version.pageCount }),
      storageKey: blob.storageKey
    }
  }

  async openReference(reference: string): Promise<ContentReadLease> {
    const versionId = parseLiteratureAttachmentVersionReference(reference)
    if (!versionId) throw new Error('Invalid Literature attachment reference.')
    return this.openContent(versionId)
  }

  async openContent(versionId: string): Promise<ContentReadLease> {
    const version = await this.resolveVersion(versionId)
    if (!version)
      throw new LiteratureAttachmentUnavailableError('Literature attachment is unavailable.')
    const client = await this.options.getClient()
    const row = await client.literatureAttachmentVersion.findUnique({ where: { id: versionId } })
    if (!row && this.options.packages) return this.options.packages.openContent(versionId)
    if (!row)
      throw new LiteratureAttachmentUnavailableError('Literature attachment is unavailable.')
    const lease = await this.options.content.openLease(row.contentBlobId)
    if (lease.checksum !== version.checksum || lease.size !== version.sizeBytes) {
      await lease.close()
      throw new LiteratureAttachmentUnavailableError(
        'Literature attachment content identity changed.'
      )
    }
    return lease
  }

  async resolveVersion(
    versionId: string
  ): Promise<ResolvedLiteratureAttachmentVersion | undefined> {
    const client = await this.options.getClient()
    const version = await client.literatureAttachmentVersion.findUnique({
      where: { id: versionId },
      include: {
        attachment: { select: { itemId: true, item: { select: { deletedAt: true } } } },
        contentBlob: { select: { storageKey: true } }
      }
    })
    if (!version) return this.options.packages?.resolveVersion(versionId)
    if (version.attachment.item.deletedAt) return undefined

    const verification = await this.options.content.verify(version.contentBlobId)
    if (verification.state !== 'available') {
      throw new LiteratureAttachmentUnavailableError(
        `Literature attachment content is unavailable: ${versionId} (${verification.reason})`
      )
    }
    const content = verification.content
    if (
      content.checksum !== version.checksum ||
      content.sizeBytes !== version.sizeBytes ||
      content.storageKey !== version.contentBlob.storageKey ||
      (content.contentType !== undefined && content.contentType !== version.contentType)
    ) {
      throw new LiteratureAttachmentUnavailableError(
        'Literature Attachment Version does not match its Content Blob authority.'
      )
    }

    return {
      itemId: version.attachment.itemId,
      attachmentId: version.attachmentId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      filename: version.filename,
      contentType: version.contentType,
      sizeBytes: Number(version.sizeBytes),
      checksum: version.checksum,
      ...(version.pageCount === null ? {} : { pageCount: version.pageCount }),
      storageKey: content.storageKey,
      path: content.path
    }
  }
}

export { LiteratureAttachmentAuthority, LiteratureAttachmentUnavailableError }
export type {
  LiteratureAttachmentAuthorityOptions,
  ResolvedLiteratureAttachmentVersion,
  ResolvedCachedLiteratureAttachmentVersion
}
