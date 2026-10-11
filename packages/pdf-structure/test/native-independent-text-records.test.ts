import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { recoverNativeProseLaneRecords } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-bounded-text-record-grid.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)

const closedPairs = (): ReturnType<typeof JSON.parse> => {
  const viewport = {
    width: 500,
    height: 500,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 500],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 500 - y]
  }
  const items: object[] = [],
    fnArray: number[] = [OPS.dependency],
    argsArray: unknown[] = [['font']]
  const draw = (str: string, x: number, baseline: number, size = 10): void => {
    items.push({
      str,
      fontName: 'font',
      transform: [size, 0, 0, size, x, 500 - baseline],
      width: (str.length * size) / 2,
      height: size,
      dir: 'ltr',
      sourceItem: { pageNumber: 3, index: items.length, text: str }
    })
    fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    argsArray.push(
      ['font', size],
      null,
      [new Float32Array([1, 0, 0, 1, x, 500 - baseline])],
      [[...str].map((unicode) => ({ unicode, width: 500, isInFont: true, operatorListId: null }))],
      null
    )
  }
  draw('Table 1: Records.', 20, 20)
  draw('Left', 125, 49.6)
  draw('Right', 325, 49.6)
  for (let n = 0; n < 4; n++) {
    const baseline = 61 + n * 12.6
    if (n !== 3) {
      draw('Kind' + n, 30, baseline)
      draw('Value' + n, 125, baseline)
    }
    draw('Name' + n, 230, baseline)
    draw(n === 1 ? '10' : 'Data' + n, 325, baseline)
    if (n === 1) {
      draw('−', 335, baseline - 3.7, 7)
      draw('2', 338.5, baseline - 3.7, 7)
    }
  }
  const rules = [40, 52.6, 103].map((y) => [20, y, 412.2, y])
  for (let n = 0; n < 5; n++) {
    const y = 40.3 + n * 12.6
    for (const x of [20.2, 22.2, 110, 210, 212, 310, 410, 412]) rules.push([x, y, x, y + 12])
  }
  for (const [x, y, right, bottom] of rules) {
    fnArray.push(OPS.constructPath)
    argsArray.push([
      OPS.stroke,
      [new Float32Array([0, x, 500 - y, 1, right, 500 - bottom])],
      new Float32Array([x, 500 - bottom, right, 500 - y])
    ])
  }
  return {
    table: { id: 'page-3-table-1', cropRect: [20, 39, 412.2, 104], structure: { objects: [] } },
    tokens: items.map((i) => tableTextToken(i, viewport, 0)),
    captions: [{ page: 3, lines: ['Table 1: Records.'], rect: [20, 10, 105, 20] }],
    rules,
    context: {
      operators: { fnArray, argsArray },
      viewport,
      sourceContent: { items, styles: { font: { ascent: 0.8, descent: -0.2, vertical: false } } }
    }
  }
}

it('retains native paired records, literal scripts and a real trailing blank pair', () => {
  const f = closedPairs(),
    original = structuredClone(f.tokens)
  const proof = recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  expect(proof.rows).toHaveLength(5)
  expect(proof.columns).toHaveLength(4)
  expect(proof.spans).toEqual([])
  const table = refineTable(
    f.table,
    f.tokens,
    f.captions,
    [],
    f.rules,
    [],
    undefined,
    undefined,
    f.context
  )
  expect(table.grid[0]).toEqual(['', 'Left', '', 'Right'])
  expect(table.grid[2]).toEqual(['Kind1', 'Value1', 'Name1', '10−2'])
  expect(table.grid[4]).toEqual(['', '', 'Name3', 'Data3'])
  expect(table.unassigned).toEqual([])
  expect(
    table.cells
      .flatMap((c) => c.sourceRects)
      .map((r) => JSON.stringify(r))
      .sort()
  ).toEqual(
    f.tokens
      .slice(1)
      .map((i) => JSON.stringify(i.rect))
      .sort()
  )
  expect(f.tokens).toEqual(original)
})

it('keeps a whole-em lower envelope when an ordinary native font exposes zero metrics', () => {
  const f = closedPairs()
  f.context.sourceContent.styles.font = { ascent: 0, descent: 0, vertical: false }
  const proof = recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  expect(proof.cropRect[3]).toBeCloseTo(108.8)
  expect(f.table.cropRect[3]).toBe(104)
})

it.each([
  'wall',
  'moving-wall',
  'missing-font',
  'detached-script',
  'caption',
  'unknown-font',
  'white',
  'unknown-metrics'
])('requires a complete unchanged paired native proof: %s', (mutation) => {
  const f = closedPairs()
  if (mutation === 'wall') f.rules.splice(12, 1)
  if (mutation === 'moving-wall') {
    f.rules[12][0] += 1
    f.rules[12][2] += 1
  }
  if (mutation === 'missing-font') f.tokens.splice(4, 1)
  if (mutation === 'detached-script') f.tokens.find((i) => i.text === '−').rect[0] += 20
  if (mutation === 'caption') f.captions[0].lines = ['Table 1:']
  if (mutation === 'unknown-font') f.context.operators.argsArray[1][0] = 'unbound'
  if (mutation === 'unknown-metrics') delete f.context.sourceContent.styles.font
  if (mutation === 'white') {
    f.context.operators.fnArray.unshift(OPS.setFillRGBColor)
    f.context.operators.argsArray.unshift(['#ffffff'])
  }
  const original = structuredClone(f.tokens)
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
  expect(f.tokens).toEqual(original)
})
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { collectTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { recoverNativeFencedGroupLabels } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-leaf-record-repair.mjs')).href
)

