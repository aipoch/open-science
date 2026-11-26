import { parsePdfStructureResult, type PdfStructureResult } from '@aipoch/pdf-structure/result'
import type { PDFDocumentProxy } from 'pdfjs-dist'

type SourceIdentity = Pick<PdfStructureResult, 'sourceChecksum' | 'sourceSizeBytes'>
type ReadCached = (request: {
  sourceId: string
  page: number
}) => Promise<PdfStructureResult | undefined>

/** Decode each batch against the source lease before using it as native ownership evidence. */
export async function readPdfStructureEvidence({
  document,
  sourceId,
  identity,
  readCached,
  assertCurrent,
  isCurrent
}: {
  document: Pick<PDFDocumentProxy, 'numPages'>
  sourceId: string
  identity: SourceIdentity
  readCached: ReadCached
  assertCurrent?: () => void
  isCurrent?: () => boolean
}): Promise<PdfStructureResult[] | undefined> {
  const batches = new Map<string, string>()
  const results: PdfStructureResult[] = []
  let bytes = 0
  let elements = 0
  for (let page = 1; page <= document.numPages; page++) {
    assertCurrent?.()
    const cached = await readCached({ sourceId, page })
    assertCurrent?.()
    if (isCurrent && !isCurrent()) return
    if (!cached) continue
    const result = parsePdfStructureResult(cached, { ...cached, ...identity })
    if (result.pageCount !== document.numPages || !result.processedPages.includes(page)) return
    const serialized = JSON.stringify(result)
    const previous = batches.get(result.extractionId)
    if (previous !== undefined) {
      if (previous !== serialized) return
      continue
    }
    bytes += serialized.length * 2
    elements += result.elements.length
    if (bytes > 32 * 1024 ** 2 || elements > 512) return
    batches.set(result.extractionId, serialized)
    results.push(result)
  }
  return results
}
