/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

// Small generated native source packets; no paper content or model outputs.
function nativeTableFont(text, x, y, width, height, index) {
  return {
    text,
    rect: [x, y - height, x + width, y],
    baseline: y,
    height,
    horizontal: true,
    fontAscent: 0.7,
    fontDescent: -0.2,
    nativeLabelRect: [x, y - height * 0.7, x + width, y + height * 0.3],
    sourceItem: { pageNumber: 1, index, text }
  }
}

function fixture() {
  const tokens = [],
    cells = [],
    grid = Array.from({ length: 18 }, () => Array(6).fill(''))
  const add = (row, column, runs, span = 1) => {
    const fonts = runs.map(([text, x, y, width = 10, height = 10]) => {
        const f = nativeTableFont(text, x, y, width, height, tokens.length)
        tokens.push(f)
        return f
      }),
      cell = {
        row,
        column,
        rowSpan: 1,
        colSpan: span,
        text: fonts.map((f) => f.text).join(' '),
        sourceItems: fonts.map((f) => f.sourceItem),
        sourceRects: fonts.map((f) => f.rect)
      }
    cells.push(cell)
    grid[row][column] = cell.text
    return cell
  }
  return {
    tokens,
    cells,
    grid,
    add,
    table: {
      page: 1,
      cropRect: [0, 0, 400, 400],
      grid,
      cells,
      issues: [],
      thumbnail: 'retained.png',
      notes: [{ text: 'Retained note' }]
    },
    rules: [],
    context: undefined
  }
}
function rule(f, r) {
  f.rules = [r]
  const p = [r[0], r[1] - 0.5, r[2], r[3] + 0.5]
  f.context = {
    operators: {
      fnArray: [OPS.setStrokeRGBColor, OPS.setLineWidth, OPS.setLineCap, OPS.constructPath],
      argsArray: [
        ['#000000'],
        [1],
        [0],
        [
          OPS.stroke,
          [[0, r[0], 400 - r[1], 1, r[2], 400 - r[3]]],
          [r[0], 400 - r[1], r[2], 400 - r[3]]
        ]
      ]
    },
    viewport: { transform: [1, 0, 0, -1, 0, 400], width: 400, height: 400, scale: 1, rotation: 0 },
    rulePaintBounds: new Map([[r.join(','), p]]),
    nativePaintIdentityGraphics: [{ kind: 'path', operationIndex: 3, rect: p }]
  }
  return f
}
function accent() {
  const f = fixture()
  f.target = f.add(0, 0, [
    ['Min.', 10, 30, 20],
    ['b', 34, 27, 6],
    ['β', 33, 30, 8],
    ['m', 41, 32, 6, 8]
  ])
  return f
}
function bar() {
  const f = fixture()
  f.target = f.add(0, 0, [
    ['Group', 10, 15, 30],
    ['∆', 20, 35, 8],
    ['E', 28, 37, 6, 8]
  ])
  return rule(f, [20, 26, 28, 26])
}
function group() {
  const f = fixture()
  f.target = f.add(0, 2, [['Combined', 150, 20, 50]])
  for (let c = 0; c < 4; c++)
    f.add(1, c, [[['Index', 'Value', 'Interval', 'Other'][c], [20, 120, 200, 300][c], 40, 20]])
  return rule(f, [110, 25, 260, 25])
}
function stacked() {
  const f = fixture()
  for (let c = 0; c < 3; c++) {
    f.add(0, c, [['Measure', 10 + c * 100, 20, 30]])
    const runs = []
    for (let r = 0; r < 3; r++)
      runs.push(
        ['0.5', 10 + c * 100, 45 + r * 14, 20],
        ['±', 31 + c * 100, 45 + r * 14, 5, 7.5],
        ['.1', 36 + c * 100, 45 + r * 14, 8, 7.5]
      )
    f.add(1, c, runs)
  }
  return f
}
function lanes() {
  const f = fixture()
  f.target = f.add(0, 0, [
    ['Kind', 10, 20, 10],
    ['Score', 50, 20, 10]
  ])
  for (let r = 1; r < 4; r++)
    f.add(r, 0, [
      [String(r), 12, 30 + r * 14, 6],
      ['0.5', 45, 30 + r * 14, 16],
      ['±', 62, 30 + r * 14, 4, 7.5],
      ['.1', 66, 30 + r * 14, 4, 7.5]
    ])
  return f
}
function cycle() {
  const f = fixture()
  for (let r = 1; r <= 6; r++) {
    f.add(r, 1, [[String(((r - 1) % 2) + 1), 80, 30 + r * 14, 10]])
    for (let c = 2; c < 4; c++) f.add(r, c, [['0.5', 100 + c * 40, 30 + r * 14, 15]])
  }
  for (let g = 0; g < 3; g++) {
    const c = f.add(1 + g * 2, 0, [[['Alpha', 'Beta', 'Gamma'][g], 10, 44 + g * 28, 30]])
    if (g === 1) {
      c.row = 2
      c.rowSpan = 3
      f.target = c
    }
  }
  return f
}
function formula() {
  const f = fixture()
  f.add(0, 0, [['Parent', 15, 20, 50]], 2)
  f.target = f.add(0, 2, [
    ['s', 180, 20, 6],
    ['2', 186, 20, 6],
    ['/', 192, 20, 6],
    ['(', 198, 20, 6]
  ])
  f.add(0, 3, [
    ['t', 205, 20, 6],
    ['2', 211, 20, 6],
    [')', 217, 20, 6]
  ])
  for (let c = 0; c < 4; c++) f.add(1, c, [[c % 2 ? '+ part' : 'K=2', 10 + c * 70, 40, 30]])
  return f
}
function nativeContext(f) {
  const viewport = {
      width: 400,
      height: 400,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 400]
    },
    operators = { fnArray: [OPS.setFillRGBColor], argsArray: [['#000000']] },
    glyphs = new Map(),
    items = f.tokens.map((t) => {
      const width = t.rect[2] - t.rect[0],
        advance = (width / t.text.length / t.height) * 1000,
        painted = [...t.text].map((unicode) => {
          glyphs.set(unicode, { fontChar: unicode, bounds: [0, -0.1, 0.4, 0.7] })
          return { unicode, fontChar: unicode, width: advance, isInFont: true }
        })
      operators.fnArray.push(
        OPS.beginText,
        OPS.setFont,
        OPS.setTextMatrix,
        OPS.showText,
        OPS.endText
      )
      operators.argsArray.push(
        [],
        ['F', t.height],
        [[1, 0, 0, 1, t.rect[0], 400 - t.baseline]],
        [painted],
        []
      )
      return {
        str: t.text,
        dir: 'ltr',
        width,
        height: t.height,
        transform: [t.height, 0, 0, t.height, t.rect[0], 400 - t.baseline],
        fontName: 'F',
        sourceItem: t.sourceItem
      }
    }),
    content = {
      items,
      styles: { F: { ascent: 0, descent: 0, vertical: false, fontFamily: 'sans-serif' } }
    },
    native = {
      viewport,
      operators,
      content,
      graphicsBounds: [],
      glyphBounds: [{ fontName: 'F', glyphs: [...glyphs.values()] }],
      sourceSha256: 'a'.repeat(64),
      pageNumber: 1
    }
  return {
    viewport,
    operators,
    sourceContent: content,
    content,
    sourcePage: {
      width: 400,
      height: 400,
      pageNumber: 1,
      invalidGraphicsBounds: 0,
      graphicsBounds: []
    },
    nativeGlyphContext: structuredClone(native),
    sourceSha256: native.sourceSha256
  }
}
function continuation() {
  const f = fixture()
  for (let r = 1; r <= 4; r++)
    f.add(r, 0, [
      [`P${r}`, 10, r * 40, 15],
      [r === 4 ? 'A complete hyphen-' : 'A complete sentence', 60, r * 40, 120],
      ...(r === 4 ? [] : [['continues here', 60, r * 40 + 12, 80]])
    ])
  f.target = f.add(5, 0, [['ated continuation', 60, 172, 90]])
  f.grid.splice(6)
  f.context = nativeContext(f)
  return f
}

