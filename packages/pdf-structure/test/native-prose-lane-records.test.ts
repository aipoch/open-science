import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
type Token = { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean }
const token = (text: string, x: number, y: number, w: number): Token => ({
  text,
  rect: [x, y, x + w, y + 10],
  height: 10,
  baseline: y + 10,
  horizontal: true
})
const input = (): ReturnType<typeof JSON.parse> => ({
  table: {
    id: 'page-7-table-1',
    cropRect: [35, 70, 555, 300],
    structure: {
      objects: [
        ...[
          [0, 110],
          [112, 210],
          [215, 315],
          [320, 520]
        ].map(([a, b]) => ({ label: 'table column', score: 0.9, rect: [a, 10, b, 225] })),
        ...[
          [10, 22],
          [24, 38],
          [50, 95],
          [100, 150],
          [155, 200],
          [202, 225]
        ].map(([a, b]) => ({ label: 'table row', score: 0.9, rect: [0, a, 520, b] }))
      ]
    }
  },
  tokens: [
    token('Published result', 40, 80, 100),
    token('Dominant', 260, 80, 65),
    token('component', 335, 80, 60),
    token('interpretation', 420, 80, 120),
    token('continued', 260, 95, 65),
    ...[115, 175, 235].flatMap((y, n) => [
      token(`Synthetic result ${n}`, 40, y, 200),
      token('Summary', 260, y, 130),
      token('Interpretation of evidence', 420, y, 130),
      token('continues with evidence', 40, y + 15, 200),
      token('continuation', 260, y + 15, 90),
      token('and its documented limits', 420, y + 15, 130),
      token('with final details', 40, y + 30, 200),
      token('remain attached to this record.', 420, y + 30, 130),
      token('final qualification.', 420, y + 45, 110)
    ])
  ],
  captions: [{ lines: ['Table 1: Synthetic prose records.'], rect: [35, 45, 555, 60] }],
  rules: [
    [40, 75, 550, 75],
    [40, 110, 550, 110],
    [40, 298, 550, 298]
  ]
})
it('recovers complete prose lanes and keeps long tails under native paragraph starts', () => {
  const f = input(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(4)
  expect(r.grid[0]).toHaveLength(3)
  expect(r.grid[0][1]).toBe('Dominant component continued')
  expect(r.grid[3][2]).toContain('final qualification.')
  expect(r.unassigned).toEqual([])
})

it('declines a crossing lane or a missing closing frame', async () => {
  const { recoverNativeProseLaneRecords } = await import(
    pathToFileURL(resolve('resources/literature-pdf-native-bounded-text-record-grid.mjs')).href
  )
  const f = input()
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules.slice(0, 2))
  ).toBeUndefined()
  expect(
    recoverNativeProseLaneRecords(
      f.table,
      [...f.tokens, token('Crossing source field', 200, 130, 150)],
      f.captions,
      f.rules
    )
  ).toBeUndefined()
})

const { recoverNativeProseLaneRecords } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-bounded-text-record-grid.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)

