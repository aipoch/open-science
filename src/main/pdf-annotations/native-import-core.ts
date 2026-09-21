import { createHash } from 'node:crypto'

import type { PdfAnnotationKind, PdfAnnotationSelector } from '../../shared/pdf-annotations'
import type { PdfMarkColor } from '../../shared/pdf-bookmarks'

const MAX_IMPORTED_NATIVE_ANNOTATIONS = 500
const MAX_UNSUPPORTED_NATIVE_ANNOTATIONS = 5_000
const NATIVE_EXTRACTOR_VERSION = 'pdf-native-annotation-v1'
const AREA_ANNOTATION_SUBTYPES = new Set([
  'Text',
  'FreeText',
  'Square',
  'Circle',
  'Ink',
  'Stamp',
  'Polygon',
  'PolyLine'
])

type PdfJsAnnotation = Readonly<{
  subtype?: string
  rect?: readonly number[]
  quadPoints?: ArrayLike<number>
  color?: ArrayLike<number> | null
  contentsObj?: { str?: string }
  titleObj?: { str?: string }
  id?: string
}>

type PdfJsTextItem = Readonly<{
  str?: string
  width?: number
  height?: number
  transform?: readonly number[]
  hasEOL?: boolean
}>

type PdfJsPage = Readonly<{
  view: readonly number[]
  rotate: number
  getAnnotations: (options?: { intent?: string }) => Promise<readonly PdfJsAnnotation[]>
  getTextContent: () => Promise<{ items: readonly PdfJsTextItem[] }>
  cleanup?: () => void
}>

type PdfNativeAnnotationDraft = Readonly<{
  nativeId?: string
  stableKey: string
  pageNumber: number
  kind: PdfAnnotationKind
  selector: PdfAnnotationSelector
  color: PdfMarkColor
  note: string
  subtype: string
}>

type NativePdfAnnotationImportResult = Readonly<{
  pageCount: number
  annotations: readonly PdfNativeAnnotationDraft[]
  unsupportedCount: number
  truncated: boolean
}>

type NativePdfAnnotationProgress = Readonly<{
  pagesProcessed: number
  pageCount: number
  annotationsFound: number
  unsupportedCount: number
}>
type NativePdfAnnotationParseOptions = Readonly<{
  signal?: AbortSignal
  onProgress?: (progress: NativePdfAnnotationProgress) => void
}>

const COLOR_RGB: Readonly<Record<PdfMarkColor, readonly [number, number, number]>> = {
  yellow: [255, 214, 41],
  blue: [64, 140, 255],
  green: [56, 191, 97],
  pink: [245, 97, 158],
  purple: [163, 107, 240]
}

const colorFromRgb = (value: ArrayLike<number> | null | undefined): PdfMarkColor => {
  if (!value || value.length < 3) return 'yellow'
  let result: PdfMarkColor = 'yellow'
  let distance = Number.POSITIVE_INFINITY
  for (const [name, rgb] of Object.entries(COLOR_RGB) as Array<
    [PdfMarkColor, readonly [number, number, number]]
  >) {
    const current =
      (Number(value[0]) - rgb[0]) ** 2 +
      (Number(value[1]) - rgb[1]) ** 2 +
      (Number(value[2]) - rgb[2]) ** 2
    if (current < distance) {
      distance = current
      result = name
    }
  }
  return result
}

const pageDimensions = (
  view: readonly number[]
): { left: number; bottom: number; width: number; height: number } | undefined => {
  if (view.length < 4) return undefined
  const [x0, y0, x1, y1] = view
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return undefined
  return { left: x0, bottom: y0, width: x1 - x0, height: y1 - y0 }
}

