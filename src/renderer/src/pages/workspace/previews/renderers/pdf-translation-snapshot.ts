import type { PdfTranslationLayoutSnapshot } from '../../../../../../shared/pdf-translation-snapshot'
import type { PdfTranslationExtraction } from './pdf-translation-extraction'
import { createPdfTranslationSource, type PdfTranslationSource } from './pdf-translation'

const snapshots = new WeakMap<PdfTranslationSource, PdfTranslationLayoutSnapshot>()

export function rememberPdfTranslationExtraction(extraction: PdfTranslationExtraction): void {
  if (snapshots.has(extraction.source)) return
  const { fingerprint, pages, units } = extraction.source
  snapshots.set(extraction.source, {
    version: 1,
    parserVersion: 'pdfjs-paragraph-layout-1',
    fingerprint,
    pages,
    units,
    coverage: extraction.coverage
  } as PdfTranslationLayoutSnapshot)
}
export function getPdfTranslationLayoutSnapshot(
  source: PdfTranslationSource
): PdfTranslationLayoutSnapshot | undefined {
  return snapshots.get(source)
}
export function restorePdfTranslationExtraction(
  snapshot: PdfTranslationLayoutSnapshot,
  resourceRequestKey: string
): PdfTranslationExtraction {
  const source = createPdfTranslationSource({ ...snapshot, resourceRequestKey })
  snapshots.set(source, snapshot)
  return { source, coverage: snapshot.coverage }
}