// Whole original fonts are drawn cell by cell. The stub may wrap before its
// peer paragraph starts; no lexical rule distinguishes a tail from a record.
const sourceOrdered = (
  columns: 2 | 3 | 4 | 6,
  paired = false,
  below = paired,
  overhang = false,
  following = false,
  scalar = false
): ReturnType<typeof JSON.parse> => {
  const width = columns === 2 ? 310 : columns * 100 + 20
  const viewport = {
    width: 800,
    height: 500,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 500],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 500 - y]
  }
  const items: object[] = []
  const fnArray: number[] = [OPS.dependency, OPS.setFont]
  const argsArray: unknown[] = [['ordinary-font'], ['ordinary-font', 10]]
  const draw = (str: string, x: number, y: number, height = 10): void => {
    items.push({
      str,
      fontName: 'ordinary-font',
      transform: [height, 0, 0, height, x, 490 - y],
      width: (str.length * height) / 2,
      height,
      dir: 'ltr',
      sourceItem: { pageNumber: 7, index: items.length, text: str }
    })
    fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    argsArray.push(
      ['ordinary-font', height],
      null,
      [new Float32Array([1, 0, 0, 1, x, 490 - y])],
      [[...str].map((unicode) => ({ unicode, width: 500, isInFont: true, operatorListId: null }))],
      null
    )
  }
  draw('Table 1: Records.', 20, below ? 230 : 10)
  for (let c = 0; c < columns; c++)
    if (!paired || c % 2 === 0)
      draw(
        overhang && c === 1 ? 'Long explanation heading extended' : `Field ${c}`,
        columns === 2 ? 20 + c * 130 : 20 + c * 100,
        45
      )
  for (let n = 0; n < 3; n++) {
    const y = 75 + n * 48
    for (let c = 0; c < columns; c++) {
      if (paired && n === 2 && c < 2) continue
      const x = columns === 2 ? 20 + c * 130 : 20 + c * 100
      if (scalar) {
        draw(c < 2 ? `Entry_${n}_${c}` : `${n + c}.0`, x, y, c < 2 ? 8 : 10)
        continue
      }
      draw(
        (paired && c % 2) || (columns === 6 && c > 0 && c < 4) ? `${n + c}.0` : `Entry ${n} ${c}`,
        x,
        y
      )
      if (columns === 6 ? c >= 4 : paired ? c % 2 === 0 && n !== 1 : c || n !== 1)
        draw('continued', x, y + 12)
      if (!paired && c === columns - 1) draw('final detail', x, y + 24)
    }
  }
  const rules = (scalar ? [40, 65] : [40, 65, 215]).map((y) => [20, y, width, y])
  const sibling = following
    ? readPdfFixture(resolve('test/fixtures/source-grids/narrative-following-table.jsonl'))
    : undefined
  if (sibling) {
    for (const [text, x, y] of sibling.text) draw(text, x, y)
    rules.push(...sibling.rules)
  }
  for (const [left, y, right] of rules) {
    fnArray.push(OPS.constructPath)
    argsArray.push([
      OPS.stroke,
      [new Float32Array([0, left, 500 - y, 1, right, 500 - y])],
      new Float32Array([left, 500 - y, right, 500 - y])
    ])
  }
  const sourceContent = {
    items,
    styles: { 'ordinary-font': { ascent: 0.8, descent: -0.2, vertical: false } }
  }
  return {
    table: { id: 'page-7-table-1', cropRect: [20, 40, width, 215] },
    tokens: items.map((i) => tableTextToken(i, viewport, 0)),
    captions: [
      {
        page: 7,
        lines: ['Table 1: Records.'],
        rect: [20, below ? 230 : 10, width, below ? 240 : 20]
      },
      ...(sibling ? [sibling.caption] : [])
    ],
    rules,
    context: { operators: { fnArray, argsArray }, viewport, sourceContent }
  }
}

