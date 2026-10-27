/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
import { nativeFigureLabelBounds } from '../../resources/literature-pdf-figure-crop-geometry.mjs'

// Invented operators and literals: no paper content or model output.
export function anonymousOrderedRasterLabels({ scale = 1, dx = 0 } = {}) {
  const width = 400 * scale + dx,
    height = 400 * scale,
    operators = { fnArray: [], argsArray: [] },
    graphicsBounds = [],
    items = [],
    tokens = [],
    glyphs = [],
    lines = [],
    style = { ascent: 0.7, descent: -0.1, vertical: false },
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    },
    add = (op, args) => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    rect = (r) => r.map((v, i) => v * scale + (i % 2 === 0 ? dx : 0))
  function text(str, x, baseline, caption = false) {
    const em = 8 * scale,
      px = x * scale + dx,
      py = height - baseline * scale
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', em])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, px, py]])
    add(OPS.showText, [[{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]])
    add(OPS.endText, null)
    const sourceItem = { pageNumber: 1, index: items.length, text: str },
      raw = {
        str,
        dir: 'ltr',
        width: em * 0.5 * str.length,
        height: em,
        transform: [em, 0, 0, em, px, py],
        fontName: 'F',
        sourceItem,
        hasEOL: true
      }
    items.push(raw)
    if (!glyphs.some((g) => g.fontChar === str))
      glyphs.push({ fontChar: str, bounds: [0, -0.1, 0.5 * str.length, 0.7] })
    tokens.push({
      ...tableTextToken(raw, viewport, 0),
      nativeLabelRect: nativeFigureLabelBounds(raw, style, viewport)
    })
    if (caption)
      lines.push({
        text: str,
        x: px,
        y: baseline * scale - em,
        width: raw.width,
        height: em,
        fontSize: em
      })
  }
  add(OPS.setFillRGBColor, ['#000000'])
  for (let n = 0; n < 2; n++) {
    const x = 50 + 170 * n
    add(OPS.save, null)
    add(OPS.transform, [130 * scale, 0, 0, 100 * scale, x * scale + dx, height - 150 * scale])
    const operationIndex = operators.fnArray.length
    add(OPS.paintImageXObject, ['invented-panel-' + n, 260, 200])
    graphicsBounds.push({
      operationIndex,
      kind: 'image',
      normalizedRect: rect([x, 50, x + 130, 150]).map((v, i) => v / (i % 2 ? height : width))
    })
    add(OPS.restore, null)
    text('(' + String.fromCharCode(97 + n) + ')', x, 162)
    text(n ? 'Far' : 'Near', x + 14, 162)
    text('View', x, 173)
  }
  text('Figure 1.', 40, 195, true)
  text('Two views.', 40, 205, true)
  const caption = { page: 1, lines: ['Figure 1.', 'Two views.'], rect: rect([40, 187, 300, 205]) },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines, graphicsBounds },
    context = {
      operators,
      viewport,
      graphicsBounds,
      content: { items, styles: { F: style } },
      glyphBounds: [{ fontName: 'F', glyphs }]
    },
    figure = {
      rect: rect([50, 50, 350, 150]),
      caption,
      graphicsCount: 2,
      reason: 'native-raster-horizontal-array'
    }
  return { args: [page, [caption], [], [], [], tokens, context], figure }
}