const normalizedRect = (
  rect: readonly number[] | undefined,
  page: { left: number; bottom: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } | undefined => {
  if (!rect || rect.length < 4) return undefined
  const [x0, y0, x1, y1] = rect
  if (![x0, y0, x1, y1].every(Number.isFinite)) return undefined
  const left = Math.max(page.left, Math.min(x0, x1))
  const right = Math.min(page.left + page.width, Math.max(x0, x1))
  const bottom = Math.max(page.bottom, Math.min(y0, y1))
  const top = Math.min(page.bottom + page.height, Math.max(y0, y1))
  if (right <= left || top <= bottom) return undefined
  return {
    x: (left - page.left) / page.width,
    y: 1 - (top - page.bottom) / page.height,
    width: (right - left) / page.width,
    height: (top - bottom) / page.height
  }
}

const normalizedQuads = (
  points: ArrayLike<number> | undefined,
  page: { left: number; bottom: number; width: number; height: number }
): Array<{ x: number; y: number; width: number; height: number }> => {
  if (!points || points.length < 8 || points.length % 8 !== 0) return []
  const quads: Array<{ x: number; y: number; width: number; height: number }> = []
  for (let offset = 0; offset < points.length; offset += 8) {
    const values = Array.from({ length: 8 }, (_, index) => Number(points[offset + index]))
    if (!values.every(Number.isFinite)) continue
    const xs = [values[0], values[2], values[4], values[6]]
    const ys = [values[1], values[3], values[5], values[7]]
    const rect = normalizedRect(
      [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      page
    )
    if (rect && quads.length < 256) quads.push(rect)
  }
  return quads
}

const annotationText = (annotation: PdfJsAnnotation): string =>
  (annotation.contentsObj?.str ?? annotation.titleObj?.str ?? '').trim().slice(0, 20_000)

const itemBounds = (item: PdfJsTextItem): [number, number, number, number] | undefined => {
  const transform = item.transform
  if (!transform || transform.length < 6) return undefined
  const [a, b, c, d, x, y] = transform
  const width = Number(item.width)
  const height = Number(item.height)
  if (![a, b, c, d, x, y, width, height].every(Number.isFinite)) return undefined
  const extentX = Math.max(width, Math.hypot(a, b) * Math.max(1, (item.str ?? '').length))
  const extentY = Math.max(height, Math.hypot(c, d))
  return [x, y - extentY, x + extentX, y]
}

type PdfJsTextRun = Readonly<{
  text: string
  bounds: readonly [number, number, number, number]
}>

const intersects = (a: readonly number[], b: readonly number[]): boolean =>
  Math.max(a[0], b[0]) < Math.min(a[2], b[2]) && Math.max(a[1], b[1]) < Math.min(a[3], b[3])

const textForQuads = (items: readonly PdfJsTextRun[], quads: readonly number[]): string => {
  if (quads.length < 8) return ''
  const xs: number[] = []
  const ys: number[] = []
  for (let index = 0; index < quads.length; index += 2) {
    xs.push(Number(quads[index]))
    ys.push(Number(quads[index + 1]))
  }
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  return items
    .filter((item) => intersects(item.bounds, bounds))
    .map((item) => item.text)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 4_000)
}

const stableKey = (
  pageNumber: number,
  annotation: PdfJsAnnotation,
  note: string,
  quads: readonly number[]
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        pageNumber,
        // PDF.js exposes the native object id for annotations created by most editors. Include
        // it when available so two legitimate marks at the same coordinates remain distinct.
        id: annotation.id,
        subtype: annotation.subtype,
        rect: annotation.rect,
        quads,
        note
      })
    )
    .digest('hex')

