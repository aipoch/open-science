import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { SmartEvidence, SmartEvidenceMode } from '../../shared/literature-smart-collections'
import type { LiteratureDocumentReader } from './document-reader'

type Client = PrismaClient | Prisma.TransactionClient
type EvidenceVersion = Prisma.LiteratureAttachmentVersionGetPayload<Record<string, never>>
export type ReadSmartEvidence = (
  request: Parameters<LiteratureDocumentReader['classificationEvidence']>[0]
) => ReturnType<LiteratureDocumentReader['classificationEvidence']>

// Metadata-only freshness checks do not parse PDFs or send model requests.
// null means a batch already checked that no version exists; undefined requests a live lookup.
export async function smartInput(
  client: Client,
  item: { id: string; title: string; abstract: string },
  mode: SmartEvidenceMode,
  loadedVersion?: EvidenceVersion | null
): Promise<{
  digest: string
  version: EvidenceVersion | undefined
}> {
  const attachment =
    mode === 'full-text' && loadedVersion === undefined
      ? await client.literatureAttachment.findFirst({
          where: { itemId: item.id, kind: 'fullText' },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } }
        })
      : undefined
  const version = loadedVersion ?? attachment?.versions[0]
  const signature =
    mode === 'abstract'
      ? [item.title, item.abstract]
      : [item.title, item.abstract, 'full-text-v1', version?.id, version?.checksum]
  return { digest: createHash('sha256').update(JSON.stringify(signature)).digest('hex'), version }
}

export async function readSmartEvidence(
  input: Awaited<ReturnType<typeof smartInput>>,
  description: string,
  mode: SmartEvidenceMode,
  read?: ReadSmartEvidence
): Promise<{
  source: SmartEvidence
  passages: { pageStart: number; pageEnd: number; content: string }[]
}> {
  if (mode === 'abstract') return { source: { coverage: 'abstract' }, passages: [] }
  const version = input.version
  if (!version || version.contentType !== 'application/pdf' || !read)
    return { source: { coverage: 'unavailable' }, passages: [] }
  try {
    const result = await read({
      attachmentId: version.attachmentId,
      attachmentVersionId: version.id,
      filename: version.filename,
      sizeBytes: Number(version.sizeBytes),
      checksum: version.checksum,
      query: description
    })
    return {
      source: {
        coverage: result.passages.length ? result.coverage : 'unavailable',
        attachmentVersionId: version.id,
        filename: version.filename
      },
      passages: result.passages
    }
  } catch {
    // PDF extraction/availability is not a classification service failure.
    return {
      source: {
        coverage: 'unavailable',
        attachmentVersionId: version.id,
        filename: version.filename
      },
      passages: []
    }
  }
}
