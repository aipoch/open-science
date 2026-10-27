/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
export function anonymousScriptedArray({
  markerGroups = false,
  rasterTitles = false,
  plotGrid = false,
  labels = ['One', 'Two']
} = {}) {
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
  if (plotGrid) {
    add(OPS.setFillRGBColor, ['#000000'])
    add(OPS.setStrokeRGBColor, ['#000000'])
    add(OPS.setLineWidth, [0.5])
    add(OPS.setMiterLimit, [1])
    for (let n = 0; n < 4; n++) {
      const x = 20 + (n % 2) * 180,
        y = 15 + Math.floor(n / 2) * 110
      add(OPS.paintFormXObjectBegin, [null, [x, height - y - 80, x + 150, height - y]])
      add(OPS.setFillRGBColor, ['#ffffff'])
      path([x, y, x + 150, y + 80])
      add(OPS.setFillRGBColor, ['#000000'])
      for (const r of [
        [x + 20, y + 15, x + 20, y + 65],
        [x + 20, y + 65, x + 120, y + 65]
      ]) {
        rules.push(r)
        path(r, OPS.stroke)
      }
      for (const [j, color] of ['#cc0000', '#0000cc'].entries()) {
        add(OPS.setFillRGBColor, [color])
        add(OPS.setStrokeRGBColor, [color])
        path([x + 45 + j * 35, y + 30, x + 47 + j * 35, y + 32], OPS.fillStroke)
      }
      add(OPS.setFillRGBColor, ['#000000'])
      add(OPS.setStrokeRGBColor, ['#000000'])
      add(OPS.beginText, null)
      show('0', x + 30, y + 71, 5)
      show('1', x + 100, y + 71, 5)
      add(OPS.endText, null)
      add(OPS.paintFormXObjectEnd, null)
      add(OPS.beginText, null)
      show('(' + String.fromCharCode(97 + n) + ')', x + 65, y + 85, 5)
      show('x', x + 73.75, y + 85, 5)
      show('= ' + (Math.floor(n / 2) + 1), x + 77.5, y + 85, 5)
      add(OPS.endText, null)
    }
    add(OPS.paintFormXObjectBegin, [null, [20, height - 230, 350, height - 218]])
    add(OPS.setFillRGBColor, ['#ffffff'])
    path([20, 218, 350, 230])
    for (const [n, color] of ['#cc0000', '#0000cc'].entries()) {
      const x = 51 + n * 165
      add(OPS.setFillRGBColor, [color])
      add(OPS.setStrokeRGBColor, [color])
      path([x, 223, x + 2, 225], OPS.fillStroke)
      add(OPS.setFillRGBColor, ['#000000'])
      add(OPS.beginText, null)
      show(labels[n], x + 4, 226, 5)
      add(OPS.endText, null)
    }
    add(OPS.paintFormXObjectEnd, null)
    add(OPS.beginText, null)
    show('C', 50, 270, 8)
    add(OPS.endText, null)
    const caption = { page: 1, lines: ['Figure 1. Panels.'], rect: [20, 260, 350, 275] },
      page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines, graphicsBounds },
      context = {
        operators: { fnArray, argsArray },
        viewport,
        content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
        glyphBounds: [{ fontName: 'F', glyphs }],
        graphicsBounds
      }
    return {
      args: [page, [caption], [], rules, [], tokens, context],
      figure: { rect: [20, 30, 350, 190], caption }
    }
  }
  add(OPS.paintFormXObjectBegin, [null, [30, rasterTitles ? 115 : 85, 370, 240]])
  add(OPS.setFillRGBColor, ['#ffffff'])
  if (!rasterTitles) path([30, 60, 370, 215])
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.5])
  add(OPS.setMiterLimit, [1])
  for (const [panel, x] of (rasterTitles ? [50, 110, 170, 230, 290] : [50, 160, 270]).entries()) {
    if (rasterTitles) {
      add(OPS.save, null)
      add(OPS.transform, [50, 0, 0, 100, x, height - 180])
      const operationIndex = fnArray.length
      add(OPS.paintImageXObject, ['panel-' + panel, 50, 100])
      graphicsBounds.push({
        operationIndex,
        kind: 'image',
        normalizedRect: [x / width, 80 / height, (x + 50) / width, 180 / height]
      })
      add(OPS.restore, null)
      add(OPS.beginText, null)
      show(['One', 'Two', 'Map', 'Sun', 'Air'][panel], x + 21.25, 74.5, 5, { line: true })
      add(OPS.endText, null)
      continue
    }
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
  } else if (!rasterTitles) {
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
  show('C', 50, rasterTitles ? 205 : 235, 8)
  add(OPS.endText, null)
  const caption = {
      page: 1,
      lines: ['Figure 1. Panels.'],
      rect: rasterTitles ? [30, 195, 370, 210] : [30, 225, 370, 240]
    },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines, graphicsBounds },
    f = {
      rect: rasterTitles ? [50, 80, 340, 180] : [40, 75, 360, 194],
      caption,
      ...(rasterTitles ? { reason: 'native-raster-horizontal-array' } : {})
    },
    context = {
      operators: { fnArray, argsArray },
      viewport,
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds
    }
  return { args: [page, [caption], [], rules, [], tokens, context], figure: f }
}
