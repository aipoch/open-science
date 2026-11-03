import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import { z } from 'zod'

const sourceKeySchema = z.string().min(1).max(4096)

export const literatureSnapshotRequestSchema = z
  .object({
    mode: z.enum(['read', 'generate']).optional(),
    itemId: z.string().trim().min(1).max(256),
    expectedSourceKey: sourceKeySchema,
    language: z.string().trim().min(1).max(64)
  })
  .strict()

// Null is the model's indication that a field is not reported; schema validity is not factual verification.
export const literatureSnapshotSectionsSchema = z
  .object({
    question: z.string().trim().min(1).max(2400).nullable(),
    population: z.string().trim().min(1).max(2400).nullable(),
    methods: z.string().trim().min(1).max(2400).nullable(),
    results: z.string().trim().min(1).max(2400).nullable(),
    limitations: z.string().trim().min(1).max(2400).nullable()
  })
  .strict()

export const literatureSnapshotReadySchema = z
  .object({
    sourceKey: sourceKeySchema,
    coverage: z.enum(['abstract', 'full-text', 'passages']),
    attachmentVersionId: z.string().optional(),
    model: z.string().min(1),
    sections: literatureSnapshotSectionsSchema
  })
  .strict()

export const literatureSnapshotIssueSchema = z
  .object({
    sourceKey: sourceKeySchema,
    issue: z.enum([
      'busy',
      'source-changed',
      'source-unavailable',
      'input-too-large',
      'not-generated'
    ])
  })
  .strict()

export const literatureSnapshotResultSchema = z.union([
  literatureSnapshotReadySchema,
  literatureSnapshotIssueSchema
])

export type LiteratureSnapshot = z.infer<typeof literatureSnapshotReadySchema>
export type LiteratureSnapshotIssue = z.infer<typeof literatureSnapshotIssueSchema>['issue']

export type LiteratureSnapshotRequest = z.infer<typeof literatureSnapshotRequestSchema>
export type LiteratureSnapshotResult = z.infer<typeof literatureSnapshotResultSchema>

/** The same current document and freshness rule is used by the UI and command owner.
 * Availability is only a hint; the reader still authorizes and verifies the immutable bytes.
 */
export function literatureSnapshotSource(
  item: Pick<
    LiteratureItemView,
    'id' | 'metadataRevision' | 'attachments' | 'deletedAt' | 'mergedIntoItemId'
  >
): {
  key: string
  active: boolean
  document?: {
    attachmentId: string
    attachmentVersionId: string
    filename: string
    sizeBytes: number
    checksum: string
  }
} {
  const active = item.deletedAt === undefined && !item.mergedIntoItemId
  const selected = [...item.attachments]
    .filter((attachment) => attachment.kind === 'fullText')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .map((attachment) => ({
      attachment,
      version: [...attachment.versions].sort((a, b) => b.versionNumber - a.versionNumber)[0]
    }))
    .find(({ version }) => version?.contentType === 'application/pdf')
  const document = selected?.version
    ? {
        attachmentId: selected.attachment.id,
        attachmentVersionId: selected.version.id,
        filename: selected.version.filename,
        sizeBytes: selected.version.sizeBytes,
        checksum: selected.version.checksum
      }
    : undefined
  // An optimistic concurrency token, not an access grant. Exclude unrelated attachments,
  // verification timestamps, display names and availability hints from evidence identity.
  return {
    active,
    key: JSON.stringify([
      item.id,
      item.metadataRevision,
      active,
      document
        ? [
            document.attachmentId,
            document.attachmentVersionId,
            document.checksum,
            document.sizeBytes
          ]
        : null
    ]),
    document
  }
}
