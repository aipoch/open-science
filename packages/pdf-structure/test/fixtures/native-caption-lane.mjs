/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { createCanvas } from '@napi-rs/canvas'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
export function anonymousCaptionLane(rows) {
  const width = 400,
    height = 400,
    operators = { fnArray: [], argsArray: [] },
    items = [],
    tokens = [],
    glyphs = [],
    viewport = {
      width,
      height,
      rotation: 0,
      scale: 1,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    },
    add = (op, a) => {
      operators.fnArray.push(op)
      operators.argsArray.push(a)
    },
    text = (str, x, baseline, size = 10) => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', size])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
      ])
      add(OPS.endText, null)
      const r = {
        str,
        dir: 'ltr',
        width: (size / 2) * str.length,
        height: size,
        transform: [size, 0, 0, size, x, height - baseline],
        fontName: 'F',
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(r)
      tokens.push(tableTextToken(r, viewport, 0))
      if (!glyphs.some((g) => g.fontChar === str))
        glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length * 0.5, 0.7] })
    }
  add(OPS.setFillRGBColor, ['#000000'])
  for (const row of rows ?? [
    ['Figure 1: A complete native picture with', 60, 300],
    ['mixed font styles in the description and', 60, 314],
    ['a closed caption.', 60, 328]
  ])
    text(...row)
  const lines = items.map((r) => ({
      text: r.str,
      x: r.transform[4],
      y: height - r.transform[5] - r.height,
      width: r.width,
      height: r.height,
      fontSize: r.height
    })),
    candidate = { page: 1, lines: lines.slice(0, 2).map((l) => l.text), rect: [60, 290, 260, 314] },
    page = {
      pageNumber: 1,
      width,
      height,
      invalidGraphicsBounds: 0,
      rotation: 0,
      renderRotation: 0,
      lines,
      graphicsBounds: []
    },
    context = {
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      operators,
      viewport,
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds: []
    },
    anchors = [{ page: 1, kind: 'figure', rect: [60, 40, 300, 260], caption: candidate }],
    canvas = createCanvas(600, 600)
  const q = canvas.getContext('2d')
  q.fillStyle = 'white'
  q.fillRect(0, 0, 600, 600)
  q.fillStyle = 'black'
  for (const r of items)
    q.fillRect(
      r.transform[4] * 1.5,
      (height - r.transform[5] - r.height * 0.7) * 1.5,
      r.width * 1.5,
      r.height * 1.2
    )
  const png = canvas.toBuffer('image/png')
  canvas.width = canvas.height = 0
  const raster = {
    page: 1,
    sourceSha256: context.sourceSha256,
    scale: 1.5,
    width: 600,
    height: 600,
    sha256: createHash('sha256').update(png).digest('hex')
  }
  return {
    args: {
      page,
      candidate,
      tokens,
      context,
      anchors,
      otherCaptions: [candidate],
      raster,
      loadPng: async () => png
    },
    png,
    add,
    text
  }
}

export function anonymousThreeRailTable() {
  const f = anonymousCaptionLane(),
    { page, tokens, context } = f.args,
    items = context.content.items
  for (const [str, x, y] of [
    ['Name', 60, 165],
    ['Value', 240, 165],
    ['Alpha', 60, 190],
    ['10', 240, 190],
    ['Beta', 60, 205],
    ['20', 240, 205],
    ['Gamma', 60, 220],
    ['30', 240, 220]
  ])
    f.text(str, x, y)
  f.add(OPS.setStrokeRGBColor, ['#000000'])
  f.add(OPS.setLineWidth, [0.8])
  for (const y of [150, 175, 230])
    f.add(OPS.constructPath, [
      OPS.stroke,
      [new Float32Array([0, 40, 400 - y, 1, 320, 400 - y])],
      new Float32Array([40, 400 - y, 320, 400 - y])
    ])
  const rect = [39.75, 149.35, 320.25, 230.65],
    cells = items.slice(3).map((r, i) => ({
      row: Math.floor(i / 2),
      column: i % 2,
      rowSpan: 1,
      colSpan: 1,
      text: r.str,
      sourceItems: [r.sourceItem],
      sourceRects: [tokens[i + 3].rect.map((n) => n * 1.5)]
    })),
    table = {
      page: 1,
      cropRect: [60, 225, 480, 345],
      sourceViewport: { width: 600, height: 600, scale: 1.5 },
      cells,
      caption: { page: 1, lines: ['Table 1: Native records.'], rect: [40, 100, 200, 110] }
    },
    width = Math.ceil((rect[2] - rect[0]) * 4),
    height = Math.ceil((rect[3] - rect[1]) * 4),
    canvas = createCanvas(width, height),
    q = canvas.getContext('2d')
  q.fillStyle = 'white'
  q.fillRect(0, 0, width, height)
  q.fillStyle = 'black'
  for (const r of items.slice(3))
    q.fillRect(
      (r.transform[4] - rect[0]) * 4,
      (400 - r.transform[5] - 7 - rect[1]) * 4,
      r.width * 4,
      32
    )
  for (const y of [150, 175, 230])
    q.fillRect((40 - rect[0]) * 4, (y - 0.4 - rect[1]) * 4, 280 * 4, 0.8 * 4)
  const png = canvas.toBuffer('image/png')
  canvas.width = canvas.height = 0
  return { args: { page, tokens, context, table, renderCrop: async () => png }, png, rect, f }
}
