import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`test/fixtures/source-grids/${name}.jsonl`))
const parse = (name: string): ReturnType<typeof JSON.parse> => {
  const x = fixture(name)
  return refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
}

const { OPS: ruledPacketOPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { collectTableRules: packetRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { proveNativeCompleteRuledSourcePacket } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-leaf-record-repair.mjs')).href
)
const {
  recoverNativeClosedParameterRows,
  recoverNativeClosedProseSymbolRows,
  recoverNativeCaptionedTwoFieldRows,
  recoverNativeRuledIntervalColumns
} = await import(pathToFileURL(resolve('resources/literature-pdf-table-regions.mjs')).href)
const { recoverNativeHeterogeneousRuledParts } = await import(
  pathToFileURL(resolve('resources/literature-pdf-ruled-narrative-grid.mjs')).href
)
type AnonymousRuledPacket = ReturnType<typeof JSON.parse>

// Small ordinary-font paint packets keep source text and paint independent of
// the model grid. Every font and line is owned; no paper fixture is involved.
function anonymousRuledPacket(
  kind: 'prose' | 'scripts' | 'parts' | 'records' | 'interval',
  options: { gap?: number; stroke?: number; offpage?: number } = {}
): AnonymousRuledPacket {
  const O = ruledPacketOPS
  const viewport = {
    scale: 1,
    width: 600,
    height: 500,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 500]
  }
  const operators: AnonymousRuledPacket = { fnArray: [], argsArray: [] }
  const content: AnonymousRuledPacket = { items: [], styles: { f: { vertical: false } } }
  const tokens: AnonymousRuledPacket[] = [],
    graphics: AnonymousRuledPacket[] = []
  const add = (code: number, args: unknown): void => {
    operators.fnArray.push(code)
    operators.argsArray.push(args)
  }
  add(O.dependency, ['f'])
  add(O.setFillRGBColor, ['#000000'])
  add(O.setStrokeRGBColor, ['#000000'])
  const stroke = options.stroke ?? 1
  add(O.setLineWidth, [stroke])
  add(O.setLineCap, [0])
  add(O.setDash, [[], 0])
  const font = (text: string, x: number, baseline: number, h = 10): void => {
    const width = (text.length * h) / 2
    const sourceItem = { pageNumber: 1, index: content.items.length, text }
    content.items.push({
      str: text,
      width,
      height: h,
      fontName: 'f',
      transform: [h, 0, 0, h, x, 500 - baseline],
      sourceItem
    })
    tokens.push({
      text,
      height: h,
      baseline,
      horizontal: true,
      rect: [x, baseline - h, x + width, baseline],
      sourceItem
    })
    add(O.beginText, null)
    add(O.setFont, ['f', h])
    add(O.setTextMatrix, [1, 0, 0, 1, x, 500 - baseline])
    add(O.showText, [
      [...text].map((char) => ({
        unicode: char,
        fontChar: char,
        width: 500,
        isInFont: true,
        originalCharCode: char.codePointAt(0),
        accent: null
      }))
    ])
    add(O.endText, null)
  }
  const line = (r: number[]): void => {
    const p = [0, r[0], 500 - r[1], 1, r[2], 500 - r[3]]
    add(O.constructPath, [
      O.stroke,
      [p],
      [Math.min(p[1], p[4]), Math.min(p[2], p[5]), Math.max(p[1], p[4]), Math.max(p[2], p[5])]
    ])
    const bounds = [
      Math.min(r[0], r[2]) - stroke / 2,
      Math.min(r[1], r[3]) - stroke / 2,
      Math.max(r[0], r[2]) + stroke / 2,
      Math.max(r[1], r[3]) + stroke / 2
    ]
    graphics.push({
      kind: 'path',
      rect: bounds.map(
        (v, k) =>
          ((k < 2
            ? Math.floor((v / (k % 2 ? 500 : 600)) * 256)
            : Math.ceil((v / (k % 2 ? 500 : 600)) * 256) + 1) *
            (k % 2 ? 500 : 600)) /
          256
      )
    })
  }
  font('Table 1: Values', 20, 65)
  const captions = [{ page: 1, lines: ['Table 1: Values'], rect: [20, 55, 95, 65] }]
  let cropRect: number[]
  if (kind === 'interval') {
    for (const y of [80, 108, 183]) line([20, y, 220, y])
    line([110, 108, 110, 183])
    font('Choice', 30, 100)
    font('Interval', 140, 100)
    for (const [row, label] of ['A', 'B', 'C'].entries()) {
      font(label, 30, 125 + row * 25)
      font(`${row + 1}.5`, 128, 125 + row * 25)
      font('−', 157, 125 + row * 25)
      font(`${row + 4}.5`, 170, 125 + row * 25)
    }
    cropRect = [20, 77, 220, 185]
  } else if (kind === 'prose') {
    const xs = [20, 180, 220, 380],
      ys = [80, 105, 145, 185, 225, 265]
    for (const y of ys) line([20, y, 380, y])
    for (let row = 0; row < 5; row++) {
      for (const x of row ? xs : [20, 380]) line([x, ys[row], x, ys[row + 1]])
      if (!row) font('Local record', 170, 96)
      else {
        font('Left prose', 30, ys[row] + 20)
        font(row % 2 ? '+' : '-', 197.5, ys[row] + 20)
        font('Right prose', 230, ys[row] + 20)
      }
    }
    cropRect = [20, 80, 380, 265]
  } else if (kind === 'records') {
    for (const y of [80, 200, 260]) line([20, y, 400, y])
    for (const [top, bottom] of [
      [80, 200],
      [200, 260]
    ])
      for (const x of [20, 80, 145, 400])
        line([x, top + (options.gap ?? 0.5), x, bottom - (options.gap ?? 0.5)])
    font('θ', 30, 95)
    font('2', 35, 97, 6)
    font('0.25', 90, 95)
    font('units', 90, 115)
    for (const [n, text] of [
      'First measured value',
      'has a continued definition',
      'inside one physical record',
      'and a final clause.'
    ].entries())
      font(text, 155, 95 + n * 30)
    font('2.5', 260, 95)
    font('3.5', 290, 125)
    font('κ', 30, 215)
    font('3', 35, 217, 6)
    font('12', 90, 215)
    for (const [n, text] of [
      'Second value belongs here',
      'with its independent meaning',
      'and its enclosed last sentence.'
    ].entries())
      font(text, 155, 215 + n * 20)
    add(O.constructPath, [
      O.fill,
      [[0, 0, 20, 1, 500, 20, 1, 500, 22, 1, 0, 22, 4]],
      [0, 20, 500, 22]
    ])
    graphics.push({
      kind: 'path',
      rect: [0, 478, 500, 480].map(
        (v, k) =>
          ((k < 2
            ? Math.floor((v / (k % 2 ? 500 : 600)) * 256)
            : Math.ceil((v / (k % 2 ? 500 : 600)) * 256) + 1) *
            (k % 2 ? 500 : 600)) /
          256
      )
    })
    cropRect = [20, 80, 400, 260]
    if (options.offpage !== undefined) {
      font('Outside', options.offpage, 470)
      content.items.pop()
      tokens.pop()
      font('Page', 510, 470)
    }
  } else if (kind === 'scripts') {
    for (const y of [80, 105, 225]) line([20, y, 200, y])
    font('Position', 30, 95)
    font('Count', 110, 95)
    for (const [n, label] of ['Alpha', 'Beta', 'Gamma'].entries()) {
      const y = 130 + n * 40
      font(label, 30, y)
      font('12.3', 110, y)
      font('+2', 134, y - 2, 6)
    }
    cropRect = [20, 80, 200, 225]
  } else {
    for (const [band, x, end, top, count] of [
      [0, 20, 560, 80, 9],
      [1, 100, 480, 210, 6]
    ]) {
      for (const y of [top, top + 25, top + 95, top + 120]) line([x, y, end, y])
      for (const [row, baseline] of [top + 15, top + 45, top + 65, top + 85, top + 110].entries()) {
        for (let col = 0; col < count; col++)
          font(
            !col
              ? row === 4
                ? 'Total'
                : 'Seq'
              : !row
                ? String.fromCharCode(65 + col)
                : String(row + band),
            x + 15 + col * 60,
            baseline
          )
      }
    }
    cropRect = [20, 80, 560, 330]
  }
  const paint = new Map(),
    rules = packetRules(operators, viewport, paint)
  return {
    table: { cropRect, sourceViewport: { width: 600, height: 500 } },
    tokens,
    captions,
    rules,
    context: {
      operators,
      content,
      viewport,
      rulePaintBounds: [...paint],
      nativeEvidenceGraphics: graphics
    }
  }
}

