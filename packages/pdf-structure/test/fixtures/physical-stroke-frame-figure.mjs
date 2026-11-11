/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

// Independent butt-capped strokes overlap physically although their native
// centerline endpoints differ. Only anonymous text and measured geometry remain.
export function anonymousPhysicalStrokeFrame(mode = 'normal') {
  const width = 400,
    height = 300,
    operators = { fnArray: [], argsArray: [] },
    items = [],
    glyphs = [],
    graphicsBounds = [],
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
    text = (str, x, baseline) => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 10])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: str.length * 500, isInFont: true }]
      ])
      add(OPS.endText, null)
      items.push({
        str,
        dir: 'ltr',
        width: str.length * 5,
        height: 10,
        fontName: 'F',
        transform: [10, 0, 0, 10, x, height - baseline],
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      })
      if (!glyphs.some((g) => g.fontChar === str))
        glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length * 0.5, 0.7] })
    },
    line = (x, y, x2, y2) => {
      const d = new Float32Array([0, x, height - y, 1, x2, height - y2]),
        bbox = new Float32Array([
          Math.min(d[1], d[4]),
          Math.min(d[2], d[5]),
          Math.max(d[1], d[4]),
          Math.max(d[2], d[5])
        ])
      add(OPS.save, null)
      add(OPS.setLineWidth, [mode === 'hairline' ? 0 : 0.4])
      add(OPS.constructPath, [OPS.stroke, [d], bbox])
      graphicsBounds.push({
        operationIndex: operators.fnArray.length - 1,
        kind: 'path',
        normalizedRect: [
          (Math.min(x, x2) - 1) / width,
          (Math.min(y, y2) - 1) / height,
          (Math.max(x, x2) + 1) / width,
          (Math.max(y, y2) + 1) / height
        ]
      })
      add(OPS.restore, null)
    }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  text('First node', 55, 65)
  text('→', 130, 65)
  text('Second node', 160, 65)
  text('Next stage', 55, 85)
  text('→', 130, 85)
  text('Final stage', 160, 85)
  text('Complete output', 55, 105)
  line(40, 45, 360, 45)
  line(mode === 'open-corner' ? 39 : 40.2, 45, mode === 'open-corner' ? 39 : 40.2, 115)
  line(359.8, 45, 359.8, 115)
  if (mode !== 'missing-side') line(40, 115, 360, 115)
  if (mode === 'intervening-text') text('Independent paragraph.', 45, 135)
  text('Figure 1. Anonymous process.', 40, 160)
  if (mode === 'foreign-text') text('Foreign source.', 90, 85)
  const caption = { page: 1, lines: ['Figure 1. Anonymous process.'], rect: [40, 148, 320, 164] },
    page = {
      pageNumber: 1,
      width,
      height,
      rotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds,
      lines: []
    },
    context = {
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      operators,
      viewport,
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds
    },
    tokens = items.map((r) => tableTextToken(r, viewport, 0)),
    captions = [caption],
    tables = []
  if (mode === 'table') tables.push([60, 60, 240, 100])
  if (mode === 'foreign-caption')
    captions.push({ page: 1, lines: ['Figure 2. Independent.'], rect: [90, 80, 200, 100] })
  if (mode === 'glyph-outside') glyphs[0].bounds[0] = -3
  if (mode === 'unknown-ink') page.invalidGraphicsBounds = 1
  if (mode === 'dashed') {
    operators.fnArray.unshift(OPS.setDash)
    operators.argsArray.unshift([[1, 1], 0])
    graphicsBounds.forEach((g) => g.operationIndex++)
  }
  return {
    args: [
      page,
      { caption, reason: 'ambiguous-graphic-direction' },
      captions,
      tables,
      tokens,
      context
    ]
  }
}
