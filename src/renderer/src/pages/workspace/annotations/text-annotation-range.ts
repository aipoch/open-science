import type { PdfTextSelector } from '../../../../../shared/annotations'

const collectSurfaceTextNodes = (surface: HTMLElement): Text[] => {
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text)
  }
  return nodes
}

const concatenatedText = (nodes: readonly Text[]): string => nodes.map((node) => node.data).join('')

const rangeStartInSurfaceText = (nodes: readonly Text[], range: Range): number | undefined => {
  let offset = 0
  for (const node of nodes) {
    if (range.startContainer === node) return offset + range.startOffset
    offset += node.data.length
  }

  const startContainer = range.startContainer
  if (startContainer.nodeType !== Node.ELEMENT_NODE) return undefined
  const child = startContainer.childNodes[range.startOffset] ?? startContainer.lastChild
  if (!child) return undefined
  offset = 0
  for (const node of nodes) {
    if (child === node || (child instanceof Element && child.contains(node))) return offset
    offset += node.data.length
  }
  return undefined
}

const rangeForTextOccurrence = (
  surface: HTMLElement,
  quote: string,
  occurrence = 0
): Range | undefined => {
  const nodes = collectSurfaceTextNodes(surface)
  const text = concatenatedText(nodes)
  let start = -1
  let from = 0
  for (let index = 0; index <= occurrence; index += 1) {
    start = text.indexOf(quote, from)
    if (start < 0) return undefined
    from = start + quote.length
  }
  const end = start + quote.length
  let offset = 0
  let startNode: Text | undefined
  let endNode: Text | undefined
  let startOffset = 0
  let endOffset = 0
  for (const node of nodes) {
    const nextOffset = offset + node.data.length
    if (!startNode && start >= offset && start < nextOffset) {
      startNode = node
      startOffset = start - offset
    }
    if (!endNode && end >= offset && end <= nextOffset) {
      endNode = node
      endOffset = end - offset
      break
    }
    offset = nextOffset
  }
  if (!startNode || !endNode) return undefined
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}

const quoteOccurrenceForRange = (surface: HTMLElement, quote: string, range: Range): number => {
  const nodes = collectSurfaceTextNodes(surface)
  const start = rangeStartInSurfaceText(nodes, range)
  if (start === undefined) return 0
  const text = concatenatedText(nodes)
  let occurrence = 0
  let from = 0
  for (;;) {
    const index = text.indexOf(quote, from)
    if (index < 0 || index >= start) return occurrence
    occurrence += 1
    from = index + quote.length
  }
}

type TextAnnotationRangeTarget = Readonly<{ id: string; quote: string }>

const rangeBelongsToSurface = (range: Range, surface: HTMLElement): boolean => {
  const ancestor = range.commonAncestorContainer
  const contained = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor
  return contained !== null && surface.contains(contained)
}

const reconcileTextAnnotationRanges = (
  surface: HTMLElement,
  annotations: readonly TextAnnotationRangeTarget[],
  existing: ReadonlyMap<string, Range>
): Map<string, Range> => {
  const next = new Map<string, Range>()
  const occurrenceByQuote = new Map<string, number>()
  for (const annotation of annotations) {
    const occurrence = occurrenceByQuote.get(annotation.quote) ?? 0
    occurrenceByQuote.set(annotation.quote, occurrence + 1)
    const exact = existing.get(annotation.id)
    const range =
      exact && rangeBelongsToSurface(exact, surface) && exact.toString() === annotation.quote
        ? exact
        : rangeForTextOccurrence(surface, annotation.quote, occurrence)
    if (range) next.set(annotation.id, range)
  }
  return next
}

const retargetTextAnnotationRange = (
  surface: HTMLElement,
  quote: string,
  existing?: Range,
  occurrence = 0
): Range | undefined => {
  if (
    existing &&
    !existing.collapsed &&
    existing.toString() === quote &&
    rangeBelongsToSurface(existing, surface)
  ) {
    return existing
  }
  return rangeForTextOccurrence(surface, quote, occurrence)
}

const PDF_TEXT_CONTEXT_LENGTH = 64

type ClippedPdfSelectionRect = Readonly<{
  left: number
  top: number
  right: number
  bottom: number
}>

const mergePdfSelectionRects = (
  rects: readonly DOMRect[],
  page: DOMRect
): readonly ClippedPdfSelectionRect[] => {
  const clipped = rects
    .flatMap((rect): ClippedPdfSelectionRect[] => {
      const left = Math.max(page.left, rect.left)
      const top = Math.max(page.top, rect.top)
      const right = Math.min(page.right || page.left + page.width, rect.right)
      const bottom = Math.min(page.bottom || page.top + page.height, rect.bottom)
      return right - left > 0.5 && bottom - top > 0.5 ? [{ left, top, right, bottom }] : []
    })
    .sort((left, right) => left.top - right.top || left.left - right.left)

  const merged: ClippedPdfSelectionRect[] = []
  for (const rect of clipped) {
    const previous = merged.at(-1)
    if (previous) {
      const overlap = Math.min(previous.bottom, rect.bottom) - Math.max(previous.top, rect.top)
      const minHeight = Math.min(previous.bottom - previous.top, rect.bottom - rect.top)
      const gap = rect.left - previous.right
      if (overlap >= minHeight * 0.6 && gap <= Math.max(minHeight, 2)) {
        merged[merged.length - 1] = {
          left: Math.min(previous.left, rect.left),
          top: Math.min(previous.top, rect.top),
          right: Math.max(previous.right, rect.right),
          bottom: Math.max(previous.bottom, rect.bottom)
        }
        continue
      }
    }
    merged.push(rect)
  }
  return merged
}

const pdfTextSelectorForRange = (
  surface: HTMLElement,
  range: Range,
  pageNumber: number,
  extractorVersion: string,
  pageSurface: HTMLElement = surface
): PdfTextSelector | undefined => {
  const nodes = collectSurfaceTextNodes(surface)
  const text = concatenatedText(nodes)
  const start = rangeStartInSurfaceText(nodes, range)
  const exact = range.toString()
  const page = pageSurface.getBoundingClientRect()
  if (
    start === undefined ||
    !exact ||
    text.slice(start, start + exact.length) !== exact ||
    page.width <= 0 ||
    page.height <= 0
  ) {
    return undefined
  }
  const quads = mergePdfSelectionRects(Array.from(range.getClientRects()), page).map((rect) => ({
    x: (rect.left - page.left) / page.width,
    y: (rect.top - page.top) / page.height,
    width: (rect.right - rect.left) / page.width,
    height: (rect.bottom - rect.top) / page.height
  }))
  if (quads.length === 0) return undefined
  const end = start + exact.length
  const prefix = text.slice(Math.max(0, start - PDF_TEXT_CONTEXT_LENGTH), start)
  const suffix = text.slice(end, end + PDF_TEXT_CONTEXT_LENGTH)
  return {
    kind: 'text',
    pageNumber,
    exact,
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
    position: { start, end },
    quads,
    extractorVersion
  }
}

export {
  pdfTextSelectorForRange,
  quoteOccurrenceForRange,
  rangeForTextOccurrence,
  reconcileTextAnnotationRanges,
  retargetTextAnnotationRange
}