function intervalPacket(): AnonymousRuledPacket {
  const x = anonymousRuledPacket('interval')
  x.table.structure = {
    objects: [
      ...[0, 90, 145].map((left, index) => ({
        label: 'table column',
        score: 1,
        rect: [left, 0, [90, 145, 200][index], 108]
      })),
      ...[8, 33, 58, 83].map((top) => ({
        label: 'table row',
        score: 1,
        rect: [0, top, 200, top + 20]
      }))
    ]
  }
  const header = x.tokens.find((token: AnonymousRuledPacket) => token.text === 'Interval')
  x.measured = [{ text: header.text, rect: header.rect, gaps: [], literalGlyphs: [...header.text] }]
  return x
}

it('uses complete native ruled domains to keep every interval in one field', () => {
  const x = intervalPacket()
  const result = refineTable(
    x.table,
    x.tokens,
    x.captions,
    [],
    x.rules,
    x.measured,
    undefined,
    undefined,
    x.context
  )
  expect(result.grid).toEqual([
    ['Choice', 'Interval'],
    ['A', '1.5 − 4.5'],
    ['B', '2.5 − 5.5'],
    ['C', '3.5 − 6.5']
  ])
  expect(result.repairs).toContain('native-ruled-interval-columns-recovered')
  expect(
    result.cells
      .flatMap((cell: AnonymousRuledPacket) => cell.sourceItems)
      .sort((a: AnonymousRuledPacket, b: AnonymousRuledPacket) => a.index - b.index)
  ).toEqual(
    x.tokens
      .filter((token: AnonymousRuledPacket) => token.rect[1] > 80)
      .map((token: AnonymousRuledPacket) => token.sourceItem)
  )
})