// Three unequal closed scopes, two complete peers per physical baseline and
// sparse centered owners. The first source lane has one owner per record.
const sparseScopedPeers = (variant = ''): ReturnType<typeof JSON.parse> => {
  const viewport = {
    width: 500,
    height: 350,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 350],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 350 - y]
  }
  const items: ReturnType<typeof JSON.parse>[] = []
  const operators = { fnArray: [OPS.dependency, OPS.setLineWidth], argsArray: [['font'], [0.5]] }
  const draw = (str: string, x: number, baseline: number, size = 10): void => {
    items.push({
      str,
      fontName: 'font',
      transform: [size, 0, 0, size, x, 350 - baseline],
      width: (str.length * size) / 2,
      height: size,
      dir: 'ltr',
      sourceItem: { pageNumber: 3, index: items.length, text: str }
    })
    operators.fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      ['font', size],
      null,
      [new Float32Array([1, 0, 0, 1, x, 350 - baseline])],
      [
        [...str].map((unicode) => ({
          unicode,
          fontChar: unicode,
          originalCharCode: unicode.codePointAt(0),
          width: 500,
          isInFont: true,
          operatorListId: null
        }))
      ],
      null
    )
  }
  draw('Table 1: Paired records.', 20, 15)
  for (const [s, x] of [
    ['Key', 30],
    ['Source', 100],
    ['Model', 200],
    ['Score', 400]
  ] as const)
    draw(s, x, 45)
  draw('Measure', 290, 38)
  draw('& value', 290, 49)
  const groups = [
    [66, 78, 90],
    [106, 118, 130, 142],
    [158, 170, 182, 194, 206]
  ]
  groups.forEach((rows, n) => {
    const center = (rows[0] + rows.at(-1)!) / 2
    draw('G' + n, 30, center + (variant === 'moved stub' && n === 1 ? 6 : 0))
    draw('M', 200, center)
    draw('s', 205, center + 1.5, 7.5)
    if (variant === 'unknown script' && n === 1) draw('x', 210, center + 1.5, 7.5)
    if (n) draw('T' + n, 100, center)
    rows.forEach((y, r) => {
      if (!n) draw('T' + r, 100, y)
      if (variant === 'missing record' && n === 1 && r === 1) return
      draw('q', 290, y)
      draw('of ' + r, variant === 'cross gutter' && n === 1 && r === 1 ? 375 : 300, y)
      draw('1.' + r, 400, y)
    })
  })
  const paths = [
    [20, 30, 460, 30],
    [20, 55, 460, 55],
    [20, 94, 460, 94],
    [20, 146, 460, 146],
    [20, 210, 460, 210],
    [270, 174, 460, 174]
  ]
  for (const [x, y, right, bottom] of paths) {
    if (variant === 'missing fence' && y === 94) continue
    const start = variant === 'partial false group' && y === 94 ? 270 : x
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, start, 350 - y, 1, right, 350 - bottom])],
      new Float32Array([start, 350 - bottom, right, 350 - y])
    ])
  }
  const paint = new Map(),
    rules = collectTableRules(operators, viewport, paint)
  const content = { items, styles: { font: { ascent: 0.8, descent: -0.2, vertical: false } } }
  const context = {
    operators,
    viewport,
    content,
    sourceContent: content,
    rulePaintBounds: paint,
    nativeEvidenceGraphics: [...paint.values()].map((r) => ({
      kind: 'path',
      rect: r.map((v: number, n: number) => {
        const size = n % 2 ? 350 : 500,
          expanded = v + (n === 0 ? -0.25 : n === 2 ? 0.25 : 0)
        return (
          ((n < 2 ? Math.floor((expanded / size) * 256) : Math.ceil((expanded / size) * 256) + 1) *
            size) /
          256
        )
      })
    }))
  }
  return {
    tokens: items.map((i) => tableTextToken(i, viewport, 0)),
    context,
    rules,
    captions: [{ page: 3, lines: ['Table 1: Paired records.'], rect: [20, 5, 135, 15] }],
    table: {
      id: 'page-3-table-1',
      cropRect: [20, 25, 460, 215],
      structure: {
        objects: [
          ...[20, 80, 180, 270, 380].map((x, n) => ({
            label: 'table column',
            score: 1,
            rect: [x - 20, 0, [80, 180, 270, 380, 460][n] - 20, 190]
          })),
          ...[25, 55, 94, 146].map((y, n) => ({
            label: 'table row',
            score: 1,
            rect: [0, y - 25, 440, [55, 94, 146, 215][n] - 25]
          })),
          { label: 'table column header', score: 1, rect: [0, 0, 440, 30] }
        ]
      }
    }
  }
}

const sparseLateResult = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> => {
  const r = refineTable(
    f.table,
    f.tokens,
    f.captions,
    [],
    f.rules,
    [],
    undefined,
    f.context.rulePaintBounds,
    f.context
  )
  const candidate = {
    ...r,
    page: 3,
    caption: f.captions[0],
    sourceViewport: { width: 500, height: 350, scale: 1 }
  }
  if (f.decorate) f.decorate(candidate)
  return recoverNativeFencedGroupLabels(
    candidate,
    f.tokens,
    f.captions,
    f.rules,
    [],
    f.context.rulePaintBounds,
    f.context.nativeEvidenceGraphics,
    f.context
  )
}

it('recovers unequal sparse scopes after actual refinement without merging complete peer records', () => {
  const f = sparseScopedPeers(),
    tokens = structuredClone(f.tokens),
    r = sparseLateResult(f)
  expect(r?.grid).toHaveLength(13)
  expect(
    r.cells.filter((c) => c.column === 0 && c.row > 0).map((c) => [c.row, c.rowSpan, c.text])
  ).toEqual([
    [1, 3, 'G0'],
    [4, 4, 'G1'],
    [8, 5, 'G2']
  ])
  expect(
    r.cells.filter((c) => c.column === 1 && c.row > 0).map((c) => [c.row, c.rowSpan, c.text])
  ).toEqual([
    [1, 1, 'T0'],
    [2, 1, 'T1'],
    [3, 1, 'T2'],
    [4, 4, 'T1'],
    [8, 5, 'T2']
  ])
  expect(
    r.cells
      .filter((c) => c.column === 2 && c.row > 0)
      .every((c) => c.textRuns?.[1].position === 'subscript' && c.textRuns[1].text === 's')
  ).toBe(true)
  expect(
    r.cells
      .flatMap((c) => c.sourceItems)
      .map((o) => o.index)
      .sort((a, b) => a - b)
  ).toEqual(
    f.tokens
      .slice(1)
      .map((i) => i.sourceItem.index)
      .sort((a, b) => a - b)
  )
  expect(f.tokens).toEqual(tokens)
})

