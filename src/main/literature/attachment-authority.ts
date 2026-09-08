import type { PrismaClient } from '@prisma/client'

import type { ContentRepository } from '../storage/content-repository'

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

type LiteratureAttachmentAuthorityOptions = Readonly<{
  getClient: () => Promise<PrismaClient>
  content: Pick<ContentRepository, 'verify'>
}>

class LiteratureAttachmentUnavailableError extends Error {}

class LiteratureAttachmentAuthority {
  constructor(private readonly options: LiteratureAttachmentAuthorityOptions) {}

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
    if (!version || version.attachment.item.deletedAt) return undefined

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
export type { LiteratureAttachmentAuthorityOptions, ResolvedLiteratureAttachmentVersion }
