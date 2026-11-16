import type { PdfTranslationLayoutSnapshot } from '../snapshot.js'
import type { PdfTranslationExtraction } from './extraction.js'
import { createPdfTranslationSource, type PdfTranslationSource } from './source.js'

const snapshots = new WeakMap<PdfTranslationSource, PdfTranslationLayoutSnapshot>()
const currentParserVersion = 'pdfjs-paragraph-layout-15'
const parserOrigins = new WeakMap<PdfTranslationSource, string | undefined>()

/** Only a completed native extraction establishes current parser provenance. */
export function rememberPdfTranslationSourceParser(source: PdfTranslationSource): void {
  parserOrigins.set(source, currentParserVersion)
}

// A policy changes admission and crops, not the parser that read its native text.
export function carryPdfTranslationParser(
  source: PdfTranslationSource,
  derived: PdfTranslationSource
): PdfTranslationSource {
  parserOrigins.set(derived, snapshots.get(source)?.parserVersion ?? parserOrigins.get(source))
  return derived
}

export function rememberPdfTranslationExtraction(extraction: PdfTranslationExtraction): void {
  if (snapshots.has(extraction.source)) return
  const parserVersion = parserOrigins.get(extraction.source)
  if (parserOrigins.has(extraction.source) && !parserVersion) return
  const { fingerprint, pages, units, originalRegions } = extraction.source
  snapshots.set(extraction.source, {
    version: 1,
    parserVersion: parserVersion ?? currentParserVersion,
    fingerprint,
    pages,
    units,
    ...(originalRegions ? { originalRegions } : {}),
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
