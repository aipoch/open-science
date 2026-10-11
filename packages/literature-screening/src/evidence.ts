import { createHash } from 'node:crypto'
import type { ScreeningStore, ScreeningDocument, ReadScreeningEvidence } from './ports.js'
import type { SmartEvidence, SmartEvidenceMode } from './contracts.js'

type Client = ScreeningStore
type EvidenceVersion = ScreeningDocument
export type ReadSmartEvidence = ReadScreeningEvidence

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
  const version =
    loadedVersion ??
    (mode === 'full-text' && loadedVersion === undefined
      ? ((await client.documents([item.id]))[0]?.document ?? undefined)
      : undefined)
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