it('preserves exact rich donor and table metadata in the sparse projection', () => {
  const f = sparseScopedPeers()
  f.decorate = (table: ReturnType<typeof JSON.parse>): void => {
    table.privateMetadata = { tag: 'preserve' }
    for (const c of table.cells.filter((c) => c.column === 2 && c.textRuns)) {
      c.privateMetadata = { tag: 'donor' }
      c.textRuns[1].privateMetadata = { tag: 'script' }
    }
  }
  const r = sparseLateResult(f)
  expect(r.privateMetadata).toEqual({ tag: 'preserve' })
  for (const c of r.cells.filter((c) => c.column === 2 && c.row > 0)) {
    expect(c.privateMetadata).toEqual({ tag: 'donor' })
    expect(c.textRuns[1].privateMetadata).toEqual({ tag: 'script' })
  }
})

it.each([
  'moved stub',
  'missing record',
  'cross gutter',
  'missing fence',
  'partial false group',
  'unknown script'
])('requires complete original sparse scope geometry: %s', (variant) => {
  const f = sparseScopedPeers(variant),
    before = structuredClone(f.tokens)
  expect(sparseLateResult(f)).toBeUndefined()
  expect(f.tokens).toEqual(before)
})

it.each([
  'raw font',
  'raw position',
  'white paint',
  'paint witness',
  'missing font',
  'source alias',
  'origin alias',
  'malformed font',
  'unknown split metadata',
  'foreign diagnostic',
  'foreign unassigned',
  'cropped owner'
])('requires the unchanged sparse whole-font packet and donors: %s', (variant) => {
  const f = sparseScopedPeers(),
    ops = f.context.operators
  if (variant === 'raw font') ops.argsArray[ops.fnArray.indexOf(OPS.setFont)][0] = 'unbound'
  if (variant === 'raw position') ops.argsArray[ops.fnArray.indexOf(OPS.setTextMatrix)][0][4] += 1
  if (variant === 'white paint') {
    ops.fnArray.unshift(OPS.setFillRGBColor)
    ops.argsArray.unshift(['#ffffff'])
  }
  if (variant === 'paint witness') f.context.nativeEvidenceGraphics[0].rect[0] += 2
  if (variant === 'missing font') f.tokens.splice(15, 1)
  if (variant === 'source alias') f.tokens[9].sourceToken = structuredClone(f.tokens[9])
  if (variant === 'origin alias') f.tokens[9].sourceItem.index = f.tokens[8].sourceItem.index
  if (variant === 'malformed font') f.tokens[9].rect[0] = NaN
  if (variant === 'unknown split metadata')
    f.decorate = (table: ReturnType<typeof JSON.parse>): void => {
      const cell = table.cells.find((c) => c.column === 1 && c.row > 0 && c.sourceTokens.length > 1)
      cell.privateMetadata = { owner: 'must not split' }
    }
  if (variant === 'foreign diagnostic')
    f.decorate = (table: ReturnType<typeof JSON.parse>): void => {
      table.issues.push('foreign-source')
    }
  if (variant === 'foreign unassigned')
    f.decorate = (table: ReturnType<typeof JSON.parse>): void => {
      table.unassigned.push('unowned source')
    }
  if (variant === 'cropped owner')
    f.decorate = (table: ReturnType<typeof JSON.parse>): void => {
      table.clipped.push('cropped source')
    }
  const before = structuredClone(f.tokens)
  expect(sparseLateResult(f)).toBeUndefined()
  expect(f.tokens).toEqual(before)
})