const parsePdfJs = async (
  filePath: string,
  options: NativePdfAnnotationParseOptions = {}
): Promise<NativePdfAnnotationImportResult> => {
  options.signal?.throwIfAborted()
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist')
  const loadingTask = pdfjs.getDocument({
    url: filePath,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0
  })
  const abortLoading = (): void => {
    void loadingTask.destroy()
  }
  options.signal?.addEventListener('abort', abortLoading, { once: true })
  const document = await loadingTask.promise.finally(() => {
    options.signal?.removeEventListener('abort', abortLoading)
  })
  const pageCount = document.numPages
  const annotations: PdfNativeAnnotationDraft[] = []
  let unsupportedCount = 0
  let truncated = false
  let lastProgressAt = 0
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      options.signal?.throwIfAborted()
      const page = (await document.getPage(pageNumber)) as unknown as PdfJsPage
      const dimensions = pageDimensions(page.view)
      if (!dimensions) continue
      const pageRotation = [0, 90, 180, 270].includes(page.rotate)
        ? (page.rotate as 0 | 90 | 180 | 270)
        : 0
      const native = await page.getAnnotations({ intent: 'display' })
      // Sticky notes and unsupported shapes do not need text extraction. On note-heavy PDFs this
      // avoids a full text walk for every page and keeps import CPU proportional to markup pages.
      const needsText = native.some(
        (annotation) =>
          ['Highlight', 'Underline', 'Squiggly', 'StrikeOut'].includes(annotation.subtype ?? '') &&
          Boolean(annotation.quadPoints)
      )
      const textContent = needsText ? await page.getTextContent() : { items: [] }
      // Calculate glyph-run bounds once per page. A paper can contain hundreds of native
      // markups, and recomputing transforms for every markup makes import CPU grow quadratically.
      const textRuns: PdfJsTextRun[] = textContent.items.flatMap((item) => {
        const bounds = itemBounds(item)
        const text = item.str?.trim() ?? ''
        return bounds && text ? [{ bounds, text }] : []
      })
      for (const annotation of native) {
        options.signal?.throwIfAborted()
        if (
          annotation.subtype === 'Popup' ||
          annotation.subtype === 'Link' ||
          annotation.subtype === 'Widget'
        )
          continue
        const subtype = annotation.subtype ?? ''
        const markupKind =
          subtype === 'Highlight'
            ? 'highlight'
            : subtype === 'Underline'
              ? 'underline'
              : subtype === 'Squiggly'
                ? 'squiggly'
                : subtype === 'StrikeOut'
                  ? 'strikethrough'
                  : undefined
        const quads = annotation.quadPoints ? Array.from(annotation.quadPoints, Number) : []
        const normalized = normalizedQuads(annotation.quadPoints, dimensions)
        const rect = normalizedRect(annotation.rect, dimensions)
        const note = annotationText(annotation)
        const color = colorFromRgb(annotation.color)
        const hasNativeIdentity = Boolean(annotation.id && /^\d+R\d*$/.test(annotation.id))
        if (hasNativeIdentity && markupKind && normalized.length > 0) {
          const exact = textForQuads(textRuns, quads)
          if (exact) {
            annotations.push({
              stableKey: stableKey(pageNumber, annotation, note, quads),
              nativeId:
                annotation.id && /^\d+R\d*$/.test(annotation.id) ? annotation.id : undefined,
              pageNumber,
              kind: markupKind,
              color,
              note,
              subtype,
              selector: {
                kind: 'text',
                pageNumber,
                exact,
                position: { start: 0, end: exact.length },
                quads: normalized,
                extractorVersion: NATIVE_EXTRACTOR_VERSION,
                pageRotation,
                coordinateVersion: 1
              }
            })
          } else if (rect) {
            annotations.push({
              stableKey: stableKey(pageNumber, annotation, note, quads),
              nativeId:
                annotation.id && /^\d+R\d*$/.test(annotation.id) ? annotation.id : undefined,
              pageNumber,
              kind: 'area',
              color,
              note,
              subtype,
              selector: { kind: 'region', pageNumber, rect, pageRotation, coordinateVersion: 1 }
            })
          } else {
            unsupportedCount += 1
          }
        } else if (hasNativeIdentity && AREA_ANNOTATION_SUBTYPES.has(subtype) && rect) {
          annotations.push({
            stableKey: stableKey(pageNumber, annotation, note, quads),
            nativeId: annotation.id && /^\d+R\d*$/.test(annotation.id) ? annotation.id : undefined,
            pageNumber,
            kind: 'area',
            color,
            note,
            subtype,
            selector: { kind: 'region', pageNumber, rect, pageRotation, coordinateVersion: 1 }
          })
        } else {
          unsupportedCount += 1
        }
        if (annotations.length >= MAX_IMPORTED_NATIVE_ANNOTATIONS) {
          truncated = true
          break
        }
        if (unsupportedCount >= MAX_UNSUPPORTED_NATIVE_ANNOTATIONS) {
          truncated = true
          break
        }
      }
      page.cleanup?.()
      const now = performance.now()
      if (now - lastProgressAt >= 100 || pageNumber === pageCount || truncated) {
        lastProgressAt = now
        options.onProgress?.({
          pagesProcessed: pageNumber,
          pageCount,
          annotationsFound: annotations.length,
          unsupportedCount
        })
      }
      if (truncated) break
    }
  } finally {
    await document.destroy()
  }
  return { pageCount, annotations, unsupportedCount, truncated }
}

export {
  MAX_IMPORTED_NATIVE_ANNOTATIONS,
  NATIVE_EXTRACTOR_VERSION,
  parsePdfJs as parseNativePdfAnnotationsOnCurrentThread
}
export type {
  NativePdfAnnotationImportResult,
  NativePdfAnnotationParseOptions,
  NativePdfAnnotationProgress,
  PdfNativeAnnotationDraft
}

export const nativeImportReceipt = (
  parsed: NativePdfAnnotationImportResult
): import('../../shared/pdf-annotations').PdfNativeImportReceipt => ({
  nativeRefs: parsed.annotations.flatMap((annotation) =>
    annotation.nativeId ? [{ pageNumber: annotation.pageNumber, id: annotation.nativeId }] : []
  ),
  pageCount: parsed.pageCount,
  unsupportedCount: parsed.unsupportedCount,
  truncated: parsed.truncated
})
