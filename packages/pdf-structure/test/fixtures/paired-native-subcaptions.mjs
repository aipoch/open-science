/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
export function anonymousPairedNativeSubcaptions({
  scale = 1,
  dx = 0,
  labels = ['First', 'Next']
} = {}) {
  const width = 400 * scale + dx,
    height = 300 * scale,
    fnArray = [],
    argsArray = [],
    items = [],
    tokens = [],
    glyphs = [],
    graphicsBounds = []
  const viewport = {
    width,
    height,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x, y) => [x, height - y]
  }
  const add = (op, args) => {
    fnArray.push(op)
    argsArray.push(args)
  }
  const point = (x, y) => [x * scale + dx, height - y * scale]
  function text(str, cx, y, size = 8) {
    const x = cx - size * 0.25 * str.length,
      [px, py] = point(x, y),
      em = size * scale
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', em])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, px, py]])
    add(OPS.showText, [
      [
        {
          unicode: str,
          fontChar: str,
          width: 500 * str.length,
          isInFont: true,
          isSpace: false,
          accent: null
        }
      ]
    ])
    add(OPS.endText, null)
    const sourceItem = { pageNumber: 1, index: items.length, text: str }
    const r = {
      str,
      dir: 'ltr',
      width: em * 0.5 * str.length,
      height: em,
      transform: [em, 0, 0, em, px, py],
      fontName: 'F',
      hasEOL: false,
      sourceItem
    }
    items.push(r)
    tokens.push(tableTextToken(r, viewport, 0))
    if (!glyphs.some((g) => g.fontChar === str))
      glyphs.push({ fontChar: str, bounds: [0, -0.1, 0.5 * str.length, 0.7] })
  }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.5 * scale])
  add(OPS.setMiterLimit, [1])
  for (let n = 0; n < 2; n++) {
    const x = 50 + n * 180,
      y = 80,
      w = 120,
      h = 80
    add(OPS.save, null)
    const pts = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
      [x, y]
    ].map(([x, y]) => point(x, y))
    const p = pts.flatMap(([x, y], i) => [i ? 1 : 0, x, y]).concat(4),
      first = point(x, y + h),
      last = point(x + w, y)
    add(OPS.constructPath, [OPS.stroke, [p], [first[0], first[1], last[0], last[1]]])
    graphicsBounds.push({
      operationIndex: fnArray.length - 1,
      kind: 'path',
      normalizedRect: [
        (x * scale + dx) / width,
        (y * scale) / height,
        ((x + w) * scale + dx) / width,
        ((y + h) * scale) / height
      ]
    })
    text('0', x + w / 2, 170)
    add(OPS.restore, null)
    text('(' + String.fromCharCode(97 + n) + ') ' + labels[n], x + w / 2, 190)
  }
  text('C', 50, 230)
  const rect = [30, 60, 370, 180].map((v, i) => v * scale + (i % 2 === 0 ? dx : 0))
  const caption = {
    page: 1,
    lines: ['Figure 1. Two plots.'],
    rect: [30 * scale + dx, 220 * scale, 370 * scale + dx, 240 * scale]
  }
  const page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines: [], graphicsBounds }
  const context = {
    operators: { fnArray, argsArray },
    viewport,
    content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
    glyphBounds: [{ fontName: 'F', glyphs }],
    graphicsBounds
  }
  return { args: [page, [caption], [], [], [], tokens, context], figure: { rect, caption } }
}
