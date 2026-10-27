import type { PDFDocumentProxy } from 'pdfjs-dist'
import { parsePdfStructureResult, type PdfStructureResult } from '@aipoch/pdf-structure/result'
import {
  applyCachedPdfStructureSources,
  type PdfTranslationExtraction,
  type PdfTranslationSourceIdentity
} from '@aipoch/pdf-translation/reader'
import type { PdfStructureSource } from '../../../../../../shared/pdf-structure'

export type PdfTranslationStructureContext = Readonly<{
  source: PdfStructureSource
  identity: PdfTranslationSourceIdentity
}>

// Structure is optional evidence from the existing cache only,
// while the reader adapters remain responsible for proving native text ownership.
export async function preparePdfTranslationStructure({
  document,
  extraction,
  context,
  signal,
  nativeDocumentFactory,
  preserveUnitIdentity = false
}: {
  document: Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'> &
    Partial<Pick<PDFDocumentProxy, 'getData' | 'getMetadata'>>
  extraction: PdfTranslationExtraction
  context?: PdfTranslationStructureContext
  signal: AbortSignal
  nativeDocumentFactory?: typeof import('pdfjs-dist').getDocument
  preserveUnitIdentity?: boolean
}): Promise<{ extraction: PdfTranslationExtraction; retainedUnitIds: readonly string[] }> {
  signal.throwIfAborted()
  const unchanged = { extraction, retainedUnitIds: [] }
  if (!context) return unchanged
  const api = window.api?.pdfStructure
  if (!api?.readCached) return unchanged
  const { source, identity } = context
  const pages = new Map<number, Promise<PdfStructureResult | undefined>>()
  const load = async (page: number): Promise<PdfStructureResult | undefined> => {
    try {
      signal.throwIfAborted()
      const cached = await api.readCached({ ...source, page })
      signal.throwIfAborted()
      if (!cached) return undefined
      const result = parsePdfStructureResult(cached, { ...cached, ...identity })
      if (result.pageCount !== document.numPages || !result.processedPages.includes(page))
        return undefined
      for (const number of result.processedPages)
        if (!pages.has(number)) pages.set(number, Promise.resolve(result))
      return result
    } catch {
      signal.throwIfAborted()
      // A failed page must not discard independent valid structure or ordinary prose.
      return undefined
    }
  }
  try {
    const prepared = await applyCachedPdfStructureSources({
      extraction,
      document,
      sourceId:
        'attachmentVersionId' in source
          ? source.attachmentVersionId
          : source.source.sourceVersionId,
      sourceIdentity: identity,
      signal,
      nativeDocumentFactory,
      preserveUnitIdentity,
      readCached: ({ page }) => {
        let pending = pages.get(page)
        if (!pending) {
          pending = load(page)
          pages.set(page, pending)
        }
        return pending
      }
    })
    signal.throwIfAborted()
    return prepared
  } catch {
    signal.throwIfAborted()
    return unchanged
  }
}