export { accent, bar, group, stacked, lanes, cycle, formula, continuation }

function nativeRecordFixture(columns, rows) {
  const f = fixture()
  f.grid.length = rows
  for (const row of f.grid) row.length = columns
  f.token = (text, x, y, width = 40) => {
    const token = nativeTableFont(text, x, y, width, 10, f.tokens.length)
    f.tokens.push(token)
    return token
  }
  f.cell = (row, column, fonts, text = fonts.map((t) => t.text).join(' '), rects) => {
    const cell = {
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      text,
      sourceRects: rects ?? fonts.map((t) => t.rect),
      ...(fonts.length ? { sourceItems: fonts.map((t) => t.sourceItem) } : {})
    }
    f.cells.push(cell)
    f.grid[row][column] = text
    return cell
  }
  f.add = (row, column, text, y) => f.cell(row, column, [f.token(text, 10 + column * 70, y)])
  f.headers = () => {
    for (let c = 0; c < columns; c++) f.add(0, c, 'Heading ' + c, 20)
  }
  f.finish = () => {
    f.context = nativeContext(f)
    for (const content of [f.context.sourceContent, f.context.nativeGlyphContext.content]) {
      content.styles.F.ascent = 0.7
      content.styles.F.descent = -0.2
    }
    return f
  }
  return f
}

