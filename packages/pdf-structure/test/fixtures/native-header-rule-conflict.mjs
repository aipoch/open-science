/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createCanvas } from '@napi-rs/canvas'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
import { collectTableRules } from '../../resources/literature-pdf-graphics.mjs'

export function anonymousHeaderRule({
  conflict = true,
  brokenRaster = false,
  duplicateSeparator = false
} = {}) {
  const width = 240,
    height = 190,
    scale = 1.5,
    crop = [25, 25, 215, 140],
    operators = { fnArray: [], argsArray: [] },
    graphicsBounds = [],
    items = [],
    glyphs = [],
    cells = [],
    strokes = []
  const viewport = {
    width,
    height,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x, y) => [x, height - y]
  }
  const work = {
    ...viewport,
    width: width * scale,
    height: height * scale,
    scale,
    transform: [scale, 0, 0, -scale, 0, height * scale],
    convertToViewportPoint: (x, y) => [x * scale, (height - y) * scale]
  }
  const add = (op, args) => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
  }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.6])
  for (const y of duplicateSeparator ? [30, 55, 55, 135] : [30, 55, 135]) {
    add(OPS.constructPath, [
      OPS.stroke,
      [[0, 30, height - y, 1, 210, height - y]],
      [30, height - y, 210, height - y]
    ])
    const rect = [30, y - 0.3, 210, y + 0.3]
    graphicsBounds.push({
      kind: 'path',
      operationIndex: operators.fnArray.length - 1,
      normalizedRect: rect.map((x, i) => x / (i % 2 ? height : width))
    })
    strokes.push(y)
  }
  const text = (str, x, baseline) => {
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', 8])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
    add(OPS.showText, [[{ unicode: str, fontChar: str, width: 500, isInFont: true }]])
    add(OPS.endText, null)
    const item = {
      str,
      width: 4,
      height: 8,
      dir: 'ltr',
      fontName: 'F',
      hasEOL: true,
      transform: [8, 0, 0, 8, x, height - baseline],
      sourceItem: { pageNumber: 1, index: items.length, text: str }
    }
    items.push(item)
    glyphs.push({ fontChar: str, bounds: [0, -0.1, 0.5, 0.7] })
    return item
  }
  const cell = (row, column, owned, rowSpan = 1) => ({
    row,
    column,
    rowSpan,
    colSpan: 1,
    text: owned.map((i) => i.str).join(''),
    sourceItems: owned.map((i) => i.sourceItem),
    sourceRects: owned.map((i) => tableTextToken(i, work, 0).rect)
  })
  const heads = [text('A', 45, 45), text('B', 105, 45), text('C', 165, 45)],
    bracket = text('(', 105, conflict ? 69 : 51)
  cells.push(cell(0, 0, [heads[0]]), cell(0, 1, [heads[1], bracket]), cell(0, 2, [heads[2]]))
  cells.push(
    cell(1, 0, [text('D', 45, 88)], 2),
    cell(1, 1, [text('E', 115, 76)]),
    cell(1, 2, [text('F', 165, 76)]),
    cell(2, 1, [text('G', 115, 98)]),
    cell(2, 2, [text('H', 165, 98)]),
    cell(3, 0, [text('I', 45, 120)]),
    cell(3, 1, [text('J', 105, 120)]),
    cell(3, 2, [text('K', 165, 120)])
  )
  text('Z', 30, 175)
  const content = { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
    sourceSha256 = 'a'.repeat(64),
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds }
  const native = {
    operators,
    glyphBounds: [{ fontName: 'F', glyphs }],
    graphicsBounds,
    viewport,
    content,
    pageNumber: 1,
    sourceSha256
  }
  const identity = graphicsBounds.map((g) => ({
    kind: g.kind,
    operationIndex: g.operationIndex,
    rect: g.normalizedRect.map((n, i) => n * (i % 2 ? height : width) * scale)
  }))
  const context = {
    sourcePage: page,
    nativeGlyphContext: native,
    nativePaintIdentityGraphics: identity,
    nativeEvidenceGraphics: identity.map(({ kind, rect }) => ({ kind, rect })),
    operators,
    viewport: work,
    sourceContent: content,
    content,
    sourceSha256
  }
  const grid = Array.from({ length: 4 }, (_, row) =>
    Array.from(
      { length: 3 },
      (_, column) => cells.find((c) => c.row === row && c.column === column)?.text ?? ''
    )
  )
  const table = {
    id: 'page-1-table-1',
    page: 1,
    cropRect: crop.map((x) => x * scale),
    sourceViewport: { width: width * scale, height: height * scale, scale },
    grid,
    cells,
    issues: [],
    reviewCandidate: true,
    thumbnail: 'retained.png'
  }
  const canvas = createCanvas((crop[2] - crop[0]) * 4, (crop[3] - crop[1]) * 4),
    paint = canvas.getContext('2d')
  paint.fillStyle = 'white'
  paint.fillRect(0, 0, canvas.width, canvas.height)
  paint.scale(4, 4)
  paint.translate(-crop[0], -crop[1])
  paint.fillStyle = 'black'
  paint.strokeStyle = 'black'
  paint.lineWidth = 0.6
  for (const y of strokes) {
    paint.beginPath()
    paint.moveTo(30, y)
    paint.lineTo(210, y)
    paint.stroke()
  }
  for (const item of items)
    paint.fillRect(item.transform[4], height - item.transform[5] - 5.6, 4, 6.4)
  if (brokenRaster) {
    paint.fillStyle = 'white'
    paint.fillRect(95, 54, 4, 2)
  }
  const png = canvas.toBuffer('image/png')
  canvas.width = canvas.height = 0
  return {
    table,
    context,
    inventory: items.map((i) => tableTextToken(i, work, 0)),
    rules: collectTableRules(operators, work),
    png
  }
}
