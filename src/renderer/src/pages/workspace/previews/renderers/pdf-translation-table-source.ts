import { getPdfTranslationTextContent } from './pdf-translation-text-content'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api'
import {
  parsePdfStructureResult,
  type PdfStructureResult,
  type ReadCachedPdfStructureRequest
} from '../../../../../../shared/pdf-structure'
import { createPdfTranslationSource, type PdfTranslationFragment } from './pdf-translation'
import type { PdfTranslationExtraction } from './pdf-translation-extraction'

export type PdfTranslationSourceIdentity = Readonly<{
  sourceChecksum: string
  sourceSizeBytes: number
}>
type Document = Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'>
type Viewport = ReturnType<PDFPageProxy['getViewport']>
type Rect = PdfTranslationFragment['rect']

// Independent native advance boxes, not glyph masks or regions safe to paint over.
function nativeRect(
  item: TextItem,
  style: TextStyle | undefined,
  viewport: Viewport
): Rect | undefined {
  if (
    item.dir !== 'ltr' ||
    style?.vertical ||
    item.transform.length !== 6 ||
    ![...item.transform, item.width, item.height].every(Number.isFinite)
  )
    return undefined
  const [a, b, c, d, x, y] = item.transform,
    advance = Math.hypot(a, b)
  if (advance <= 0 || item.width <= 0 || item.height <= 0 || a * d - b * c <= 0) return undefined
  const ux = a / advance,
    uy = b / advance
  if (
    Math.min(Math.abs(ux), Math.abs(uy)) > 0.0001 ||
    Math.abs(a * c + b * d) > advance * Math.hypot(c, d) * 0.5
  )
    return undefined
  const points = [
    [x, y],
    [x + ux * item.width, y + uy * item.width],
    [x - uy * item.height, y + ux * item.height],
    [x + ux * item.width - uy * item.height, y + uy * item.width + ux * item.height]
  ].map(([x, y]) => viewport.convertToViewportPoint(x, y))
  const left = Math.min(...points.map((p) => p[0])),
    top = Math.min(...points.map((p) => p[1]))
  const rect = {
    x: left / viewport.width,
    y: top / viewport.height,
    width: (Math.max(...points.map((p) => p[0])) - left) / viewport.width,
    height: (Math.max(...points.map((p) => p[1])) - top) / viewport.height
  }
  return Object.values(rect).every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= -1e-9 &&
    rect.y >= -1e-9 &&
    rect.x + rect.width <= 1 + 1e-9 &&
    rect.y + rect.height <= 1 + 1e-9
    ? rect
    : undefined
}

