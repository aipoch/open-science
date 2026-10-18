import type { OPS, PDFPageProxy } from 'pdfjs-dist'
import type { PdfTranslationExtraction } from './extraction.js'
import { isPdfTranslationCaption } from './layout.js'
import { createPdfTranslationSource, type PdfTranslationFragment } from './source.js'

type Rect = PdfTranslationFragment['rect']
type Matrix = readonly number[]
type Document = { getPage: (number: number) => Promise<PDFPageProxy> }
type Source = PdfTranslationExtraction['source']
const multiply = (a: Matrix, b: Matrix): number[] => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5]
]
const overlaps = (a: Rect, b: Rect, pad = 0.004): boolean =>
  a.x <= b.x + b.width + pad &&
  b.x <= a.x + a.width + pad &&
  a.y <= b.y + b.height + pad &&
  b.y <= a.y + a.height + pad
const union = (a: Rect, b: Rect): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
  height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y)
})
const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x - 0.003 &&
  inner.y >= outer.y - 0.003 &&
  inner.x + inner.width <= outer.x + outer.width + 0.003 &&
  inner.y + inner.height <= outer.y + outer.height + 0.003

/** Conservative graphic anchors, not regions authorized for PDF text replacement. */
async function graphicRegions(
  page: PDFPageProxy,
  ops: typeof OPS,
  signal: AbortSignal
): Promise<{
  images: Rect[]
  vectors: Rect[]
  rules?: Rect[]
}> {
  const images: Rect[] = [],
    vectors: Rect[] = []
  // Older embedders may provide only the text extraction subset of PDFPageProxy.
  if (typeof page.getOperatorList !== 'function') return { images, vectors }
  const viewport = page.getViewport({ scale: 1 })
  const list = await page.getOperatorList()
  signal.throwIfAborted()
  if (list.fnArray.length > 150000) return { images, vectors }
  let matrix: Matrix = viewport.transform
  const stack: Matrix[] = []
  const add = (bounds: readonly number[], target: Rect[]): void => {
    if (bounds.length !== 4 || !bounds.every(Number.isFinite)) return
    const [left, bottom, right, top] = bounds
    if (right < left || top < bottom) return
    const points = [
      [left, bottom],
      [left, top],
      [right, bottom],
      [right, top]
    ].map(([x, y]) => [
      matrix[0] * x + matrix[2] * y + matrix[4],
      matrix[1] * x + matrix[3] * y + matrix[5]
    ])
    const x = Math.max(0, Math.min(...points.map((p) => p[0])) / viewport.width),
      y = Math.max(0, Math.min(...points.map((p) => p[1])) / viewport.height)
    const rect = {
      x,
      y,
      width: Math.min(1, Math.max(...points.map((p) => p[0])) / viewport.width) - x,
      height: Math.min(1, Math.max(...points.map((p) => p[1])) / viewport.height) - y
    }
    // Ignore rules, tiny glyph outlines and page backgrounds/scanned body pages.
    if (
      rect.width >= 0 &&
      rect.height >= 0 &&
      (target === vectors
        ? Math.max(rect.width, rect.height) >= 0.006
        : rect.width >= 0.006 && rect.height >= 0.006) &&
      rect.width * rect.height <= 0.7
    )
      target.push(rect)
  }
  for (let index = 0; index < list.fnArray.length; index++) {
    if (index % 1000 === 0) signal.throwIfAborted()
    if (images.length + vectors.length > 10000) return { images: [], vectors: [] }
    const op = list.fnArray[index],
      args = list.argsArray[index]
    if (op === ops.save || op === ops.paintFormXObjectBegin || op === ops.beginGroup) {
      if (stack.length >= 128) return { images: [], vectors: [] }
      stack.push(matrix)
      if (op === ops.paintFormXObjectBegin && args[0]) matrix = multiply(matrix, args[0])
    } else if (op === ops.restore || op === ops.paintFormXObjectEnd || op === ops.endGroup) {
      if (!stack.length) return { images: [], vectors: [] }
      matrix = stack.pop()!
    } else if (op === ops.transform) matrix = multiply(matrix, args)
    else if (op === ops.constructPath && args[2]) add(args[2], vectors)
    else if (op === ops.paintImageXObjectRepeat && args[3]?.length <= 10000) {
      const base = matrix
      for (let at = 0; at < args[3].length; at += 2) {
        matrix = multiply(base, [args[1], 0, 0, args[2], args[3][at], args[3][at + 1]])
        add([0, 0, 1, 1], images)
      }
      matrix = base
    } else if (
      op === ops.paintImageXObject ||
      op === ops.paintInlineImageXObject ||
      op === ops.paintImageMaskXObject
    )
      add([0, 0, 1, 1], images)
  }
  // Connected vector shapes identify a diagram. Standalone filled text boxes
  // require a nearby figure caption below before any text can be skipped.
  if (vectors.length > 5000) return { images, vectors: [] }
  const grouped: Rect[] = []
  for (const rect of vectors) {
    let merged = rect
    for (let index = 0; index < grouped.length;) {
      if (overlaps(merged, grouped[index])) {
        merged = union(merged, grouped.splice(index, 1)[0])
        index = 0
      } else index++
    }
    if (merged.width * merged.height <= 0.7) grouped.push(merged)
  }
  return {
    images,
    vectors: grouped.filter((rect) => rect.width >= 0.006 && rect.height >= 0.006),
    rules: vectors.filter((rect) => rect.width >= 0.18 && rect.height < 0.006)
  }
}

