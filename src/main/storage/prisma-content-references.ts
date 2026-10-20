import type { Prisma } from '@prisma/client'
import type { ContentReferences } from './content-repository'

// Durable references outlive feature activation, including Trash and Inbox records.
// Keep this adapter installed for the database lifetime, even when Literature is disabled.
export const persistentContentReferences: ContentReferences<Prisma.TransactionClient> = {
  async findReferencedIds(client, contentIds) {
    const where = contentIds ? { contentBlobId: { in: [...contentIds] } } : undefined
    const references = await Promise.all([
      client.uploadVersion.findMany({
        where: where ?? { contentBlobId: { not: null } },
        select: { contentBlobId: true }
      }),
      client.artifactVersion.findMany({
        where: where ?? { contentBlobId: { not: null } },
        select: { contentBlobId: true }
      }),
      client.literatureAttachmentVersion.findMany({ where, select: { contentBlobId: true } }),
      client.literatureInboxPdf.findMany({ where, select: { contentBlobId: true } })
    ])
    return new Set(
      references.flat().flatMap(({ contentBlobId }) => (contentBlobId ? [contentBlobId] : []))
    )
  },
  async hasReferences(transaction, contentId) {
    const where = { contentBlobId: contentId }
    const counts = await Promise.all([
      transaction.uploadVersion.count({ where }),
      transaction.artifactVersion.count({ where }),
      transaction.literatureAttachmentVersion.count({ where }),
      transaction.literatureInboxPdf.count({ where })
    ])
    return counts.some((count) => count > 0)
  }
}
