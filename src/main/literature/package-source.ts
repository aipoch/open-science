import type { PrismaClient } from '@prisma/client'
import type { PackageLiteratureSource } from '../session-package/literature-source'
import { LiteratureCatalog } from './catalog'

export const createLiteraturePackageSource = (
  getClient: () => Promise<PrismaClient>
): PackageLiteratureSource => ({
  async readVersions(versionIds) {
    const client = await getClient()
    const rows = await client.literatureAttachmentVersion.findMany({
      where: { id: { in: [...versionIds] } },
      include: { attachment: { include: { item: true } }, contentBlob: true },
      orderBy: [{ attachmentId: 'asc' }, { versionNumber: 'asc' }]
    })
    return rows.map((row) => {
      if (
        row.attachment.item.deletedAt ||
        row.contentBlob.state !== 'available' ||
        row.contentType !== 'application/pdf' ||
        row.checksum !== row.contentBlob.checksum ||
        row.sizeBytes !== row.contentBlob.sizeBytes
      )
        throw new Error('Literature PDF content identity is invalid.')
      return {
        id: row.id,
        attachmentId: row.attachmentId,
        itemId: row.attachment.itemId,
        versionNumber: row.versionNumber,
        filename: row.filename,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        checksum: row.checksum,
        storageKey: row.contentBlob.storageKey,
        createdAt: row.createdAt
      }
    })
  },
  async readItem(itemId) {
    const view = await new LiteratureCatalog(getClient).get(itemId)
    return view
      ? { itemId: view.id, metadataRevision: view.metadataRevision, item: view.item }
      : undefined
  }
})