const intervalRejections: [string, (x: AnonymousRuledPacket) => void][] = [
  [
    'no native separator',
    (x) => {
      x.rules = x.rules.filter((r: number[]) => r[0] !== r[2])
    }
  ],
  [
    'incomplete native separator',
    (x) => {
      x.rules.find((r: number[]) => r[0] === r[2])[3] = 150
    }
  ],
  [
    'genuine separate numeric field',
    (x) => {
      x.rules.push([165, 108, 165, 183])
    }
  ],
  [
    'incomplete lower rule',
    (x) => {
      x.rules.find((r: number[]) => r[1] === 183)[2] = 210
    }
  ],
  [
    'missing measured header witness',
    (x) => {
      x.measured = []
    }
  ],
  [
    'measured header has a leaf gap',
    (x) => {
      x.measured[0].gaps = [{ left: 160, right: 170, index: 4 }]
    }
  ],
  [
    'partly visible native glyph',
    (x) => {
      x.tokens[1].rect[0] = 10
    }
  ],
  [
    'crossing native separator glyph',
    (x) => {
      x.tokens[2].rect[0] = 105
    }
  ],
  [
    'overlapping interval operands',
    (x) => {
      x.tokens.find((t: AnonymousRuledPacket) => t.text === '4.5').rect[0] = 135
    }
  ],
  [
    'independent scalars without interval operator',
    (x) => {
      x.tokens = x.tokens.filter((t: AnonymousRuledPacket) => t.text !== '−')
    }
  ],
  [
    'crop-external parent alias',
    (x) => {
      x.tokens.push({ ...x.tokens[1], rect: [500, 400, 530, 410] })
    }
  ],
  [
    'unknown graphics state',
    (x) => {
      x.context.operators.fnArray.push(ruledPacketOPS.setGState)
      x.context.operators.argsArray.push([[['ca', 0.5]]])
    }
  ],
  [
    'unproved clip',
    (x) => {
      x.context.operators.fnArray.push(ruledPacketOPS.clip)
      x.context.operators.argsArray.push(null)
    }
  ]
]

it.each(intervalRejections)(
  'retains model interval columns without complete proof: %s',
  (_, change) => {
    const x = intervalPacket()
    change(x)
    expect(
      recoverNativeRuledIntervalColumns(x.table, x.tokens, x.rules, x.measured, x.context)
    ).toBeUndefined()
  }
)

function colorIntervalCaption(x: AnonymousRuledPacket): void {
  const op = x.context.operators
  const begin = op.fnArray.indexOf(ruledPacketOPS.beginText)
  op.fnArray.splice(begin, 0, ruledPacketOPS.setFillRGBColor)
  op.argsArray.splice(begin, 0, ['#102694'])
  const end = op.fnArray.indexOf(ruledPacketOPS.endText)
  op.fnArray.splice(end + 1, 0, ruledPacketOPS.setFillRGBColor)
  op.argsArray.splice(end + 1, 0, ['#000000'])
}

it('proves outside colored native text without relaxing the default complete packet guard', () => {
  const x = intervalPacket()
  colorIntervalCaption(x)
  expect(
    proveNativeCompleteRuledSourcePacket(
      x.tokens.filter((t: AnonymousRuledPacket) => t.rect[1] > 80),
      x.rules,
      x.context,
      x.table.cropRect
    )
  ).toBe(false)
  expect(
    recoverNativeRuledIntervalColumns(x.table, x.tokens, x.rules, x.measured, x.context)
  ).toBeDefined()
})

it.each(['inside', 'touching', 'stroke', 'unrestored', 'transparent'])(
  'rejects interval recovery with unproved colored paint: %s',
  (kind) => {
    const x = intervalPacket()
    colorIntervalCaption(x)
    const op = x.context.operators
    if (kind === 'inside' || kind === 'unrestored') {
      const restore = op.fnArray.indexOf(ruledPacketOPS.endText) + 1
      op.fnArray.splice(restore, 1)
      op.argsArray.splice(restore, 1)
    } else if (kind === 'touching') {
      // The first painted caption ends exactly on the top crop boundary.
      const matrix = op.fnArray.indexOf(ruledPacketOPS.setTextMatrix)
      op.argsArray[matrix][5] = 500 - x.table.cropRect[1]
      x.context.content.items[0].transform[5] = 500 - x.table.cropRect[1]
      x.tokens[0].baseline = x.table.cropRect[1]
      x.tokens[0].rect = [20, x.table.cropRect[1] - 10, 90, x.table.cropRect[1]]
    } else if (kind === 'stroke') {
      const line = op.fnArray.indexOf(ruledPacketOPS.constructPath)
      op.fnArray.splice(line, 0, ruledPacketOPS.setStrokeRGBColor)
      op.argsArray.splice(line, 0, ['#102694'])
    } else {
      op.fnArray.push(ruledPacketOPS.setGState)
      op.argsArray.push([[['ca', 0.5]]])
    }
    expect(
      recoverNativeRuledIntervalColumns(x.table, x.tokens, x.rules, x.measured, x.context)
    ).toBeUndefined()
  }
)

it('tracks save and restore around exterior colored text before proving the black interval', () => {
  const x = intervalPacket()
  colorIntervalCaption(x)
  const op = x.context.operators
  const firstText = op.fnArray.indexOf(ruledPacketOPS.beginText)
  op.fnArray.splice(firstText - 1, 0, ruledPacketOPS.save)
  op.argsArray.splice(firstText - 1, 0, null)
  const restore = op.fnArray.indexOf(ruledPacketOPS.endText) + 1
  op.fnArray[restore] = ruledPacketOPS.restore
  op.argsArray[restore] = null
  expect(
    recoverNativeRuledIntervalColumns(x.table, x.tokens, x.rules, x.measured, x.context)
  ).toBeDefined()
})

function refineAnonymousRecords(x: AnonymousRuledPacket): AnonymousRuledPacket {
  const table = {
    ...x.table,
    rowCount: 3,
    columnCount: 3,
    spans: [],
    grid: [
      ['', '', ''],
      ['', '', ''],
      ['', '', '']
    ],
    unassigned: [],
    structure: {
      objects: [
        ...[
          [17, 32],
          [29, 126],
          [121, 163]
        ].map(([top, bottom]) => ({
          label: 'table row',
          score: 0.95,
          rect: [0, top, 380, bottom]
        })),
        ...[
          [0, 60],
          [60, 125],
          [125, 380]
        ].map(([left, right]) => ({
          label: 'table column',
          score: 0.95,
          rect: [left, 0, right, 180]
        }))
      ]
    }
  }
  return refineTable(table, x.tokens, x.captions, [], x.rules, [], undefined, undefined, x.context)
}

