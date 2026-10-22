import { pdfReflowContentKinds } from './reflow-content.js'
import { createPdfTranslationSource, type PdfTranslationSource } from './source.js'

type Unit = PdfTranslationSource['units'][number]
type Region = NonNullable<PdfTranslationSource['originalRegions']>[number]
const literal = (text: string): boolean =>
  /^(?:https?:\/\/\S+|www\.\S+|(?:doi:\s*|https?:\/\/doi\.org\/)?10\.\d{4,9}\/\S+|[^\s@]+@[^\s@]+)$/iu.test(
    text.trim()
  )
const code = (unit: Unit): boolean =>
  /^```/u.test(unit.source.trim()) ||
  /^(?:[$%>]\s*\w+|(?:pip3?|npm|npx|git|curl|wget|docker|conda|uv|cargo|cmake)\s+(?:--?\w|install\b|run\b|build\b|clone\b)|(?:def|class|function)\s+\w+\s*[(:{])/u.test(
    unit.source.trim()
  ) ||
  Boolean(
    unit.sourceOnly &&
    /(?:\bdef\s+\w+\(|\breturn\b|#include\s*<|\bimport\s+\w+|^[$%>]\s*\w+)/u.test(unit.source)
  )
const union = (a: Region['rect'], b: Region['rect']): Region['rect'] => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
  height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y)
})

/** Derive admission/rendering policy without changing historical IDs or stored translations. */
export function applyPdfContentFirstPolicy(source: PdfTranslationSource): PdfTranslationSource {
  const kinds = pdfReflowContentKinds(source)
  const regions: Region[] = [...(source.originalRegions ?? [])]
  const codeRegions: Region[] = []
  const units = source.units.map((unit): Unit => {
    const preserve =
      kinds.get(unit.id) === 'reference'
        ? 'reference'
        : (unit.preserve ?? (literal(unit.source) ? 'literal' : code(unit) ? 'code' : undefined))
    if (preserve === 'formula' || preserve === 'code') {
      // Preserve the original glyphs, line spacing and indentation as a block.
      const byPage = new Map<number, Region['rect']>()
      for (const fragment of unit.fragments)
        byPage.set(
          fragment.pageNumber,
          byPage.has(fragment.pageNumber)
            ? union(byPage.get(fragment.pageNumber)!, fragment.rect)
            : fragment.rect
        )
      for (const [pageNumber, rect] of byPage) {
        const region = { pageNumber, rect }
        if (preserve === 'code') codeRegions.push(region)
        else regions.push(region)
      }
    }
    return unit.figure || preserve
      ? { ...unit, sourceOnly: true, ...(preserve ? { preserve } : {}) }
      : unit
  })
  codeRegions.sort((a, b) => a.pageNumber - b.pageNumber || a.rect.y - b.rect.y)
  let block: { pageNumber: number; rect: Region['rect'] } | undefined
  for (const region of codeRegions) {
    if (
      block &&
      block.pageNumber === region.pageNumber &&
      region.rect.y - block.rect.y - block.rect.height < 0.025 &&
      region.rect.y >= block.rect.y &&
      region.rect.x < block.rect.x + block.rect.width + 0.025 &&
      region.rect.x + region.rect.width > block.rect.x - 0.025
    )
      block.rect = union(block.rect, region.rect)
    else {
      block = { ...region }
      regions.push(block)
    }
  }
  const uniqueRegions = regions.filter(
    (region, index) =>
      !regions
        .slice(0, index)
        .some(
          (other) =>
            region.pageNumber === other.pageNumber &&
            (['x', 'y', 'width', 'height'] as const).every(
              (axis) => Math.abs(region.rect[axis] - other.rect[axis]) < 1e-9
            )
        )
  )
  return createPdfTranslationSource({ ...source, units, originalRegions: uniqueRegions })
}
