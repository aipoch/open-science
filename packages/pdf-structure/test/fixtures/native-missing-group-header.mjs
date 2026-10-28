/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { createCanvas } from '@napi-rs/canvas'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

// Anonymous minimal native scene: one empty stub, two fenced parent groups,
// four leaf headings and two data records. No external document text or IDs.
export function anonymousMissingGroupHeader({
  completeHeader = false,
  spanningTitle = false,
  shiftedParent = false
} = {}) {
  const width = 300,
    height = 220,
    scale = 1.5,
    operators = { fnArray: [], argsArray: [] },
    graphicsBounds = [],
    items = [],
    glyphs = [],
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    },
    work = {
      ...viewport,
      width: width * scale,
      height: height * scale,
      scale,
      transform: [scale, 0, 0, -scale, 0, height * scale],
      convertToViewportPoint: (x, y) => [x * scale, (height - y) * scale]
    },
    canvas = createCanvas(width * scale, height * scale),
    ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  ctx.fillStyle = '#000000'
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 0.6
  const add = (op, args) => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
  }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.6])
  const line = (x0, y0, x1, y1) => {
    add(OPS.constructPath, [
      OPS.stroke,
      [[0, x0, height - y0, 1, x1, height - y1]],
      [
        Math.min(x0, x1),
        Math.min(height - y0, height - y1),
        Math.max(x0, x1),
        Math.max(height - y0, height - y1)
      ]
    ])
    const rect =
      x0 === x1
        ? [x0 - 0.3, Math.min(y0, y1), x0 + 0.3, Math.max(y0, y1)]
        : [Math.min(x0, x1), y0 - 0.3, Math.max(x0, x1), y0 + 0.3]
    graphicsBounds.push({
      kind: 'path',
      operationIndex: operators.fnArray.length - 1,
      normalizedRect: rect.map((n, i) => n / (i % 2 ? height : width))
    })
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }
  for (const y of [30.2, 85.2, 180.2]) line(25, y, 275, y)
  for (const x of [65, 170.2]) line(x, 30.2, x, 180.2)
  const text = (str, x, baseline, advance = 4) => {
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', 8])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
    add(OPS.showText, [
      [{ unicode: str, fontChar: str, width: (advance / 8) * 1000, isInFont: true }]
    ])
    add(OPS.endText, null)
    const item = {
      str,
      width: advance,
      height: 8,
      dir: 'ltr',
      fontName: 'F',
      hasEOL: true,
      transform: [8, 0, 0, 8, x, height - baseline],
      sourceItem: { pageNumber: 1, index: items.length, text: str }
    }
    items.push(item)
    glyphs.push({ fontChar: str, bounds: [0, -0.1, advance / 8, 0.7] })
    ctx.fillRect(x, baseline - 5.6, advance, 6.4)
    return item
  }
  const upper = spanningTitle
      ? [text('A', 40, 49, 210)]
      : [
          text('A', 40, 49),
          text('B', 95, 49),
          text('C', 130, shiftedParent ? 51 : 49),
          text('D', 205, 49),
          text('E', 240, 49)
        ],
    leaves = [text('F', 95, 72), text('G', 130, 72), text('H', 205, 72), text('I', 240, 72)],
    cells = [],
    xs = [40, 95, 130, 205, 240]
  const cell = (row, column, owned) => ({
    row,
    column,
    rowSpan: 1,
    colSpan: 1,
    text: owned.map((i) => i.str).join(''),
    sourceItems: owned.map((i) => i.sourceItem),
    sourceRects: owned.map((i) => tableTextToken(i, work, 0).rect)
  })
  cells.push(cell(0, 0, completeHeader ? upper.slice(0, 1) : []))
  for (let column = 1; column < 5; column++)
    cells.push(
      cell(
        0,
        column,
        completeHeader && !spanningTitle
          ? [upper[column], leaves[column - 1]]
          : [leaves[column - 1]]
      )
    )
  let code = 74
  for (let row = 1; row < 3; row++)
    for (let column = 0; column < 5; column++)
      cells.push(
        cell(row, column, [text(String.fromCharCode(code++), xs[column], row === 1 ? 110 : 145)])
      )
  text('Z', 30, 200)
  const content = { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
    sourceSha256 = 'a'.repeat(64),
    png = canvas.toBuffer('image/png'),
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds },
    context = {
      operators,
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds,
      viewport,
      content,
      pageNumber: 1,
      sourceSha256,
      captionLaneRaster: {
        page: 1,
        sourceSha256,
        scale,
        width: canvas.width,
        height: canvas.height,
        sha256: createHash('sha256').update(png).digest('hex')
      }
    },
    table = {
      id: 'page-1-table-1',
      page: 1,
      cropRect: [20, 25, 280, 185].map((n) => n * scale),
      sourceViewport: { width: width * scale, height: height * scale, scale },
      region: [20 / width, 25 / height, 280 / width, 185 / height],
      cells,
      grid: Array.from({ length: 3 }, (_, row) =>
        Array.from(
          { length: 5 },
          (_, column) => cells.find((c) => c.row === row && c.column === column).text
        )
      ),
      issues: [],
      reviewCandidate: true
    }
  canvas.width = canvas.height = 0
  return { table, page, context, png }
}
