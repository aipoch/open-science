/* eslint-disable @typescript-eslint/explicit-function-return-type -- test fixtures */
import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
const { refineTable, seedNativeClosedRecordTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeThreeColumnParameterRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-bounded-text-record-grid.mjs')).href
)
const { recoverNativeCompleteNumericRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-bounded-text-record-grid.mjs')).href
)
const { recoverNativeSixColumnMicrobenchmarkRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeInlineGroupLabels } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

it('recovers unassigned rows in a complete three-column parameter table', () => {
  let index = 0
  const item = (text: string, x: number, y: number, width = 30) => ({
    text,
    rect: [x, y, x + width, y + 8],
    baseline: y + 8,
    height: 8,
    horizontal: true,
    pageNumber: 1,
    index: index++
  })
  const items = [
    item('Parameter', 10, 10),
    item('Value', 110, 10),
    item('Notes', 210, 10),
    item('Existing', 10, 30, 45),
    item('1', 110, 30, 8),
    item('Missing field', 10, 50, 60),
    item('2', 110, 50, 8),
    item('Verified', 210, 50, 40)
  ]
  const rows = [
    { rect: [0, 0, 300, 25], origin: 'model' },
    { rect: [0, 25, 300, 45], origin: 'model' }
  ]
  const cells = [
    {
      row: 0,
      column: 0,
      rowSpan: 1,
      colSpan: 1,
      text: 'Parameter',
      sourceTokens: [items[0]],
      sourceRects: [items[0].rect]
    },
    {
      row: 0,
      column: 1,
      rowSpan: 1,
      colSpan: 1,
      text: 'Value',
      sourceTokens: [items[1]],
      sourceRects: [items[1].rect]
    },
    {
      row: 0,
      column: 2,
      rowSpan: 1,
      colSpan: 1,
      text: 'Notes',
      sourceTokens: [items[2]],
      sourceRects: [items[2].rect]
    },
    {
      row: 1,
      column: 0,
      rowSpan: 1,
      colSpan: 1,
      text: 'Existing',
      sourceTokens: [items[3]],
      sourceRects: [items[3].rect]
    },
    {
      row: 1,
      column: 1,
      rowSpan: 1,
      colSpan: 1,
      text: '1',
      sourceTokens: [items[4]],
      sourceRects: [items[4].rect]
    },
    { row: 1, column: 2, rowSpan: 1, colSpan: 1, text: '', sourceTokens: [], sourceRects: [] }
  ]
  const unassigned = ['Missing field', '2', 'Verified']
  const repairs: string[] = []
  const issues = new Set(['unassigned-source-text'])
  expect(
    recoverNativeThreeColumnParameterRows({
      table: { cropRect: [0, 0, 300, 100], readingRotation: 0 },
      items,
      rows,
      cells,
      baseCells: [],
      columnRects: [
        [0, 0, 100, 100],
        [100, 0, 200, 100],
        [200, 0, 300, 100]
      ],
      headerRows: [0],
      rules: [
        [0, 0, 300, 0],
        [0, 25, 300, 25],
        [0, 100, 300, 100]
      ],
      unassigned,
      issues,
      repairs
    })
  ).toBe(true)
  expect(rows).toHaveLength(3)
  expect(cells.find((cell) => cell.text === 'Missing field')).toMatchObject({
    row: 2,
    column: 0,
    origin: 'source-parameter-row'
  })
  expect(cells.find((cell) => cell.text === 'Verified')).toMatchObject({
    row: 2,
    column: 2
  })
  expect(unassigned).toEqual([])
  expect(issues.has('unassigned-source-text')).toBe(false)
  expect(repairs).toEqual(['native-three-column-parameter-row-recovered'])
})