// A whole-font composite label and three complete row-major prose records.
// The detector isolates the last continuation as an extra blank-key row.
const compositeHeaderProse = (): ReturnType<typeof JSON.parse> => {
  const viewport = {
    width: 450,
    height: 400,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 400],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 400 - y]
  }
  const items: ReturnType<typeof JSON.parse>[] = [],
    operators = { fnArray: [OPS.dependency, OPS.setLineWidth], argsArray: [['font'], [0.5]] }
  const op = (code: number, args: unknown): void => {
    operators.fnArray.push(code)
    operators.argsArray.push(args as ReturnType<typeof JSON.parse>)
  }
  const draw = (str: string, x: number, baseline: number): void => {
    items.push({
      str,
      fontName: 'font',
      transform: [10, 0, 0, 10, x, 400 - baseline],
      width: str.length * 5,
      height: 10,
      dir: 'ltr',
      sourceItem: { pageNumber: 3, index: items.length, text: str }
    })
    op(OPS.setFont, ['font', 10])
    op(OPS.beginText, null)
    op(OPS.setTextMatrix, [new Float32Array([1, 0, 0, 1, x, 400 - baseline])])
    op(OPS.showText, [
      [...str].map((unicode) => ({
        unicode,
        fontChar: unicode,
        originalCharCode: unicode.codePointAt(0),
        width: 500,
        isInFont: true,
        operatorListId: null
      }))
    ])
    op(OPS.endText, null)
  }
  draw('Table 1: Records.', 20, 20)
  draw('Key (', 22, 52)
  draw('q', 47, 52)
  draw(')', 52, 52)
  draw('Meaning', 96, 52)
  draw('Relation', 208, 52)
  draw('Outcome', 310, 52)
  for (let n = 0; n < 3; n++) {
    const y = 74 + n * 26
    draw(['Alpha', 'Bravo', 'Delta'][n], 22, y)
    draw('First term', 96, y)
    draw('detail', 96, y + 12)
    draw('Peer term', 208, y)
    draw('Result', 310, y)
    if (n === 2) draw('detail', 310, y + 12)
  }
  for (const y of [40, 58, 146])
    op(OPS.constructPath, [
      OPS.stroke,
      [new Float32Array([0, 20, 400 - y, 1, 410, 400 - y])],
      new Float32Array([20, 400 - y, 410, 400 - y])
    ])
  const paint = new Map(),
    rules = collectTableRules(operators, viewport, paint)
  const content = { items, styles: { font: { ascent: 0.8, descent: -0.2, vertical: false } } }
  return {
    table: {
      id: 'page-3-table-1',
      cropRect: [18, 39, 411, 149],
      rowCount: 5,
      columnCount: 4,
      structure: {
        objects: [
          ...[39, 58, 88, 114, 132].map((y, n) => ({
            label: 'table row',
            score: 1,
            rect: [0, y - 39, 393, [58, 88, 114, 132, 149][n] - 39]
          })),
          ...[18, 76, 190, 290].map((x, n) => ({
            label: 'table column',
            score: 1,
            rect: [x - 18, 0, [76, 190, 290, 411][n] - 18, 110]
          })),
          { label: 'table column header', score: 1, rect: [0, 0, 393, 19] }
        ]
      }
    },
    tokens: items.map((i) => tableTextToken(i, viewport, 0)),
    captions: [{ page: 3, lines: ['Table 1: Records.'], rect: [20, 10, 105, 20] }],
    rules,
    context: {
      operators,
      viewport,
      sourceContent: content,
      content,
      rulePaintBounds: paint,
      nativeEvidenceGraphics: [...paint.values()].map((r) => ({
        kind: 'path',
        rect: r.map(
          (v: number, n: number) =>
            ((n < 2
              ? Math.floor((v / (n % 2 ? 400 : 450)) * 256)
              : Math.ceil((v / (n % 2 ? 400 : 450)) * 256) + 1) *
              (n % 2 ? 400 : 450)) /
            256
        )
      }))
    }
  }
}

it('keeps a final prose continuation with its complete record below a composite whole-font header', () => {
  const f = compositeHeaderProse(),
    before = structuredClone(f.tokens)
  const r = refineTable(
    f.table,
    f.tokens,
    f.captions,
    [],
    f.rules,
    [],
    undefined,
    f.context.rulePaintBounds,
    f.context
  )
  expect(r.grid).toEqual([
    ['Key (q)', 'Meaning', 'Relation', 'Outcome'],
    ['Alpha', 'First term detail', 'Peer term', 'Result'],
    ['Bravo', 'First term detail', 'Peer term', 'Result'],
    ['Delta', 'First term detail', 'Peer term', 'Result detail']
  ])
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .flatMap((c) => c.sourceRects)
      .map((r) => JSON.stringify(r))
      .sort()
  ).toEqual(
    f.tokens
      .slice(1)
      .map((i) => JSON.stringify(i.rect))
      .sort()
  )
  expect(f.tokens).toEqual(before)
})

it.each([
  'missing packet',
  'unknown font',
  'white paint',
  'alpha',
  'raw position',
  'foreign raw text',
  'partial peer',
  'source alias',
  'literal mismatch'
])('refuses a composite prose header without complete raw source closure: %s', (variant) => {
  const f = compositeHeaderProse(),
    ops = f.context.operators
  if (variant === 'missing packet') delete f.context.content
  if (variant === 'unknown font') ops.argsArray[ops.fnArray.indexOf(OPS.setFont)][0] = 'unbound'
  if (variant === 'white paint' || variant === 'alpha') {
    ops.fnArray.unshift(variant === 'white paint' ? OPS.setFillRGBColor : OPS.setGState)
    ops.argsArray.unshift(variant === 'white paint' ? ['#ffffff'] : [[['ca', 0]]])
  }
  if (variant === 'raw position') {
    const matrix = ops.argsArray[ops.fnArray.indexOf(OPS.setTextMatrix)][0]
    matrix[4] += 100
  }
  if (variant === 'foreign raw text') {
    ops.fnArray.push(OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    ops.argsArray.push(
      null,
      [new Float32Array([1, 0, 0, 1, 100, 280])],
      [
        [
          {
            unicode: 'x',
            fontChar: 'x',
            originalCharCode: 120,
            width: 500,
            isInFont: true,
            operatorListId: null
          }
        ]
      ],
      null
    )
  }
  if (variant === 'partial peer') f.tokens.splice(12, 1)
  if (variant === 'source alias') f.tokens[2].sourceToken = structuredClone(f.tokens[2])
  if (variant === 'literal mismatch') f.tokens[2].sourceItem.text = 'different'
  const snapshot = (): ReturnType<typeof JSON.parse> => ({
    ...f,
    context: {
      ...f.context,
      viewport: { ...f.context.viewport, convertToViewportPoint: undefined }
    }
  })
  const before = structuredClone(snapshot())
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
  expect(snapshot()).toEqual(before)
})

const centeredGroups = (): ReturnType<typeof JSON.parse> => {
  const f = compositeHeaderProse(),
    content = f.context.content,
    ops = f.context.operators
  content.items = []
  ops.fnArray = [OPS.dependency, OPS.setLineWidth]
  ops.argsArray = [['font'], [0.5]]
  const draw = (str: string, x: number, y: number): void => {
    content.items.push({
      str,
      fontName: 'font',
      transform: [10, 0, 0, 10, x, 400 - y],
      width: str.length * 5,
      height: 10,
      dir: 'ltr',
      sourceItem: { pageNumber: 3, index: content.items.length, text: str }
    })
    ops.fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    ops.argsArray.push(
      ['font', 10],
      null,
      [new Float32Array([1, 0, 0, 1, x, 400 - y])],
      [
        [...str].map((unicode) => ({
          unicode,
          fontChar: unicode,
          originalCharCode: unicode.codePointAt(0),
          width: 500,
          isInFont: true,
          operatorListId: null
        }))
      ],
      null
    )
  }
  draw('Table 1: Records.', 20, 20)
  draw('Group', 22, 52)
  draw('Method', 96.001, 52)
  draw('Score', 208, 52)
  for (let n = 0; n < 6; n++) {
    const y = 74 + Math.floor(n / 3) * 62 + (n % 3) * 18
    if (n % 3 === 1) draw(n < 3 ? 'Alpha' : 'Bravo', 22, y)
    draw('Kind' + n, 96, y)
    draw(String(11 + n), 208, y)
  }
  for (const y of [40, 58, 124, 186]) {
    ops.fnArray.push(OPS.constructPath)
    ops.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, 20, 400 - y, 1, 270, 400 - y])],
      new Float32Array([20, 400 - y, 270, 400 - y])
    ])
  }
  const paint = new Map()
  f.rules = collectTableRules(ops, f.context.viewport, paint)
  f.context.rulePaintBounds = paint
  f.context.nativeEvidenceGraphics = [...paint.values()].map((r) => ({
    kind: 'path',
    rect: r.map(
      (v: number, n: number) =>
        ((n < 2
          ? Math.floor((v / (n % 2 ? 400 : 450)) * 256)
          : Math.ceil((v / (n % 2 ? 400 : 450)) * 256) + 1) *
          (n % 2 ? 400 : 450)) /
        256
    )
  }))
  f.tokens = content.items.map((i) => tableTextToken(i, f.context.viewport, 0))
  f.table = {
    id: 'page-3-table-1',
    cropRect: [18, 39, 272, 188],
    rowCount: 6,
    columnCount: 3,
    structure: {
      objects: [
        ...[58, 82, 100, 124, 144, 162].map((y, n) => ({
          label: 'table row',
          score: 1,
          rect: [0, y - 39, 254, [82, 100, 124, 144, 162, 188][n] - 39]
        })),
        ...[18, 76, 190].map((x, n) => ({
          label: 'table column',
          score: 1,
          rect: [x - 18, 0, [76, 190, 272][n] - 18, 149]
        })),
        { label: 'table column header', score: 1, rect: [0, 19, 254, 85] }
      ]
    }
  }
  return f
}

