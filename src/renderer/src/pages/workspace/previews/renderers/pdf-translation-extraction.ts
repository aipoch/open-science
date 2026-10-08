import { getPdfTranslationTextContent } from './pdf-translation-text-content'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { createPdfTranslationSource, type PdfTranslationSource } from './pdf-translation'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from './pdf-translation-layout'

export type PdfTranslationExclusionReason =
  'invalid-geometry' | 'unsupported-orientation' | 'outside-page'

export type PdfTranslationExtraction = Readonly<{
  source: PdfTranslationSource
  /** Source coverage only: included text is not necessarily prose or a correct translation. */
  coverage: Readonly<{
    pageCount: number
    textItemCount: number
    includedItemCount: number
    excludedItemCount: number
    pagesWithoutText: readonly number[]
    exclusions: readonly Readonly<{
      unitId?: string
      reason: PdfTranslationExclusionReason
      items: readonly Readonly<{ pageNumber: number; index: number; text: string }>[]
    }>[]
    /** Advisory grouping uncertainty; does not silently remove source text. */
    warnings: readonly Readonly<{ unitId: string; reasons: readonly string[] }>[]
  }>
}>

type TextStyle = { vertical?: boolean; ascent?: number; descent?: number }

// Text-run navigation bounds, not glyph outlines or regions safe to paint over.
// PDF.js TextLayer uses a font-height box and falls back to ascent / 1+descent / 0.8.
function independentRect(
  item: PdfLayoutTextItem,
  page: PdfLayoutPage,
  style: TextStyle | undefined
): PdfTranslationSource['units'][number]['fragments'][number]['rect'] | undefined {
  if (item.dir !== 'ltr' || style?.vertical) return undefined
  const [a, b, c, d, x, y] = item.transform
  const advance = Math.hypot(a, b),
    font = Math.hypot(c, d)
  if (advance <= 0 || font <= 0 || item.width <= 0) return undefined
  const quarter = ((Math.round(Math.atan2(-b, a) / (Math.PI / 2)) % 4) + 4) % 4
  const [ux, uy] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1]
  ][quarter]
  if (
    Math.hypot(a / advance - ux, -b / advance - uy) > 0.0001 ||
    Math.abs((a * c + b * d) / (advance * font)) > 0.0001 ||
    a * d - b * c <= 0
  )
    return undefined
  const ascent = style?.ascent || (style?.descent ? 1 + style.descent : 0.8)
  const points = [
    [0, -ascent * font],
    [item.width, -ascent * font],
    [item.width, (1 - ascent) * font],
    [0, (1 - ascent) * font]
  ].map(([u, v]) => [x + ux * u - uy * v, page.height - y + uy * u + ux * v])
  const left = Math.min(...points.map(([x]) => x)),
    top = Math.min(...points.map(([, y]) => y))
  const rect = {
    x: left / page.width,
    y: top / page.height,
    width: (Math.max(...points.map(([x]) => x)) - left) / page.width,
    height: (Math.max(...points.map(([, y]) => y)) - top) / page.height
  }
  return Object.values(rect).every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= 1.000001 &&
    rect.y + rect.height <= 1.000001
    ? rect
    : undefined
}