export { nativeRecordFixture }

// One complete expression whose upper signed index was assigned to the prior row.
export function signedScriptRows() {
  const f = nativeRecordFixture(3, 4)
  f.headers()
  for (let row = 1; row <= 3; row++)
    for (let column = 0; column < 2; column++) f.add(row, column, 'record', 28 + row * 12)
  const previous = f.token('prior', 150, 40, 30),
    word = f.token('ratio', 150, 52, 25),
    base = f.token('x', 210, 52, 6),
    sign = f.token('−', 216.2, 47.63, 6),
    upper = f.token('j', 222.2, 47.63, 5),
    lower = f.token('k', 216.2, 54.345, 4)
  for (const t of [sign, upper, lower]) {
    t.height = 20 / 3
    t.rect[1] = t.baseline - t.height
    t.nativeLabelRect = [
      t.rect[0],
      t.baseline - t.height * 0.7,
      t.rect[2],
      t.baseline + t.height * 0.3
    ]
  }
  f.cell(1, 2, [previous, sign, upper])
  f.cell(2, 2, [word, base, lower])
  f.add(3, 2, 'last', 64)
  f.script = { previous, base, sign, upper, lower }
  return f.finish()
}

export function addScriptRowPaint(f, kind) {
  const index = f.script.sign.sourceItem.index,
    at = 1 + 5 * index
  for (const c of [f.context, f.context.nativeGlyphContext]) {
    if (kind === 'white' || kind === 'transparent') {
      const op = kind === 'white' ? OPS.setFillRGBColor : OPS.setGState,
        value = kind === 'white' ? ['#ffffff'] : [[['ca', 0]]],
        reset = kind === 'white' ? ['#000000'] : [[['ca', 1]]]
      c.operators.fnArray.splice(at, 0, op)
      c.operators.argsArray.splice(at, 0, value)
      c.operators.fnArray.splice(at + 6, 0, op)
      c.operators.argsArray.splice(at + 6, 0, reset)
    } else {
      const width = kind === 'thin' ? 0.001 : 4,
        y = kind === 'thin' ? 42.95 : 40,
        empty = kind === 'empty'
      c.operators.fnArray.push(OPS.setLineWidth, OPS.constructPath)
      c.operators.argsArray.push(
        [width],
        [
          OPS.stroke,
          empty ? [null] : [[0, 205, 400 - y, 1, 230, 400 - y]],
          empty || kind === 'missing-bounds' ? null : [205, 400 - y, 230, 400 - y]
        ]
      )
    }
  }
  return f
}
