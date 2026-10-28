/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createCanvas } from '@napi-rs/canvas'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

export function anonymousCaptionlessMathBody() {
  const width = 200,
    height = 220,
    crop = [19, 39, 181, 111],
    scale = 1.5,
    operators = { fnArray: [], argsArray: [] },
    graphicsBounds = [],
    items = [],
    glyphs = [],
    cells = [],
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
    add = (op, args) => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    text = (str, x, baseline, size = 8) => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', size])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
      add(OPS.showText, [[{ unicode: str, fontChar: str, width: 500, isInFont: true }]])
      add(OPS.endText, null)
      const item = {
        str,
        dir: 'ltr',
        width: size / 2,
        height: size,
        transform: [size, 0, 0, size, x, height - baseline],
        fontName: 'F',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(item)
      if (!glyphs.some((g) => g.fontChar === str))
        glyphs.push({ fontChar: str, bounds: [0, -0.1, 0.5, 0.7] })
      return item
    },
    cell = (row, column, records, script = false) => {
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: records.map((i) => i.str).join(''),
        sourceItems: records.map((i) => i.sourceItem),
        sourceRects: records.map((i) => tableTextToken(i, work, 0).rect),
        ...(script
          ? {
              textRuns: records.map((i, n) => ({
                text: i.str,
                position: n ? 'subscript' : 'normal'
              }))
            }
          : {})
      })
    }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.6])
  for (const y of [40, 60, 110]) {
    add(OPS.constructPath, [
      OPS.stroke,
      [[0, 20, height - y, 1, 180, height - y]],
      [20, height - y, 180, height - y]
    ])
    graphicsBounds.push({
      kind: 'path',
      operationIndex: operators.fnArray.length - 1,
      normalizedRect: [20 / width, (y - 0.3) / height, 180 / width, (y + 0.3) / height]
    })
  }
  cell(0, 0, [text('H', 35, 53)])
  cell(0, 1, [text('J', 105, 53)])
  cell(1, 0, [text('0', 35, 78)])
  cell(1, 1, [text('X', 105, 78), text('i', 109, 80, 5)], true)
  cell(2, 0, [text('1', 35, 100)])
  cell(2, 1, [text('Y', 105, 100), text('j', 109, 102, 5)], true)
  text('Z', 30, 190)
  const content = { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
    tokens = items.map((i) => ({
      ...tableTextToken(i, viewport, 0),
      fontAscent: 0.7,
      fontDescent: -0.1
    })),
    page = {
      pageNumber: 1,
      width,
      height,
      rotation: 0,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds
    },
    nativeContext = {
      operators,
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds,
      viewport,
      content,
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64)
    },
    table = {
      id: 'page-1-table-1',
      page: 1,
      cropRect: crop.map((x) => x * scale),
      sourceViewport: { width: width * scale, height: height * scale, scale },
      grid: [
        ['H', 'J'],
        ['0', 'Xi'],
        ['1', 'Yj']
      ],
      cells,
      issues: ['ambiguous-cell-assignment'],
      reviewCandidate: false,
      unassigned: [],
      clipped: [],
      notes: [],
      region: crop.map((x, i) => x / (i % 2 ? height : width)),
      thumbnail: 'retained.png'
    },
    canvas = createCanvas((crop[2] - crop[0]) * 4, (crop[3] - crop[1]) * 4),
    paint = canvas.getContext('2d')
  paint.fillStyle = 'white'
  paint.fillRect(0, 0, canvas.width, canvas.height)
  paint.scale(4, 4)
  paint.translate(-crop[0], -crop[1])
  paint.strokeStyle = 'black'
  paint.lineWidth = 0.6
  for (const y of [40, 60, 110]) {
    paint.beginPath()
    paint.moveTo(20, y)
    paint.lineTo(180, y)
    paint.stroke()
  }
  paint.fillStyle = 'black'
  for (const i of items.slice(0, -1)) {
    const [size, , , , x, y] = i.transform
    paint.fillRect(x, height - y - size * 0.7, size * 0.5, size * 0.8)
  }
  const png = canvas.toBuffer('image/png')
  canvas.width = canvas.height = 1
  return {
    table,
    options: { page, tokens, nativeContext, competingRects: [], captionRects: [] },
    png
  }
}