it('recovers one complete unassigned numeric band in a wide ruled table', () => {
  let index = 0
  const item = (text: string, column: number, y: number) => ({
    text,
    rect: [column * 20 + 1, y, column * 20 + 10, y + 8],
    baseline: y + 8,
    height: 8,
    horizontal: true,
    pageNumber: 1,
    index: index++
  })
  const columns = Array.from({ length: 9 }, (_, column) => [column * 20, column * 20 + 20])
  const columnRects = columns.map(([left, right]) => [left, 0, right, 120])
  const existing = [
    [
      item('1', 1, 20),
      item('2', 2, 20),
      item('3', 3, 20),
      item('4', 4, 20),
      item('5', 5, 20),
      item('6', 6, 20),
      item('7', 7, 20),
      item('8', 8, 20)
    ],
    [
      item('9', 1, 60),
      item('10', 2, 60),
      item('11', 3, 60),
      item('12', 4, 60),
      item('13', 5, 60),
      item('14', 6, 60),
      item('15', 7, 60),
      item('16', 8, 60)
    ]
  ]
  const missing = [
    item('(64,32)', 1, 40),
    item('4.26', 2, 40),
    item('5.38', 3, 40),
    item('6.50', 4, 40),
    item('4.59', 5, 40),
    item('6.10', 6, 40),
    item('7.69', 7, 40),
    item('8.24', 8, 40)
  ]
  const items = [...existing.flat(), ...missing]
  const rows = [
    { rect: [0, 12, 180, 32], origin: 'model' },
    { rect: [0, 52, 180, 72], origin: 'model' }
  ]
  const cells = existing.flatMap((row, rowIndex) => [
    {
      row: rowIndex,
      column: 0,
      rowSpan: 1,
      colSpan: 1,
      text: '',
      sourceItems: [],
      sourceTokens: [],
      sourceRects: []
    },
    ...row.map((source, offset) => ({
      row: rowIndex,
      column: offset + 1,
      rowSpan: 1,
      colSpan: 1,
      text: source.text,
      sourceItems: [source],
      sourceTokens: [source],
      sourceRects: [source.rect]
    }))
  ])
  const unassigned = missing.map((source) => source.text)
  const repairs: string[] = []
  const issues = new Set(['unassigned-source-text'])
  expect(
    recoverNativeCompleteNumericRows({
      table: { cropRect: [0, 0, 180, 100] },
      items,
      rows,
      cells,
      baseCells: [],
      columnRects,
      rules: [
        [0, 0, 180, 0],
        [0, 100, 180, 100]
      ],
      unassigned,
      issues,
      repairs
    })
  ).toBe(true)
  expect(rows).toHaveLength(3)
  expect(cells.filter((cell) => cell.row === 1).map((cell) => cell.text)).toEqual([
    '',
    '(64,32)',
    '4.26',
    '5.38',
    '6.50',
    '4.59',
    '6.10',
    '7.69',
    '8.24'
  ])
  expect(unassigned).toEqual([])
  expect(issues.has('unassigned-source-text')).toBe(false)
  expect(repairs).toEqual(['native-complete-numeric-row-recovered'])
})

it('keeps a partial wide numeric band unassigned', () => {
  const item = (text: string, column: number, y: number) => ({
    text,
    rect: [column * 20 + 1, y, column * 20 + 10, y + 8],
    baseline: y + 8,
    height: 8,
    horizontal: true,
    pageNumber: 1,
    index: column + y * 10
  })
  const columnRects = Array.from({ length: 9 }, (_, column) => [
    column * 20,
    0,
    column * 20 + 20,
    120
  ])
  const peers = [
    [1, 2, 3, 4, 5, 6, 7, 8].map((value, column) => item(String(value), column + 1, 20)),
    [9, 10, 11, 12, 13, 14, 15, 16].map((value, column) => item(String(value), column + 1, 60))
  ]
  const partial = [item('(64,32)', 1, 40), item('4.26', 2, 40), item('5.38', 3, 40)]
  const cells = peers.flatMap((row, rowIndex) => [
    {
      row: rowIndex,
      column: 0,
      rowSpan: 1,
      colSpan: 1,
      text: '',
      sourceItems: [],
      sourceTokens: [],
      sourceRects: []
    },
    ...row.map((source, column) => ({
      row: rowIndex,
      column: column + 1,
      rowSpan: 1,
      colSpan: 1,
      text: source.text,
      sourceItems: [source],
      sourceTokens: [source],
      sourceRects: [source.rect]
    }))
  ])
  const unassigned = partial.map((source) => source.text)
  const repairs: string[] = []
  const issues = new Set(['unassigned-source-text'])
  expect(
    recoverNativeCompleteNumericRows({
      table: { cropRect: [0, 0, 180, 100] },
      items: [...peers.flat(), ...partial],
      rows: [
        { rect: [0, 12, 180, 32], origin: 'model' },
        { rect: [0, 52, 180, 72], origin: 'model' }
      ],
      cells,
      baseCells: [],
      columnRects,
      rules: [
        [0, 0, 180, 0],
        [0, 100, 180, 100]
      ],
      unassigned,
      issues,
      repairs
    })
  ).toBe(false)
  expect(unassigned).toEqual(['(64,32)', '4.26', '5.38'])
  expect(repairs).toEqual([])
})

