import type { PDFPageProxy } from 'pdfjs-dist'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import { nativeAlgorithmInkRegions, nativeLabelRegion } from './native-source-geometry.js'
import type { PdfTranslationSource } from './source.js'
import { createAuxiliaryNativeInkReader, nativeInkPageCurrent } from './auxiliary-native-ink.js'
import { getPdfTranslationTextContent } from './text-content.js'

type Region = PdfStructureResult['elements'][number]['regions'][number]
type NativePage = {
  proxy?: PDFPageProxy
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
  viewport: ReturnType<PDFPageProxy['getViewport']>
}

export async function verifiedPdfTableRegions(
  source: PdfTranslationSource,
  candidates: Parameters<typeof verifiedPdfStructureRegions>[1],
  pages: ReadonlyMap<number, NativePage>,
  captions: readonly Region[],
  options: Parameters<typeof createAuxiliaryNativeInkReader>[0]
): Promise<{
  regions: NonNullable<PdfTranslationSource['originalRegions']>
  current: () => boolean
}> {
  const needed = new Set<number>(),
    baseline = verifyRegions(source, candidates, pages, captions, (region) => {
      needed.add(region.page)
      return false
    })
  const { document, signal } = options,
    pageEntries = [...pages].map(([number, input]) => ({
      number,
      input,
      proxy: input.proxy,
      content: input.content,
      viewport: input.viewport,
      project: input.viewport.convertToViewportPoint,
      readText: input.proxy?.getTextContent,
      readViewport: input.proxy?.getViewport
    })),
    getPage = document.getPage,
    scope = (): string =>
      JSON.stringify([
        source,
        captions,
        candidates.map(({ regions, owners }) => [regions, [...owners]]),
        document.fingerprints,
        document.numPages,
        pageEntries.map(({ input }) => [
          input.content,
          input.viewport,
          input.proxy?.ref,
          input.proxy?.view,
          input.proxy?.rotate
        ])
      ]),
    snapshot = scope(),
    checks: (() => boolean)[] = [],
    maps = new Map<number, Awaited<ReturnType<typeof nativeAlgorithmInkRegions>>>()
  let valid = true
  const current = (): boolean => {
    try {
      return (
        valid &&
        !signal?.aborted &&
        document.getPage === getPage &&
        source.fingerprint === document.fingerprints[0] &&
        source.pages.length === document.numPages &&
        scope() === snapshot &&
        pages.size === pageEntries.length &&
        pageEntries.every(
          ({ number, input, proxy, content, viewport, project, readText, readViewport }) =>
            pages.get(number) === input &&
            input.proxy === proxy &&
            input.content === content &&
            input.viewport === viewport &&
            viewport.convertToViewportPoint === project &&
            proxy?.getTextContent === readText &&
            proxy?.getViewport === readViewport
        ) &&
        checks.every((check) => check())
      )
    } catch {
      return false
    }
  }
  if (!needed.size) return { regions: baseline, current }
  const auxiliary = createAuxiliaryNativeInkReader(options)
  try {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    for (const number of needed) {
      const input = pages.get(number)!,
        page = input.proxy
      if (!page) continue
      if (page.pageNumber !== number || page !== (await document.getPage(number))) continue
      const { content, viewport } = input,
        expected = source.pages[number - 1]
      if (
        !expected ||
        viewport.width !== expected.width ||
        viewport.height !== expected.height ||
        JSON.stringify(content) !== JSON.stringify(await getPdfTranslationTextContent(page)) ||
        JSON.stringify(viewport) !== JSON.stringify(page.getViewport({ scale: 1 }))
      )
        continue
      const operators = await page.getOperatorList(),
        keys = new Set<string>(),
        stack: string[] = []
      let font = ''
      for (const [index, op] of operators.fnArray.entries()) {
        const args = operators.argsArray[index]
        if (op === OPS.setFont) font = args[0]
        else if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op))
          stack.push(font)
        else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op))
          font = stack.pop() ?? ''
        else if (op === OPS.showText)
          for (const glyph of args[0])
            if (typeof glyph?.fontChar === 'string') keys.add(font + '_path_' + glyph.fontChar)
      }
      const pageCurrent = nativeInkPageCurrent(page, content, viewport, operators, [...keys])
      if (!pageCurrent) continue
      checks.push(
        () =>
          input.proxy === page &&
          input.content === content &&
          input.viewport === viewport &&
          pageCurrent()
      )
      const selected = new Set(
        candidates.flatMap(({ owners }) =>
          [...owners].flatMap((key) => {
            const [ownerPage, index] = key.split(':').map(Number)
            return ownerPage === number ? [index] : []
          })
        )
      )
      if (!current()) throw Error('Native table crop evidence changed')
      const ink =
        (await nativeAlgorithmInkRegions(page, content, viewport, number, selected, operators)) ??
        (await auxiliary.read({
          page,
          content,
          viewport,
          pageNumber: number,
          selected,
          operatorSnapshot: operators
        }))
      if (!current()) throw Error('Native table crop evidence changed')
      if (ink) maps.set(number, ink)
    }
  } catch {
    // Unavailable optional glyph evidence must retain the original crop policy
    // and cell claims. A changed input is still rejected by current().
    maps.clear()
  } finally {
    try {
      await auxiliary.dispose()
    } catch {
      valid = false
    }
  }
  if (!current()) return { regions: [], current }
  const regions = verifyRegions(source, candidates, pages, captions, (region, index) => {
    const ink = maps.get(region.page)?.get(index)
    if (!ink || ink.page !== region.page) return false
    // Match Writer cropPixels: a nominally disjoint glyph must also stay out
    // of the outward-rounded pixels embedded in the original-region image.
    const { width, height } = pages.get(region.page)!.viewport,
      scale = Math.min(2, 2400 / Math.max(width, height)),
      pw = Math.ceil(width * scale),
      ph = Math.ceil(height * scale),
      pixels = (r: Region): Region => {
        const x = Math.max(0, Math.floor(r.x * pw)),
          y = Math.max(0, Math.floor(r.y * ph))
        return {
          page: r.page,
          x,
          y,
          width: Math.max(1, Math.min(pw - x, Math.ceil((r.x + r.width) * pw) - x)),
          height: Math.max(1, Math.min(ph - y, Math.ceil((r.y + r.height) * ph) - y))
        }
      }
    return !overlaps(pixels(region), pixels(ink))
  })
  return { regions, current }
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
  return verifyRegions(source, candidates, pages, captions)
}

function verifyRegions(
  source: PdfTranslationSource,
  candidates: Parameters<typeof verifiedPdfStructureRegions>[1],
  pages: ReadonlyMap<number, NativePage>,
  captions: readonly Region[],
  foreignOutside?: (region: Region, index: number) => boolean
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
              // A clipped navigation intersection cannot establish a whole original crop.
              f.unclippedRect ||
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
        if (!owners.has(`${region.page}:${index}`)) {
          if (foreignOutside?.(region, index)) continue
          return []
        }
        if (!structureRegionContains(region, native)) return []
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
              f.unclippedRect ||
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