it('keeps two fully fenced parameter records whole despite model cuts through their continued descriptions', () => {
  const x = anonymousRuledPacket('records'),
    before = structuredClone(x)
  const result = refineAnonymousRecords(x)
  expect(result.grid).toEqual([
    [
      'θ2',
      '0.25 units',
      'First measured value 2.5 has a continued definition 3.5 inside one physical record and a final clause.'
    ],
    [
      'κ3',
      '12',
      'Second value belongs here with its independent meaning and its enclosed last sentence.'
    ]
  ])
  expect(result.unassigned).toEqual([])
  expect(result.cells).toHaveLength(6)
  expect(
    result.cells
      .flatMap((cell: AnonymousRuledPacket) => cell.sourceItems)
      .sort((a: AnonymousRuledPacket, b: AnonymousRuledPacket) => a.index - b.index)
  ).toEqual(x.tokens.slice(1).map((token: AnonymousRuledPacket) => token.sourceItem))
  expect(x).toEqual(before)
})

function recoverAnonymousRuled(x: AnonymousRuledPacket, kind: string): AnonymousRuledPacket {
  return kind === 'prose'
    ? recoverNativeClosedProseSymbolRows(x.table, x.tokens, x.rules, x.context)
    : kind === 'scripts'
      ? recoverNativeCaptionedTwoFieldRows(x.table, x.tokens, x.captions, x.rules, x.context)
      : recoverNativeHeterogeneousRuledParts(x.table, x.tokens, x.captions, x.rules, x.context)
}

function moveAnonymousWholeFont(x: AnonymousRuledPacket, index: number, dx: number): void {
  x.context.content.items[index].transform[4] += dx
  x.tokens[index].rect[0] += dx
  x.tokens[index].rect[2] += dx
  const matrices = x.context.operators.fnArray
    .map((code: number, n: number) => (code === ruledPacketOPS.setTextMatrix ? n : -1))
    .filter((n: number) => n >= 0)
  x.context.operators.argsArray[matrices[index]][4] += dx
}

function appendAnonymousRecordFont(
  x: AnonymousRuledPacket,
  text: string,
  left: number,
  baseline: number,
  height = 10
): void {
  const O = ruledPacketOPS,
    index = x.context.content.items.length,
    width = (text.length * height) / 2
  const sourceItem = { pageNumber: 1, index, text }
  x.context.content.items.push({
    str: text,
    width,
    height,
    fontName: 'f',
    transform: [height, 0, 0, height, left, 500 - baseline],
    sourceItem
  })
  x.tokens.push({
    text,
    height,
    baseline,
    horizontal: true,
    rect: [left, baseline - height, left + width, baseline],
    sourceItem
  })
  x.context.operators.fnArray.push(O.beginText, O.setFont, O.setTextMatrix, O.showText, O.endText)
  x.context.operators.argsArray.push(
    null,
    ['f', height],
    [1, 0, 0, 1, left, 500 - baseline],
    [
      [...text].map((char) => ({
        unicode: char,
        fontChar: char,
        width: 500,
        isInFont: true,
        originalCharCode: char.codePointAt(0),
        accent: null
      }))
    ],
    null
  )
}

it('refuses a right-aligned independent numeric subtable with unequal digit widths', () => {
  const x = anonymousRuledPacket('records')
  for (const [oldText, newText, left] of [
    ['First measured value', 'First measured value here', 155],
    ['2.5', '2.5', 290],
    ['3.5', '23.5', 285]
  ] as const) {
    const index = x.tokens.findIndex((i: AnonymousRuledPacket) => i.text === oldText),
      token = x.tokens[index],
      raw = x.context.content.items[index]
    moveAnonymousWholeFont(x, index, left - token.rect[0])
    token.text = newText
    token.sourceItem.text = newText
    raw.str = newText
    raw.width = newText.length * 5
    token.rect[2] = left + raw.width
    const shows = x.context.operators.fnArray
      .map((code: number, n: number) => (code === ruledPacketOPS.showText ? n : -1))
      .filter((n: number) => n >= 0)
    x.context.operators.argsArray[shows[index]] = [
      Array.from(newText, (char) => ({
        unicode: char,
        fontChar: char,
        width: 500,
        isInFont: true,
        originalCharCode: char.codePointAt(0),
        accent: null
      }))
    ]
  }
  expect(recoverNativeClosedParameterRows(x.table, x.tokens, x.rules, x.context)).toBeUndefined()
  expect(refineAnonymousRecords(x).repairs ?? []).not.toContain(
    'native-closed-parameter-records-recovered'
  )
})

it.each([0.2, 0.6, 1.5])(
  'preserves complete native records with stroke width %s under the existing edge contract',
  (stroke) => {
    const x = anonymousRuledPacket('records', { stroke, gap: 0.75 })
    expect(
      recoverNativeClosedParameterRows(x.table, x.tokens, x.rules, x.context)?.ownedTokens.size
    ).toBe(x.tokens.length - 1)
    expect(refineAnonymousRecords(x).grid).toHaveLength(2)
  }
)

it('retains the global guard while proving an outside rectangular fill and a wholly off-page text run locally', () => {
  const x = anonymousRuledPacket('records', { offpage: -100 })
  expect(proveNativeCompleteRuledSourcePacket(x.tokens, x.rules, x.context, x.table.cropRect)).toBe(
    false
  )
  expect(recoverNativeClosedParameterRows(x.table, x.tokens, x.rules, x.context)).toBeDefined()
  const result = refineAnonymousRecords(x)
  expect(result.grid).toHaveLength(2)
  expect(result.unassigned).toEqual([])
})

