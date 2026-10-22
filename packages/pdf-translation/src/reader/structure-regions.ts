import type { PDFPageProxy } from 'pdfjs-dist'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import { nativeLabelRegion } from './native-source-geometry.js'
import type { PdfTranslationSource } from './source.js'

type Region = PdfStructureResult['elements'][number]['regions'][number]
type NativePage = {
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
  viewport: ReturnType<PDFPageProxy['getViewport']>
}

export const structureRegionContains = (outer: Region, inner: Region): boolean =>
  outer.page === inner.page &&
  inner.x >= outer.x - 1e-6 &&
  inner.y >= outer.y - 1e-6 &&
  inner.x + inner.width <= outer.x + outer.width + 1e-6 &&
  inner.y + inner.height <= outer.y + outer.height + 1e-6

const overlaps = (a: Region, b: Region): boolean =>
  a.page === b.page &&
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height

/** Crop safety only. Callers must already have proved each native ownership claim. */
export function verifiedPdfStructureRegions(
  source: PdfTranslationSource,
  candidates: readonly { regions: readonly Region[]; owners: ReadonlySet<string> }[],
  pages: ReadonlyMap<number, NativePage>,
  captions: readonly Region[]
): NonNullable<PdfTranslationSource['originalRegions']> {
  return candidates.flatMap(({ regions, owners }) =>
    regions.flatMap((candidate) => {
      let region = candidate
      // Translation fragments include layout padding. Expand only from complete,
      // already owned units; the expanded crop still needs every check below.
      for (const unit of source.units) {
        if (!unit.fragments.some((f) => overlaps(candidate, { page: f.pageNumber, ...f.rect })))
          continue
        if (
          unit.fragments.some(
            (f) =>
              f.pageNumber !== candidate.page ||
              !f.items.length ||
              f.items.some((item) => !owners.has(`${f.pageNumber}:${item.index}`))
          )
        )
          return []
        for (const { rect } of unit.fragments) {
          const x = Math.min(region.x, rect.x),
            y = Math.min(region.y, rect.y)
          region = {
            page: region.page,
            x,
            y,
            width: Math.max(region.x + region.width, rect.x + rect.width) - x,
            height: Math.max(region.y + region.height, rect.y + rect.height) - y
          }
        }
      }
      if (
        !Object.values(region).every(Number.isFinite) ||
        region.x < 0 ||
        region.y < 0 ||
        region.x + region.width > 1 ||
        region.y + region.height > 1
      )
        return []
      const page = pages.get(region.page)
      if (!page || captions.some((caption) => overlaps(region, caption))) return []
      let found = false
      for (const [index, item] of page.content.items.entries()) {
        if (!('str' in item) || !item.str.trim()) continue
        const native = nativeLabelRegion(
          item,
          page.content.styles?.[item.fontName],
          page.viewport,
          region.page
        )
        // Unknown geometry cannot prove an item lies outside this crop.
        if (!native) return []
        if (!overlaps(region, native)) continue
        if (!owners.has(`${region.page}:${index}`) || !structureRegionContains(region, native))
          return []
        found = true
      }
      if (!found) return []
      for (const unit of source.units) {
        if (!unit.fragments.some((f) => overlaps(region, { page: f.pageNumber, ...f.rect })))
          continue
        // Never crop part of a mixed prose/label unit, including across pages.
        if (
          unit.fragments.some(
            (f) =>
              !structureRegionContains(region, { page: f.pageNumber, ...f.rect }) ||
              !f.items.length ||
              f.items.some((item) => !owners.has(`${f.pageNumber}:${item.index}`))
          )
        )
          return []
      }
      const { page: pageNumber, ...rect } = region
      return [{ pageNumber, rect }]
    })
  )
}
