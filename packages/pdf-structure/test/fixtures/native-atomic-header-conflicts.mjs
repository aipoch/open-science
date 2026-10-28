/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createCanvas } from '@napi-rs/canvas'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectTableRules } from '../../resources/literature-pdf-graphics.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

export function anonymousAtomicHeader({
  headerDivider = false,
  sharedHeaderPacket = false,
  extraPaint = false,
  brokenRaster = false,
  smallSecondLine = false,
  reverseBottom = false,
  geometryScale = 1
} = {}) {
  const width = 300 * geometryScale,
    height = 260 * geometryScale,
    scale = 1.5,
    xs = [30, 90, 150, 210, 270],
    nativeCrop = [29, 39, 271, 127].map((n) => n * geometryScale),
    operators = { fnArray: [], argsArray: [] },
    graphicsBounds = [],
    items = [],
    glyphs = [],
    strokes = [],
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    },
    workViewport = {
      ...viewport,
      width: width * scale,
      height: height * scale,
      scale,
      transform: [scale, 0, 0, -scale, 0, height * scale],
      convertToViewportPoint: (x, y) => [x * scale, (height - y) * scale]
    },
    add = (op, args) => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    stroke = (x0, y0, x1, y1) => {
      const a = x0 * geometryScale,
        b = y0 * geometryScale,
        c = x1 * geometryScale,
        d = y1 * geometryScale,
        halfWidth = 0.3 * geometryScale
      add(OPS.constructPath, [
        OPS.stroke,
        [[0, a, height - b, 1, c, height - d]],
        [Math.min(a, c), height - Math.max(b, d), Math.max(a, c), height - Math.min(b, d)]
      ])
      const rect = [
        Math.min(a, c) - (a === c ? halfWidth : 0),
        Math.min(b, d) - (b === d ? halfWidth : 0),
        Math.max(a, c) + (a === c ? halfWidth : 0),
        Math.max(b, d) + (b === d ? halfWidth : 0)
      ]
      graphicsBounds.push({
        kind: 'path',
        operationIndex: operators.fnArray.length - 1,
        normalizedRect: rect.map((n, i) => n / (i % 2 ? height : width))
      })
      strokes.push([a, b, c, d])
    },
    text = (str, x, baseline, em = 8) => {
      const size = em * geometryScale,
        px = x * geometryScale,
        py = baseline * geometryScale
      add(OPS.setTextMatrix, [[1, 0, 0, 1, px, height - py]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
      ])
      const item = {
        str,
        dir: 'ltr',
        width: size * 0.5 * str.length,
        height: size,
        transform: [size, 0, 0, size, px, height - py],
        fontName: 'F',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(item)
      if (!glyphs.some((g) => g.fontChar === str))
        glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length * 0.5, 0.7] })
      return item
    },
    begin = () => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 8 * geometryScale])
    },
    end = () => add(OPS.endText, null),
    cell = (row, column, item) => {
      const token = tableTextToken(item, workViewport, 0)
      return {
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: item.str,
        sourceItems: [item.sourceItem],
        sourceRects: [token.rect]
      }
    },
    cells = []
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.6 * geometryScale])
  stroke(30, 40, 270, 40)
  stroke(reverseBottom ? 270 : 30, 78, reverseBottom ? 30 : 270, 78)
  for (const x of xs) stroke(x, 40, x, 78)
  if (headerDivider) stroke(30, 61, 270, 61)
  if (extraPaint) stroke(35, 45, 85, 73)
  if (sharedHeaderPacket) begin()
  for (let column = 0; column < 4; column++) {
    if (!sharedHeaderPacket) begin()
    cells.push(
      cell(0, column, text('Head' + String.fromCharCode(65 + column), xs[column] + 10, 54))
    )
    if (smallSecondLine) add(OPS.setFont, ['F', 4 * geometryScale])
    cells.push(
      cell(
        1,
        column,
        text(
          'Type' + String.fromCharCode(65 + column),
          xs[column] + 10,
          68,
          smallSecondLine ? 4 : 8
        )
      )
    )
    if (!sharedHeaderPacket) end()
  }
  if (sharedHeaderPacket) end()
  stroke(30, 82, 270, 82)
  for (let row = 0; row < 2; row++) {
    const top = 82 + row * 22,
      bottom = top + 22
    for (const x of xs) stroke(x, top, x, bottom)
    stroke(30, bottom, 270, bottom)
    begin()
    for (let column = 0; column < 4; column++)
      cells.push(
        cell(row + 2, column, text(String(row * 4 + column + 1), xs[column] + 10, top + 14))
      )
    end()
  }
  begin()
  text('Outside', 30, 220)
  end()
  const page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds },
    content = { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
    sourceSha256 = 'a'.repeat(64),
    native = {
      operators,
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds,
      viewport,
      content,
      pageNumber: 1,
      sourceSha256
    },
    identity = graphicsBounds.map((g) => ({
      kind: g.kind,
      operationIndex: g.operationIndex,
      rect: g.normalizedRect.map((n, i) => n * (i % 2 ? height : width) * scale)
    })),
    context = {
      sourcePage: page,
      nativeGlyphContext: native,
      nativePaintIdentityGraphics: identity,
      nativeEvidenceGraphics: identity.map(({ kind, rect }) => ({ kind, rect })),
      operators,
      viewport: workViewport,
      sourceContent: content,
      content,
      sourceSha256
    },
    inventory = items.map((i) => tableTextToken(i, workViewport, 0)),
    rules = collectTableRules(operators, workViewport),
    grid = Array.from({ length: 4 }, (_, row) =>
      Array.from(
        { length: 4 },
        (_, column) => cells.find((c) => c.row === row && c.column === column).text
      )
    ),
    table = {
      id: 'page-1-table-1',
      page: 1,
      cropRect: nativeCrop.map((n) => n * scale),
      sourceViewport: { width: width * scale, height: height * scale, scale },
      grid,
      cells,
      issues: [],
      reviewCandidate: true,
      thumbnail: 'retained.png',
      notes: [{ text: 'Retained note' }]
    },
    canvas = createCanvas(
      Math.ceil((nativeCrop[2] - nativeCrop[0]) * 4),
      Math.ceil((nativeCrop[3] - nativeCrop[1]) * 4)
    ),
    paint = canvas.getContext('2d')
  paint.fillStyle = 'white'
  paint.fillRect(0, 0, canvas.width, canvas.height)
  paint.scale(4, 4)
  paint.translate(-nativeCrop[0], -nativeCrop[1])
  paint.strokeStyle = 'black'
  paint.lineWidth = 0.6 * geometryScale
  for (const [x0, y0, x1, y1] of strokes) {
    paint.beginPath()
    paint.moveTo(x0, y0)
    paint.lineTo(x1, y1)
    paint.stroke()
  }
  if (brokenRaster) {
    paint.fillStyle = 'white'
    paint.fillRect(149 * geometryScale, 55 * geometryScale, 2 * geometryScale, 3 * geometryScale)
  }
  return { table, inventory, rules, context, png: canvas.toBuffer('image/png') }
}
