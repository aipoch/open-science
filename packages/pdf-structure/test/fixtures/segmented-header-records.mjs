/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
import { collectTableRules } from '../../resources/literature-pdf-graphics.mjs'

export function anonymousSegmentedHeaderRecords(kind = 'empty-stub') {
  const width = 280,
    height = 260,
    items = [],
    tokens = [],
    glyphs = new Map(),
    graphicsBounds = []
  const operators = { fnArray: [], argsArray: [] }
  const viewport = {
    width,
    height,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x, y) => [x, height - y]
  }
  const add = (op, args) => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
  }
  const text = (str, x, y, h = 10) => {
    const sourceItem = { pageNumber: 1, index: items.length, text: str }
    items.push({
      str,
      dir: 'ltr',
      fontName: 'F',
      width: (str.length * h) / 2,
      height: h,
      transform: [h, 0, 0, h, x, height - y],
      sourceItem
    })
    tokens.push(tableTextToken(items.at(-1), viewport, 0))
    glyphs.set(str, { fontChar: str, bounds: [0, -0.1, str.length / 2, 0.7] })
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', h])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - y]])
    add(OPS.showText, [
      [{ unicode: str, fontChar: str, width: str.length * 500, isInFont: true, isSpace: false }]
    ])
    add(OPS.endText, null)
  }
  const fill = (r, color = '#000000', evenOdd = false) => {
    add(OPS.setFillRGBColor, [color])
    const native = [r[0], height - r[3], r[2], height - r[1]]
    add(OPS.constructPath, [
      evenOdd ? OPS.eoFill : OPS.fill,
      [
        [
          0,
          native[0],
          native[1],
          1,
          native[2],
          native[1],
          1,
          native[2],
          native[3],
          1,
          native[0],
          native[3],
          4
        ]
      ],
      native
    ])
    graphicsBounds.push({
      kind: 'path',
      operationIndex: operators.fnArray.length - 1,
      normalizedRect: r.map((v, n) => v / (n % 2 ? height : width))
    })
  }
  add(OPS.setFillRGBColor, ['#000000'])
  text('Table 1: Values.', 20, 65)
  for (const y of [80, 96, 162])
    for (let c = 0; c < 4; c++)
      fill([c ? 64 + c * 60 - 60 + (y === 162 ? -0.25 : 0.5) : 20, y - 0.25, 64 + c * 60, y + 0.25])
  for (const y of [80, 96]) fill([64, y - 0.25, 64.5, y + 0.25], '#000000', true)
  fill([63, 161.75, 63.5, 162.25])
  fill([20, 80.25, 64, 95.75], '#ffffff', true)
  fill([64.5, 80.25, 124, 95.75], '#ffffff', true)
  add(OPS.setFillRGBColor, ['#000000'])
  if (kind !== 'empty-stub') text('Key', 22, 91)
  text('A', 65, 91)
  text('B', 125, 91)
  text('C', 185, 91)
  if (kind === 'uncertainty') text('2', 190, 88, 6)
  for (let r = 0; r < 4; r++) {
    const y = 111 + r * 15
    text(kind === 'empty-stub' ? String.fromCharCode(75 + r) : String(r + 1), 22, y)
    if (kind === 'uncertainty' && r === 3) {
      text('10', 65, y)
      text('±', 78, y)
      text('1', 87, y)
      text('20 ± 2', 125, y)
      text('30', 185, y)
      text('±', 198, y)
      text('3', 207, y)
    } else for (let c = 1; c < 4; c++) text(String(10 * r + c), 5 + c * 60, y)
  }
  const content = { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } }
  const native = {
    operators,
    viewport,
    content,
    glyphBounds: [{ fontName: 'F', glyphs: [...glyphs.values()] }],
    graphicsBounds
  }
  const paint = new Map(),
    rules = collectTableRules(operators, viewport, paint)
  const rowCuts = kind === 'empty-stub' ? [78, 118, 133, 148, 165] : [78, 99, 119, 134, 149, 165]
  const columnCuts = kind === 'uncertainty' ? [20, 124, 184, 244] : [20, 64, 124, 184, 244]
  const table = {
    id: 'anonymous',
    cropRect: [18, 78, 246, 165],
    structure: {
      objects: [
        ...rowCuts.slice(1).map((y, n) => ({
          label: 'table row',
          score: 1,
          rect: [0, rowCuts[n] - 78, 228, y - 78]
        })),
        ...columnCuts.slice(1).map((x, n) => ({
          label: 'table column',
          score: 1,
          rect: [columnCuts[n] - 18, 0, x - 18, 87]
        })),
        {
          label: 'table column header',
          score: 1,
          rect: [0, 0, 228, kind === 'empty-stub' ? 40 : 21]
        }
      ]
    }
  }
  const captions = [{ page: 1, lines: ['Table 1: Values.'], rect: [20, 55, 95, 65] }]
  const context = {
    nativeGlyphContext: native,
    sourceContent: content,
    sourcePage: { pageNumber: 1 },
    viewport,
    rulePaintBounds: paint
  }
  return {
    table,
    tokens,
    captions,
    rules,
    context,
    text: (...args) => {
      text(...args)
      native.glyphBounds[0].glyphs = [...glyphs.values()]
    },
    fill,
    native
  }
}
