/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createCanvas } from '@napi-rs/canvas'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
import { collectTableRules } from '../../resources/literature-pdf-graphics.mjs'

export function anonymousPrintedFace() {
  const width = 220,
    height = 180,
    scale = 1.5,
    nativeCrop = [19, 29, 201, 111],
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
      convertToViewportPoint: (x, y) => [x * scale, height * scale - y * scale]
    },
    operators = { fnArray: [], argsArray: [] },
    graphicsBounds = [],
    items = [],
    glyphs = [],
    canvas = createCanvas((nativeCrop[2] - nativeCrop[0]) * 4, (nativeCrop[3] - nativeCrop[1]) * 4),
    paint = canvas.getContext('2d'),
    add = (op, a) => {
      operators.fnArray.push(op)
      operators.argsArray.push(a)
    },
    stroke = (x0, y0, x1, y1) => {
      add(OPS.constructPath, [
        OPS.stroke,
        [[0, x0, height - y0, 1, x1, height - y1]],
        [Math.min(x0, x1), height - Math.max(y0, y1), Math.max(x0, x1), height - Math.min(y0, y1)]
      ])
      const rect = [
        Math.min(x0, x1) - (x0 === x1 ? 0.3 : 0),
        Math.min(y0, y1) - (y0 === y1 ? 0.3 : 0),
        Math.max(x0, x1) + (x0 === x1 ? 0.3 : 0),
        Math.max(y0, y1) + (y0 === y1 ? 0.3 : 0)
      ]
      graphicsBounds.push({
        kind: 'path',
        operationIndex: operators.fnArray.length - 1,
        normalizedRect: rect.map((x, i) => x / (i % 2 ? height : width))
      })
      paint.beginPath()
      paint.moveTo(x0, y0)
      paint.lineTo(x1, y1)
      paint.stroke()
    },
    text = (str, x, baseline) => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 10])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: str.length * 500, isInFont: true }]
      ])
      add(OPS.endText, null)
      const item = {
        str,
        dir: 'ltr',
        width: str.length * 5,
        height: 10,
        transform: [10, 0, 0, 10, x, height - baseline],
        fontName: 'F',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(item)
      if (!glyphs.some((g) => g.fontChar === str))
        glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length * 0.5, 0.7] })
      paint.fillRect(x, baseline - 7, str.length * 5, 8)
      return item
    }
  paint.fillStyle = 'white'
  paint.fillRect(0, 0, canvas.width, canvas.height)
  paint.scale(4, 4)
  paint.translate(-nativeCrop[0], -nativeCrop[1])
  paint.fillStyle = paint.strokeStyle = 'black'
  paint.lineWidth = 0.6
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.6])
  for (const y of [30, 55, 80, 110]) stroke(20, y, 200, y)
  for (const x of [20, 80, 140, 200]) stroke(x, 30, x, 55)
  for (const x of [20, 80, 200]) stroke(x, 55, x, 80)
  for (const x of [20, 80, 140, 200]) stroke(x, 80, x, 110)
  const label = text('Label', 95, 46),
    other = text('Other', 155, 46),
    count = text('Count', 30, 71),
    number = text('12', 110, 71),
    next = text('Next', 30, 98),
    a = text('3', 95, 98),
    b = text('4', 155, 98)
  const cell = (row, column, sources) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: sources.map((s) => s.str).join(' '),
      sourceItems: sources.map((s) => s.sourceItem),
      sourceRects: sources.map((s) => tableTextToken(s, work, 0).rect)
    }),
    cells = [
      cell(0, 0, [count]),
      cell(0, 1, [label, number]),
      cell(0, 2, [other]),
      cell(1, 0, [next]),
      cell(1, 1, [a]),
      cell(1, 2, [b])
    ],
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds },
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
      rect: g.normalizedRect.map((x, i) => x * (i % 2 ? height : width) * scale)
    })),
    context = {
      sourcePage: page,
      nativeGlyphContext: native,
      nativePaintIdentityGraphics: identity,
      nativeEvidenceGraphics: identity.map(({ kind, rect }) => ({ kind, rect })),
      operators,
      viewport: work,
      sourceContent: content,
      content,
      sourceSha256
    },
    table = {
      id: 'page-1-table-1',
      page: 1,
      cropRect: nativeCrop.map((x) => x * scale),
      sourceViewport: { width: work.width, height: work.height, scale },
      grid: [
        ['Count', 'Label 12', 'Other'],
        ['Next', '3', '4']
      ],
      cells,
      issues: [],
      reviewCandidate: true,
      thumbnail: 'retained.png',
      notes: [{ text: 'Retained note' }]
    }
  return {
    table,
    inventory: items.map((i) => tableTextToken(i, work, 0)),
    rules: collectTableRules(operators, work),
    context,
    png: canvas.toBuffer('image/png')
  }
}
