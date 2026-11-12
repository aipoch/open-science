/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

export function anonymousSixPanelHatchFigure(mode = 'normal') {
  const width = 600,
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
    add = (op, a) => {
      operators.fnArray.push(op)
      operators.argsArray.push(a)
    },
    text = (str, x, baseline) => {
      add(OPS.setFillRGBColor, ['#000000'])
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 8])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
      ])
      add(OPS.endText, null)
      items.push({
        str,
        dir: 'ltr',
        width: str.length * 4,
        height: 8,
        fontName: 'F',
        transform: [8, 0, 0, 8, x, height - baseline],
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      })
      if (!glyphs.some((g) => g.fontChar === str))
        glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length * 0.5, 0.7] })
    },
    rectangle = (x, y, w, h, op) => {
      const b = [x, height - y - h, x + w, height - y],
        d = new Float32Array([
          0,
          b[0],
          b[1],
          1,
          b[0],
          b[3],
          1,
          b[2],
          b[3],
          1,
          b[2],
          b[1],
          1,
          b[0],
          b[1],
          4
        ])
      add(OPS.constructPath, [op, [d], new Float32Array(b)])
      graphicsBounds.push({
        operationIndex: operators.fnArray.length - 1,
        kind: 'path',
        normalizedRect: [
          (x - 1) / width,
          (y - 1) / height,
          (x + w + 1) / width,
          (y + h + 1) / height
        ]
      })
    },
    hatch = () =>
      add(OPS.setFillColorN, [
        'TilingPattern',
        '#a5c0ca',
        {
          fnArray: [OPS.save, OPS.setLineWidth, OPS.constructPath, OPS.restore],
          argsArray: [
            null,
            [0.4],
            [OPS.stroke, [new Float32Array([0, 0, 0, 1, 3, 3])], new Float32Array([0, 0, 3, 3])],
            null
          ],
          length: 4
        },
        [1, 0, 0, 1, 0, 0],
        [-1, -1, 4, 4],
        3,
        3,
        2,
        1
      ])
  add(OPS.setGState, [
    [
      ['CA', 1],
      ['ca', 1]
    ]
  ])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.4])
  add(OPS.save, null)
  let panel = 0
  for (const y of [40, 120])
    for (const x of [40, 180, 320]) {
      if (mode !== 'missing-frame' || panel !== 0)
        rectangle(x + (mode === 'column-shift' && panel === 5 ? 4 : 0), y, 100, 50, OPS.stroke)
      hatch()
      rectangle(x + 20, y + 25, 15, 25, OPS.fillStroke)
      if (panel === 0 && (mode === 'overpaint' || mode === 'extra-overlay'))
        rectangle(x + 20, y + 25, 15, 25, OPS.fillStroke)
      if (panel === 0 && mode === 'extra-overlay') rectangle(x + 20, y + 25, 15, 25, OPS.fillStroke)
      if (panel === 0 && mode === 'third-bar') rectangle(x + 45, y + 20, 12, 30, OPS.fillStroke)
      hatch()
      rectangle(x + 65, y + 15, 15, 35, OPS.fillStroke)
      text('1.0', x + 20, y + 20)
      text('2.0', x + 65, y + 10)
      panel++
    }
  hatch()
  rectangle(465, 90, 12, 8, OPS.fillStroke)
  text('Reference', 485, 98)
  text('Alternative', 485, 118)
  for (const [n, x] of [40, 180, 320].entries())
    if (mode !== 'partial-subcaption' || n !== 1)
      text(
        '(' +
          String.fromCharCode(mode === 'wrong-subcaption' && n === 1 ? 100 : 97 + n) +
          ') Model ' +
          String(n + 1),
        x + 5,
        mode === 'detached-subcaption' && n === 1 ? 260 : 205
      )
  add(OPS.restore, null)
  text('Figure 1. Six anonymous panels.', 30, 250)
  const caption = {
      page: 1,
      lines: ['Figure 1. Six anonymous panels.'],
      rect: [30, 238, 550, 254]
    },
    figure = { rect: [455, 75, 550, 130], caption },
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
      sourceSha256: 'c'.repeat(64),
      operators,
      viewport,
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds
    },
    tokens = items.map((r) => tableTextToken(r, viewport, 0))
  const captions = [caption],
    tables = []
  if (mode === 'foreign-caption')
    captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [40, 195, 120, 210] })
  if (mode === 'table') tables.push([40, 40, 140, 90])
  if (mode === 'source-owner') figure.sourceItems = [items[0].sourceItem]
  return { args: [page, figure, captions, tables, tokens, context], peers: [figure] }
}