it('rejects a complete numeric band outside the peer-row interval', () => {
  const item = (text: string, column: number, y: number) => ({
    text,
    rect: [column * 20 + 1, y, column * 20 + 10, y + 8],
    baseline: y + 8,
    height: 8,
    horizontal: true,
    pageNumber: 1,
    index: column + y * 10
  })
  const columnRects = Array.from({ length: 9 }, (_, column) => [
    column * 20,
    0,
    column * 20 + 20,
    120
  ])
  const peers = [
    [1, 2, 3, 4, 5, 6, 7, 8].map((value, column) => item(String(value), column + 1, 20)),
    [9, 10, 11, 12, 13, 14, 15, 16].map((value, column) => item(String(value), column + 1, 60))
  ]
  const trailing = [1, 2, 3, 4, 5, 6, 7, 8].map((value, column) =>
    item(String(value + 16), column + 1, 80)
  )
  const cells = peers.flatMap((row, rowIndex) => [
    {
      row: rowIndex,
      column: 0,
      rowSpan: 1,
      colSpan: 1,
      text: '',
      sourceItems: [],
      sourceTokens: [],
      sourceRects: []
    },
    ...row.map((source, column) => ({
      row: rowIndex,
      column: column + 1,
      rowSpan: 1,
      colSpan: 1,
      text: source.text,
      sourceItems: [source],
      sourceTokens: [source],
      sourceRects: [source.rect]
    }))
  ])
  const unassigned = trailing.map((source) => source.text)
  const repairs: string[] = []
  const issues = new Set(['unassigned-source-text'])
  expect(
    recoverNativeCompleteNumericRows({
      table: { cropRect: [0, 0, 180, 100] },
      items: [...peers.flat(), ...trailing],
      rows: [
        { rect: [0, 12, 180, 32], origin: 'model' },
        { rect: [0, 52, 180, 72], origin: 'model' }
      ],
      cells,
      baseCells: [],
      columnRects,
      rules: [
        [0, 0, 180, 0],
        [0, 100, 180, 100]
      ],
      unassigned,
      issues,
      repairs
    })
  ).toBe(false)
  expect(unassigned).toEqual(trailing.map((source) => source.text))
  expect(repairs).toEqual([])
})

it('rebuilds a complete six-column microbenchmark row set from native lanes', () => {
  let index = 0
  const item = (text: string, column: number, y: number) => ({
    text,
    rect: [column * 10 + 1, y, column * 10 + 8, y + 6],
    baseline: y + 6,
    height: 6,
    horizontal: true,
    pageNumber: 1,
    index: index++
  })
  const columnRects = Array.from({ length: 6 }, (_, column) => [
    column * 10,
    0,
    column * 10 + 10,
    100
  ])
  const header = [item('Hz', 3, 8), item('#Inf.', 4, 8), item('L/M/H', 5, 8)]
  const rows = [
    ['Base-8Hz', '8.045', '484.7', '6.67', '402', '0/0/100'],
    ['Base-5Hz', '7.578', '456.6', '4.40', '265', '0/100/0'],
    ['Base-2Hz', '6.847', '410.8', '1.90', '114', '100/0/0'],
    ['Proposed', '7.301', '438.1', '3.37', '202', '50/38/13']
  ].flatMap((row, rowIndex) => row.map((text, column) => item(text, column, 24 + rowIndex * 12)))
  const items = [...header, ...rows]
  const cells = Array.from({ length: 6 }, (_, column) => ({
    row: 0,
    column,
    rowSpan: 1,
    colSpan: 1,
    text: column === 5 ? '(%)' : '',
    sourceItems: [],
    sourceTokens: [],
    sourceRects: []
  }))
  const unassigned: string[] & { reconciliationItems?: unknown[] } = []
  Object.defineProperty(unassigned, 'reconciliationItems', { value: items })
  const repairs: string[] = []
  const issues = new Set<string>()
  expect(
    recoverNativeSixColumnMicrobenchmarkRows({
      table: {
        cropRect: [0, 0, 60, 100],
        structure: {
          objects: Array.from({ length: 6 }, (_, column) => ({
            label: 'table column',
            rect: [column * 10, 0, column * 10 + 10, 100]
          }))
        }
      },
      cells,
      rows: [{ rect: [0, 0, 60, 20], origin: 'model' }],
      baseCells: [],
      columnRects,
      headerRows: [0],
      rules: [],
      unassigned,
      issues,
      repairs,
      observedRuns: [{}]
    })
  ).toBe(true)
  expect(cells.filter((cell) => cell.row > 0).map((cell) => cell.text)).toEqual(
    rows.map((source) => source.text)
  )
  expect(cells.find((cell) => cell.row === 0 && cell.column === 3)?.text).toBe('Hz')
  expect(cells.find((cell) => cell.row === 0 && cell.column === 5)?.text).toBe('L/M/H')
  expect(repairs).toEqual(['native-six-column-microbenchmark-recovered'])
})