it('preserves complete record ownership under a non-unit native viewport scale', () => {
  const scale = 0.5
  const x = anonymousRuledPacket('records')
  x.context.viewport = {
    ...x.context.viewport,
    scale,
    width: 600 * scale,
    height: 500 * scale,
    transform: [scale, 0, 0, -scale, 0, 500 * scale]
  }
  for (const token of x.tokens) {
    token.rect = token.rect.map((v: number) => v * scale)
    token.height *= scale
    token.baseline *= scale
  }
  for (const g of x.context.nativeEvidenceGraphics) g.rect = g.rect.map((v: number) => v * scale)
  x.table.cropRect = x.table.cropRect.map((v: number) => v * scale)
  const paint = new Map()
  x.rules = packetRules(x.context.operators, x.context.viewport, paint)
  x.context.rulePaintBounds = [...paint]
  const proof = recoverNativeClosedParameterRows(x.table, x.tokens, x.rules, x.context)
  expect(proof?.ownedTokens.size).toBe(x.tokens.length - 1)
  expect(proof?.rows).toHaveLength(2)
})

it.each([115, 112])(
  'refuses a detached small numeric unit-line font at baseline %s',
  (baseline) => {
    const x = anonymousRuledPacket('records')
    appendAnonymousRecordFont(x, '3', 137, baseline, 6)
    expect(recoverNativeClosedParameterRows(x.table, x.tokens, x.rules, x.context)).toBeUndefined()
    expect(refineAnonymousRecords(x).repairs ?? []).not.toContain(
      'native-closed-parameter-records-recovered'
    )
  }
)

it.each([
  'second-scalar',
  'unit-with-separated-scalars',
  'multiple-stub-values',
  'numeric-subtable',
  'detached-scalar-digits'
] as const)('refuses the independent %s record domain inside a closed frame', (kind) => {
  const x = anonymousRuledPacket('records')
  if (kind === 'second-scalar') appendAnonymousRecordFont(x, '3', 90, 145)
  if (kind === 'unit-with-separated-scalars') {
    appendAnonymousRecordFont(x, '3', 125, 115)
    appendAnonymousRecordFont(x, '4', 136, 115)
  }
  if (kind === 'multiple-stub-values') {
    appendAnonymousRecordFont(x, 'β', 30, 145)
    appendAnonymousRecordFont(x, '5', 90, 145)
  }
  if (kind === 'numeric-subtable')
    moveAnonymousWholeFont(
      x,
      x.tokens.findIndex((i: AnonymousRuledPacket) => i.text === '3.5'),
      -30
    )
  if (kind === 'detached-scalar-digits') appendAnonymousRecordFont(x, '2', 125, 95)
  const before = structuredClone(x)
  expect(recoverNativeClosedParameterRows(x.table, x.tokens, x.rules, x.context)).toBeUndefined()
  expect(refineAnonymousRecords(x).repairs ?? []).not.toContain(
    'native-closed-parameter-records-recovered'
  )
  expect(x).toEqual(before)
})

it.each(['sourceItem', 'sourceSegment', 'sourceToken', 'nestedItem', 'nestedSegment'] as const)(
  'refuses a crop-external %s alias of an owned record font',
  (carrier) => {
    const x = anonymousRuledPacket('records'),
      origin = x.tokens[1].sourceItem
    const alias: AnonymousRuledPacket = {
      text: origin.text,
      rect: [500, 300, 505, 310],
      height: 10,
      baseline: 310,
      horizontal: true
    }
    if (carrier === 'nestedItem') alias.sourceToken = { sourceItem: origin }
    else if (carrier === 'nestedSegment')
      alias.sourceToken = { sourceSegment: { ...origin, start: 0, end: 1 } }
    else alias[carrier] = carrier === 'sourceSegment' ? { ...origin, start: 0, end: 1 } : origin
    x.tokens.push(alias)
    expect(recoverNativeClosedParameterRows(x.table, x.tokens, x.rules, x.context)).toBeUndefined()
    expect(refineAnonymousRecords(x).repairs ?? []).not.toContain(
      'native-closed-parameter-records-recovered'
    )
  }
)

