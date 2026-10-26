import { parsePdfStructureResult, type PdfStructureResult } from '@aipoch/pdf-structure/result'
import type { OPS, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { PdfTranslationExtraction } from './extraction.js'
import { isPdfTranslationCaption } from './layout.js'
import { createPdfTranslationSource, type PdfTranslationFragment } from './source.js'
import type { PdfTranslationSourceIdentity } from './table-source.js'
import { verifiedPdfStructureRegions } from './structure-regions.js'
import { nativeLabelRegion } from './native-source-geometry.js'
import { retainPdfWholeRegionSources } from './whole-region-retention.js'

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
    let page: PDFPageProxy | undefined
    try {
      page = await document.getPage(number)
      signal.throwIfAborted()
      const { images, vectors, rules = [] } = await graphicRegions(page, operators, signal)
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
    } finally {
      // PDF.js defers cleanup while a shared page is still rendering.
      page?.cleanup()
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
          figure.issues.some(
            (issue) =>
              issue.code !== 'native-raster-composite-grid' &&
              issue.code !== 'native-disjoint-mixed-group'
          )
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
      const originalRegions = verifiedPdfStructureRegions(
        source,
        elements
          .filter((element) => element.kind === 'figure')
          .map((element) => ({
            regions: element.regions,
            owners: new Set(
              [...claims].filter(([, owner]) => owner === element).map(([key]) => key)
            )
          })),
        new Map(
          [...native].map(([number, content]) => [
            number,
            { content, viewport: viewports.get(number)! }
          ])
        ),
        elements.flatMap((element) => element.caption?.regions ?? [])
      )
      current()
      return changed || originalRegions.length
        ? Object.freeze({
            ...extraction,
            source: createPdfTranslationSource({
              ...source,
              units,
              ...(originalRegions.length
                ? { originalRegions: [...(source.originalRegions ?? []), ...originalRegions] }
                : {})
            })
          })
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