it('recovers narrative records when the competing lower title owns its own native table', () => {
  const f = sourceOrdered(2, false, false, false, true)
  f.table.structure = { objects: [] }
  const before = structuredClone({ tokens: f.tokens, table: f.table, captions: f.captions })
  const r = refineTable(
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
  expect(r.grid).toHaveLength(4)
  expect(r.grid[2][0]).toBe('Entry 1 0')
  expect(r.grid[3][1]).toContain('final detail')
  expect(r.unassigned).toEqual([])
  expect(r.issues).not.toContain('text-crosses-crop-boundary')
  const owned = r.cells.flatMap((c) => c.sourceItems)
  expect(new Set(owned.map((i) => i.index)).size).toBe(owned.length)
  expect(owned.map((i) => i.index).sort((a, b) => a - b)).toEqual(
    f.tokens.filter((i) => i.rect[1] >= 40 && i.rect[3] < 215).map((i) => i.sourceItem.index)
  )
  expect({ tokens: f.tokens, table: f.table, captions: f.captions }).toEqual(before)
  const reversed = refineTable(
    f.table,
    [...f.tokens].reverse(),
    [...f.captions].reverse(),
    [],
    [...f.rules].reverse(),
    [],
    undefined,
    undefined,
    f.context
  )
  expect(reversed.grid).toEqual(r.grid)
})

it.each([
  'absent-frame',
  'unproved-frame',
  'missing-record',
  'non-numeric-record',
  'wrong-caption',
  'intervening-source',
  'omitted-corridor-source'
])('keeps caption ambiguity without a complete following table (%s)', (mutation) => {
  const f = sourceOrdered(2, false, false, false, true)
  if (mutation === 'absent-frame') f.rules = f.rules.filter((r) => r[1] !== 350)
  if (mutation === 'unproved-frame') {
    const ops = f.context.operators
    const last = ops.fnArray.lastIndexOf(OPS.constructPath)
    ops.argsArray[last][1][0][4] -= 10
  }
  if (mutation === 'missing-record') f.tokens = f.tokens.filter((i) => i.text !== '9.0')
  if (mutation === 'non-numeric-record') {
    const item = f.tokens.find((i) => i.text === '9.0')
    item.text = item.sourceItem.text = 'x.0'
    f.context.sourceContent.items[item.sourceItem.index].str = 'x.0'
    const args = f.context.operators.argsArray.find(
      (a) => a?.[0]?.map?.((g) => g.unicode ?? '').join('') === '9.0'
    )
    args[0][0].unicode = 'x'
  }
  if (mutation === 'wrong-caption') f.captions[1].lines = ['Table 2: Other.']
  if (mutation === 'intervening-source') f.tokens.push(token('Unowned line', 20, 242, 90))
  if (mutation === 'omitted-corridor-source') {
    const items = f.context.sourceContent.items
    items.push({
      str: 'Hidden',
      fontName: 'ordinary-font',
      transform: [10, 0, 0, 10, 20, 248],
      width: 30,
      height: 10,
      dir: 'ltr',
      sourceItem: { pageNumber: 7, index: items.length, text: 'Hidden' }
    })
    f.context.operators.fnArray.push(OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    f.context.operators.argsArray.push(
      null,
      [new Float32Array([1, 0, 0, 1, 20, 248])],
      [
        [...'Hidden'].map((unicode) => ({
          unicode,
          width: 500,
          isInFont: true,
          operatorListId: null
        }))
      ],
      null
    )
  }
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
})

it.each([2, 3, 4, 6] as const)(
  'uses complete visible native cell cycles for %i fields',
  (columns) => {
    const f = sourceOrdered(columns)
    const original = structuredClone(f.tokens)
    const r = recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
    expect(r.rows).toHaveLength(4)
    expect(r.columns).toHaveLength(columns)
    expect(r.ownedTokens.size).toBe(f.tokens.length - 1)
    const first = [...r.ownedTokens].filter(
      (i: Token) => i.rect[1] >= r.rows[1][1] && i.rect[3] <= r.rows[1][3]
    )
    expect(first.map((i: Token) => i.text)).toContain('final detail')
    expect(r.preservePhysicalRows).toBe(true)
    expect(f.tokens).toEqual(original)
  }
)

it('retains complete original sources in three independently wrapped prose fields', () => {
  const f = sourceOrdered(3)
  f.table.structure = { objects: [] }
  const before = structuredClone(f.tokens)
  const result = refineTable(
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
  expect(result.grid).toHaveLength(4)
  expect(result.grid[3]).toEqual([
    'Entry 2 0 continued',
    'Entry 2 1 continued',
    'Entry 2 2 continued final detail'
  ])
  expect(result.unassigned).toEqual([])
  expect(result.cells.flatMap((c) => c.sourceItems).sort((a, b) => a.index - b.index)).toEqual(
    before.slice(1).map((i) => i.sourceItem)
  )
  expect(
    result.cells
      .flatMap((c) => c.sourceRects)
      .map(JSON.stringify)
      .sort()
  ).toEqual(
    before
      .slice(1)
      .map((i) => JSON.stringify(i.rect))
      .sort()
  )
  expect(f.tokens).toEqual(before)
})

const openScalar = (): ReturnType<typeof JSON.parse> => {
  const f = sourceOrdered(6, false, false, false, false, true)
  f.table.cropRect = [19, 39, 621, 215]
  f.table.structure = {
    objects: Array.from({ length: 6 }, (_, c) => ({
      label: 'table column',
      rect: [c * 100, 0, (c + 1) * 100, 175]
    }))
  }
  return f
}

it.each(
  ['top', 'bottom', 'both'].flatMap((boundary) =>
    ['native-and-declared', 'native-only', 'declared-only'].map((witness) => ({
      boundary,
      witness
    }))
  )
)(
  'declines a foreign scalar stroke crossing $boundary with $witness evidence',
  ({ boundary, witness }) => {
    const f = openScalar(),
      top = boundary === 'bottom' ? 100 : 30,
      bottom = boundary === 'top' ? 130 : 225,
      before = structuredClone(f.tokens)
    if (witness !== 'native-only') f.rules.push([30, top, 30, bottom])
    if (witness !== 'declared-only') {
      f.context.operators.fnArray.push(OPS.constructPath)
      f.context.operators.argsArray.push([
        OPS.stroke,
        [new Float32Array([0, 30, 500 - top, 1, 30, 500 - bottom])],
        new Float32Array([30, 500 - bottom, 30, 500 - top])
      ])
    }
    expect(
      recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
    ).toBeUndefined()
    expect(f.tokens).toEqual(before)
  }
)

it('retains complete same-baseline scalar records in an existing open-bottom table crop', () => {
  const f = openScalar(),
    before = structuredClone(f.tokens)
  const plan = recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  expect(plan?.rows).toHaveLength(4)
  expect(plan?.columns).toHaveLength(6)
  expect(plan?.cropRect).toEqual(f.table.cropRect)
  const r = refineTable(
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
  expect(r.grid).toHaveLength(4)
  expect(r.grid[2]).toEqual(['Entry_1_0', 'Entry_1_1', '3.0', '4.0', '5.0', '6.0'])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c) => c.sourceItems).sort((a, b) => a.index - b.index)).toEqual(
    before.slice(1).map((i) => i.sourceItem)
  )
  expect(f.tokens).toEqual(before)
})

it.each([
  'incomplete-record',
  'different-baseline',
  'foreign-rule',
  'missing-caption',
  'non-scalar',
  'source-alias',
  'different-label-size',
  'missing-native-rule'
])('declines open scalar recovery for %s', (kind) => {
  const f = openScalar()
  const item = f.tokens.find((i) => i.text === '3.0')
  if (kind === 'incomplete-record') f.tokens.splice(f.tokens.indexOf(item), 1)
  if (kind === 'different-baseline') {
    item.baseline++
    item.rect[1]++
    item.rect[3]++
  }
  if (kind === 'foreign-rule') f.rules.push([150, 120, 180, 120])
  if (kind === 'missing-caption') f.captions = []
  if (kind === 'non-scalar') item.text = item.sourceItem.text = 'unknown'
  if (kind === 'source-alias')
    f.tokens.push({
      ...item,
      rect: [700, 300, 710, 310],
      baseline: 310,
      sourceItem: undefined,
      sourceSegment: { ...item.sourceItem, start: 0, end: item.text.length }
    })
  if (kind === 'different-label-size') f.tokens.find((i) => i.text === 'Entry_1_0').height = 7
  if (kind === 'missing-native-rule') {
    f.context.operators.fnArray.pop()
    f.context.operators.argsArray.pop()
  }
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
})

it.each(['missing-fence', 'source-conflict', 'cross-field-order', 'misaligned-start'])(
  'declines a three-field source cycle with %s',
  (kind) => {
    const f = sourceOrdered(3)
    if (kind === 'missing-fence') f.rules.pop()
    if (kind === 'source-conflict') f.tokens[4].sourceItem = { ...f.tokens[5].sourceItem }
    if (kind === 'cross-field-order') {
      const a = f.tokens.find((i) => i.text === 'Entry 0 1')
      const b = f.tokens.find((i) => i.text === 'Entry 0 2')
      ;[a.sourceItem.index, b.sourceItem.index] = [b.sourceItem.index, a.sourceItem.index]
    }
    if (kind === 'misaligned-start') {
      const i = f.tokens.find((i) => i.text === 'Entry 0 1')
      i.baseline += 1
      i.rect[1] += 1
      i.rect[3] += 1
    }
    expect(
      recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
    ).toBeUndefined()
  }
)

it('retains unequal closed prose/scalar pairs and the complete caption below the frame', () => {
  const f = sourceOrdered(4, true)
  f.table.structure = { objects: [] }
  const result = refineTable(
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
  expect(result.grid).toHaveLength(4)
  expect(result.grid[0]).toEqual(['Field 0', '', 'Field 2', ''])
  expect(result.grid[3]).toEqual(['', '', 'Entry 2 2 continued', '5.0'])
  expect(result.unassigned).toEqual([])
  expect(
    result.cells
      .flatMap((c) => c.sourceRects)
      .map((r) => JSON.stringify(r))
      .sort()
  ).toEqual(
    f.tokens
      .slice(1)
      .map((i) => JSON.stringify(i.rect))
      .sort()
  )
})

it('retains all prose records under an overhanging header with a caption below the frame', () => {
  const f = sourceOrdered(2, false, true, true)
  f.context.operators.fnArray.unshift(OPS.setGState)
  f.context.operators.argsArray.unshift([
    [
      ['CA', 1],
      ['ca', 1]
    ]
  ])
  f.table.structure = { objects: [] }
  const r = refineTable(
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
  expect(r.grid).toHaveLength(4)
  expect(r.grid[0]).toEqual(['Field 0', 'Long explanation heading extended'])
  expect(r.grid[2][0]).toBe('Entry 1 0')
  expect(r.grid[3][1]).toContain('final detail')
  expect(r.cropRect[2]).toBeGreaterThanOrEqual(315)
  expect(r.unassigned).toEqual([])
})

it.each([false, true])(
  'checks transformed filled paint outside the native prose packet (crossing=%s)',
  (crossing) => {
    const f = sourceOrdered(2, false, true, true)
    const { fnArray, argsArray } = f.context.operators
    fnArray.push(OPS.save, OPS.transform, OPS.constructPath, OPS.constructPath, OPS.restore)
    argsArray.push(
      null,
      [0, 1, -1, 0, crossing ? 100 : 650, crossing ? 400 : 100],
      [
        OPS.fill,
        [new Float32Array([0, 0, 0, 1, 10, 0, 1, 10, 10, 1, 0, 10, 4])],
        new Float32Array([0, 0, 10, 10])
      ],
      [OPS.endPath, [null], null],
      null
    )
    const r = recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
    if (crossing) expect(r).toBeUndefined()
    else expect(r.rows).toHaveLength(4)
  }
)

it('declines nonopaque native prose despite complete fonts and rules', () => {
  const f = sourceOrdered(2, false, true, true)
  f.context.operators.fnArray.unshift(OPS.setGState)
  f.context.operators.argsArray.unshift([[['ca', 0.5]]])
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
})

it('requires scalar peers for the six-field wrapped family', () => {
  const f = sourceOrdered(6),
    item = f.tokens.find((i) => i.text === '1.0')
  item.text = 'x.0'
  item.sourceItem.text = 'x.0'
  f.context.sourceContent.items[item.sourceItem.index].str = 'x.0'
  const raw = f.context.operators.argsArray.find(
    (a) => Array.isArray(a?.[0]) && a[0].map((g) => g.unicode ?? '').join('') === '1.0'
  )
  raw[0][0].unicode = 'x'
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
})

it('does not admit an opaque whole raw packet absent from native source content', () => {
  const f = sourceOrdered(4, true)
  f.context.operators.fnArray.push(OPS.showText)
  f.context.operators.argsArray.push([
    [{ unicode: 'X', width: 500, isInFont: true, operatorListId: null }]
  ])
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
})

it('requires runtime program, complete caption and closing fence for the new source cycles', () => {
  const f = sourceOrdered(2)
  expect(recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules.slice(0, 2), f.context)
  ).toBeUndefined()
  expect(
    recoverNativeProseLaneRecords(
      f.table,
      f.tokens,
      [{ ...f.captions[0], lines: ['Table 1:'] }],
      f.rules,
      f.context
    )
  ).toBeUndefined()
})

it.each([
  'white',
  'alpha',
  'unknown-font',
  'Type3',
  'width',
  'orphan',
  'duplicate-origin',
  'changed-origin',
  'missing-font',
  'unproved-rule'
])('refuses %s without mutating native source owners', (mutation) => {
  const f = sourceOrdered(4)
  const ops = f.context.operators
  const text = ops.fnArray.indexOf(OPS.showText)
  if (mutation === 'white') {
    ops.fnArray.unshift(OPS.setFillRGBColor)
    ops.argsArray.unshift(['#ffffff'])
  }
  if (mutation === 'alpha') {
    ops.fnArray.unshift(OPS.setGState)
    ops.argsArray.unshift([[['ca', 0]]])
  }
  if (mutation === 'unknown-font') ops.argsArray[1][0] = 'unbound-font'
  if (mutation === 'Type3') ops.argsArray[text][0][0].operatorListId = 'type3-paint'
  if (mutation === 'width') ops.argsArray[text][0][0].width = 700
  if (mutation === 'orphan')
    ops.argsArray[text][0].push({ unicode: 'x', width: 500, isInFont: true, operatorListId: null })
  if (mutation === 'duplicate-origin') f.tokens[2].sourceItem.index = f.tokens[1].sourceItem.index
  if (mutation === 'changed-origin') f.tokens[2].sourceItem.text = 'other'
  if (mutation === 'missing-font') f.tokens.splice(3, 1)
  if (mutation === 'unproved-rule') {
    ops.fnArray.push(OPS.setDash)
    ops.argsArray.push([[2, 2], 0])
    const path = ops.fnArray.indexOf(OPS.constructPath)
    ops.fnArray.splice(path, 0, OPS.setDash)
    ops.argsArray.splice(path, 0, [[2, 2], 0])
  }
  const before = structuredClone(f.tokens)
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
  expect(f.tokens).toEqual(before)
})