it.each([
  'open-edge',
  'crossed-leaf',
  'touching-ink',
  'partial-viewport',
  'fill-at-frame',
  'clip',
  'alpha',
  'unknown-state',
  'transformed-paint',
  'missing-source',
  'missing-graphic'
] as const)('refuses the scoped closed-record %s counterexample', (kind) => {
  const x = anonymousRuledPacket(
    'records',
    kind === 'open-edge' ? { gap: 1.01 } : kind === 'partial-viewport' ? { offpage: -5 } : {}
  )
  const op = x.context.operators,
    O = ruledPacketOPS
  if (kind === 'crossed-leaf') moveAnonymousWholeFont(x, 1, 48)
  if (kind === 'touching-ink') moveAnonymousWholeFont(x, 1, 44.8)
  if (kind === 'fill-at-frame') {
    const n = op.fnArray.findIndex(
      (code: number, n: number) => code === O.constructPath && op.argsArray[n][0] === O.fill
    )
    op.argsArray[n] = [
      O.fill,
      [[0, 0, 238, 1, 500, 238, 1, 500, 240, 1, 0, 240, 4]],
      [0, 238, 500, 240]
    ]
    x.context.nativeEvidenceGraphics.at(-1).rect = [0, 260, 500, 262].map(
      (v: number, k: number) =>
        ((k < 2
          ? Math.floor((v / (k % 2 ? 500 : 600)) * 256)
          : Math.ceil((v / (k % 2 ? 500 : 600)) * 256) + 1) *
          (k % 2 ? 500 : 600)) /
        256
    )
  }
  if (kind === 'clip') {
    op.fnArray.unshift(O.clip)
    op.argsArray.unshift(null)
  }
  if (kind === 'alpha') {
    op.fnArray.unshift(O.setGState)
    op.argsArray.unshift([['ca', 0.5]])
  }
  if (kind === 'unknown-state') {
    op.fnArray.unshift(987654)
    op.argsArray.unshift(null)
  }
  if (kind === 'transformed-paint') {
    op.fnArray.unshift(O.transform)
    op.argsArray.unshift([1, 0.1, 0, 1, 0, 0])
  }
  if (kind === 'missing-source') x.tokens.splice(5, 1)
  if (kind === 'missing-graphic') x.context.nativeEvidenceGraphics.pop()
  const before = structuredClone(x)
  expect(recoverNativeClosedParameterRows(x.table, x.tokens, x.rules, x.context)).toBeUndefined()
  expect(refineAnonymousRecords(x).repairs ?? []).not.toContain(
    'native-closed-parameter-records-recovered'
  )
  expect(x).toEqual(before)
})

it.each([
  ['prose', 3, 40],
  ['scripts', 2, -40],
  ['parts', 51, -60]
] as const)(
  'refuses native %s fonts that cross or destroy their physical lanes',
  (kind, index, dx) => {
    const x = anonymousRuledPacket(kind)
    moveAnonymousWholeFont(x, index, dx)
    expect(
      proveNativeCompleteRuledSourcePacket(x.tokens, x.rules, x.context, x.table.cropRect)
    ).toBe(true)
    const before = structuredClone(x)
    expect(recoverAnonymousRuled(x, kind)).toBeUndefined()
    expect(x).toEqual(before)
  }
)

it('refuses one missing inner record fence even when the remaining source paint is complete', () => {
  const x = anonymousRuledPacket('prose'),
    op = x.context.operators
  const n = op.fnArray.findIndex(
    (code: number, n: number) =>
      code === ruledPacketOPS.constructPath &&
      op.argsArray[n][1][0][1] === 180 &&
      op.argsArray[n][1][0][2] === 395
  )
  const ordinal = op.fnArray
    .slice(0, n)
    .filter((code: number) => code === ruledPacketOPS.constructPath).length
  op.fnArray.splice(n, 1)
  op.argsArray.splice(n, 1)
  x.context.nativeEvidenceGraphics.splice(ordinal, 1)
  const paint = new Map()
  x.rules = packetRules(op, x.context.viewport, paint)
  x.context.rulePaintBounds = [...paint]
  expect(proveNativeCompleteRuledSourcePacket(x.tokens, x.rules, x.context, x.table.cropRect)).toBe(
    true
  )
  expect(recoverAnonymousRuled(x, 'prose')).toBeUndefined()
})

it('accepts the actual PDF.js typed path/matrix carriers but refuses mismatched bounds', () => {
  const x = anonymousRuledPacket('prose'),
    op = x.context.operators
  for (let n = 0; n < op.fnArray.length; n++) {
    if (op.fnArray[n] === ruledPacketOPS.constructPath) {
      op.argsArray[n][1][0] = new Float32Array(op.argsArray[n][1][0])
      op.argsArray[n][2] = new Float32Array(op.argsArray[n][2])
    }
    if (op.fnArray[n] === ruledPacketOPS.setTextMatrix)
      op.argsArray[n] = [new Float32Array(op.argsArray[n])]
  }
  expect(recoverAnonymousRuled(x, 'prose')).toBeDefined()
  op.argsArray[op.fnArray.indexOf(ruledPacketOPS.constructPath)][2][0] += 1
  expect(recoverAnonymousRuled(x, 'prose')).toBeUndefined()
})

it('refuses compensated text advances that move an interior glyph outside its whole font', () => {
  const x = anonymousRuledPacket('scripts'),
    op = x.context.operators
  const shows = op.fnArray
    .map((code: number, n: number) => (code === ruledPacketOPS.showText ? n : -1))
    .filter((n: number) => n >= 0)
  const glyphs = op.argsArray[shows[1]][0]
  glyphs.splice(2, 0, -10000)
  glyphs.splice(4, 0, 10000)
  expect(recoverAnonymousRuled(x, 'scripts')).toBeUndefined()
})

it.each(['scripts', 'parts'] as const)(
  'requires the same-page canonical caption for %s and preserves complete stroke ink',
  (kind) => {
    const x = anonymousRuledPacket(kind),
      proof = recoverAnonymousRuled(x, kind)
    expect(proof.cropRect[1]).toBeLessThan(x.table.cropRect[1])
    expect(proof.cropRect[3]).toBeGreaterThan(x.table.cropRect[3])
    x.captions[0].page = 2
    expect(recoverAnonymousRuled(x, kind)).toBeUndefined()
  }
)