const groupCandidate = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> => {
  const r = refineTable(
    f.table,
    f.tokens,
    f.captions,
    [],
    f.rules,
    [],
    undefined,
    f.context.rulePaintBounds,
    f.context
  )
  // The existing late producer supplies canonical caption/page metadata after
  // refine, with the unchanged original context rather than repaired tokens.
  return {
    ...r,
    page: 3,
    caption: f.captions[0],
    sourceViewport: { width: 450, height: 400, scale: 1 }
  }
}

const groupedProducer = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> => {
  const table = groupCandidate(f)
  return (
    recoverNativeFencedGroupLabels(
      table,
      f.tokens,
      f.captions,
      f.rules,
      [],
      f.context.rulePaintBounds,
      f.context.nativeEvidenceGraphics,
      f.context
    ) ?? table
  )
}

it('projects two independently fenced centered group labels over their three complete records', () => {
  const f = centeredGroups(),
    candidate = groupCandidate(f),
    r = groupedProducer(f)
  expect(
    candidate.cells
      .filter((c) => c.column === 0 && c.row > 0 && c.text)
      .map((c) => [c.row, c.rowSpan])
  ).toEqual([
    [2, 1],
    [5, 1]
  ])
  expect(
    recoverNativeFencedGroupLabels(
      candidate,
      f.tokens,
      f.captions,
      f.rules,
      [],
      f.context.rulePaintBounds,
      f.context.nativeEvidenceGraphics,
      { operators: f.context.operators, viewport: f.context.viewport }
    )
  ).toBeUndefined()
  expect(
    r.cells
      .filter((c) => c.column === 0 && c.row > 0 && c.text)
      .map((c) => [c.row, c.rowSpan, c.text])
  ).toEqual([
    [1, 3, 'Alpha'],
    [4, 3, 'Bravo']
  ])
  expect(r.grid.map((row) => row[0])).toEqual(['Group', 'Alpha', '', '', 'Bravo', '', ''])
  expect(
    r.cells
      .flatMap((c) => c.sourceRects)
      .map((r) => JSON.stringify(r))
      .sort()
  ).toEqual(
    f.tokens
      .slice(1)
      .map((i) => JSON.stringify(i.rect))
      .sort()
  )
  expect(r.cells.filter((c) => c.column > 0 || c.row === 0)).toEqual(
    candidate.cells.filter((c) => c.column > 0 || c.row === 0)
  )
  for (const key of ['cropRect', 'caption', 'notes', 'issues', 'unassigned'])
    expect(r[key]).toEqual(candidate[key])
})

