/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
export function anonymousScriptedArray({ markerGroups = false } = {}) {
  const width = 400,
    height = 300,
    fnArray = [],
    argsArray = [],
    graphicsBounds = [],
    items = [],
    tokens = [],
    glyphs = [],
    lines = [],
    rules = [],
    add = (op, args) => {
      fnArray.push(op)
      argsArray.push(args)
    },
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    }
  const path = (rect, kind = OPS.fill) => {
    const [x0, y0, x1, y1] = rect,
      index = fnArray.length,
      p =
        kind === OPS.stroke
          ? [0, x0, height - y0, 1, x1, height - y1]
          : [0, x0, height - y0, 1, x1, height - y0, 1, x1, height - y1, 1, x0, height - y1, 4]
    add(OPS.constructPath, [kind, [p], [x0, height - y1, x1, height - y0]])
    graphicsBounds.push({
      operationIndex: index,
      kind: 'path',
      normalizedRect: [
        (x0 - 0.25) / width,
        (y0 - 0.25) / height,
        (x1 + 0.25) / width,
        (y1 + 0.25) / height
      ]
    })
  }
  const show = (text, x, y, size, { blank = false, line = false, rotated = false } = {}) => {
    add(OPS.setFont, ['F', size])
    const c = rotated ? Math.SQRT1_2 : 1,
      b = rotated ? Math.SQRT1_2 : 0
    add(OPS.setTextMatrix, [[c, b, -b, c, x, height - y]])
    const g = {
      unicode: text,
      fontChar: text,
      width: 500 * text.length,
      isInFont: !blank,
      isSpace: blank,
      accent: null
    }
    add(OPS.showText, [[g]])
    if (!glyphs.some((g) => g.fontChar === text))
      glyphs.push({
        fontChar: text,
        bounds: blank ? [0, 0, 0, 0] : [0, -0.1, 0.5 * text.length, 0.7]
      })
    if (blank) return
    const sourceItem = { pageNumber: 1, index: items.length, text },
      raw = {
        str: text,
        dir: 'ltr',
        width: size * 0.5 * text.length,
        height: size,
        transform: [size * c, size * b, -size * b, size * c, x, height - y],
        fontName: 'F',
        hasEOL: false,
        sourceItem
      }
    items.push(raw)
    tokens.push(tableTextToken(raw, viewport, 0))
    if (line) lines.push({ text, x, y: y - size, width: size * 0.5, height: size, fontSize: size })
  }
  add(OPS.paintFormXObjectBegin, [null, [30, 85, 370, 240]])
  add(OPS.setFillRGBColor, ['#ffffff'])
  path([30, 60, 370, 215])
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.5])
  add(OPS.setMiterLimit, [1])
  for (const x of [50, 160, 270]) {
    for (const r of [
      [x, 80, x, 180],
      [x, 180, x + 80, 180]
    ]) {
      rules.push(r)
      path(r, OPS.stroke)
    }
    path([x + 15, 120, x + 25, 135])
    path([x + 50, 100, x + 60, 115])
    for (let n = 0; n < 3; n++) {
      add(OPS.beginText, null)
      show(String(n), x + 5 + n * 30, 185, 5, { line: true })
      add(OPS.endText, null)
    }
  }
  if (markerGroups) {
    const labels = ['Alpha', 'Bravo', 'Gamma'],
      colors = ['#cc0000', '#00aa00', '#0000cc']
    for (let n = 0; n < 3; n++) {
      const x = 80 + n * 100
      add(OPS.setFillRGBColor, [colors[n]])
      path([x - 6, 65.5, x - 3, 68.5], OPS.fillStroke)
      add(OPS.beginText, null)
      show(labels[n], x, 70, 6)
      add(OPS.endText, null)
    }
    for (const x of [50, 160, 270]) {
      for (let n = 0; n < 3; n++) {
        const tick = x + 20 + n * 20
        add(OPS.setFillRGBColor, [colors[n]])
        path([tick - 1.5, 135, tick + 1.5, 138], OPS.fillStroke)
        path([tick, 180, tick, 182], OPS.stroke)
        add(OPS.beginText, null)
        show(labels[n], tick - 15 * Math.SQRT1_2, 182.5 + 21 * Math.SQRT1_2, 6, { rotated: true })
        add(OPS.endText, null)
      }
      add(OPS.beginText, null)
      show('G', x + 38.5, 201, 6)
      add(OPS.endText, null)
    }
  } else {
    add(OPS.beginText, null)
    show('A', 304, 198, 8)
    show('u', 308, 195, 5.6)
    show('v', 308, 201, 5.6)
    show('B', 312, 198, 8)
    show(' ', 317, 198, 8, { blank: true })
    add(OPS.endText, null)
  }
  add(OPS.paintFormXObjectEnd, null)
  add(OPS.beginText, null)
  show('C', 50, 235, 8)
  add(OPS.endText, null)
  const caption = { page: 1, lines: ['Figure 1. Panels.'], rect: [30, 225, 370, 240] },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines, graphicsBounds },
    f = { rect: [40, 75, 360, 194], caption },
    context = {
      operators: { fnArray, argsArray },
      viewport,
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds
    }
  return { args: [page, [caption], [], rules, [], tokens, context], figure: f }
}