it.each(['prose', 'scripts', 'parts'] as const)(
  'owns every whole source font in a closed %s body',
  (kind) => {
    const x = anonymousRuledPacket(kind),
      before = structuredClone(x),
      proof = recoverAnonymousRuled(x, kind)
    expect(proof).toBeDefined()
    expect(x).toEqual(before)
    if (kind === 'parts') {
      expect(
        proof.parts.map((p: AnonymousRuledPacket) => [p.grid.length, p.grid[0].length])
      ).toEqual([
        [5, 9],
        [5, 6]
      ])
      expect(proof.parts.flatMap((p: AnonymousRuledPacket) => p.cells)).toHaveLength(75)
      expect(proof.parts.map((p: AnonymousRuledPacket) => p.title)).toEqual(['Seq', 'Seq'])
      for (const p of proof.parts)
        for (const c of p.cells) {
          expect(c.sourceItems).toHaveLength(1)
          expect(c.sourceRects[0][0]).toBeGreaterThanOrEqual(c.rect[0])
          expect(c.sourceRects[0][2]).toBeLessThanOrEqual(c.rect[2])
        }
    } else {
      expect(proof.rows).toHaveLength(kind === 'prose' ? 5 : 4)
      expect(proof.columns).toHaveLength(kind === 'prose' ? 3 : 2)
      expect(proof.ownedTokens.size).toBe(x.tokens.length - 1)
    }
  }
)

it.each(['prose', 'scripts', 'parts'] as const)(
  'refuses missing whole fonts and incomplete native fences in %s',
  (kind) => {
    const x = anonymousRuledPacket(kind)
    x.tokens.splice(2, 1)
    expect(recoverAnonymousRuled(x, kind)).toBeUndefined()
    const y = anonymousRuledPacket(kind)
    y.rules.pop()
    expect(recoverAnonymousRuled(y, kind)).toBeUndefined()
  }
)

it.each(['white', 'alpha', 'unknown-program', 'not-in-font', 'pose', 'origin', 'graphic'] as const)(
  'refuses the %s source-packet counterexample',
  (change) => {
    const x = anonymousRuledPacket('scripts'),
      O = ruledPacketOPS,
      op = x.context.operators
    if (change === 'white') op.argsArray[op.fnArray.indexOf(O.setFillRGBColor)] = ['#ffffff']
    if (change === 'alpha') {
      op.fnArray.unshift(O.setGState)
      op.argsArray.unshift([['ca', 0]])
    }
    const glyph = op.argsArray[op.fnArray.indexOf(O.showText)][0][0]
    if (change === 'unknown-program') glyph.operatorListId = 'missing-program'
    if (change === 'not-in-font') glyph.isInFont = false
    if (change === 'pose') {
      x.context.content.items[2].transform[4] += 1
      x.tokens[2].rect[0] += 1
      x.tokens[2].rect[2] += 1
    }
    if (change === 'origin')
      x.tokens[2].sourceItem = { pageNumber: 2, index: 2, text: x.tokens[2].text }
    if (change === 'graphic') x.context.nativeEvidenceGraphics.pop()
    const before = structuredClone(x)
    expect(
      proveNativeCompleteRuledSourcePacket(x.tokens, x.rules, x.context, x.table.cropRect)
    ).toBe(false)
    expect(recoverAnonymousRuled(x, 'scripts')).toBeUndefined()
    expect(x).toEqual(before)
  }
)

const { recoverIdentifierRecords, recoverSectionLocalColumns, recoverAdditiveCohortRecords } =
  await import(pathToFileURL(resolve('resources/literature-pdf-sectional-records.mjs')).href)

it('restores omitted native counts and section probabilities with additive totals', () => {
  const t = parse('additive-cohort-counts-with-omitted-records')
  expect(t.unassigned).toEqual([])
  expect(t.grid).toContainEqual(['0', '55 (60)', '33 (39)', '88 (50)', ''])
  expect(t.grid).toContainEqual(['Age groups', '', '', '', '0.07'])
  expect(t.grid).toContainEqual(['CIRS-G⁎', '', '', '', '0.09'])
  expect(t.cells.find((c: { text: string }) => c.text === 'N (%)')).toMatchObject({ colSpan: 3 })
})

it('refuses an empty first header font rather than inventing a part title', () => {
  const x = anonymousRuledPacket('parts')
  x.tokens[1].text = ''
  expect(recoverAnonymousRuled(x, 'parts')).toBeUndefined()
})

it('rejects additive reconstruction when a printed total disagrees', () => {
  const x = fixture('additive-cohort-counts-with-omitted-records')
  x.tokens.find((i: { text: string }) => i.text === '88 (50)').text = '89 (50)'
  expect(recoverAdditiveCohortRecords(x.table, x.tokens, x.rules)).toBeUndefined()
})

it('rejects identifier reconstruction when identifiers repeat', () => {
  const x = fixture('identifier-records-with-omitted-and-combined-rows')
  x.tokens.find((i: { text: string }) => i.text === '27').text = '25'
  expect(recoverIdentifierRecords(x.table, x.tokens, x.rules)).toBeUndefined()
})

it('rejects section reconstruction when a cohort measurement is absent', () => {
  const x = fixture('section-local-columns-with-changing-cohort-counts')
  x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '71 (64)')
  expect(recoverSectionLocalColumns(x.table, x.tokens, x.rules)).toBeUndefined()
})

it('requires native section dividers before changing local columns', () => {
  const x = fixture('section-local-columns-with-changing-cohort-counts')
  expect(recoverSectionLocalColumns(x.table, x.tokens, [])).toBeUndefined()
})

it('does not extend a partial ruled stub without its closing border', () => {
  const x = fixture('ruled-stub-with-sparse-followup-values')
  const closing = Math.max(
    ...x.rules.filter((r: number[]) => r[1] === r[3]).map((r: number[]) => r[1])
  )
  x.rules = x.rules.filter((r: number[]) => r[1] !== closing)
  const t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
  expect(t.cells.find((c: { text: string }) => c.text === 'Coaching Services')?.rowSpan).not.toBe(3)
})

