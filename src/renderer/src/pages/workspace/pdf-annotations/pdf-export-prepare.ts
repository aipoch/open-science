import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfAnnotation } from '../../../../../shared/pdf-annotations'
import type { PdfExportMark } from './pdf-export-contract'

export const preparePdfExportMarks = async (
  document: Pick<PDFDocumentProxy, 'getPage' | 'numPages'>,
  annotations: readonly PdfAnnotation[],
  signal: AbortSignal,
  describe: (annotation: PdfAnnotation) => string
): Promise<PdfExportMark[]> => {
  const marks: PdfExportMark[] = []
  const notes = new Map<number, number>()
  const grouped = Map.groupBy(annotations, ({ target: { selector } }) =>
    selector.kind === 'document-note' ? 1 : selector.pageNumber
  )
  for (const [pageNumber, items] of grouped) {
    signal.throwIfAborted()
    if (pageNumber < 1 || pageNumber > document.numPages) throw new Error('invalid-annotations')
    const page = await document.getPage(pageNumber)
    signal.throwIfAborted()
    // Annotation QuadPoints describe text orientation, not the rotated screen rectangle.
    // PDF.js exposes the original text matrix; most papers share one direction, so the
    // common path resolves it once per page rather than searching every glyph for every mark.
    const content = items.some((item) => item.target.selector.kind === 'text')
      ? await page.getTextContent()
      : undefined
    signal.throwIfAborted()
    const runs =
      content?.items.flatMap((item) => {
        if (!('str' in item) || !item.str.trim()) return []
        const [a, b, , , x, y] = item.transform
        const rotation = ((Math.round(Math.atan2(b, a) / (Math.PI / 2)) % 4) + 4) % 4
        const dx = [1, 0, -1, 0][rotation],
          dy = [0, 1, 0, -1][rotation]
        const points = [
          [x, y],
          [x + dx * item.width, y + dy * item.width],
          [x - dy * item.height, y + dx * item.height],
          [x + dx * item.width - dy * item.height, y + dy * item.width + dx * item.height]
        ]
        return [
          {
            rotation,
            bounds: [
              Math.min(...points.map((p) => p[0])),
              Math.min(...points.map((p) => p[1])),
              Math.max(...points.map((p) => p[0])),
              Math.max(...points.map((p) => p[1]))
            ]
          }
        ]
      }) ?? []
    const rotations = new Set(runs.map((run) => run.rotation))
    const orientTextQuad = (quad: number[]): number[] => {
      const xs = [quad[0], quad[2], quad[4], quad[6]],
        ys = [quad[1], quad[3], quad[5], quad[7]]
      const x0 = Math.min(...xs),
        x1 = Math.max(...xs),
        y0 = Math.min(...ys),
        y1 = Math.max(...ys)
      let rotation = runs[0]?.rotation ?? 0
      if (rotations.size > 1) {
        let bestOverlap = 0
        for (const run of runs) {
          const overlap =
            Math.max(0, Math.min(x1, run.bounds[2]) - Math.max(x0, run.bounds[0])) *
            Math.max(0, Math.min(y1, run.bounds[3]) - Math.max(y0, run.bounds[1]))
          if (overlap > bestOverlap) {
            bestOverlap = overlap
            rotation = run.rotation
          }
        }
      }
      return [
        [x0, y1, x1, y1, x0, y0, x1, y0],
        [x0, y0, x0, y1, x1, y0, x1, y1],
        [x1, y0, x0, y0, x1, y1, x0, y1],
        [x1, y1, x1, y0, x0, y1, x0, y0]
      ][rotation]
    }
    let processed = 0
    for (const annotation of items) {
      if (++processed % 32 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        signal.throwIfAborted()
      }
      const selector = annotation.target.selector
      const viewport = page.getViewport({
        scale: 1,
        rotation: selector.kind === 'document-note' ? page.rotate : selector.pageRotation
      })
      let rects: readonly { x: number; y: number; width: number; height: number }[]
      if (selector.kind === 'text') rects = selector.quads
      else if (selector.kind === 'region') rects = [selector.rect]
      else {
        const index = notes.get(pageNumber) ?? 0
        notes.set(pageNumber, index + 1)
        // Place note icons along the visible page edge, wrapping to a second column as needed.
        const side = Math.min(18, viewport.width / 20, viewport.height / 20)
        const rows = Math.max(1, Math.floor((viewport.height - 16) / (side + 6)))
        const column = Math.floor(index / rows)
        if ((column + 1) * (side + 6) > viewport.width / 2) throw new Error('too-many-notes')
        rects = [
          {
            x: (viewport.width - 8 - side - column * (side + 6)) / viewport.width,
            y: (8 + (index % rows) * (side + 6)) / viewport.height,
            width: side / viewport.width,
            height: side / viewport.height
          }
        ]
      }
      const quads = rects.map(({ x, y, width, height }) => [
        ...viewport.convertToPdfPoint(x * viewport.width, y * viewport.height),
        ...viewport.convertToPdfPoint((x + width) * viewport.width, y * viewport.height),
        ...viewport.convertToPdfPoint(x * viewport.width, (y + height) * viewport.height),
        ...viewport.convertToPdfPoint((x + width) * viewport.width, (y + height) * viewport.height)
      ])
      marks.push({
        id: annotation.id,
        kind: annotation.kind,
        color: annotation.color,
        createdAt: annotation.createdAt,
        updatedAt: annotation.updatedAt,
        note: describe(annotation),
        pageNumber,
        quads: selector.kind === 'text' ? quads.map(orientTextQuad) : quads
      })
    }
  }
  return marks
}