// Three-line academic tables often have no vertical rules. A caption plus
// matching top/header/bottom rules proves an atomic region without guessing cells.
function tableRegions(units: Source['units'], rules: readonly Rect[], number: number): Rect[] {
  const captions = units
    .filter(
      (unit) => /^(?:Table|Tab\.)\s*\d/iu.test(unit.source) && isPdfTranslationCaption(unit.source)
    )
    .flatMap((unit) => unit.fragments.filter((f) => f.pageNumber === number))
  const regions: Rect[] = []
  for (const caption of captions) {
    for (const above of [true, false]) {
      const nearby = rules
        .filter(
          (rule) =>
            rule.x < caption.rect.x + caption.rect.width &&
            rule.x + rule.width > caption.rect.x &&
            (above
              ? rule.y <= caption.rect.y && caption.rect.y - rule.y < 0.1
              : rule.y >= caption.rect.y + caption.rect.height &&
                rule.y - caption.rect.y - caption.rect.height < 0.1)
        )
        .sort((a, b) => (above ? b.y - a.y : a.y - b.y))
      const edge = nearby[0]
      if (!edge) continue
      const aligned = rules
        .filter(
          (rule) =>
            Math.abs(rule.x - edge.x) < 0.012 &&
            Math.abs(rule.x + rule.width - edge.x - edge.width) < 0.012 &&
            (above
              ? rule.y <= edge.y && edge.y - rule.y < 0.65
              : rule.y >= edge.y && rule.y - edge.y < 0.65)
        )
        .sort((a, b) => a.y - b.y)
      const distinct = aligned.filter(
        (rule, index) => !index || rule.y - aligned[index - 1].y > 0.004
      )
      if (distinct.length < 3) continue
      // The header separator follows the top rule closely; a distant rule can
      // belong to another table or a footnote and cannot establish the top.
      const tops = distinct
        .slice(0, -2)
        .filter((rule, index) => distinct[index + 1].y - rule.y < 0.06)
      const top = tops[0]
      const bottom = above ? edge : distinct.at(-1)
      if (!top || !bottom || bottom.y - top.y < 0.025) continue
      const rect = {
        x: Math.max(0, top.x - 0.002),
        y: Math.max(0, top.y - 0.003),
        width: Math.min(1, top.x + top.width + 0.002) - Math.max(0, top.x - 0.002),
        height: Math.min(1, bottom.y + bottom.height + 0.003) - Math.max(0, top.y - 0.003)
      }
      if (captions.some((other) => overlaps(rect, other.rect, 0))) continue
      const inside = units.filter(
        (unit) =>
          !isPdfTranslationCaption(unit.source) &&
          unit.fragments.some(
            (fragment) => fragment.pageNumber === number && contains(rect, fragment.rect)
          )
      )
      if (
        inside.length < 3 ||
        inside.some(
          (unit) => unit.source.length > 800 && unit.fragments.some((f) => f.rect.width > 0.65)
        )
      )
        continue
      if (!regions.some((region) => overlaps(region, rect, 0))) regions.push(rect)
    }
  }
  return regions
}

/** Run before admitting a new translation; historical snapshots keep their indices unchanged. */
export async function preservePdfFigureSources<T extends Pick<PdfTranslationExtraction, 'source'>>({
  document,
  extraction,
  operators,
  signal,
  skipTranslation = true
}: {
  document: Document
  extraction: T
  operators: typeof OPS
  signal: AbortSignal
  /** Preparation can annotate ownership before the user chooses a layout mode. */
  skipTranslation?: boolean
}): Promise<T> {
  const source = extraction.source,
    preserved = new Set<string>()
  const originalRegions: NonNullable<Source['originalRegions']>[number][] = [
    ...(source.originalRegions ?? [])
  ]
  for (let number = 1; number <= source.pages.length; number++) {
    signal.throwIfAborted()
    const units = source.units.filter((unit) => unit.fragments.some((f) => f.pageNumber === number))
    if (!units.length) continue
    try {
      const {
        images,
        vectors,
        rules = []
      } = await graphicRegions(await document.getPage(number), operators, signal)
      const captions = units
        .filter(
          (unit) =>
            /^(?:Figure|Fig\.)\s*\d/iu.test(unit.source) && isPdfTranslationCaption(unit.source)
        )
        .flatMap((unit) => unit.fragments.filter((f) => f.pageNumber === number))
      const regions = [
        ...images,
        ...tableRegions(units, rules, number),
        ...vectors.filter((rect) =>
          captions.some(
            ({ rect: caption }) =>
              caption.y >= rect.y + rect.height - 0.003 &&
              caption.y - rect.y - rect.height < 0.14 &&
              caption.x < rect.x + rect.width &&
              caption.x + caption.width > rect.x
          )
        )
      ]
      for (const rect of regions)
        if (
          !originalRegions.some(
            (region) => region.pageNumber === number && contains(region.rect, rect)
          )
        )
          originalRegions.push({ pageNumber: number, rect })
      for (const unit of units.filter(
        (unit) =>
          !isPdfTranslationCaption(unit.source) &&
          unit.fragments.every((f) => f.pageNumber === number)
      ))
        if (
          unit.fragments.every((fragment) => regions.some((rect) => contains(rect, fragment.rect)))
        )
          preserved.add(unit.id)
    } catch {
      // Missing/unusual graphics must not prevent ordinary text translation.
      signal.throwIfAborted()
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  if (!preserved.size && !originalRegions.length) return extraction
  return Object.freeze({
    ...extraction,
    source: createPdfTranslationSource({
      ...source,
      originalRegions,
      units: source.units.map((unit) =>
        preserved.has(unit.id)
          ? { ...unit, ...(skipTranslation ? { sourceOnly: true as const } : {}), figure: true }
          : unit
      )
    })
  })
}