it('requires a table caption before expanding a narrow prose header', () => {
  const x = fixture('open-header-above-narrow-prose-table')
  const t = refineTable(x.table, x.tokens, [], x.notes, x.rules)
  expect(t.grid[0]).not.toEqual(['Toxicity', 'Therapy B/Placebo Dose to Restart Treatment*'])
})

it('preserves all identifier records and bounds sparse ancestors independently', () => {
  const t = parse('identifier-records-with-omitted-and-combined-rows')
  expect(t.grid.slice(2).map((r: string[]) => r[2])).toEqual([
    '03',
    '09',
    '11',
    '16',
    '23',
    '25',
    '27',
    '28',
    '62',
    '63',
    '66',
    '67',
    '69',
    '72',
    '73',
    '77',
    '76',
    '78',
    '81',
    '83'
  ])
  expect(t.unassigned).toEqual([])
  expect(t.cells.find((c: { text: string }) => c.text === 'Site A')).toMatchObject({ rowSpan: 8 })
  expect(t.cells.find((c: { text: string }) => c.text === 'Site B')).toMatchObject({ rowSpan: 12 })
  expect(t.cells.find((c: { text: string }) => c.text === 'Variant Classification')).toMatchObject({
    colSpan: 2
  })
})

it('recovers a missing paired stub span from repeated ruled sections', () => {
  const t = parse('ruled-stub-with-missing-paired-span')
  expect(t.cells.find((c: { text: string }) => c.text === 'Information Services')).toMatchObject({
    rowSpan: 2
  })
})

it('extends a partial ruled stub across sparse followup values', () => {
  const t = parse('ruled-stub-with-sparse-followup-values')
  expect(t.cells.find((c: { text: string }) => c.text === 'Study Info only (N=118)')).toMatchObject(
    { column: 2, colSpan: 1 }
  )
  expect(t.cells.find((c: { text: string }) => c.text === 'Coaching Services')).toMatchObject({
    rowSpan: 3
  })
})

it('keeps two-cohort records aligned after three-cohort sections', () => {
  const t = parse('section-local-columns-with-changing-cohort-counts')
  expect(t.grid[0]).toHaveLength(6)
  expect(t.unassigned).toEqual([])
  expect(t.grid.map((r: string[]) => r.filter(Boolean))).toContainEqual([
    'Median OS, months',
    '23.6',
    '24.1'
  ])
  expect(t.grid.map((r: string[]) => r.filter(Boolean))).toContainEqual([
    'ADL',
    '<100 n = 24',
    '100 n = 125'
  ])
})

it('retains every shifted probability and section sample heading', () => {
  const t = parse('section-local-columns-with-shifted-probabilities')
  expect(t.grid[0]).toHaveLength(5)
  expect(t.unassigned).toEqual([])
  expect(t.grid.map((r: string[]) => r.filter(Boolean))).toContainEqual([
    'Number with TTP event (%)',
    '15 (45)',
    '38 (72)',
    '.005'
  ])
  expect(t.grid.filter((r: string[]) => r.some((s) => s.includes('n =')))).toHaveLength(7)
})

it('recovers a matching section above an identical numeric threshold sequence', () => {
  const t = parse('repeated-numeric-threshold-section-span')
  expect(t.cells.find((c: { text: string }) => c.text === 'With arm dropping')).toMatchObject({
    colSpan: 5
  })
})

it('keeps a regression probability out of a record with no paired estimate', () => {
  const t = parse('probability-span-across-absent-regression-pair')
  const r = t.grid.findIndex((r: string[]) => r[0] === 'Growth pattern')
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === r && c.column === 4)
  ).toMatchObject({ text: '<0.01', rowSpan: 1 })
  expect(t.grid[r + 1].slice(3)).toEqual(['', ''])
})

it('attaches an outdented parenthetical tail to its measured record', () => {
  const t = parse('outdented-parenthetical-record-tail')
  expect(
    t.grid.find((r: string[]) => r[0].endsWith('treatments (oophorectomy)'))?.slice(1)
  ).toEqual(['13 (21.3 %)', '19 (31.7 %)', '32 (26.5 %)', '0.22'])
})
it('keeps an independently underlined cohort title out of the blank stub', () => {
  const t = parse('underlined-single-column-parent')
  expect(t.cells.find((c: { text: string }) => c.text === 'Therapy A Alone')).toMatchObject({
    column: 1,
    colSpan: 1
  })
})
it('separates a complete first record below the native header border', () => {
  const t = parse('native-header-border-through-model-row')
  expect(t.grid).toContainEqual(['Any SAE*', '9 (13.8)', '5 (16.7)', '78 (20.6)', '23 (12.0)'])
})
it('separates a first section below the native header border', () => {
  const t = parse('native-header-border-before-section')
  expect(t.grid).toContainEqual(['AEs associated with discontinuation*', '', '', '', ''])
})
it('recovers both headings above a narrow prose table', () => {
  const t = parse('open-header-above-narrow-prose-table')
  expect(t.grid[0]).toEqual(['Toxicity', 'Therapy B/Placebo Dose to Restart Treatment*'])
  expect(t.unassigned).toEqual([])
})
it('keeps a printed range with its preceding measured label', () => {
  const t = parse('range-tail-assigned-to-following-record')
  expect(t.grid).toContainEqual(['Histologic Grade', '', ''])
  expect(t.grid).toContainEqual(['I', '8 (30%)', '2 (7%)'])
  expect(t.grid).toContainEqual(['Surgery⁎', '', ''])
  expect(t.grid).toContainEqual([
    'FSI: Total Disruption Index (range 0–70)',
    '10.19 (10.7)',
    '15.5 (14.4)'
  ])
})