/** Before publication only. Failure preserves the entire extraction; cells remain source-only. */
export async function applyCachedPdfTableSources({
  extraction,
  document,
  attachmentVersionId,
  sourceIdentity,
  signal,
  readCached
}: {
  extraction: PdfTranslationExtraction
  document: Document
  attachmentVersionId: string
  sourceIdentity: PdfTranslationSourceIdentity
  signal: AbortSignal
  readCached: (request: ReadCachedPdfStructureRequest) => Promise<PdfStructureResult | undefined>
}): Promise<PdfTranslationExtraction> {
  signal.throwIfAborted()
  const identity = { ...sourceIdentity },
    source = extraction.source
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
      throw new Error('PDF source changed during table verification')
  }
  try {
    const batches = new Map<string, string>(),
      results: PdfStructureResult[] = []
    let bytes = 0,
      elements = 0
    for (let page = 1; page <= document.numPages; page++) {
      current()
      const cached = await readCached({ attachmentVersionId, page })
      current()
      if (!cached) continue
      // Schema decoding copies the response before any further await. Identity comes from the lease.
      const result = parsePdfStructureResult(cached, { ...cached, ...identity })
      if (result.pageCount !== document.numPages || !result.processedPages.includes(page))
        return extraction
      const serialized = JSON.stringify(result),
        prior = batches.get(result.extractionId)
      if (prior !== undefined) {
        if (prior !== serialized) return extraction
        continue
      }
      bytes += serialized.length * 2
      elements += result.elements.length
      // Same bounded cache inventory as the existing figures reader; never publish a partial replacement.
      if (bytes > 32 * 1024 ** 2 || elements > 512) return extraction
      batches.set(result.extractionId, serialized)
      results.push(result)
    }
    const owners = new Map<string, string>(),
      claims = new Map<string, string>()
    const ids = new Set<string>(),
      removed = new Set<string>()
    const replacements: PdfTranslationExtraction['source']['units'][number][] = []
    for (const unit of source.units) {
      if (ids.has(unit.id)) return extraction
      ids.add(unit.id)
      for (const fragment of unit.fragments)
        for (const item of fragment.items) {
          const key = `${fragment.pageNumber}:${item.index}`
          if (owners.has(key)) return extraction
          owners.set(key, item.text)
        }
    }
    const pages = new Map<
      number,
      {
        viewport: Viewport
        rotation: number
        content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
      }
    >()
    for (const result of results)
      for (const element of result.elements) {
        const tables =
          element.tableParts?.map((part) => part.table) ?? (element.table ? [element.table] : [])
        for (const [part, table] of tables.entries()) {
          const tableKey = `${result.extractionId}:${element.id}:${part}`
          for (const cell of table.cells) {
            if (!cell.text.trim() && !cell.regions.length && !cell.sourceItems?.length) continue
            if (!cell.sourceItems?.length || cell.sourceItems.length !== cell.regions.length)
              return extraction
            const remaining = [...cell.regions],
              fragments = new Map<
                number,
                { items: { index: number; text: string }[]; rects: Rect[] }
              >()
            for (const origin of cell.sourceItems) {
              const key = `${origin.pageNumber}:${origin.index}`
              if (owners.get(key) !== origin.text || claims.has(key)) return extraction
              let page = pages.get(origin.pageNumber)
              if (!page) {
                current()
                const proxy = await document.getPage(origin.pageNumber)
                current()
                const viewport = proxy.getViewport({ scale: 1 }),
                  content = await getPdfTranslationTextContent(proxy)
                current()
                page = { viewport, content, rotation: proxy.rotate }
                pages.set(origin.pageNumber, page)
              }
              const expectedPage = result.pages.find((p) => p.page === origin.pageNumber)
              const sourcePage = source.pages[origin.pageNumber - 1]
              if (
                !expectedPage ||
                !sourcePage ||
                page.rotation !== expectedPage.rotation ||
                ![page.viewport.width, page.viewport.height].every(
                  (n) => Number.isFinite(n) && n > 0
                ) ||
                Math.abs(page.viewport.width - expectedPage.width) > 0.01 ||
                Math.abs(page.viewport.height - expectedPage.height) > 0.01 ||
                Math.abs(page.viewport.width - sourcePage.width) > 0.01 ||
                Math.abs(page.viewport.height - sourcePage.height) > 0.01
              )
                return extraction
              const raw = page.content.items[origin.index]
              if (!raw || !('str' in raw) || raw.str !== origin.text) return extraction
              const rect = nativeRect(raw, page.content.styles[raw.fontName], page.viewport)
              if (!rect) return extraction
              const matches = remaining
                .map((region, index) => ({ region, index }))
                .filter(
                  ({ region }) =>
                    region.page === origin.pageNumber &&
                    (['x', 'y', 'width', 'height'] as const).every(
                      (axis) => Math.abs(region[axis] - rect[axis]) <= 1e-6
                    )
                )
              if (matches.length !== 1) return extraction
              const [matched] = remaining.splice(matches[0].index, 1)
              claims.set(key, tableKey)
              const fragment = fragments.get(origin.pageNumber) ?? { items: [], rects: [] }
              fragment.items.push({ index: origin.index, text: origin.text })
              fragment.rects.push(matched)
              fragments.set(origin.pageNumber, fragment)
            }
            const id = `table-source:${tableKey}:${cell.row}:${cell.column}`
            if (ids.has(id)) return extraction
            ids.add(id)
            replacements.push({
              id,
              sourceOnly: true,
              source: cell.sourceItems.map((i) => i.text).join(' '),
              fragments: [...fragments].map(([pageNumber, { items, rects }]) => {
                const x = Math.min(...rects.map((r) => r.x)),
                  y = Math.min(...rects.map((r) => r.y))
                return {
                  pageNumber,
                  items,
                  rect: {
                    x,
                    y,
                    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
                    height: Math.max(...rects.map((r) => r.y + r.height)) - y
                  }
                }
              })
            })
          }
        }
      }
    if (!replacements.length) return extraction
    for (const unit of source.units) {
      const keys = unit.fragments.flatMap((f) => f.items.map((i) => `${f.pageNumber}:${i.index}`))
      const claimed = keys.filter((key) => claims.has(key))
      if (!claimed.length) continue
      if (
        claimed.length !== keys.length ||
        new Set(claimed.map((key) => claims.get(key))).size !== 1
      )
        return extraction
      removed.add(unit.id)
    }
    current()
    // Exact owners were consumed once above; only whole units move, so no text can disappear.
    return Object.freeze({
      ...extraction,
      source: createPdfTranslationSource({
        ...source,
        units: [...source.units.filter((u) => !removed.has(u.id)), ...replacements]
      })
    })
  } catch {
    signal.throwIfAborted()
    return extraction
  }
}