it.each([
  'missing packet',
  'raw position',
  'white paint',
  'foreign raw text',
  'source alias',
  'missing fence',
  'incomplete caption',
  'blank metadata',
  'noncloneable metadata'
])('keeps centered labels unchanged without complete group closure: %s', (variant) => {
  const f = centeredGroups(),
    table = groupCandidate(f),
    ops = f.context.operators
  if (variant === 'missing packet') delete f.context.content
  if (variant === 'raw position') ops.argsArray[ops.fnArray.indexOf(OPS.setTextMatrix)][0][4] += 100
  if (variant === 'white paint') {
    ops.fnArray.unshift(OPS.setFillRGBColor)
    ops.argsArray.unshift(['#ffffff'])
  }
  if (variant === 'foreign raw text') {
    ops.fnArray.push(OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    ops.argsArray.push(
      null,
      [new Float32Array([1, 0, 0, 1, 100, 280])],
      [
        [
          {
            unicode: 'x',
            fontChar: 'x',
            originalCharCode: 120,
            width: 500,
            isInFont: true,
            operatorListId: null
          }
        ]
      ],
      null
    )
  }
  if (variant === 'source alias') f.tokens[2].sourceToken = structuredClone(f.tokens[2])
  if (variant === 'missing fence') f.rules.splice(2, 1)
  if (variant === 'incomplete caption') table.caption = { ...table.caption, lines: ['Table 1:'] }
  if (variant === 'blank metadata')
    table.cells.find((c) => c.row === 1 && c.column === 0).extra = 'keep'
  if (variant === 'noncloneable metadata') table.extra = (): void => {}
  const before = table.cells.map((c) => ({ ...c, sourceTokens: [...c.sourceTokens] }))
  const grid = structuredClone(table.grid)
  expect(
    recoverNativeFencedGroupLabels(
      table,
      f.tokens,
      f.captions,
      f.rules,
      [],
      f.context.rulePaintBounds,
      f.context.nativeEvidenceGraphics,
      f.context
    )
  ).toBeUndefined()
  expect(table.cells).toEqual(before)
  expect(table.grid).toEqual(grid)
})

const firstRecordProse = (): ReturnType<typeof JSON.parse> => {
  const f = centeredGroups(),
    content = f.context.content,
    ops = f.context.operators
  content.items = []
  ops.fnArray = [OPS.dependency, OPS.setLineWidth]
  ops.argsArray = [['font'], [0.5]]
  const draw = (str: string, x: number, y: number, size = 10): void => {
    content.items.push({
      str,
      fontName: 'font',
      transform: [size, 0, 0, size, x, 400 - y],
      width: (str.length * size) / 2,
      height: size,
      dir: 'ltr',
      sourceItem: { pageNumber: 3, index: content.items.length, text: str }
    })
    ops.fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    ops.argsArray.push(
      ['font', size],
      null,
      [new Float32Array([1, 0, 0, 1, x, 400 - y])],
      [
        [...str].map((unicode) => ({
          unicode,
          fontChar: unicode,
          originalCharCode: unicode.codePointAt(0),
          width: 500,
          isInFont: true,
          operatorListId: null
        }))
      ],
      null
    )
  }
  draw('Table 1: Records.', 20, 20)
  const xs = [22, 85, 150, 215, 280, 345]
  for (const [c, text] of ['Key', 'Role', 'Agent', 'Idea', 'Trend', 'Place'].entries())
    draw(text, xs[c], 52)
  for (let n = 0; n < 3; n++) {
    const y = 74 + n * 34
    draw('g', xs[0], y)
    draw(['a', 'b', 'c'][n], xs[0] + 5, y + 1, 6)
    for (const [c, text] of ['term-', 'peer', 'idea', 'trend', 'zone'].entries())
      draw(text, xs[c + 1], y)
    draw('detail', xs[1], y + 14)
    if (n === 0) draw('more', xs[3], y + 14)
    draw('change', xs[4], y + 14)
  }
  for (const y of [40, 58, 170]) {
    ops.fnArray.push(OPS.constructPath)
    ops.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, 20, 400 - y, 1, 400, 400 - y])],
      new Float32Array([20, 400 - y, 400, 400 - y])
    ])
  }
  const paint = new Map()
  f.rules = collectTableRules(ops, f.context.viewport, paint)
  f.context.rulePaintBounds = paint
  f.context.nativeEvidenceGraphics = [...paint.values()].map((r) => ({
    kind: 'path',
    rect: r.map(
      (v: number, n: number) =>
        ((n < 2
          ? Math.floor((v / (n % 2 ? 400 : 450)) * 256)
          : Math.ceil((v / (n % 2 ? 400 : 450)) * 256) + 1) *
          (n % 2 ? 400 : 450)) /
        256
    )
  }))
  f.tokens = content.items.map((i) => tableTextToken(i, f.context.viewport, 0))
  f.table = {
    id: 'page-3-table-1',
    cropRect: [18, 39, 410, 172],
    rowCount: 4,
    columnCount: 6,
    structure: {
      objects: [
        ...[39, 58, 94, 128].map((y, n) => ({
          label: 'table row',
          score: 1,
          rect: [0, y - 39, 392, [58, 83, 128, 172][n] - 39]
        })),
        ...[18, 75, 140, 205, 270, 335].map((x, n) => ({
          label: 'table column',
          score: 1,
          rect: [x - 18, 0, [75, 140, 205, 270, 335, 410][n] - 18, 133]
        })),
        { label: 'table column header', score: 1, rect: [0, 0, 392, 19] }
      ]
    }
  }
  return f
}

it('attaches three simultaneous first-record continuations through the actual refiner', () => {
  const f = firstRecordProse(),
    old = refineTable(
      f.table,
      f.tokens,
      f.captions,
      [],
      f.rules,
      [],
      undefined,
      f.context.rulePaintBounds
    ),
    r = refineTable(
      f.table,
      f.tokens,
      f.captions,
      [],
      f.rules,
      [],
      undefined,
      f.context.rulePaintBounds,
      f.context
    )
  expect(old.unassigned).toEqual(['detail', 'more', 'change'])
  expect(r.grid[1]).toEqual(['ga', 'term-detail', 'peer', 'idea more', 'trend change', 'zone'])
  expect(r.unassigned).toEqual([])
  expect(r.cells.filter((c) => c.row !== 1 || ![1, 3, 4].includes(c.column))).toEqual(
    old.cells.filter((c) => c.row !== 1 || ![1, 3, 4].includes(c.column))
  )
  expect(r.cropRect).toEqual(old.cropRect)
  expect(
    r.cells
      .flatMap((c) => c.sourceRects)
      .map(JSON.stringify)
      .sort()
  ).toEqual(
    f.tokens
      .slice(1)
      .map((i) => JSON.stringify(i.rect))
      .sort()
  )
})

const { recoverNativeFirstRecordContinuations } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-leaf-record-repair.mjs')).href
)

