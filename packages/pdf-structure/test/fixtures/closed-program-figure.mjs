/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

export function anonymousPairedProgramFigure({
  rightLabel = '(b) Right panel',
  labelOffset = 0,
  anisotropicStroke = false
} = {}) {
  const width = 500,
    height = 360,
    operators = { fnArray: [], argsArray: [] },
    items = [],
    tokens = [],
    glyphs = [],
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
      const item = {
        str,
        dir: 'ltr',
        width: str.length * 5,
        height: 10,
        transform: [10, 0, 0, 10, x, height - baseline],
        fontName: 'F',
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(item)
      tokens.push(tableTextToken(item, viewport, 0))
      if (!glyphs.some((g) => g.fontChar === str))
        glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length * 0.5, 0.7] })
    },
    paint = (x, y, w, h) =>
      add(OPS.constructPath, [
        OPS.fill,
        [
          [
            0,
            x,
            height - y - h,
            1,
            x + w,
            height - y - h,
            1,
            x + w,
            height - y,
            1,
            x,
            height - y,
            4
          ]
        ],
        [x, height - y - h, x + w, height - y]
      ])
  add(OPS.setFillRGBColor, ['#000000'])
  for (let n = 0; n < 2; n++) {
    const x = 30 + n * 250,
      bbox = [x, 150, x + 190, 300],
      group = { matrix: null, bbox, smask: null, isolated: true, knockout: false }
    add(OPS.paintFormXObjectBegin, [null, bbox])
    add(OPS.beginGroup, [group])
    paint(x + 10, 70, 120, 35)
    paint(x + 20, 160, 100, 45)
    add(OPS.setStrokeRGBColor, ['#000000'])
    add(OPS.setLineWidth, [0.75])
    add(OPS.setLineCap, [1])
    add(OPS.setDash, [[], 0])
    if (anisotropicStroke && n === 0) {
      add(OPS.save, null)
      add(OPS.transform, [1e-20, 0, 0, 1e-11, x + 95, 260])
      add(OPS.setLineWidth, [1e14])
    }
    const line = new Float32Array(
      anisotropicStroke && n === 0 ? [0, -1e23, 0, 1, 1e23, 1e-5] : [0, -1000, -1000, 1, 2000, 2000]
    )
    add(OPS.constructPath, [
      OPS.stroke,
      [line],
      new Float32Array([line[1], line[2], line[4], line[5]])
    ])
    if (anisotropicStroke && n === 0) add(OPS.restore, null)
    text('Axis', x + 10, 90)
    text('Value', x + 20, 180)
    text('Mark', x + 100, 200)
    add(OPS.endGroup, [group])
    add(OPS.paintFormXObjectEnd, null)
    text(n ? rightLabel : '(a) Left panel', x + 10, 240 + (n ? labelOffset : 0))
  }
  text('Figure 1. Two complete panels.', 30, 280)
  const caption = { page: 1, lines: ['Figure 1. Two complete panels.'], rect: [30, 265, 470, 285] },
    page = {
      pageNumber: 1,
      width,
      height,
      rotation: 0,
      invalidGraphicsBounds: 0,
      lines: [],
      graphicsBounds: []
    },
    context = {
      operators,
      viewport,
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds: []
    },
    figure = { caption, rect: [30, 60, 470, 210] }
  return { args: [page, figure, [caption], [], tokens, context] }
}