it('recovers native inline group labels without changing leaf values', () => {
  let index = 0
  const item = (text: string, column: number, y: number) => ({
    text,
    rect: [column * 20 + 1, y, column * 20 + 12, y + 8],
    baseline: y + 8,
    height: 8,
    horizontal: true,
    pageNumber: 1,
    index: index++
  })
  const columnRects = Array.from({ length: 5 }, (_, column) => [
    column * 20,
    0,
    column * 20 + 20,
    140
  ])
  const labels = [item('Hopper', 0, 36), item('Blackwell', 0, 84)]
  const bodyRows = [24, 48, 72, 96].map((y, row) =>
    Array.from({ length: 5 }, (_, column) =>
      item(row === 0 ? `a${column}` : `${row}${column}`, column, y)
    )
  )
  const headerItems = Array.from({ length: 5 }, (_, column) => item(`h${column}`, column, 8))
  const cells = [
    ...headerItems.map((source, column) => ({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: source.text,
      sourceItems: [source],
      sourceTokens: [source],
      sourceRects: [source.rect]
    })),
    ...bodyRows.flatMap((row, rowIndex) =>
      row.map((source, column) => ({
        row: rowIndex + 1,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: source.text,
        sourceItems: [source],
        sourceTokens: [source],
        sourceRects: [source.rect]
      }))
    )
  ]
  const rows = Array.from({ length: 5 }, (_, row) => ({
    rect: [0, row * 24, 100, row * 24 + 16],
    origin: 'model'
  }))
  const unassigned: string[] & { reconciliationItems?: unknown[] } = labels.map(
    (label) => label.text
  )
  Object.defineProperty(unassigned, 'reconciliationItems', { value: labels })
  const repairs: string[] = []
  const issues = new Set(['unassigned-source-text'])
  expect(
    recoverNativeInlineGroupLabels({
      table: {
        cropRect: [0, 0, 100, 140],
        structure: {
          objects: [
            { label: 'table', rect: [0, 0, 100, 140] },
            ...columnRects.map((rect) => ({ label: 'table column', rect }))
          ]
        }
      },
      cells,
      rows,
      baseCells: cells.map((cell) => ({ ...cell })),
      columnRects,
      headerRows: [0],
      rules: [
        [0, 0, 100, 0],
        [0, 140, 100, 140]
      ],
      unassigned,
      issues,
      repairs
    })
  ).toBe(true)
  expect(rows).toHaveLength(7)
  expect(cells.filter((cell) => cell.colSpan === 5).map((cell) => cell.text)).toEqual([
    'Hopper',
    'Blackwell'
  ])
  expect(unassigned).toEqual([])
  expect(repairs).toEqual(['native-inline-group-labels-recovered'])
})
const examples = readFileSync(resolve('test/fixtures/native-bounded-literal-records.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const fixture = (kind: string): ReturnType<typeof JSON.parse> =>
  structuredClone(examples.find((f) => f.kind === kind))
const run = (f: ReturnType<typeof fixture>): ReturnType<typeof refineTable> =>
  refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
const chars = (s: string): string => [...s.replace(/\s/gu, '')].sort().join('')
for (const [kind, rows, cols] of [
  ['wrapped-prose-pairs', 8, 2],
  ['headerless-field-pairs', 5, 2],
  ['literal-definition-records', 16, 3],
  ['closed-dimension-fields', 3, 4],
  ['four-stub-scalar-records', 15, 12],
  ['repeated-deviation-records', 24, 10],
  ['paired-interval-records', 13, 7],
  ['complete-estimator-intervals', 12, 7]
] as const) {
  it(`preserves complete physical records and source glyphs in ${kind}`, () => {
    const input = fixture(kind),
      before = structuredClone(input),
      result = run(input)
    expect(result.grid).toHaveLength(rows)
    expect(result.grid.every((r: string[]) => r.length === cols)).toBe(true)
    expect(chars(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
      chars(input.items.map((i: { text: string }) => i.text).join(''))
    )
    expect(result.unassigned).toEqual([])
    const source = result.cells.flatMap((c: { sourceTokens?: unknown[] }) => c.sourceTokens ?? [])
    expect(new Set(source).size).toBe(source.length)
    expect(input).toEqual(before)
  })
}
for (const kind of [
  'wrapped-prose-pairs',
  'headerless-field-pairs',
  'literal-definition-records',
  'closed-dimension-fields',
  'heterogeneous-literal-panels',
  'four-stub-scalar-records',
  'repeated-deviation-records',
  'paired-interval-records'
]) {
  it(`keeps ${kind} independent of source enumeration`, () => {
    const input = fixture(kind),
      expected = run(input).grid
    input.items.reverse()
    input.rules.reverse()
    input.runs.reverse()
    expect(run(input).grid).toEqual(expected)
  })
  it(`refuses unfenced ${kind} ownership`, () => {
    const input = fixture(kind)
    input.rules = []
    const result = run(input)
    expect(
      result.repairs.some((s: string) =>
        /^native-(?:bounded-literal|vertical-wrapped|physical-panel|closed-leaf-complete|repeated-deviation|paired-interval)/u.test(
          s
        )
      )
    ).toBe(false)
  })
}
it('refuses ordinary prose without a literal neighboring table caption', () => {
  const input = fixture('wrapped-prose-pairs')
  input.captions = []
  expect(run(input).repairs).not.toContain('native-bounded-literal-prose-records-recovered')
})
it('retains uncertainty when source prose crosses a independently witnessed gutter', () => {
  const input = fixture('wrapped-prose-pairs'),
    i = input.items.find((i: { text: string }) => i.text === 'XXXXXX')
  i.rect[2] = input.table.cropRect[2] - 1
  expect(run(input).repairs).not.toContain('native-bounded-literal-prose-records-recovered')
})
it('does not inherit a sparse first-stub factor label', () => {
  const result = run(fixture('literal-definition-records'))
  expect(result.grid[3][0]).toBe('')
  expect(result.grid[4][0]).toBe('')
  expect(result.cells.every((c: { rowSpan: number }) => c.rowSpan === 1)).toBe(true)
})
it('does not infer repeated groups if one literal sequence changes', () => {
  const input = fixture('repeated-deviation-records'),
    stub = input.items.filter(
      (i: { rect: number[]; baseline: number }) =>
        i.rect[0] > 160 && i.rect[0] < 170 && i.baseline > 398
    )
  stub[7].text += ' Q'
  expect(run(input).repairs).not.toContain('native-repeated-deviation-source-records-recovered')
})
it('keeps source uncertainty when one scalar witness is absent', () => {
  const input = fixture('four-stub-scalar-records'),
    i = input.items.findIndex(
      (i: { text: string; rect: number[] }) => i.rect[0] > 730 && /^0\.\d+$/u.test(i.text)
    )
  input.items.splice(i, 1)
  expect(run(input).repairs).not.toContain('native-closed-leaf-complete-records-recovered')
})
it('preserves lower literal panel fields through proved column unions', () => {
  const input = fixture('heterogeneous-literal-panels'),
    result = run(input)
  expect(
    result.cells.some(
      (c: { text: string; colSpan: number }) => c.text === '0.668 ± 0.006' && c.colSpan === 2
    )
  ).toBe(true)
  expect(chars(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    chars(input.items.map((i: { text: string }) => i.text).join(''))
  )
  expect(result.unassigned).toEqual([])
})
for (const [kind, rows] of [
  ['boxed-native-field-seed', 11],
  ['captionless-native-deviation-seed', 5]
] as const) {
  it(`restores a detector-missed ${kind} from its complete native frame`, () => {
    const input = fixture(kind),
      frame = {
        ...input.frame,
        sourceTokens: input.items,
        headerTokens: input.frame.headerIndexes?.map((n: number) => input.items[n])
      },
      before = structuredClone(input),
      table = seedNativeClosedRecordTable(frame, input.items, input.rules, 1)
    expect(table).toBeDefined()
    const result = refineTable(table, input.items, input.captions, [], input.rules, input.runs)
    expect(result.grid).toHaveLength(rows)
    expect(result.grid.every((r: string[]) => r.length === 2)).toBe(true)
    expect(result.unassigned).toEqual([])
    expect(chars(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
      chars(input.items.map((i: { text: string }) => i.text).join(''))
    )
    expect(input).toEqual(before)
    expect(frame.caption).toEqual(
      kind === 'captionless-native-deviation-seed' ? undefined : input.captions[0]
    )
  })
  it(`rejects ${kind} when its physical fence is absent`, () => {
    const input = fixture(kind),
      frame = {
        ...input.frame,
        sourceTokens: input.items,
        headerTokens: input.frame.headerIndexes?.map((n: number) => input.items[n])
      }
    expect(seedNativeClosedRecordTable(frame, input.items, [], 1)).toBeUndefined()
  })
}
it('does not create a numerical table from an uncertain mathematical field', () => {
  const input = fixture('boxed-native-field-seed'),
    frame = { ...input.frame, sourceTokens: input.items }
  input.items.find((i: { rect: number[] }) => i.rect[0] > 460).text = 'a = unknown'
  expect(seedNativeClosedRecordTable(frame, input.items, input.rules, 1)).toBeUndefined()
})
it('orders a uniquely raised adjacent literal header without changing its script metadata', () => {
  const input = fixture('closed-dimension-fields'),
    result = run(input),
    cell = result.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 3)
  expect(cell.text).toBe('N(XXXX)')
  expect(cell.textRuns).toEqual([
    { text: 'N', position: 'normal' },
    { text: '(XXXX)', position: 'superscript' }
  ])
  expect(cell.sourceRects.every((r: number[]) => r[1] >= result.cropRect[1])).toBe(true)
})
it('does not expand a raised-header crop into caption-owned text', () => {
  const input = fixture('closed-dimension-fields')
  input.captions[0].rect[3] = 565
  expect(run(input).repairs).not.toContain('native-vertical-wrapped-literal-fields-recovered')
})
it('does not consume an undecodable zero-width literal as a native physical record', () => {
  const input = fixture('wrapped-prose-pairs'),
    i = input.items[3]
  i.rect[2] = i.rect[0]
  expect(run(input).repairs).not.toContain('native-bounded-literal-prose-records-recovered')
})
it('refuses incomplete estimator-interval atoms rather than completing a bracket', () => {
  const input = fixture('complete-estimator-intervals'),
    i = input.items.find((i: { text: string }) => i.text === ']')
  i.text = '?'
  expect(run(input).repairs).not.toContain('native-estimator-interval-fields-recovered')
})
it('trims only the proved closing boundary while retaining every external note diagnostic', () => {
  const input = fixture('closed-body-with-external-note'),
    result = run(input)
  expect(result.grid).toHaveLength(6)
  expect(result.grid[0]).toHaveLength(4)
  expect(result.cropRect[3]).toBeCloseTo(1044.38, 5)
  const note = input.items.filter((i: { rect: number[] }) => i.rect[1] > 1043.88)
  expect(note.length).toBeGreaterThan(0)
  for (const item of note) expect(result.unassigned).toContain(item.text)
  expect(
    result.cells.every((c: { sourceRects: number[][] }) =>
      c.sourceRects.every((r) => r[3] < 1043.88)
    )
  ).toBe(true)
  const before = structuredClone(input),
    changed = structuredClone(input)
  changed.rules = changed.rules.filter((r: number[]) => Math.abs(r[1] - 1043.88) > 0.05)
  expect(run(changed).repairs).not.toContain('native-closed-leaf-body-crop-trimmed')
  expect(input).toEqual(before)
})