it.each([
  'missing packet',
  'unknown font',
  'glyph',
  'raw position',
  'white paint',
  'foreign text',
  'baseline',
  'gutter',
  'next record',
  'literal',
  'opaque run',
  'duplicate unassigned',
  'foreign origin',
  'foreign token origin',
  'scripted target',
  'noncloneable metadata'
])('refuses first-record continuation ownership without complete evidence: %s', (variant) => {
  const f = firstRecordProse(),
    table = refineTable(
      f.table,
      f.tokens,
      f.captions,
      [],
      f.rules,
      [],
      undefined,
      f.context.rulePaintBounds
    ),
    ops = f.context.operators
  if (variant === 'missing packet') delete f.context.content
  if (variant === 'unknown font') ops.argsArray[ops.fnArray.indexOf(OPS.setFont)][0] = 'unknown'
  if (variant === 'glyph') ops.argsArray[ops.fnArray.indexOf(OPS.showText)][0][0].isInFont = false
  if (variant === 'raw position') ops.argsArray[ops.fnArray.indexOf(OPS.setTextMatrix)][0][4] += 100
  if (variant === 'white paint') {
    ops.fnArray.unshift(OPS.setFillRGBColor)
    ops.argsArray.unshift(['#ffffff'])
  }
  if (variant === 'foreign text') {
    ops.fnArray.push(OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    ops.argsArray.push(
      null,
      [new Float32Array([1, 0, 0, 1, 100, 280])],
      [
        [
          {
            unicode: 'x',
            fontChar: 'x',
            originalCharCode: 120,
            width: 500,
            isInFont: true,
            operatorListId: null
          }
        ]
      ],
      null
    )
  }
  if (variant === 'baseline') f.tokens.find((i) => i.text === 'more').baseline += 2
  if (variant === 'gutter') f.tokens.find((i) => i.text === 'more').rect[2] = 285
  if (variant === 'next record') f.tokens.find((i) => i.text === 'more').rect[3] = 100
  if (variant === 'literal') table.cells.find((c) => c.row === 1 && c.column === 3).text = 'other'
  if (variant === 'opaque run') {
    const c = table.cells.find((c) => c.row === 1 && c.column === 3)
    c.textRuns = [{ text: c.text, position: 'normal', extra: 'preserve' }]
  }
  if (variant === 'duplicate unassigned') table.unassigned[1] = table.unassigned[0]
  if (variant === 'foreign origin')
    table.cells.find((c) => c.row === 1 && c.column === 3).sourceItems[0].index = 0
  if (variant === 'foreign token origin')
    table.cells.find((c) => c.row === 1 && c.column === 3).sourceTokens[0].sourceItem = {
      pageNumber: 3,
      index: 0,
      text: 'idea'
    }
  if (variant === 'scripted target') {
    const c = table.cells.find((c) => c.row === 1 && c.column === 3)
    c.textRuns = [{ text: c.text, position: 'superscript' }]
  }
  if (variant === 'noncloneable metadata') table.extra = (): void => {}
  const grid = structuredClone(table.grid),
    cells = structuredClone(table.cells)
  expect(
    recoverNativeFirstRecordContinuations(table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
  expect(table.grid).toEqual(grid)
  expect(table.cells).toEqual(cells)
})

it('preserves normal rich runs and cloneable cell metadata when appending proved continuations', () => {
  const f = firstRecordProse(),
    table = refineTable(
      f.table,
      f.tokens,
      f.captions,
      [],
      f.rules,
      [],
      undefined,
      f.context.rulePaintBounds
    )
  const targets = table.cells.filter((c) => c.row === 1 && [1, 3, 4].includes(c.column))
  for (const c of targets) {
    c.textRuns = [{ text: c.text, position: 'normal' }]
    c.extra = { retain: ['literal', 3] }
  }
  const before = structuredClone(table)
  const proof = recoverNativeFirstRecordContinuations(
    table,
    f.tokens,
    f.captions,
    f.rules,
    f.context
  )
  expect(proof?.replacements).toHaveLength(3)
  for (const { cell, replacement } of proof.replacements) {
    expect(replacement.textRuns).toEqual([{ text: replacement.text, position: 'normal' }])
    expect(replacement.extra).toEqual(cell.extra)
  }
  expect(table).toEqual(before)
})

const { recoverNativeTextRecordGrid } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-text-record-grid.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/native-independent-text-records.jsonl'))

const scriptedFixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/native-scripted-independent-records.jsonl'))

it('retains independently measured records when uniquely attached scripts touch the next font box', () => {
  const x = scriptedFixture(),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(4)
  expect(r.grid.map((row: string[]) => row[0])).toEqual(['Item #', '4', '5', '6'])
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})

it.each([
  'missing script',
  'detached script',
  'overlapping normal lines',
  'excessive script overlap',
  'only two peers',
  'non-indexed stub',
  'header/body overlap',
  'foreign footer ink',
  'unmatched double stroke',
  'crossing opening from outside',
  'crossing closing from outside'
])('does not infer scripted record ownership from incomplete evidence: %s', (variant) => {
  const x = scriptedFixture()
  const normals = x.items.filter(
    (i: { height: number; baseline: number }) => i.height > 10 && i.baseline > 180
  )
  const scripts = x.items.filter((i: { height: number }) => i.height < 10)
  if (variant === 'missing script') x.items.splice(x.items.indexOf(scripts[0]), 1)
  if (variant === 'detached script') scripts[0].rect[0] += 2
  if (variant === 'overlapping normal lines')
    normals.find((i: { text: string }) => i.text === '5').rect[1] = 190
  if (variant === 'excessive script overlap') scripts[0].rect[3] += 1
  if (variant === 'only two peers')
    x.items = x.items.filter((i: { baseline: number }) => i.baseline < 220)
  if (variant === 'non-indexed stub')
    normals.find((i: { text: string }) => i.text === '5').text = 'Other'
  if (variant === 'header/body overlap') x.items[0].rect[3] = 180
  if (variant === 'foreign footer ink')
    x.items.push({
      text: 'X',
      rect: [90, 228, 100, 233],
      height: 5,
      baseline: 233,
      horizontal: true
    })
  if (variant === 'unmatched double stroke') {
    x.rules.at(-1)[1] += 0.8
    x.rules.at(-1)[3] += 0.8
  }
  if (variant === 'crossing opening from outside')
    x.items.push({
      text: 'Foreign',
      rect: [90, 150, 120, 160],
      height: 10,
      baseline: 150,
      horizontal: true
    })
  if (variant === 'crossing closing from outside')
    x.items.push({
      text: 'Foreign',
      rect: [90, 230, 120, 245],
      height: 15,
      baseline: 245,
      horizontal: true
    })
  expect(recoverNativeTextRecordGrid(x.table, x.items, x.captions, x.rules)).toBeUndefined()
})

it('recovers an omitted independently printed pair through the full refiner', () => {
  const x = fixture(),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid).toEqual([
    ['Entry', 'Description'],
    ['Alpha', 'Source A'],
    ['Beta', 'Source B'],
    ['Gamma', 'Source C'],
    ['Delta', 'Source D']
  ])
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((b: number[]) => JSON.stringify(b))
      .sort()
  ).toEqual(x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})

it.each([
  'caption',
  'closing',
  'missing pair',
  'crossing source',
  'overlapping font boxes',
  'different font',
  'foreign line',
  'internal separator'
])('requires complete independent source ownership: %s', (variant) => {
  const x = fixture()
  if (variant === 'caption') x.captions = []
  if (variant === 'closing') x.rules.pop()
  if (variant === 'missing pair') x.items.splice(5, 1)
  if (variant === 'crossing source') x.items[4].rect[2] = 140
  if (variant === 'overlapping font boxes') x.items[4].rect[1] = 45
  if (variant === 'different font') x.items[4].height = 20
  if (variant === 'foreign line')
    x.items.push({
      text: 'Independent paragraph',
      rect: [60, 76, 200, 86],
      height: 10,
      baseline: 86,
      horizontal: true
    })
  if (variant === 'internal separator') x.rules.push([0, 67, 260, 67])
  expect(
    recoverNativeTextRecordGrid(x.table, x.items, x.captions, x.rules),
    variant
  ).toBeUndefined()
})

it('keeps a uniquely owned script with its normal baseline record', () => {
  const x = fixture()
  x.items.push({ text: 'x', rect: [175, 61, 180, 68], height: 7, baseline: 68, horizontal: true })
  const r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(5)
  expect(
    r.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 1)?.sourceRects
  ).toContainEqual([175, 61, 180, 68])
})

const fourLeafFixture = (): ReturnType<typeof JSON.parse> => {
  const x = fixture()
  for (const i of x.items) if (i.rect[0] > 75) i.rect = [180, i.rect[1], 245, i.rect[3]]
  for (const [y, a, b] of [
    [25, 'Count', 'Total'],
    [50, '11', '31'],
    [70, '12', '32'],
    [90, '13', '33'],
    [110, '14', '34']
  ] as const) {
    x.items.push(
      { text: a, rect: [70, y - 10, 100, y], height: 10, baseline: y, horizontal: true },
      { text: b, rect: [120, y - 10, 150, y], height: 10, baseline: y, horizontal: true }
    )
  }
  return x
}

const groupedParameterFixture = (): ReturnType<typeof JSON.parse> => {
  const x = fixture()
  x.items[0].text = 'Parameter'
  x.items[1].text = 'Value'
  for (let n = 3; n < x.items.length; n += 2) x.items[n].text = String(n + 20)
  x.rules.push([0, 75, 260, 75])
  return x
}

it('preserves complete parameter records on both sides of a native group divider', () => {
  const x = groupedParameterFixture(),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(recoverNativeTextRecordGrid(x.table, x.items, x.captions, x.rules)?.rows).toHaveLength(5)
  expect(r.grid).toHaveLength(5)
  expect(r.grid.slice(1).map((row: string[]) => row[0])).toEqual([
    'Alpha',
    'Beta',
    'Gamma',
    'Delta'
  ])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})

it.each(['crossing divider', 'single record band', 'prose values', 'different header'])(
  'rejects incomplete independent parameter group evidence: %s',
  (variant) => {
    const x = groupedParameterFixture()
    if (variant === 'crossing divider') x.rules.at(-1)[1] = x.rules.at(-1)[3] = 65
    if (variant === 'single record band') x.rules.at(-1)[1] = x.rules.at(-1)[3] = 55
    if (variant === 'prose values')
      for (let n = 3; n < x.items.length; n += 2) x.items[n].text = 'Another paragraph'
    if (variant === 'different header') x.items[0].text = 'Entry'
    expect(recoverNativeTextRecordGrid(x.table, x.items, x.captions, x.rules)).toBeUndefined()
  }
)

it('proves four complete source lanes when prose generated phantom model columns', () => {
  const x = fourLeafFixture(),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid).toEqual([
    ['Entry', 'Count', 'Total', 'Description'],
    ['Alpha', '11', '31', 'Source A'],
    ['Beta', '12', '32', 'Source B'],
    ['Gamma', '13', '33', 'Source C'],
    ['Delta', '14', '34', 'Source D']
  ])
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((b: number[]) => JSON.stringify(b))
      .sort()
  ).toEqual(x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})

it.each(['missing header', 'missing value', 'overlapping lanes'])(
  'rejects incomplete four-lane proof: %s',
  (variant) => {
    const x = fourLeafFixture()
    if (variant === 'missing header') x.items.splice(10, 1)
    if (variant === 'missing value') x.items.splice(12, 1)
    if (variant === 'overlapping lanes') x.items[12].rect[2] = 135
    expect(recoverNativeTextRecordGrid(x.table, x.items, x.captions, x.rules)).toBeUndefined()
  }
)
