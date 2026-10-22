import { parsePdfStructureResult, type PdfStructureResult } from '@aipoch/pdf-structure/result'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { PdfTranslationExtraction } from './extraction.js'
import { createPdfTranslationSource } from './source.js'
import type { PdfTranslationSourceIdentity } from './table-source.js'
import { nativeLabelRegion } from './native-source-geometry.js'
import { retainPdfWholeRegionSources } from './whole-region-retention.js'

/** Preserve every native item; only complete, independently proved figure units leave prose. */
export async function applyCachedPdfFigureSources({
  extraction,
  document,
  sourceId,
  sourceIdentity,
  signal,
  readCached
}: {
  extraction: PdfTranslationExtraction
  document: Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'>
  sourceId: string
  sourceIdentity: PdfTranslationSourceIdentity
  signal: AbortSignal
  readCached: (
    request: Readonly<{ sourceId: string; page: number }>
  ) => Promise<PdfStructureResult | undefined>
}): Promise<PdfTranslationExtraction> {
  signal.throwIfAborted()
  const source = extraction.source,
    identity = { ...sourceIdentity }
  if (
    !/^[a-f0-9]{64}$/.test(identity.sourceChecksum) ||
    !Number.isSafeInteger(identity.sourceSizeBytes) ||
    identity.sourceSizeBytes <= 0 ||
    !source.fingerprint ||
    source.fingerprint !== document.fingerprints[0] ||
    source.pages.length !== document.numPages
  )
    return extraction
  const current = (): void => {
    signal.throwIfAborted()
    if (
      source.fingerprint !== document.fingerprints[0] ||
      source.pages.length !== document.numPages
    )
      throw new Error('PDF source changed during figure verification')
  }
  type Region = PdfStructureResult['elements'][number]['regions'][number]
  const inside = (r: Region, outer: Region): boolean =>
    r.page === outer.page &&
    r.x >= outer.x - 1e-6 &&
    r.y >= outer.y - 1e-6 &&
    r.x + r.width <= outer.x + outer.width + 1e-6 &&
    r.y + r.height <= outer.y + outer.height + 1e-6
  const overlaps = (a: Region, b: Region): boolean =>
    a.page === b.page &&
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  try {
    const results: PdfStructureResult[] = [],
      batches = new Map<string, string>()
    let bytes = 0,
      count = 0
    for (let page = 1; page <= document.numPages; page++) {
      current()
      const cached = await readCached({ sourceId, page })
      current()
      if (!cached) continue
      const result = parsePdfStructureResult(cached, { ...cached, ...identity })
      if (result.pageCount !== document.numPages || !result.processedPages.includes(page))
        return extraction
      const serialized = JSON.stringify(result),
        previous = batches.get(result.extractionId)
      if (previous !== undefined) {
        if (previous !== serialized) return extraction
        continue
      }
      bytes += serialized.length * 2
      count += result.elements.length
      if (bytes > 32 * 1024 ** 2 || count > 512) return extraction
      batches.set(result.extractionId, serialized)
      results.push(result)
    }
    const figureExtraction = await (async () => {
      const elements = results.flatMap((result) => result.elements)
      const owners = new Map<string, string>()
      for (const unit of source.units)
        for (const fragment of unit.fragments)
          for (const item of fragment.items) {
            const key = `${fragment.pageNumber}:${item.index}`
            if (owners.has(key)) return extraction
            owners.set(key, item.text)
          }
      const native = new Map<
        number,
        Awaited<ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['getTextContent']>>
      >()
      const viewports = new Map<number, ReturnType<PDFPageProxy['getViewport']>>()
      const claims = new Map<string, (typeof elements)[number]>()
      for (const figure of elements) {
        if (
          figure.kind !== 'figure' ||
          !figure.sourceItems?.length ||
          !figure.caption ||
          // This code records the native recovery mechanism, not uncertainty.
          // It never substitutes for the complete source and geometry proof below.
          figure.issues.some((issue) => issue.code !== 'native-raster-composite-grid')
        )
          continue
        for (const item of figure.sourceItems) {
          const key = `${item.pageNumber}:${item.index}`
          if (claims.has(key) || owners.get(key) !== item.text) return extraction
          if (!native.has(item.pageNumber)) {
            current()
            const page = await document.getPage(item.pageNumber),
              viewport = page.getViewport({ scale: 1 })
            current()
            const expected = source.pages[item.pageNumber - 1]
            if (
              !expected ||
              ![viewport.width, viewport.height].every((n) => Number.isFinite(n) && n > 0) ||
              Math.abs(viewport.width - expected.width) > 1e-6 ||
              Math.abs(viewport.height - expected.height) > 1e-6
            )
              return extraction
            viewports.set(item.pageNumber, viewport)
            native.set(item.pageNumber, await page.getTextContent())
            current()
          }
          const original = native.get(item.pageNumber)!.items[item.index]
          if (!original || !('str' in original) || original.str !== item.text) return extraction
          const region = nativeLabelRegion(
            original,
            native.get(item.pageNumber)!.styles?.[original.fontName],
            viewports.get(item.pageNumber)!,
            item.pageNumber
          )
          if (
            !region ||
            !figure.regions.some((outer) => inside(region, outer)) ||
            elements.some(
              (element) =>
                (element !== figure && element.regions.some((other) => overlaps(region, other))) ||
                element.caption?.regions.some((caption) => overlaps(region, caption))
            )
          )
            return extraction
          claims.set(key, figure)
        }
      }
      let changed = false
      const units = source.units.map((unit) => {
        if (unit.sourceOnly) return unit
        const keys = unit.fragments.flatMap((fragment) =>
          fragment.items.map((item) => `${fragment.pageNumber}:${item.index}`)
        )
        const figure = claims.get(keys[0])
        if (!figure || keys.some((key) => claims.get(key) !== figure)) return unit
        // Whole source units only. A mixed prose/caption unit must remain readable;
        // no crop-based text selection, string slicing or inferred ownership here.
        const regions = unit.fragments.map((fragment) => ({
          page: fragment.pageNumber,
          ...fragment.rect
        }))
        if (
          regions.some(
            (region) =>
              !figure.regions.some((outer) => inside(region, outer)) ||
              elements.some(
                (element) =>
                  (element !== figure &&
                    element.regions.some((other) => overlaps(region, other))) ||
                  element.caption?.regions.some((caption) => overlaps(region, caption))
              )
          )
        )
          return unit
        changed = true
        return { ...unit, sourceOnly: true as const }
      })
      current()
      return changed
        ? Object.freeze({ ...extraction, source: createPdfTranslationSource({ ...source, units }) })
        : extraction
    })()
    return retainPdfWholeRegionSources({
      extraction: figureExtraction,
      document,
      results,
      sourceIdentity: identity,
      signal
    })
  } catch {
    signal.throwIfAborted()
    return extraction
  }
}