/** Borrows the reader's PDF; owns no loading task, page cleanup, or document disposal. */
export async function extractPdfTranslationSource({
  document,
  resourceRequestKey,
  signal,
  onProgress
}: {
  document: Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'>
  resourceRequestKey: string
  signal: AbortSignal
  onProgress?: (pagesRead: number) => void
}): Promise<PdfTranslationExtraction> {
  signal.throwIfAborted()
  const fingerprint = document.fingerprints[0]
  if (!fingerprint || !Number.isInteger(document.numPages) || document.numPages < 1)
    throw new Error('Invalid PDF source identity')
  const pages: PdfLayoutPage[] = []
  const styles: Record<string, TextStyle>[] = []
  const pagesWithoutText: number[] = []
  const exclusions: PdfTranslationExtraction['coverage']['exclusions'][number][] = []
  let textItemCount = 0
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    signal.throwIfAborted()
    const page = await document.getPage(pageNumber)
    signal.throwIfAborted()
    const viewport = page.getViewport({ scale: 1 })
    if (
      ![viewport.width, viewport.height].every((n) => Number.isFinite(n) && n > 0) ||
      viewport.transform.length !== 6 ||
      !viewport.transform.every(Number.isFinite)
    )
      throw new Error('Invalid PDF page geometry')
    const content = await getPdfTranslationTextContent(page)
    signal.throwIfAborted()
    let pageTextItems = 0
    const items = content.items.map((item, index) => {
      const empty = {
        str: '',
        width: 0,
        height: 0,
        dir: 'ltr',
        transform: [0, 0, 0, 0, 0, 0],
        hasEOL: 'hasEOL' in item ? item.hasEOL : undefined
      }
      if (!('str' in item) || !item.str.trim()) return empty
      textItemCount++
      pageTextItems++
      if (
        item.transform.length !== 6 ||
        ![...item.transform, item.width, item.height].every(Number.isFinite) ||
        item.width < 0 ||
        item.height < 0
      ) {
        exclusions.push({
          reason: 'invalid-geometry',
          items: [{ pageNumber, index, text: item.str }]
        })
        return empty
      }
      // Express PDF coordinates in the reader's default viewport, including CropBox
      // offsets and UserUnit scaling. Grouping uses a bottom-up virtual PDF axis.
      const [a, b, c, d, x, y] = item.transform
      const [ma, mb, mc, md, mx, my] = viewport.transform
      const scale = Math.hypot(ma, mb)
      return {
        str: item.str,
        width: item.width * scale,
        height: item.height * scale,
        dir: item.dir,
        transform: [
          ma * a + mc * b,
          -(mb * a + md * b),
          ma * c + mc * d,
          -(mb * c + md * d),
          ma * x + mc * y + mx,
          viewport.height - (mb * x + md * y + my)
        ],
        fontName: item.fontName,
        fontAscent: content.styles?.[item.fontName]?.ascent,
        fontDescent: content.styles?.[item.fontName]?.descent,
        hasEOL: item.hasEOL
      }
    })
    styles.push(content.styles ?? {})
    if (pageTextItems === 0) pagesWithoutText.push(pageNumber)
    pages.push({
      page: pageNumber,
      width: viewport.width,
      height: viewport.height,
      // Item coordinates already include the default viewport rotation above. Group
      // readable horizontal prose in that space; sideways items still remain source-only.
      rotation: 0,
      items
    })
    onProgress?.(pageNumber)
    // Let the reader paint and deliver cancellation between page reads.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    signal.throwIfAborted()
  }
  // ponytail: grouping is synchronous; move it to a worker if long-document profiling requires it.
  const layout = groupPdfTranslationPages({ pages })
  const units: PdfTranslationSource['units'][number][] = []
  const independent: PdfTranslationSource['units'][number][] = []
  const warnings: PdfTranslationExtraction['coverage']['warnings'][number][] = []
  const accounted = new Set(
    exclusions.flatMap((entry) => entry.items.map((item) => `${item.pageNumber}:${item.index}`))
  )
  for (const unit of layout.units) {
    signal.throwIfAborted()
    let reason: PdfTranslationExclusionReason | undefined
    if (unit.risks.includes('unsupported-orientation')) reason = 'unsupported-orientation'
    const fragments = unit.fragments.flatMap((fragment) => {
      const page = layout.pages[fragment.page - 1]
      const block = page.blocks.find((block) => block.id === fragment.id)!
      const r = fragment.rect
      const rect = {
        x: r.x / page.width,
        y: r.y / page.height,
        width: (r.right - r.x) / page.width,
        height: (r.bottom - r.y) / page.height
      }
      if (
        !reason &&
        (!Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0)
      )
        reason = 'invalid-geometry'
      if (
        !reason &&
        (rect.x < 0 ||
          rect.y < 0 ||
          rect.x + rect.width > 1.000001 ||
          rect.y + rect.height > 1.000001)
      )
        reason = 'outside-page'
      const items = block.items
        .map((key, index) => {
          if (accounted.has(key)) throw new Error('Duplicate PDF source item ownership')
          accounted.add(key)
          return { index: Number(key.split(':')[1]), text: block.originalStrings[index] }
        })
        .sort((a, b) => a.index - b.index)
      // A wide caption above a narrow column can create a bounding box containing
      // another block. Retain the unit identity/text but use its existing line boxes.
      const overlaps = page.blocks.some(
        (other) =>
          other.id !== block.id &&
          other.rect.x < r.right &&
          other.rect.right > r.x &&
          other.rect.y < r.bottom &&
          other.rect.bottom > r.y
      )
      return overlaps && block.lines.length > 1 && !reason
        ? block.lines.map((line) => ({
            pageNumber: fragment.page,
            rect: {
              x: line.x / page.width,
              y: line.y / page.height,
              width: (line.right - line.x) / page.width,
              height: (line.bottom - line.y) / page.height
            },
            items: items.filter((item) => line.items.includes(fragment.page + ':' + item.index))
          }))
        : [{ pageNumber: fragment.page, rect, items }]
    })
    // Keep the established grouping/IDs unchanged. Recover only isolated original items;
    // never merge a rotated table's values through the prose grouping heuristic.
    if (
      reason === 'unsupported-orientation' &&
      fragments.length === 1 &&
      fragments[0].items.length === 1
    ) {
      const fragment = fragments[0],
        original = fragment.items[0]
      const page = pages[fragment.pageNumber - 1],
        item = page.items[original.index]
      const rect = independentRect(item, page, styles[fragment.pageNumber - 1][item.fontName ?? ''])
      if (rect) {
        independent.push({
          id: `rot-p${fragment.pageNumber}-i${original.index}`,
          source: original.text,
          sourceOnly: true,
          fragments: [{ ...fragment, rect }]
        })
        continue
      }
    }
    if (reason)
      exclusions.push({
        unitId: unit.id,
        reason,
        items: fragments.flatMap((fragment) =>
          fragment.items.map((item) => ({ ...item, pageNumber: fragment.pageNumber }))
        )
      })
    else {
      units.push({
        id: unit.id,
        source: unit.source,
        ...(unit.sourceOnly ? { sourceOnly: true as const } : {}),
        fragments
      })
      if (unit.risks.length)
        warnings.push(Object.freeze({ unitId: unit.id, reasons: Object.freeze([...unit.risks]) }))
    }
  }
  if (accounted.size !== textItemCount) throw new Error('Incomplete PDF source item coverage')
  // Retain native item order for independent anchors; this is not inferred table reading order.
  independent.sort(
    (a, b) =>
      a.fragments[0].pageNumber - b.fragments[0].pageNumber ||
      a.fragments[0].items[0].index - b.fragments[0].items[0].index
  )
  const excludedItemCount = exclusions.reduce((count, entry) => count + entry.items.length, 0)
  signal.throwIfAborted()
  return Object.freeze({
    source: createPdfTranslationSource({
      resourceRequestKey,
      fingerprint,
      pages,
      units: [...units, ...independent]
    }),
    coverage: Object.freeze({
      pageCount: pages.length,
      textItemCount,
      includedItemCount: textItemCount - excludedItemCount,
      excludedItemCount,
      pagesWithoutText: Object.freeze(pagesWithoutText),
      exclusions: Object.freeze(
        exclusions.map((entry) =>
          Object.freeze({
            ...entry,
            items: Object.freeze(entry.items.map((item) => Object.freeze(item)))
          })
        )
      ),
      warnings: Object.freeze(warnings)
    })
  })
}
