import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { collectTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { nativePageTextPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { resolveTableCellMerges } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-merges.mjs')).href
)
const {
  populateTableCellText,
  recoverDenseNumericColumnRects,
  recoverDenseNumericContinuationRows,
  recoverDenseGroupedHeaderSpans,
  reconcileFragmentedCountHeaders
} = await import(pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href)

const token = (text: string, rect: number[]): object => ({
  text,
  rect,
  baseline: rect[3],
  height: rect[3] - rect[1],
  horizontal: true
})

type TextCell = {
  row: number
  column: number
  rowSpan: number
  colSpan: number
  rect: number[]
  origin: string
  items: object[]
  text?: string
}

const textCell = (
  row: number,
  column: number,
  rect: number[],
  origin = 'model-grid'
): TextCell => ({
  row,
  column,
  rowSpan: 1,
  colSpan: 1,
  rect,
  origin,
  items: []
})

it('rebuilds shifted dense metric cuts from repeated two-stub numeric rows', () => {
  const columnRects = Array.from({ length: 17 }, (_, column) => [
    column * 20,
    0,
    (column + 1) * 20,
    100
  ])
  const rows = [
    { rect: [0, 0, 340, 20] },
    { rect: [0, 20, 340, 40] },
    { rect: [0, 40, 340, 60] },
    { rect: [0, 60, 340, 80] }
  ]
  const items = rows.slice(1).flatMap((row, index) => {
    const baseline = (row.rect[1] + row.rect[3]) / 2
    return [
      token(`Model-${index}`, [2, baseline - 5, 12, baseline + 5]),
      token(index % 2 ? 'MT' : 'ST', [22, baseline - 5, 28, baseline + 5]),
      ...Array.from({ length: 15 }, (_, value) => {
        const left = 42 + value * 20
        return token(`${index + value + 1}.0`, [left, baseline - 5, left + 8, baseline + 5])
      })
    ]
  })
  // Shift two model cuts so the old geometry would merge neighboring values.
  columnRects[10][0] += 8
  columnRects[11][2] -= 8
  const repaired = recoverDenseNumericColumnRects({ items, rows, columnRects, headerRows: [0] })
  expect(repaired).toBeDefined()
  expect(repaired).toHaveLength(17)
  expect(
    repaired?.every(
      (rect, index) => rect[0] < rect[2] && (index === 0 || rect[0] >= repaired[index - 1][2])
    )
  ).toBe(true)
})

it('reassigns a fused numeric baseline to the neighboring dense row', () => {
  const rows = [
    { rect: [0, 0, 160, 20] },
    { rect: [0, 20, 160, 40] },
    { rect: [0, 40, 160, 60] },
    { rect: [0, 60, 160, 80] }
  ]
  const columnRects = Array.from({ length: 8 }, (_, column) => [
    column * 20,
    0,
    (column + 1) * 20,
    80
  ])
  const cells = rows.flatMap((row, rowIndex) =>
    columnRects.map((rect, column) => ({
      row: rowIndex,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [rect[0], row.rect[1], rect[2], row.rect[3]],
      items: []
    }))
  )
  const sourceItem = {
    pageNumber: 1,
    index: 42,
    text: '0.70 1.04'
  }
  const first = {
    text: '0.70',
    horizontal: true,
    baseline: 48,
    height: 10,
    rect: [40, 42, 59, 52],
    sourceItem
  }
  const second = {
    text: '1.04',
    horizontal: true,
    baseline: 48,
    height: 10,
    rect: [60, 42, 79, 52],
    sourceItem
  }
  const assignments = new Map([
    [first, cells.find((cell) => cell.row === 3 && cell.column === 2)],
    [second, cells.find((cell) => cell.row === 3 && cell.column === 3)]
  ])
  const repairs: string[] = []
  const recovered = recoverDenseNumericContinuationRows({
    items: [first, second],
    cells,
    rows,
    columnRects,
    headerRows: [0],
    assignments,
    ambiguousAssignments: new Set(),
    repairs
  })
  expect(recovered).toBe(1)
  expect(assignments.get(first)?.row).toBe(2)
  expect(assignments.get(second)?.row).toBe(2)
  expect(repairs).toContain('dense-numeric-continuation-row-reassigned')
})

it('reassigns split single-value baselines only with a numbered dense stub', () => {
  const rows = [
    { rect: [0, 0, 160, 20] },
    { rect: [0, 20, 160, 40] },
    { rect: [0, 40, 160, 60] },
    { rect: [0, 60, 160, 80] }
  ]
  const columnRects = Array.from({ length: 8 }, (_, column) => [
    column * 20,
    0,
    (column + 1) * 20,
    80
  ])
  const cells = rows.flatMap((row, rowIndex) =>
    columnRects.map((rect, column) => ({
      row: rowIndex,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [rect[0], row.rect[1], rect[2], row.rect[3]],
      items: []
    }))
  )
  const make = (
    text: string,
    column: number
  ): {
    text: string
    horizontal: boolean
    baseline: number
    height: number
    rect: number[]
    sourceItem: { pageNumber: number; index: number; text: string }
  } => ({
    text,
    horizontal: true,
    baseline: 48,
    height: 10,
    rect: [column * 20 + 2, 42, column * 20 + 10, 52],
    sourceItem: { pageNumber: 1, index: column + 10, text }
  })
  const stub = make('1', 1)
  const anchors = [4, 5, 6, 7].map((column) => make(`${column}.0`, column))
  const split = [make('0.70', 2), make('1.04', 3)]
  const assignments = new Map([
    [stub, cells.find((cell) => cell.row === 2 && cell.column === 1)],
    ...anchors.map((item) => [
      item,
      cells.find((cell) => cell.row === 2 && cell.column === Number(item.text[0]))
    ]),
    [split[0], cells.find((cell) => cell.row === 3 && cell.column === 2)],
    [split[1], cells.find((cell) => cell.row === 3 && cell.column === 3)]
  ])
  const repairs: string[] = []
  expect(
    recoverDenseNumericContinuationRows({
      items: [stub, ...anchors, ...split],
      cells,
      rows,
      columnRects,
      headerRows: [0],
      assignments,
      ambiguousAssignments: new Set(),
      repairs
    })
  ).toBeGreaterThanOrEqual(2)
  expect(assignments.get(split[0])?.row).toBe(2)
  expect(assignments.get(split[1])?.row).toBe(2)
  expect(repairs).toContain('dense-numeric-baseline-row-reassigned')
})

function denseGroupedHeaderFixture(): {
  cells: (Omit<TextCell, 'origin' | 'items'> & { text: string; sourceRects?: number[][] })[]
  headerRows: number[]
} {
  const leaves = Array.from({ length: 15 }, (_, index) => {
    const column = index + 2,
      rect = [column * 30, 20, (column + 1) * 30, 40]
    return {
      row: 1,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect,
      text: ['SR↑0.5', 'Sim↑', 'RI↑'][index % 3],
      sourceRects: [rect]
    }
  })
  const labels = ['BDP', 'BDQ', 'BPQ', 'DPQ', 'BDPQ']
  const parents = labels.map((text, group) => {
    const center = (group * 3 + 3.5) * 30
    return {
      row: 0,
      column: [2, 5, 9, 12, 15][group],
      rowSpan: 1,
      colSpan: group === 4 ? 2 : 3,
      rect: [center - 10, 0, center + 10, 20],
      text,
      sourceRects: [[center - 10, 0, center + 10, 20]]
    }
  })
  return {
    cells: [
      { row: 0, column: 0, rowSpan: 2, colSpan: 1, rect: [0, 0, 30, 40], text: 'Model' },
      { row: 0, column: 1, rowSpan: 2, colSpan: 1, rect: [30, 0, 60, 40], text: 'T' },
      ...parents,
      { row: 0, column: 8, rowSpan: 1, colSpan: 1, rect: [240, 0, 270, 20], text: '' },
      ...leaves
    ],
    headerRows: [0, 1]
  }
}

it('rebuilds shifted dense grouped metric parent spans from printed three-leaf groups', () => {
  const fixture = denseGroupedHeaderFixture()
  const issues = new Set(['conflicting-spanning-cells', 'unresolved-spanning-cells'])
  const repairs: string[] = []
  expect(
    recoverDenseGroupedHeaderSpans({
      cells: fixture.cells,
      headerRows: fixture.headerRows,
      issues,
      repairs
    })
  ).toBe(5)
  expect(
    fixture.cells
      .filter((cell) => cell.row === 0 && cell.text)
      .sort((a, b) => a.column - b.column)
      .slice(2)
      .map((cell) => [cell.column, cell.colSpan, cell.text])
  ).toEqual([
    [2, 3, 'BDP'],
    [5, 3, 'BDQ'],
    [8, 3, 'BPQ'],
    [11, 3, 'DPQ'],
    [14, 3, 'BDPQ']
  ])
  expect(issues.size).toBe(0)
  expect(repairs).toContain('dense-grouped-header-spans-recovered')
  const secondRepairs: string[] = []
  expect(
    recoverDenseGroupedHeaderSpans({
      cells: fixture.cells,
      headerRows: fixture.headerRows,
      issues,
      repairs: secondRepairs
    })
  ).toBe(0)
  expect(secondRepairs).toEqual([])
})

it.each(['non-three-leaf-pattern', 'parent-source-center-outside-group'])(
  'leaves dense grouped headers unchanged without strict source proof: %s',
  (variant) => {
    const fixture = denseGroupedHeaderFixture()
    if (variant === 'non-three-leaf-pattern')
      fixture.cells.find((cell) => cell.row === 1)!.text = 'Value'
    else {
      const parent = fixture.cells.find((cell) => cell.text === 'BPQ')!
      parent.sourceRects = [[0, 0, 10, 20]]
    }
    const before = fixture.cells.map((cell) => ({
      row: cell.row,
      column: cell.column,
      colSpan: cell.colSpan
    }))
    const repairs: string[] = []
    expect(
      recoverDenseGroupedHeaderSpans({
        cells: fixture.cells,
        headerRows: fixture.headerRows,
        issues: new Set(['conflicting-spanning-cells']),
        repairs
      })
    ).toBe(0)
    expect(
      fixture.cells.map((cell) => ({ row: cell.row, column: cell.column, colSpan: cell.colSpan }))
    ).toEqual(before)
    expect(repairs).toEqual([])
  }
)

function denseNumericFixture({
  bodyRows = 4,
  columns = 17,
  valuesPerRow = columns - 2
}: { bodyRows?: number; columns?: number; valuesPerRow?: number } = {}): {
  cells: TextCell[]
  items: object[]
  rows: { rect: number[] }[]
  columnRects: number[][]
} {
  const columnRects = Array.from({ length: columns }, (_, column) => [
    column * 20,
    0,
    (column + 1) * 20,
    (bodyRows + 1) * 20
  ])
  const rows = Array.from({ length: bodyRows + 1 }, (_, row) => ({
    rect: [0, row * 20, columns * 20, (row + 1) * 20]
  }))
  const cells = rows.flatMap((row, rowIndex) =>
    columnRects.map((rect, column) =>
      textCell(rowIndex, column, [rect[0], row.rect[1], rect[2], row.rect[3]])
    )
  )
  const items = rows.slice(1).flatMap((row, rowIndex) => {
    const baseline = (row.rect[1] + row.rect[3]) / 2
    return [
      token(`Model-${rowIndex}`, [2, baseline - 5, 12, baseline + 5]),
      token('ST', [22, baseline - 5, 28, baseline + 5]),
      ...Array.from({ length: valuesPerRow }, (_, value) => {
        const left = 42 + value * 20
        return token(`${rowIndex + value + 1}.0`, [left, baseline - 5, left + 8, baseline + 5])
      })
    ]
  })
  return { cells, items, rows, columnRects }
}

it('populates every leaf from a complete dense two-stub table', () => {
  const fixture = denseNumericFixture()
  const issues = new Set(['overlapping-predicted-columns'])
  const repairs: string[] = []
  const unassigned = populateTableCellText({
    ...fixture,
    pageItems: fixture.items,
    headerRows: [0],
    rules: [],
    bottom: 100,
    issues,
    repairs
  })
  expect(unassigned).toEqual([])
  expect(fixture.cells.find((cell) => cell.row === 1 && cell.column === 9)?.text).toBe('8.0')
  expect(fixture.cells.find((cell) => cell.row === 1 && cell.column === 16)?.text).toBe('15.0')
  expect(repairs).toContain('source-dense-numeric-columns-recovered')
})

it('splits a fused numeric source run through populated cells', () => {
  const cells = Array.from({ length: 16 }, (_, index) => {
    const row = Math.floor(index / 8)
    const column = index % 8
    return textCell(row, column, [column * 20, row * 20, (column + 1) * 20, (row + 1) * 20])
  })
  // Leave the fused run ambiguous to the normal owner pass; the numeric
  // fallback below must prove the contiguous two-cell sequence.
  cells[8].rect = [-100, 20, -1, 40]
  cells[14].rect = [120, 20, 140, 40]
  cells[15].rect = [140, 20, 160, 40]
  const items = [token('Model', [-95, 25, -85, 35]), token('0.60 1.31', [120, 25, 160.5, 35])]
  const issues = new Set<string>()
  const repairs: string[] = []
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems: items,
    rows: [{ rect: [0, 0, 160, 20] }, { rect: [0, 20, 160, 40] }],
    columnRects: Array.from({ length: 8 }, (_, column) => [column * 20, 0, (column + 1) * 20, 40]),
    headerRows: [0],
    rules: [],
    bottom: 40,
    issues,
    repairs
  })
  expect(unassigned).toEqual([])
  expect(cells.find((cell) => cell.row === 1 && cell.column === 6)?.text).toBe('0.60')
  expect(cells.find((cell) => cell.row === 1 && cell.column === 7)?.text).toContain('1.31')
  expect(
    repairs.some(
      (repair) =>
        repair === 'wide-source-run-split' || repair === 'unassigned-dense-numeric-run-recovered'
    )
  ).toBe(true)
})

it.each([
  ['short table', denseNumericFixture({ columns: 7, valuesPerRow: 5 }), undefined],
  ['incomplete row', denseNumericFixture({ valuesPerRow: 14 }), undefined],
  ['too few repeated rows', denseNumericFixture({ bodyRows: 2 }), undefined]
])('does not infer dense cuts for a %s', (_name, fixture, expected) => {
  expect(
    recoverDenseNumericColumnRects({
      items: fixture.items,
      rows: fixture.rows,
      columnRects: fixture.columnRects,
      headerRows: [0]
    })
  ).toBe(expected)
})

it.each([
  ['7', '7'],
  ['Group', 'Group'],
  ['Group A', 'Group']
])('keeps %s cell text from hiding an unowned %s token', (assigned, unowned) => {
  const cells = [textCell(0, 0, [0, 0, 50, 20]), textCell(0, 1, [50, 0, 100, 20])]
  const items = [token(assigned, [5, 5, 35, 15]), token(unowned, [45, 5, 55, 15])]
  const issues = new Set<string>()
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems: items,
    rows: [{ rect: [0, 0, 100, 20] }],
    columnRects: [
      [0, 0, 50, 20],
      [50, 0, 100, 20]
    ],
    headerRows: [],
    rules: [],
    bottom: 20,
    issues,
    repairs: []
  })
  expect(cells.map((cell) => cell.text)).toEqual([assigned, ''])
  expect(unassigned).toEqual([unowned])
  expect(issues).toContain('unassigned-source-text')
})

it('keeps a split confidence interval tail with the preceding estimate', () => {
  const cells = [
    textCell(0, 0, [0, 0, 50, 35]),
    textCell(0, 1, [50, 0, 100, 35]),
    textCell(1, 0, [0, 15, 50, 55]),
    textCell(1, 1, [50, 15, 100, 55])
  ]
  const rows = [{ rect: [0, 0, 100, 35] }, { rect: [0, 15, 100, 55] }]
  const items = [token('Estimate (–2 to', [60, 5, 95, 15]), token('–3)', [60, 20, 80, 30])]
  const issues = new Set<string>()
  const repairs: string[] = []
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems: items,
    rows,
    columnRects: [
      [0, 0, 50, 100],
      [50, 0, 100, 100]
    ],
    headerRows: [],
    rules: [],
    bottom: 60,
    issues,
    repairs
  })
  expect(unassigned).toEqual([])
  expect(cells[1].text).toBe('Estimate (–2 to –3)')
  expect(repairs).toContain('confidence-interval-tail-recovered')
})

it('reconciles repeated count headers split at a model column boundary', () => {
  const cells = [
    { ...textCell(0, 0, [0, 0, 20, 20]), text: '' },
    { ...textCell(0, 1, [20, 0, 40, 20]), text: '(n' },
    { ...textCell(0, 2, [40, 0, 60, 20]), text: 'Anastrozole 1 mg = 49)' },
    { ...textCell(0, 3, [60, 0, 80, 20]), text: '(n' },
    { ...textCell(0, 4, [80, 0, 100, 20]), text: 'Tamoxifen 20 mg = 50)' },
    { ...textCell(1, 0, [0, 20, 20, 40]), text: '' },
    { ...textCell(1, 1, [20, 20, 40, 40]), text: 'n' },
    { ...textCell(1, 2, [40, 20, 60, 40]), text: '(%)' },
    { ...textCell(1, 3, [60, 20, 80, 40]), text: 'n' },
    { ...textCell(1, 4, [80, 20, 100, 40]), text: '(%)' }
  ]
  const issues = new Set(['span-conflicts-with-source-columns'])
  const repairs: string[] = []
  expect(reconcileFragmentedCountHeaders({ cells, issues, repairs })).toBe(2)
  expect(cells.filter((cell) => cell.row === 0)).toEqual([
    expect.objectContaining({ row: 0, column: 0, colSpan: 1, text: '' }),
    expect.objectContaining({
      row: 0,
      column: 1,
      colSpan: 2,
      rect: [20, 0, 60, 20],
      text: 'Anastrozole 1 mg (n = 49)'
    }),
    expect.objectContaining({
      row: 0,
      column: 3,
      colSpan: 2,
      rect: [60, 0, 100, 20],
      text: 'Tamoxifen 20 mg (n = 50)'
    })
  ])
  expect(issues).toEqual(new Set())
  expect(repairs).toContain('fragmented-treatment-header-reconciled')
})

it('recovers a missing time-point record beside a continuation fragment', () => {
  const cells = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 4 }, (_, column) =>
      textCell(row, column, [
        column * 50,
        row === 0 ? 0 : row === 1 ? 20 : 42,
        (column + 1) * 50,
        row === 0 ? 20 : row === 1 ? 46 : 70
      ])
    )
  ).flat()
  const rows = [{ rect: [0, 0, 200, 20] }, { rect: [0, 20, 200, 46] }, { rect: [0, 42, 200, 70] }]
  const items = [
    token('T1', [10, 28, 25, 36]),
    token('10', [60, 28, 75, 36]),
    token('20', [110, 28, 125, 36]),
    token('0.4', [160, 28, 180, 36]),
    token('T2', [10, 40, 25, 48]),
    token('11', [60, 40, 75, 48]),
    token('21', [110, 40, 125, 48]),
    token('1.2', [160, 40, 180, 48]),
    token('to 16)', [160, 50, 190, 58])
  ]
  const issues = new Set<string>()
  const repairs: string[] = []
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems: items,
    rows,
    columnRects: [
      [0, 0, 50, 100],
      [50, 0, 100, 100],
      [100, 0, 150, 100],
      [150, 0, 200, 100]
    ],
    headerRows: [0],
    rules: [],
    bottom: 80,
    issues,
    repairs
  })
  expect(unassigned).toEqual([])
  expect(cells.find((cell) => cell.row === 2 && cell.column === 0)?.text).toBe('T2')
  expect(cells.find((cell) => cell.row === 2 && cell.column === 3)?.text).toBe('1.2 to 16)')
  expect(repairs).toContain('complete-statistical-record-recovered')
})

it('keeps a split superscript exponent beside a repeated footnote marker', () => {
  const cells = [textCell(0, 0, [0, 0, 200, 30])]
  const label = token('1 Median PSA, ng mL', [10, 10, 100, 22])
  const sign = { ...token('−', [100, 8.5, 106, 16.5]), inlineSymbol: true }
  const exponent = token('1', [106, 8.5, 112, 16.5])
  const suffix = token('(IQR)', [114, 10, 140, 22])
  const issues = new Set<string>()
  const repairs: string[] = []
  const unassigned = populateTableCellText({
    cells,
    items: [label, sign, exponent, suffix],
    pageItems: [label, sign, exponent, suffix],
    rows: [{ rect: [0, 0, 200, 30] }],
    columnRects: [[0, 0, 200, 30]],
    headerRows: [],
    rules: [],
    bottom: 30,
    recordGrid: { ownedTokens: new Set([label, sign, suffix]) },
    issues,
    repairs
  })
  expect(unassigned).toEqual([])
  expect(cells[0].text).toBe('1 Median PSA, ng mL−1 (IQR)')
  expect(repairs).toContain('multi-glyph-script-recovered')
})

it('preserves a narrow source gap after a repaired sample-size equals sign', () => {
  const cells = [textCell(0, 0, [0, 0, 100, 20])]
  const items = [
    token('(n', [10, 5, 24, 15]),
    token('=', [26, 5, 32, 15]),
    token('119)', [33, 5, 52, 15])
  ]
  const issues = new Set<string>()
  const repairs: string[] = []
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems: items,
    rows: [{ rect: [0, 0, 100, 20] }],
    columnRects: [[0, 0, 100, 20]],
    headerRows: [],
    rules: [],
    bottom: 20,
    issues,
    repairs
  })
  expect(unassigned).toEqual([])
  expect(cells[0].text).toBe('(n = 119)')
})

it('recovers numeric-leading treatment headers from a padded ruled crop', () => {
  const table = {
    id: 'numeric-leading-header',
    cropRect: [0, 0, 500, 130],
    structure: {
      objects: [
        ...Array.from({ length: 5 }, (_, column) => ({
          label: 'table column',
          rect: [column * 100, 0, (column + 1) * 100, 130]
        })),
        { label: 'table column header', rect: [0, 24, 500, 38] },
        { label: 'table row', rect: [0, 24, 500, 38] },
        { label: 'table row', rect: [0, 38, 500, 58] }
      ]
    }
  }
  const source = [
    token('5-Session arm (N=163)', [120, 8, 190, 18]),
    token('1-Session arm (N=164)', [320, 8, 390, 18]),
    token('N (%)', [120, 26, 160, 34]),
    token('M (SD)', [220, 26, 270, 34]),
    token('N (%)', [320, 26, 360, 34]),
    token('M (SD)', [420, 26, 470, 34]),
    token('Age', [10, 42, 35, 50]),
    token('10 (1)', [120, 42, 160, 50]),
    token('20 (2)', [220, 42, 260, 50]),
    token('30 (3)', [320, 42, 360, 50]),
    token('40 (4)', [420, 42, 460, 50])
  ]
  const result = refineTable(
    table,
    source,
    [{ lines: ['Table 1. Demographics'], rect: [0, -20, 160, -10] }],
    [],
    [
      [0, 4, 500, 4],
      [0, 22, 500, 22],
      [0, 36, 500, 36]
    ]
  )
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.grid.slice(0, 2)).toEqual([
    ['', '5-Session arm (N=163)', '', '1-Session arm (N=164)', ''],
    ['', 'N (%)', 'M (SD)', 'N (%)', 'M (SD)']
  ])
  expect(result.repairs).toContain('treatment-header-recovered')
})

it('recovers a single parent line above a detected leaf header', () => {
  const result = refineTable(
    {
      id: 'stacked-parent-header',
      cropRect: [0, 0, 300, 90],
      structure: {
        objects: [
          ...Array.from({ length: 3 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 90]
          })),
          { label: 'table column header', rect: [0, 20, 300, 70] },
          { label: 'table row', rect: [0, 20, 300, 35] },
          { label: 'table row', rect: [0, 35, 300, 52] },
          { label: 'table row', rect: [0, 52, 300, 70] }
        ]
      }
    },
    [
      token('Parent', [210, 8, 260, 16]),
      token('Leaf', [210, 22, 240, 30]),
      token('Value', [110, 22, 145, 30]),
      token('Label', [10, 39, 45, 47]),
      token('1', [210, 39, 218, 47])
    ],
    [{ lines: ['Table 1. Stacked header'], rect: [0, -20, 120, -10] }],
    [],
    [
      [0, 5, 300, 5],
      [0, 70, 300, 70]
    ]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid[0][2]).toBe('Parent Leaf')
  expect(result.repairs).toContain('leading-header-line-recovered')
})

it('recovers a multi-column header band with wrapped comparison labels', () => {
  const rows = [
    [0, 30, 800, 50],
    [0, 50, 800, 66],
    [0, 66, 800, 82]
  ]
  const groups = [
    [
      token('Training', [120, 8, 170, 18]),
      token('Control', [220, 8, 270, 18]),
      token('Training effect*', [320, 8, 390, 18]),
      token('p for TE', [420, 8, 470, 18]),
      token('1', [470, 10, 474, 16]),
      token('p for IE', [520, 8, 570, 18]),
      token('2', [570, 10, 574, 16])
    ],
    [token('(Training vs.', [320, 20, 390, 30])],
    [token('Control)', [320, 31, 370, 41])]
  ]
  const columnRects = Array.from({ length: 8 }, (_, column) => [
    column * 100,
    0,
    (column + 1) * 100,
    100
  ])
  const result = refineTable(
    {
      id: 'multicolumn-wrapped-header',
      cropRect: [0, 0, 800, 100],
      structure: {
        objects: [
          ...columnRects.map((rect) => ({ label: 'table column', rect })),
          ...rows.map((rect) => ({ label: 'table row', rect }))
        ]
      }
    },
    [
      ...groups.flat(),
      token('Measure', [10, 52, 80, 60]),
      token('Baseline', [120, 52, 170, 60]),
      token('Value', [10, 68, 50, 76]),
      token('10', [120, 68, 135, 76])
    ],
    [{ lines: ['Table 1. Wrapped comparison'], rect: [0, -20, 200, -10] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.grid[0]).toEqual([
    '',
    'Training',
    'Control',
    'Training effect* (Training vs. Control)',
    'p for TE1',
    'p for IE2',
    '',
    ''
  ])
  expect(result.repairs).toContain('clipped-multicolumn-heading-recovered')
})

it('recovers a complete numeric row missed between detected records', () => {
  const result = refineTable(
    {
      id: 'missing-numeric-row',
      cropRect: [0, 0, 400, 120],
      structure: {
        objects: [
          ...Array.from({ length: 4 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 120]
          })),
          { label: 'table column header', rect: [0, 0, 400, 20] },
          { label: 'table row', rect: [0, 20, 400, 35] },
          { label: 'table row', rect: [0, 58, 400, 75] },
          { label: 'table row', rect: [0, 78, 400, 95] }
        ]
      }
    },
    [
      token('Range', [10, 25, 55, 33]),
      token('1–2', [110, 25, 130, 33]),
      token('2–3', [210, 25, 230, 33]),
      token('3–4', [310, 25, 330, 33]),
      token('Mean', [10, 42, 45, 50]),
      token('1.8', [110, 42, 125, 50]),
      token('2.1', [210, 42, 225, 50]),
      token('1.5', [310, 42, 325, 50]),
      token('Total', [10, 62, 45, 70]),
      token('3.6', [110, 62, 125, 70]),
      token('1.1', [210, 62, 225, 70]),
      token('6.2', [310, 62, 325, 70])
    ],
    [{ lines: ['Table 1. Missing row'], rect: [0, -20, 120, -10] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid).toContainEqual(['Mean', '1.8', '2.1', '1.5'])
  expect(result.repairs).toContain('text-supported-row-recovered')
})

it('recovers a missing statistical row with a non-significant value', () => {
  const result = refineTable(
    {
      id: 'missing-ns-row',
      cropRect: [0, 0, 700, 130],
      structure: {
        objects: [
          ...Array.from({ length: 7 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 130]
          })),
          { label: 'table column header', rect: [0, 0, 700, 20] },
          { label: 'table row', rect: [0, 20, 700, 36] },
          { label: 'table row', rect: [0, 54, 700, 70] },
          { label: 'table row', rect: [0, 72, 700, 88] }
        ]
      }
    },
    [
      token('Definition of cancer', [10, 24, 95, 32]),
      token('28%', [110, 24, 135, 32]),
      token('35%', [210, 24, 235, 32]),
      token('36%', [310, 24, 335, 32]),
      token('0.72', [410, 24, 440, 32]),
      token('ns', [610, 24, 625, 32]),
      token('Definition of Pap test', [10, 42, 100, 50]),
      token('41%', [110, 42, 135, 50]),
      token('49%', [210, 42, 235, 50]),
      token('67%', [310, 42, 335, 50]),
      token('4.62*', [410, 42, 445, 50]),
      token('ns', [610, 42, 625, 50]),
      token('Frequency of Pap test', [10, 58, 100, 66]),
      token('31%', [110, 58, 135, 66]),
      token('32%', [210, 58, 235, 66]),
      token('16%', [310, 58, 335, 66]),
      token('3.17', [410, 58, 440, 66]),
      token('ns', [610, 58, 625, 66])
    ],
    [{ lines: ['Table 3. Knowledge indicators'], rect: [0, -20, 180, -10] }]
  )
  expect(result.grid).toContainEqual([
    'Definition of Pap test',
    '41%',
    '49%',
    '67%',
    '4.62*',
    '',
    'ns'
  ])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('text-supported-row-recovered')
})

it('merges wide statistical section headings across native body columns', () => {
  const result = refineTable(
    {
      id: 'wide-statistical-section',
      cropRect: [0, 0, 500, 100],
      structure: {
        objects: [
          ...Array.from({ length: 5 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 100]
          })),
          { label: 'table column header', rect: [0, 0, 500, 18] },
          { label: 'table row', rect: [0, 18, 500, 34] },
          { label: 'table row', rect: [0, 34, 500, 50] }
        ]
      }
    },
    [
      token('Outcome scale (statistical result', [10, 21, 270, 29]),
      token('P', [270, 21, 278, 29]),
      token('=.52b)', [278, 21, 315, 29]),
      token('Control', [10, 38, 55, 46]),
      token('10', [110, 38, 125, 46]),
      token('20', [210, 38, 225, 46]),
      token('30', [310, 38, 325, 46]),
      token('40', [410, 38, 425, 46])
    ],
    [{ lines: ['Table 1. Wide section'], rect: [0, -18, 150, -8] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid[0][0]).toBe('Outcome scale (statistical resultP=.52b)')
  expect(
    result.cells.find(
      (cell: { row: number; column: number }) => cell.row === 0 && cell.column === 0
    )?.colSpan
  ).toBe(5)
  expect(result.repairs).toContain('source-wide-section-span-recovered')
})

it('recovers a detached continuation above a native table header', () => {
  const result = refineTable(
    {
      id: 'detached-header-continuation',
      cropRect: [0, 0, 300, 90],
      structure: {
        objects: [
          ...Array.from({ length: 3 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 90]
          })),
          { label: 'table column header', rect: [0, 20, 300, 50] },
          { label: 'table row', rect: [0, 20, 300, 34] },
          { label: 'table row', rect: [0, 34, 300, 50] }
        ]
      }
    },
    [
      token('Bonferroni post hoc', [205, 10, 285, 18]),
      token('Pairwise comparisons', [205, 22, 285, 30]),
      token('Outcome A', [10, 38, 70, 46]),
      token('Control', [110, 38, 150, 46]),
      token('0.04', [205, 38, 225, 46])
    ],
    [{ lines: ['Table 1. Results'], rect: [0, -20, 120, -10] }]
  )
  expect(result.grid[0][2]).toContain('Bonferroni post hoc')
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('detached-header-continuation-recovered')
})

it('restores a statistical parent header over empty model child columns', () => {
  const result = refineTable(
    {
      id: 'statistical-parent-header',
      cropRect: [0, 0, 600, 90],
      structure: {
        objects: [
          ...Array.from({ length: 6 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 90]
          })),
          { label: 'table column header', rect: [0, 0, 600, 30] },
          { label: 'table spanning cell', rect: [400, 0, 600, 20] },
          { label: 'table row', rect: [0, 0, 600, 20] },
          { label: 'table row', rect: [0, 20, 600, 40] }
        ]
      }
    },
    [
      token('Scale', [10, 5, 45, 13]),
      token('Control', [110, 5, 160, 13]),
      token('Linear mixed model statistical tests', [405, 5, 585, 13]),
      token('Outcome', [10, 25, 55, 33]),
      token('10', [110, 25, 125, 33]),
      token('20', [210, 25, 225, 33]),
      token('30', [310, 25, 325, 33]),
      token('40', [410, 25, 425, 33]),
      token('50', [510, 25, 525, 33])
    ]
  )
  expect(result.grid[0][4]).toBe('Linear mixed model statistical tests')
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 4, colSpan: 2, rowSpan: 1 })
  )
  expect(result.unassigned).toEqual([])
})

it('spans descriptive statistical section labels before numeric effects', () => {
  const result = refineTable(
    {
      id: 'statistical-section-label',
      cropRect: [0, 0, 600, 80],
      structure: {
        objects: [
          ...Array.from({ length: 6 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 80]
          })),
          { label: 'table column header', rect: [0, 0, 600, 16] },
          { label: 'table row', rect: [0, 0, 600, 16] },
          { label: 'table row', rect: [0, 16, 600, 32] },
          { label: 'table row', rect: [0, 32, 600, 48] }
        ]
      }
    },
    [
      token('Scale', [10, 4, 45, 12]),
      token('Functional well-being', [10, 20, 190, 28]),
      token('3.22 (1,102)', [310, 20, 375, 28]),
      token('.08', [410, 20, 430, 28]),
      token('5.25 (2,90)', [510, 20, 575, 28]),
      token('T0', [10, 36, 25, 44]),
      token('10', [110, 36, 125, 44]),
      token('20', [210, 36, 225, 44]),
      token('30', [310, 36, 325, 44]),
      token('40', [410, 36, 425, 44]),
      token('50', [510, 36, 525, 44])
    ]
  )
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 0, colSpan: 3, text: 'Functional well-being' })
  )
  expect(result.unassigned).toEqual([])
})

it('recovers a text-only comparison section between numeric rows', () => {
  const result = refineTable(
    {
      id: 'missing-comparison-section',
      cropRect: [0, 0, 500, 110],
      structure: {
        objects: [
          ...Array.from({ length: 5 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 110]
          })),
          { label: 'table row', rect: [0, 20, 500, 36] },
          { label: 'table row', rect: [0, 74, 500, 90] }
        ]
      }
    },
    [
      token('BCCT vs Panel', [10, 22, 90, 30]),
      token('83', [110, 22, 125, 30]),
      token('65', [210, 22, 225, 30]),
      token('18', [310, 22, 325, 30]),
      token('0.57', [410, 22, 440, 30]),
      token('Patient live vs patient live', [10, 44, 90, 52]),
      token('Clinician vs patient', [10, 76, 100, 84]),
      token('89', [110, 76, 125, 84]),
      token('88', [210, 76, 225, 84]),
      token('1', [310, 76, 318, 84]),
      token('0.15', [410, 76, 440, 84])
    ],
    [{ lines: ['Table 1. Agreement'], rect: [0, -20, 120, -10] }]
  )
  expect(result.grid).toContainEqual(['Patient live vs patient live', '', '', '', ''])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('missing-section-row-recovered')
})

it('recovers aligned numeric tails wrapped below a statistical row', () => {
  const result = refineTable(
    {
      id: 'wrapped-numeric-tail',
      cropRect: [0, 0, 400, 110],
      structure: {
        objects: [
          ...Array.from({ length: 4 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 110]
          })),
          { label: 'table column header', rect: [0, 0, 400, 20] },
          { label: 'table row', rect: [0, 20, 400, 40] },
          { label: 'table row', rect: [0, 50, 400, 68] }
        ]
      }
    },
    [
      token('Group', [10, 24, 50, 32]),
      token('Placebo', [110, 24, 160, 32]),
      token('63.27 ±', [210, 24, 260, 32]),
      token('−5.27 ±', [310, 24, 360, 32]),
      token('1.1', [210, 34, 225, 42]),
      token('0.8', [310, 34, 325, 42]),
      token('Next', [10, 54, 40, 62]),
      token('1', [110, 54, 118, 62]),
      token('2', [210, 54, 218, 62]),
      token('3', [310, 54, 318, 62])
    ],
    [{ lines: ['Table 1. Wrapped statistic'], rect: [0, -20, 120, -10] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid[0][2]).toBe('63.27 ± 1.1')
  expect(result.grid[0][3]).toBe('−5.27 ± 0.8')
})

it('keeps split chi-square fragments with the populated section row', () => {
  const result = refineTable(
    {
      id: 'split-statistical-fragments',
      cropRect: [0, 0, 500, 90],
      structure: {
        objects: [
          ...Array.from({ length: 5 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 90]
          })),
          { label: 'table row', rect: [0, 0, 500, 18] },
          { label: 'table row', rect: [0, 18, 500, 40] },
          { label: 'table row', rect: [0, 32, 500, 50] },
          { label: 'table row', rect: [0, 50, 500, 68] }
        ]
      }
    },
    [
      token('Characteristics', [5, 4, 80, 12]),
      token('Time since diagnosis, months, n (%)', [5, 20, 95, 28]),
      token('2', [310, 18, 315, 27]),
      token('χ', [300, 22, 307, 32]),
      token('(df)=3.945 (2)', [316, 22, 382, 32]),
      token('.14', [410, 22, 425, 32]),
      token('≤3', [5, 54, 20, 62]),
      token('25 (49)', [110, 54, 155, 62]),
      token('24 (46)', [210, 54, 255, 62])
    ],
    [{ lines: ['Table 1. Baseline characteristics'], rect: [0, -20, 180, -10] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.issues).not.toContain('ambiguous-cell-assignment')
  expect(result.grid.some((row: string[]) => row.includes('2 χ (df)=3.945 (2)'))).toBe(true)
})

it('keeps slash-wrapped values with the preceding row when bands overlap', () => {
  const result = refineTable(
    {
      id: 'overlapping-wrapped-row',
      cropRect: [0, 0, 300, 90],
      structure: {
        objects: [
          ...Array.from({ length: 3 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 90]
          })),
          { label: 'table column header', rect: [0, 0, 300, 18] },
          { label: 'table row', rect: [0, 18, 300, 46] },
          { label: 'table row', rect: [0, 34, 300, 54] },
          { label: 'table row', rect: [0, 50, 300, 70] }
        ]
      }
    },
    [
      token('Four months', [8, 20, 70, 28]),
      token('8.8 (12.1) /', [110, 20, 170, 28]),
      token('9.7 (11.5) /', [210, 20, 270, 28]),
      token('3 (16)', [110, 36, 145, 44]),
      token('5.5 (12.5)', [210, 36, 260, 44]),
      token('12 months', [8, 52, 65, 60]),
      token('6.5 (11.3) /', [110, 52, 170, 60]),
      token('12.4 (15.1) /', [210, 52, 275, 60])
    ],
    [{ lines: ['Table 1. Patient characteristics'], rect: [0, -18, 180, -8] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.issues).not.toContain('ambiguous-cell-assignment')
  const wrapped = result.grid.find((row: string[]) => row[0] === 'Four months')
  expect(wrapped?.slice(1)).toEqual(['8.8 (12.1) / 3 (16)', '9.7 (11.5) / 5.5 (12.5)'])
})

it('discards numeric model spans that absorb an independent value column', () => {
  const result = refineTable(
    {
      id: 'numeric-span-conflict',
      cropRect: [0, 0, 300, 70],
      structure: {
        objects: [
          ...Array.from({ length: 3 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 70]
          })),
          { label: 'table row', rect: [0, 0, 300, 35] },
          { label: 'table row', rect: [0, 35, 300, 70] },
          { label: 'table spanning cell', rect: [100, 35, 300, 70] }
        ]
      }
    },
    [token('Label', [10, 8, 50, 18]), token('42', [210, 43, 230, 53])]
  )
  expect(result.grid).toEqual([
    ['Label', '', ''],
    ['', '', '42']
  ])
  expect(
    result.cells.some(
      (cell: { row: number; colSpan: number }) => cell.row === 1 && cell.colSpan > 1
    )
  ).toBe(false)
  expect(result.issues).toEqual([])
  expect(result.repairs).toContain('source-numeric-span-discarded')
})

it('assigns a ruled section label that crosses the stub boundary', () => {
  const result = refineTable(
    {
      id: 'ruled-section-label',
      cropRect: [0, 0, 300, 90],
      structure: {
        objects: [
          ...Array.from({ length: 3 }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 90]
          })),
          { label: 'table column header', rect: [0, 0, 300, 20] },
          ...[0, 20, 40].map((top) => ({ label: 'table row', rect: [0, top, 300, top + 20] }))
        ]
      }
    },
    [
      token('Variable', [10, 5, 55, 15]),
      token('Section heading', [10, 23, 180, 33]),
      token('10', [110, 43, 130, 53]),
      token('20', [210, 43, 230, 53])
    ],
    [],
    [],
    [[0, 38, 300, 38]]
  )
  expect(result.grid[1]).toEqual(['Section heading', '', ''])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('source-section-span-recovered')
})

it('recovers compact count labels above repeated n/% columns', () => {
  const columns = 9
  const result = refineTable(
    {
      id: 'compact-count-header',
      cropRect: [0, 0, 900, 150],
      structure: {
        objects: [
          ...Array.from({ length: columns }, (_, column) => ({
            label: 'table column',
            rect: [column * 100, 0, (column + 1) * 100, 150]
          })),
          { label: 'table column header', rect: [0, 40, 900, 80] },
          ...[40, 60, 80, 100].map((top) => ({
            label: 'table row',
            rect: [0, top, 900, top + 20]
          }))
        ]
      }
    },
    [
      token('Control (', [110, 20, 160, 30]),
      token('n', [160, 20, 170, 30]),
      token('=', [175, 20, 185, 30]),
      token('65)', [190, 20, 210, 30]),
      token('WBH', [310, 20, 350, 30]),
      token('(n', [350, 20, 370, 30]),
      token('=', [375, 20, 385, 30]),
      token('98)', [390, 20, 410, 30]),
      token('WBH2', [510, 20, 560, 30]),
      token('(n', [560, 20, 580, 30]),
      token('=', [585, 20, 595, 30]),
      token('35)', [600, 20, 620, 30]),
      token('Characteristics', [10, 62, 80, 70]),
      ...[110, 210, 310, 410, 510, 610].flatMap((x) => [
        token('n', [x, 62, x + 10, 70]),
        token('%', [x + 40, 62, x + 50, 70])
      ]),
      token('Race', [10, 85, 40, 93]),
      ...[110, 210, 310, 410, 510, 610].map((x, index) =>
        token(String(index + 1), [x, 85, x + 10, 93])
      ),
      token('Urban', [10, 105, 50, 113]),
      ...[110, 210, 310, 410, 510, 610].map((x, index) =>
        token(String(index + 2), [x, 105, x + 10, 113])
      )
    ],
    [{ lines: ['Table 1. Characteristics'], rect: [0, -20, 150, -10] }]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid[0].slice(1, 7)).toEqual([
    'Control (n = 65)',
    '',
    'WBH(n = 98)',
    '',
    'WBH2(n = 35)',
    ''
  ])
  expect(result.repairs).toContain('compact-treatment-header-recovered')
  expect(result.issues).not.toContain('unresolved-spanning-cells')
})

it.each(['complete', 'missing-rule', 'different-leaf', 'crossing-rule'])(
  'recovers separate parent and leaf tiers only with complete evidence (%s)',
  (variant) => {
    const columns = 7
    const result = refineTable(
      {
        id: 'ruled-parent-groups',
        cropRect: [0, 0, 700, 120],
        structure: {
          objects: [
            ...Array.from({ length: columns }, (_, column) => ({
              label: 'table column',
              rect: [column * 100, 0, (column + 1) * 100, 120]
            })),
            { label: 'table column header', rect: [0, 20, 700, 35] },
            ...[20, 35, 50, 65].map((top) => ({
              label: 'table row',
              rect: [0, top, 700, top + 15]
            }))
          ]
        }
      },
      [
        token('Grade <5*', [110, 5, 205, 14]),
        token('Grade', [410, 5, 485, 14]),
        token('≥5*', [487, 5, 515, 14]),
        token('Odds ratio', [110, 24, 170, 32]),
        token('95%CI', [210, 24, 255, 32]),
        token('P-value', [310, 24, 355, 32]),
        token('Odds ratio', [410, 24, 470, 32]),
        token('95%CI', [510, 24, 555, 32]),
        token(variant === 'different-leaf' ? 'Count' : 'P-value', [610, 24, 655, 32]),
        token('No family history', [10, 39, 90, 47]),
        token('Reference', [110, 39, 165, 47]),
        token('Reference', [410, 39, 465, 47]),
        token('Prostate cancer only', [10, 54, 95, 62]),
        token('1.46', [110, 54, 135, 62]),
        token('1.18–1.80', [210, 54, 265, 62]),
        token('<0.001', [310, 54, 350, 62]),
        token('1.51', [410, 54, 435, 62]),
        token('1.10–2.06', [510, 54, 565, 62]),
        token('0.01', [610, 54, 635, 62]),
        token('Breast cancer only', [10, 69, 95, 77]),
        token('1.10', [110, 69, 135, 77]),
        token('0.86–1.40', [210, 69, 265, 77]),
        token('0.46', [310, 69, 335, 77]),
        token('0.92', [410, 69, 435, 77]),
        token('0.62–1.36', [510, 69, 565, 77]),
        token('0.66', [610, 69, 635, 77])
      ],
      [{ lines: ['Table 1. Grouped statistics'], rect: [0, -20, 150, -10] }],
      [],
      [
        [110, 17, variant === 'crossing-rule' ? 455 : 355, 17],
        ...(variant === 'missing-rule' ? [] : [[410, 17, 655, 17]]),
        [0, 37, 700, 37]
      ]
    )
    if (variant !== 'complete') {
      expect(result.repairs).not.toContain('ruled-group-header-recovered')
      return
    }
    expect(result.unassigned).toEqual([])
    expect(result.issues).not.toContain('unassigned-source-text')
    expect(result.grid[0].slice(1, 7)).toEqual(['Grade <5*', '', '', 'Grade ≥5*', '', ''])
    expect(result.grid[1]).toEqual([
      '',
      'Odds ratio',
      '95%CI',
      'P-value',
      'Odds ratio',
      '95%CI',
      'P-value'
    ])
    expect(result.cells.filter((cell: { row: number }) => cell.row === 1)).toHaveLength(7)
    expect(result.cells).toContainEqual(
      expect.objectContaining({ row: 0, column: 1, rowSpan: 1, colSpan: 3, text: 'Grade <5*' })
    )
    expect(result.cells).toContainEqual(
      expect.objectContaining({ row: 0, column: 4, rowSpan: 1, colSpan: 3, text: 'Grade ≥5*' })
    )
    expect(result.repairs).toContain('ruled-group-header-recovered')
  }
)

it.each([false, true])(
  'reconciles nested section spans only with empty trailing slots (value: %s)',
  (hasValue) => {
    const baseCells = Array.from({ length: 3 }, (_, column) => ({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 100, 0, (column + 1) * 100, 20],
      sourceTokens: []
    }))
    const items = [
      token('Section measurements', [10, 5, 190, 15]),
      // The next record touches the heading band but its center belongs below it.
      token('0.64', [210, 19, 235, 29]),
      ...(hasValue ? [token('0.12', [210, 5, 235, 15])] : [])
    ]
    const issues = new Set<string>()
    const repairs: string[] = []
    const cells = resolveTableCellMerges({
      proposals: [
        { slots: baseCells.slice(0, 2), origin: 'model-span', sectionHeader: true },
        { slots: baseCells, origin: 'model-span', sectionHeader: true }
      ],
      baseCells,
      items,
      rows: [{ rect: [0, 0, 300, 20] }],
      headerRows: [0],
      headerRuns: new Map(),
      rules: [],
      recordGrid: undefined,
      populatedColumns: () => [0, 1, 2],
      issues,
      repairs
    })
    if (hasValue) {
      expect(repairs).not.toContain('duplicate-model-span-discarded')
      expect(cells).not.toContainEqual(expect.objectContaining({ row: 0, column: 0, colSpan: 3 }))
    } else {
      expect(issues).not.toContain('conflicting-spanning-cells')
      expect(cells).toContainEqual(expect.objectContaining({ row: 0, column: 0, colSpan: 3 }))
      expect(repairs).toContain('duplicate-model-span-discarded')
    }
  }
)

// Complete anonymous native glyph packets, three independent header postfixes
// and three scalar body rows; the shifted model cut crosses the first marker.
function postfixNativeExample(): ReturnType<typeof JSON.parse> {
  const width = 280,
    height = 120,
    entries: [string, number, number][] = []
  for (let c = 0; c < 3; c++) {
    const center = 50 + c * 75
    entries.push(
      ['Metric ' + String.fromCharCode(65 + c), center - 23.75, 15],
      ['↓', center + 18.75, 15]
    )
  }
  for (let row = 0; row < 3; row++)
    for (let c = 0; c < 3; c++)
      entries.push([`${row + 1}.${c + 1}${c + 1}`, 40 + c * 75, 35 + row * 20])
  const items = entries.map(([str, x, y], index) => ({
      str,
      width: str.length * 5,
      height: 10,
      dir: 'ltr',
      fontName: 'F',
      transform: [10, 0, 0, 10, x, height - y],
      sourceItem: { pageNumber: 1, index, text: str }
    })),
    content = { items, styles: { F: { ascent: 0, descent: 0, vertical: false } } },
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    workViewport = {
      width: width * 1.5,
      height: height * 1.5,
      scale: 1.5,
      rotation: 0,
      transform: [1.5, 0, 0, -1.5, 0, height * 1.5],
      convertToViewportPoint: (x: number, y: number) => [x * 1.5, (height - y) * 1.5]
    },
    operators = { fnArray: [] as number[], argsArray: [] as ReturnType<typeof JSON.parse>[] }
  for (const item of items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['F', 10],
      [new Float32Array([1, 0, 0, 1, item.transform[4], item.transform[5]])],
      [Array.from(item.str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
      null
    )
  }
  operators.fnArray.push(OPS.setLineWidth, OPS.setLineCap)
  operators.argsArray.push([0.4], [0])
  const rules = [
      [0, 2, 250, 2],
      [0, 22, 250, 22],
      [0, 90, 250, 90]
    ],
    graphicsBounds = rules.map((r) => {
      const operationIndex = operators.fnArray.length
      operators.fnArray.push(OPS.constructPath)
      operators.argsArray.push([
        OPS.stroke,
        [new Float32Array([0, r[0], height - r[1], 1, r[2], height - r[3]])],
        new Float32Array([r[0], height - r[3], r[2], height - r[1]])
      ])
      return {
        kind: 'path',
        operationIndex,
        normalizedRect: r.map((n, i) => n / (i % 2 ? height : width))
      }
    }),
    nativeGlyphContext = {
      content,
      viewport,
      operators,
      graphicsBounds,
      pageNumber: 1,
      sourceSha256: '0'.repeat(64),
      glyphBounds: [
        {
          fontName: 'F',
          glyphs: [...new Set(items.flatMap((i) => Array.from(i.str)))].map((c) => ({
            fontChar: c,
            bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
          }))
        }
      ]
    },
    sourcePage = {
      pageNumber: 1,
      width,
      height,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds
    },
    tokens = items.map((i) => tableTextToken(i, workViewport, 0)),
    context = {
      sourcePage,
      nativeGlyphContext,
      viewport: workViewport,
      operators,
      sourceContent: content,
      content,
      rulePaintBounds: new Map()
    },
    table = {
      id: 'anonymous-postfix-header',
      cropRect: [0, 0, 375, 150],
      structure: {
        objects: [
          ...[0, 71, 162.5].map((left, c) => ({
            label: 'table column',
            rect: [left * 1.5, 25 * 1.5, [71, 162.5, 250][c] * 1.5, 90 * 1.5]
          })),
          ...[25, 45, 65].map((top) => ({
            label: 'table row',
            rect: [0, top * 1.5, 375, (top + 20) * 1.5]
          })),
          { label: 'table column header', rect: [0, 37.5, 375, 67.5] }
        ]
      }
    }
  return { table, tokens, context, rules: collectTableRules(operators, workViewport) }
}

const refinePostfixExample = (
  f: ReturnType<typeof postfixNativeExample>,
  context = f.context
): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.tokens, [], [], f.rules, [], undefined, context.rulePaintBounds, context)

it('reassigns a whole postfix source only when repeated native header and body centers close uniquely', () => {
  const f = postfixNativeExample(),
    before = refinePostfixExample(f, { ...f.context, sourcePage: undefined }),
    snapshot = { table: structuredClone(f.table), tokens: structuredClone(f.tokens) },
    after = refinePostfixExample(f)
  expect(before.grid[0]).toEqual(['Metric A', '↓ Metric B ↓', 'Metric C ↓'])
  expect(after.grid[0]).toEqual(['Metric A ↓', 'Metric B ↓', 'Metric C ↓'])
  expect(after.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row > 0)).toEqual(
    before.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row > 0)
  )
  expect(after.rows).toEqual(before.rows)
  expect(after.cropRect).toEqual(before.cropRect)
  expect(after.issues).toEqual(before.issues)
  expect(after.unassigned).toEqual(before.unassigned)
  const headers = after.cells
    .filter((c: ReturnType<typeof JSON.parse>) => c.row === 0)
    .sort(
      (a: ReturnType<typeof JSON.parse>, b: ReturnType<typeof JSON.parse>) => a.column - b.column
    )
  expect(
    headers.every(
      (c: ReturnType<typeof JSON.parse>, i: number) => !i || c.rect[0] >= headers[i - 1].rect[2]
    )
  ).toBe(true)
  expect(headers[0].sourceItems).toEqual([f.tokens[0].sourceItem, f.tokens[1].sourceItem])
  expect(headers[0].sourceRects).toEqual([f.tokens[0].rect, f.tokens[1].rect])
  expect(headers[1].sourceItems).toEqual([f.tokens[2].sourceItem, f.tokens[3].sourceItem])
  expect(headers[1].sourceRects).toEqual([f.tokens[2].rect, f.tokens[3].rect])
  const keys = (t: ReturnType<typeof JSON.parse>): string[] =>
    t.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems ?? [])
      .map((s: ReturnType<typeof JSON.parse>) => JSON.stringify(s))
      .sort()
  expect(keys(after)).toEqual(keys(before))
  expect({ table: f.table, tokens: f.tokens }).toEqual(snapshot)
  expect(after.repairs).toContain('native-calibrated-postfix-header-recovered')
})

function prependPostfixState(
  f: ReturnType<typeof postfixNativeExample>,
  op: number,
  args: unknown[]
): void {
  f.context.operators.fnArray.unshift(op)
  f.context.operators.argsArray.unshift(args)
  for (const g of f.context.sourcePage.graphicsBounds) g.operationIndex++
}
function appendPostfixRule(f: ReturnType<typeof postfixNativeExample>, r: number[]): void {
  const o = f.context.operators,
    p = f.context.sourcePage,
    h = p.height,
    index = o.fnArray.length
  o.fnArray.push(OPS.constructPath)
  o.argsArray.push([
    OPS.stroke,
    [new Float32Array([0, r[0], h - r[1], 1, r[2], h - r[3]])],
    new Float32Array([r[0], h - r[3], r[2], h - r[1]])
  ])
  p.graphicsBounds.push({
    kind: 'path',
    operationIndex: index,
    normalizedRect: r.map((x, i) => x / (i % 2 ? p.height : p.width))
  })
  f.rules = collectTableRules(o, f.context.viewport)
}
function setPostfixClosingState(
  f: ReturnType<typeof postfixNativeExample>,
  op: number,
  args: unknown[]
): void {
  const index = f.context.sourcePage.graphicsBounds.at(-1).operationIndex
  f.context.operators.fnArray.splice(index, 0, op)
  f.context.operators.argsArray.splice(index, 0, args)
  for (const graphic of f.context.sourcePage.graphicsBounds)
    if (graphic.operationIndex >= index) graphic.operationIndex++
}
const postfixEvidenceNegatives: [string, (f: ReturnType<typeof postfixNativeExample>) => void][] = [
  ['transparent closing witness', (f) => setPostfixClosingState(f, OPS.setGState, [[['CA', 0]]])],
  ['white closing witness', (f) => setPostfixClosingState(f, OPS.setStrokeRGBColor, ['#ffffff'])],
  ['duplicate closing witness', (f) => appendPostfixRule(f, [0, 90, 250, 90])],
  [
    'already complete header ownership',
    (f) => {
      const columns = f.table.structure.objects.filter(
        (o: ReturnType<typeof JSON.parse>) => o.label === 'table column'
      )
      columns[0].rect[2] = 115
      columns[1].rect[0] = 115
    }
  ],
  [
    'missing original page',
    (f) => {
      delete f.context.sourcePage
    }
  ],
  [
    'unknown page graphics',
    (f) => {
      f.context.sourcePage.invalidGraphicsBounds = 1
    }
  ],
  [
    'mismatched source page',
    (f) => {
      f.context.sourcePage.pageNumber = 2
    }
  ],
  [
    'rotated source page',
    (f) => {
      f.context.sourcePage.renderRotation = 90
    }
  ],
  [
    'unbound work transform',
    (f) => {
      f.context.viewport.transform[4] = 1
    }
  ],
  [
    'missing arrow outline',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs =
        f.context.nativeGlyphContext.glyphBounds[0].glyphs.filter(
          (g: ReturnType<typeof JSON.parse>) => g.fontChar !== '↓'
        )
    }
  ],
  [
    'empty visible letter outline',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
        (g: ReturnType<typeof JSON.parse>) => g.fontChar === 'M'
      ).bounds = [0, 0, 0, 0]
    }
  ],
  [
    'painted whitespace in a header source',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
        (g: ReturnType<typeof JSON.parse>) => g.fontChar === ' '
      ).bounds = [0, 0, 0.5, 0.7]
    }
  ],
  [
    'missing complete source slot',
    (f) => {
      f.tokens.splice(1, 1)
    }
  ],
  [
    'duplicate source identity',
    (f) => {
      f.tokens[2].sourceItem.index = f.tokens[0].sourceItem.index
    }
  ],
  [
    'altered native source text',
    (f) => {
      f.context.nativeGlyphContext.content.items[1].str = '↑'
    }
  ],
  ['transparent header text', (f) => prependPostfixState(f, OPS.setGState, [[['ca', 0]]])],
  ['white header text', (f) => prependPostfixState(f, OPS.setFillRGBColor, ['#ffffff'])],
  ['unknown blend mode', (f) => prependPostfixState(f, OPS.setGState, [[['BM', 'multiply']]])],
  ['nonempty soft mask', (f) => prependPostfixState(f, OPS.setGState, [[['SMask', true]]])],
  ['nonfill text rendering', (f) => prependPostfixState(f, OPS.setTextRenderingMode, [1])],
  ['vertical rule splitting a label from its marker', (f) => appendPostfixRule(f, [68, 2, 68, 22])],
  ['duplicate opening rule', (f) => appendPostfixRule(f, [0, 2, 250, 2])],
  [
    'missing native opening',
    (f) => {
      f.rules = f.rules.filter((r: number[]) => r[1] !== 3)
    }
  ],
  [
    'too few independent body rows',
    (f) => {
      f.tokens.splice(12, 3)
      f.context.sourceContent.items.splice(12, 3)
      f.context.operators.fnArray.splice(60, 15)
      f.context.operators.argsArray.splice(60, 15)
      for (const g of f.context.sourcePage.graphicsBounds) g.operationIndex -= 15
      const rows = f.table.structure.objects.filter(
        (o: ReturnType<typeof JSON.parse>) => o.label === 'table row'
      )
      f.table.structure.objects.splice(f.table.structure.objects.indexOf(rows[2]), 1)
    }
  ],
  [
    'spanning metric slot',
    (f) => {
      f.table.structure.objects.push({
        label: 'table spanning cell',
        rect: [0, 37.5, 243.75, 97.5]
      })
    }
  ],
  [
    'body column cuts crossing a source',
    (f) => {
      f.table.structure.objects.find(
        (o: ReturnType<typeof JSON.parse>) => o.label === 'table column'
      ).rect[2] = 70
    }
  ],
  [
    'body center contradicting the complete postfix group',
    (f) => {
      for (let i = 6; i < f.tokens.length; i += 3) {
        const item = f.context.sourceContent.items[i]
        item.transform[4] += 1
        f.context.operators.argsArray[i * 5 + 2] = [
          new Float32Array([1, 0, 0, 1, item.transform[4], item.transform[5]])
        ]
        f.tokens[i] = tableTextToken(item, f.context.viewport, 0)
      }
    }
  ],
  [
    'unclaimed complete native source inside a metric record',
    (f) => {
      const index = f.context.sourceContent.items.length,
        item = {
          str: 'X',
          width: 5,
          height: 10,
          dir: 'ltr',
          fontName: 'F',
          transform: [10, 0, 0, 10, 60, 85],
          sourceItem: { pageNumber: 1, index, text: 'X' }
        }
      f.context.sourceContent.items.push(item)
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.push({
        fontChar: 'X',
        bounds: [0, 0, 0.5, 0.7]
      })
      f.context.operators.fnArray.push(
        OPS.beginText,
        OPS.setFont,
        OPS.setTextMatrix,
        OPS.showText,
        OPS.endText
      )
      f.context.operators.argsArray.push(
        null,
        ['F', 10],
        [new Float32Array([1, 0, 0, 1, 60, 85])],
        [[{ unicode: 'X', fontChar: 'X', width: 500, isInFont: true }]],
        null
      )
    }
  ]
]
for (const [label, mutate] of postfixEvidenceNegatives)
  it('keeps the original header source ownership without ' + label, () => {
    const f = postfixNativeExample()
    mutate(f)
    const before = refinePostfixExample(f, { ...f.context, sourcePage: undefined }),
      after = refinePostfixExample(f)
    expect(after).toEqual(before)
    expect(after.repairs).not.toContain('native-calibrated-postfix-header-recovered')
  })

// The text extractor normalizes an outside micro sign to Greek mu; the loaded
// operator glyph and every claimed table literal remain unchanged.
function postfixModelHeaderExample(): ReturnType<typeof JSON.parse> {
  const f = postfixNativeExample(),
    n = f.context.nativeGlyphContext,
    columns = f.table.structure.objects.filter(
      (o: ReturnType<typeof JSON.parse>) => o.label === 'table column'
    )
  columns[0].rect[2] = 67 * 1.5
  columns[1].rect[0] = 67 * 1.5
  f.table.structure.objects = f.table.structure.objects.filter(
    (o: ReturnType<typeof JSON.parse>) => o.label !== 'table column header'
  )
  f.table.structure.objects.push(
    { label: 'table row', rect: [0, 9, 375, 30] },
    { label: 'table column header', rect: [0, 9, 375, 30] }
  )
  const index = n.content.items.length,
    item = {
      str: 'μ',
      width: 5,
      height: 10,
      dir: 'ltr',
      fontName: 'F',
      transform: [10, 0, 0, 10, 260, 10],
      sourceItem: { pageNumber: 1, index, text: 'μ' }
    }
  n.content.items.push(item)
  n.glyphBounds[0].glyphs.push({ fontChar: 'µ', bounds: [0, 0, 0.5, 0.7] })
  n.operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
  n.operators.argsArray.push(
    null,
    ['F', 10],
    [new Float32Array([1, 0, 0, 1, 260, 10])],
    [[{ unicode: 'µ', fontChar: 'µ', width: 500, isInFont: true }]],
    null
  )
  f.tokens.push(tableTextToken(item, f.context.viewport, 0))
  return f
}

it('proves a model header from complete native fences while preserving foreign normalized source literals', () => {
  const f = postfixModelHeaderExample(),
    input = JSON.stringify(f),
    before = refinePostfixExample(f, { ...f.context, sourcePage: undefined }),
    after = refinePostfixExample(f)
  expect(
    before.cells.find((c: ReturnType<typeof JSON.parse>) =>
      c.sourceItems?.some((s: ReturnType<typeof JSON.parse>) => s.index === 1)
    )?.column
  ).toBe(1)
  expect(
    after.cells.find((c: ReturnType<typeof JSON.parse>) =>
      c.sourceItems?.some((s: ReturnType<typeof JSON.parse>) => s.index === 1)
    )?.column
  ).toBe(0)
  expect(after.grid[0]).toEqual(['Metric A ↓', 'Metric B ↓', 'Metric C ↓'])
  expect(after.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row > 0)).toEqual(
    before.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row > 0)
  )
  expect(after.grid.slice(1)).toEqual(before.grid.slice(1))
  expect(after.rows).toEqual(before.rows)
  expect(after.cropRect).toEqual(before.cropRect)
  expect(after.issues).toEqual(before.issues)
  expect(
    after.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems ?? [])
      .map((s: object) => JSON.stringify(s))
      .sort()
  ).toEqual(
    before.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems ?? [])
      .map((s: object) => JSON.stringify(s))
      .sort()
  )
  expect(JSON.stringify(f)).toBe(input)
})

const modelHeaderRefusals: [string, (f: ReturnType<typeof postfixNativeExample>) => void][] = [
  [
    'missing model header',
    (f) => {
      f.table.structure.objects = f.table.structure.objects.filter(
        (o: ReturnType<typeof JSON.parse>) => o.label !== 'table column header'
      )
    }
  ],
  [
    'competing model headers',
    (f) => {
      f.table.structure.objects.push(
        structuredClone(
          f.table.structure.objects.find(
            (o: ReturnType<typeof JSON.parse>) => o.label === 'table column header'
          )
        )
      )
    }
  ],
  [
    'model header crosses native opening',
    (f) => {
      f.table.structure.objects.find(
        (o: ReturnType<typeof JSON.parse>) => o.label === 'table column header'
      ).rect[1] = 0
    }
  ],
  [
    'model row crosses native separator',
    (f) => {
      f.table.structure.objects.find(
        (o: ReturnType<typeof JSON.parse>) => o.label === 'table row' && o.rect[1] === 9
      ).rect[3] = 36
    }
  ],
  [
    'model header misses an independent column center',
    (f) => {
      f.table.structure.objects.find(
        (o: ReturnType<typeof JSON.parse>) => o.label === 'table column header'
      ).rect[2] = 200
    }
  ],
  [
    'missing original page',
    (f) => {
      delete f.context.sourcePage
    }
  ],
  [
    'unknown original graphics',
    (f) => {
      f.context.sourcePage.invalidGraphicsBounds = 1
    }
  ],
  [
    'foreign source comparison is not PDFjs normalization',
    (f) => {
      const r = f.context.sourceContent.items[15]
      r.str = 'Q'
      r.sourceItem.text = 'Q'
      f.tokens[15] = tableTextToken(r, f.context.viewport, 0)
    }
  ],
  [
    'missing foreign outline',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs =
        f.context.nativeGlyphContext.glyphBounds[0].glyphs.filter(
          (g: ReturnType<typeof JSON.parse>) => g.fontChar !== 'µ'
        )
    }
  ],
  [
    'foreign source geometry is unbound',
    (f) => {
      const r = f.context.sourceContent.items[15]
      r.transform[4] -= 1
      f.tokens[15] = tableTextToken(r, f.context.viewport, 0)
    }
  ],
  [
    'foreign outline enters the complete header',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
        (g: ReturnType<typeof JSON.parse>) => g.fontChar === 'µ'
      ).bounds = [-25, 9.5, -24.5, 10.2]
    }
  ],
  [
    'foreign outline enters a body record',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
        (g: ReturnType<typeof JSON.parse>) => g.fontChar === 'µ'
      ).bounds = [-21.5, 7.5, -21, 8.2]
    }
  ],
  [
    'claimed text would need normalization',
    (f) => {
      const n = f.context.nativeGlyphContext,
        r = n.content.items[0]
      r.str = 'μetric A'
      r.sourceItem.text = r.str
      n.operators.argsArray[3][0][0] = { unicode: 'µ', fontChar: 'µ', width: 500, isInFont: true }
      f.tokens[0] = tableTextToken(r, f.context.viewport, 0)
    }
  ],
  [
    'extra body paint without source ownership',
    (f) => {
      const n = f.context.nativeGlyphContext,
        operationIndex = n.operators.fnArray.length
      n.operators.fnArray.push(OPS.constructPath)
      n.operators.argsArray.push([
        OPS.fill,
        [new Float32Array([0, 5, 78, 1, 10, 78, 1, 10, 80, 1, 5, 80, 4])],
        new Float32Array([5, 78, 10, 80])
      ])
      n.graphicsBounds.push({
        kind: 'path',
        operationIndex,
        normalizedRect: [5 / 280, 40 / 120, 10 / 280, 42 / 120]
      })
    }
  ],
  ['transparent header paint', (f) => prependPostfixState(f, OPS.setGState, [[['ca', 0]]])],
  ['unproved closing fence', (f) => setPostfixClosingState(f, OPS.setGState, [[['CA', 0]]])],
  ['duplicate closing fence', (f) => appendPostfixRule(f, [0, 90, 250, 90])],
  ['duplicate opening fence', (f) => appendPostfixRule(f, [0, 2, 250, 2])],
  ['duplicate header separator', (f) => appendPostfixRule(f, [0, 22, 250, 22])],
  [
    'competing metric span slot',
    (f) => {
      f.table.structure.objects.push({
        label: 'table spanning cell',
        rect: [0, 37.5, 243.75, 97.5]
      })
    }
  ],
  [
    'repeated native source slot',
    (f) => {
      f.tokens[2].sourceItem.index = f.tokens[0].sourceItem.index
    }
  ],
  [
    'unloaded complete metric source',
    (f) => {
      f.context.nativeGlyphContext.operators.argsArray[3][0][0].isInFont = false
    }
  ],
  [
    'contradicting body centroid',
    (f) => {
      const n = f.context.nativeGlyphContext
      for (let i = 6; i < 15; i += 3) {
        const r = n.content.items[i]
        r.transform[4] += 1
        n.operators.argsArray[i * 5 + 2] = [
          new Float32Array([1, 0, 0, 1, r.transform[4], r.transform[5]])
        ]
        f.tokens[i] = tableTextToken(r, f.context.viewport, 0)
      }
    }
  ]
]

it.each(modelHeaderRefusals)(
  'retains a complete model-header mapping without %s',
  (_label, mutate) => {
    const f = postfixModelHeaderExample()
    mutate(f)
    const input = JSON.stringify(f),
      before = refinePostfixExample(f, { ...f.context, sourcePage: undefined }),
      after = refinePostfixExample(f)
    expect(after).toEqual(before)
    expect(JSON.stringify(f)).toBe(input)
  }
)

it('keeps default packet literals strict and permits only unclaimed one-to-one PDFjs source comparison', () => {
  const f = postfixModelHeaderExample(),
    n = f.context.nativeGlyphContext,
    tokens = n.content.items.map((r: ReturnType<typeof JSON.parse>) =>
      tableTextToken(r, n.viewport, 0)
    ),
    claimed = new Set(Array.from({ length: 15 }, (_, i) => i)),
    input = JSON.stringify(f)
  expect(nativePageTextPacketInventory(f.context.sourcePage, tokens, n, true)).toBeUndefined()
  expect(
    nativePageTextPacketInventory(f.context.sourcePage, tokens, n, true, undefined, true)
  ).toBeUndefined()
  expect(
    nativePageTextPacketInventory(
      f.context.sourcePage,
      tokens,
      n,
      true,
      new Set([...claimed, 15]),
      true
    )
  ).toBeUndefined()
  const proof = nativePageTextPacketInventory(f.context.sourcePage, tokens, n, true, claimed, true),
    foreign = proof?.records.find((r: ReturnType<typeof JSON.parse>) => r.index === 15)
  expect(foreign?.r.str).toBe('μ')
  expect(foreign?.part[0].g.text).toBe('µ')
  expect(foreign?.foreignSourceNormalized).toBe(true)
  expect(JSON.stringify(f)).toBe(input)
})

it('refuses a foreign normalization that expands one native character into multiple source characters', () => {
  const f = postfixModelHeaderExample(),
    n = f.context.nativeGlyphContext,
    item = n.content.items[15]
  item.str = 'fi'
  item.sourceItem.text = 'fi'
  n.operators.argsArray.at(-2)[0][0].unicode = 'ﬁ'
  const tokens = n.content.items.map((r: ReturnType<typeof JSON.parse>) =>
    tableTextToken(r, n.viewport, 0)
  )
  expect(
    nativePageTextPacketInventory(
      f.context.sourcePage,
      tokens,
      n,
      true,
      new Set(Array.from({ length: 15 }, (_, i) => i)),
      true
    )
  ).toBeUndefined()
})

// Three anonymous native ruled blocks, complete original glyphs and two model
// section peers; the middle whole label crosses the stub beside one marker.
function fencedSectionNativeExample(
  bodyRows = 3,
  splitValues = false
): ReturnType<typeof JSON.parse> {
  const width = 320,
    height = 360,
    scale = 1.5,
    cuts = [0, 70, 125, 180, 235, 300],
    entries: [string, number, number][] = [
      ['Setting', 8, 25],
      ...['A', 'B', 'C', 'D'].map(
        (n, c) => ['Metric ' + n, cuts[c + 1] + 5, 25] as [string, number, number]
      )
    ],
    bands = [[13, 30]],
    sectionRows: number[] = []
  for (let section = 0; section < 3; section++) {
    const baseline = 50 + section * 90
    sectionRows.push(bands.length)
    bands.push([baseline - 11, baseline + 3])
    entries.push(
      ['Grouped outcome measures', 8, baseline],
      [String.fromCharCode(80 + section), 132, baseline]
    )
    for (let row = 0; row < bodyRows; row++) {
      const y = baseline + 20 + row * 20
      bands.push([y - 11, y + 3])
      entries.push(['Row ' + String.fromCharCode(65 + row), 8, y])
      for (let col = 1; col < 5; col++) {
        const value = '' + (section + 1) + (row + 1) + col,
          x = cuts[col] + 8
        if (splitValues) entries.push(['.', x, y], [value, x + 5, y])
        else entries.push(['.' + value, x, y])
      }
    }
  }
  const items = entries.map(([str, x, y], index) => ({
      str,
      width: str.length * 5,
      height: 10,
      fontName: 'F',
      dir: 'ltr',
      transform: [10, 0, 0, 10, x, height - y],
      sourceItem: { pageNumber: 1, index, text: str }
    })),
    content = { items, styles: { F: { ascent: 0, descent: 0, vertical: false } } },
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    },
    workViewport = {
      width: width * scale,
      height: height * scale,
      scale,
      rotation: 0,
      transform: [scale, 0, 0, -scale, 0, height * scale],
      convertToViewportPoint: (x, y) => [x * scale, (height - y) * scale]
    },
    operators = { fnArray: [] as number[], argsArray: [] as ReturnType<typeof JSON.parse>[] }
  for (const item of items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      [],
      ['F', 10],
      [new Float32Array([1, 0, 0, 1, item.transform[4], item.transform[5]])],
      [
        Array.from(item.str, (c) => ({
          unicode: c,
          fontChar: c,
          originalCharCode: c.codePointAt(0),
          width: 500,
          isSpace: c === ' ',
          isInFont: true
        }))
      ],
      []
    )
  }
  operators.fnArray.push(OPS.setLineWidth, OPS.setLineCap)
  operators.argsArray.push([0.4], [0])
  const rules = [10, 35, 125, 215, 305].map((y) => [0, y, 300, y]),
    graphicsBounds = rules.map((r) => {
      const operationIndex = operators.fnArray.length
      operators.fnArray.push(OPS.constructPath)
      operators.argsArray.push([
        OPS.stroke,
        [new Float32Array([0, r[0], height - r[1], 1, r[2], height - r[3]])],
        new Float32Array([r[0], height - r[3], r[2], height - r[1]])
      ])
      return {
        kind: 'path',
        operationIndex,
        normalizedRect: r.map((n, i) => n / (i % 2 ? height : width))
      }
    }),
    nativeGlyphContext = {
      content,
      viewport,
      operators,
      graphicsBounds,
      pageNumber: 1,
      sourceSha256: '0'.repeat(64),
      glyphBounds: [
        {
          fontName: 'F',
          glyphs: [...new Set(items.flatMap((i) => Array.from(i.str)))].map((fontChar) => ({
            fontChar,
            bounds: fontChar === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
          }))
        }
      ]
    },
    sourcePage = {
      pageNumber: 1,
      width,
      height,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds
    },
    context = {
      sourcePage,
      nativeGlyphContext,
      viewport: workViewport,
      operators,
      sourceContent: content,
      content,
      rulePaintBounds: new Map()
    },
    tokens = items.map((i) => tableTextToken(i, workViewport, 0)),
    table = {
      id: 'anonymous-fenced-section',
      cropRect: [0, 0, 450, 480],
      structure: {
        objects: [
          ...cuts.slice(0, -1).map((x, c) => ({
            label: 'table column',
            rect: [x * scale, 13 * scale, cuts[c + 1] * scale, 305 * scale]
          })),
          ...bands.map((r) => ({ label: 'table row', rect: [0, r[0] * scale, 450, r[1] * scale] })),
          { label: 'table column header', rect: [0, 13 * scale, 450, 30 * scale] },
          ...sectionRows
            .filter((_, i) => i !== 1)
            .map((r) => ({
              label: 'table projected row header',
              rect: [0, bands[r][0] * scale, 450, bands[r][1] * scale]
            }))
        ]
      }
    }
  return {
    table,
    tokens,
    context,
    rules: collectTableRules(operators, workViewport),
    targetIndex: items.findIndex(
      (i) => i.str === 'Grouped outcome measures' && i.transform[5] === height - 140
    )
  }
}
const refineFencedSectionExample = (
  f: ReturnType<typeof JSON.parse>,
  context = f.context
): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.tokens, [], [], f.rules, [], undefined, context.rulePaintBounds, context)
function insertFencedSectionOperation(
  f: ReturnType<typeof JSON.parse>,
  index: number,
  op: number,
  args: ReturnType<typeof JSON.parse>
): void {
  const o = f.context.operators
  o.fnArray.splice(index, 0, op)
  o.argsArray.splice(index, 0, args)
  for (const g of f.context.sourcePage.graphicsBounds)
    if (g.operationIndex >= index) g.operationIndex++
}
function appendFencedSectionForeign(f: ReturnType<typeof JSON.parse>, paint: boolean): void {
  const c = f.context.nativeGlyphContext,
    o = c.operators
  if (paint) {
    const index = o.fnArray.length
    o.fnArray.push(OPS.constructPath)
    o.argsArray.push([
      OPS.fill,
      [new Float32Array([0, 100, 215, 1, 120, 215, 1, 120, 225, 1, 100, 225, 4])],
      new Float32Array([100, 215, 120, 225])
    ])
    c.graphicsBounds.push({
      kind: 'path',
      operationIndex: index,
      normalizedRect: [100 / 320, 135 / 360, 120 / 320, 145 / 360]
    })
    return
  }
  const sourceItem = { pageNumber: 1, index: c.content.items.length, text: 'Z' },
    item = {
      str: 'Z',
      width: 5,
      height: 10,
      fontName: 'F',
      dir: 'ltr',
      transform: [10, 0, 0, 10, 310, 220],
      sourceItem
    }
  c.content.items.push(item)
  f.tokens.push(tableTextToken(item, f.context.viewport, 0))
  c.glyphBounds[0].glyphs.push({ fontChar: 'Z', bounds: [-11, 0, 0.5, 0.7] })
  o.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
  o.argsArray.push(
    null,
    ['F', 10],
    [new Float32Array([1, 0, 0, 1, 310, 220])],
    [
      [
        {
          unicode: 'Z',
          fontChar: 'Z',
          originalCharCode: 90,
          width: 500,
          isSpace: false,
          isInFont: true
        }
      ]
    ],
    null
  )
}
it.each([false, true])(
  'joins a fully fenced section source without changing records (split values: %s)',
  (splitValues) => {
    const f = fencedSectionNativeExample(3, splitValues),
      snapshot = JSON.stringify({ table: f.table, tokens: f.tokens, context: f.context }),
      before = refineFencedSectionExample(f, { ...f.context, sourcePage: undefined }),
      after = refineFencedSectionExample(f),
      owner = after.cells.find((c: ReturnType<typeof JSON.parse>) =>
        c.sourceItems?.some((i: ReturnType<typeof JSON.parse>) => i.index === f.targetIndex)
      )
    expect(owner).toMatchObject({
      row: 5,
      column: 0,
      colSpan: 5,
      text: 'Grouped outcome measures Q'
    })
    expect(owner.sourceItems.map((i: ReturnType<typeof JSON.parse>) => i.index)).toEqual([
      f.targetIndex,
      f.targetIndex + 1
    ])
    expect(after.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row !== 5)).toEqual(
      before.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row !== 5)
    )
    expect(after.rows).toEqual(before.rows)
    expect(after.grid.filter((_r: unknown, i: number) => i !== 5)).toEqual(
      before.grid.filter((_r: unknown, i: number) => i !== 5)
    )
    expect(after.cropRect).toEqual(before.cropRect)
    expect(after.issues).toEqual(before.issues)
    expect(after.repairs).toContain('native-fenced-section-ownership-recovered')
    expect(JSON.stringify({ table: f.table, tokens: f.tokens, context: f.context })).toBe(snapshot)
  }
)
const fencedSectionRefusals: [string, (f: ReturnType<typeof JSON.parse>) => void][] = [
  [
    'missing original page',
    (f) => {
      delete f.context.sourcePage
    }
  ],
  [
    'invalid original graphics',
    (f) => {
      f.context.sourcePage.invalidGraphicsBounds = 1
    }
  ],
  [
    'partial fonts only',
    (f) => {
      f.context.nativeGlyphContext.partialFontGlyphBounds = f.context.nativeGlyphContext.glyphBounds
      delete f.context.nativeGlyphContext.glyphBounds
    }
  ],
  [
    'missing marker outline',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs =
        f.context.nativeGlyphContext.glyphBounds[0].glyphs.filter(
          (g: ReturnType<typeof JSON.parse>) => g.fontChar !== 'Q'
        )
    }
  ],
  [
    'marker ink outside the proved row',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
        (g: ReturnType<typeof JSON.parse>) => g.fontChar === 'Q'
      ).bounds = [0, 0, 0.5, 3]
    }
  ],
  [
    'empty nonblank marker outline',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
        (g: ReturnType<typeof JSON.parse>) => g.fontChar === 'Q'
      ).bounds = [0, 0, 0, 0]
    }
  ],
  [
    'white claimed text',
    (f) => {
      insertFencedSectionOperation(f, 0, OPS.setFillRGBColor, ['#ffffff'])
    }
  ],
  [
    'unknown alpha state',
    (f) => {
      insertFencedSectionOperation(f, 0, OPS.setGState, [[['ca', 0.5]]])
    }
  ],
  [
    'white native fences',
    (f) => {
      insertFencedSectionOperation(f, 0, OPS.setStrokeRGBColor, ['#ffffff'])
    }
  ],
  [
    'duplicate native separator',
    (f) => {
      const c = f.context.nativeGlyphContext,
        g = c.graphicsBounds[2],
        id = c.operators.fnArray.length
      c.operators.fnArray.push(OPS.constructPath)
      c.operators.argsArray.push(structuredClone(c.operators.argsArray[g.operationIndex]))
      c.graphicsBounds.push({ ...g, operationIndex: id })
    }
  ],
  ['foreign body paint', (f) => appendFencedSectionForeign(f, true)],
  ['foreign glyph ink with exterior advance', (f) => appendFencedSectionForeign(f, false)],
  [
    'painted whitespace',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
        (g: ReturnType<typeof JSON.parse>) => g.fontChar === ' '
      ).bounds = [0, 0, 0.5, 0.7]
    }
  ],
  [
    'incomplete source binding',
    (f) => {
      f.tokens.find(
        (t: ReturnType<typeof JSON.parse>) => t.sourceItem.index === f.targetIndex
      ).sourceItem = { pageNumber: 1, index: f.targetIndex, text: 'different literal' }
    }
  ],
  [
    'missing repeated model section witness',
    (f) => {
      let first = true
      f.table.structure.objects = f.table.structure.objects.filter(
        (o: ReturnType<typeof JSON.parse>) =>
          o.label !== 'table projected row header' || !first || (first = false)
      )
    }
  ],
  [
    'conflicting section span',
    (f) => {
      f.table.structure.objects.push({ label: 'table spanning cell', rect: [0, 193.5, 450, 244.5] })
    }
  ],
  [
    'ordinary prose in a native value lane',
    (f) => {
      const c = f.context.nativeGlyphContext,
        index = c.content.items.findIndex((i: ReturnType<typeof JSON.parse>) => i.str === '.211'),
        item = c.content.items[index]
      item.str = 'word'
      item.sourceItem.text = 'word'
      f.tokens.find((t: ReturnType<typeof JSON.parse>) => t.sourceItem.index === index).text =
        'word'
      c.operators.argsArray[index * 5 + 3] = [
        Array.from('word', (fontChar) => ({
          unicode: fontChar,
          fontChar,
          originalCharCode: fontChar.codePointAt(0),
          width: 500,
          isSpace: false,
          isInFont: true
        }))
      ]
    }
  ],
  [
    'unknown source checksum',
    (f) => {
      delete f.context.nativeGlyphContext.sourceSha256
    }
  ],
  [
    'source rotation mismatch',
    (f) => {
      f.context.sourcePage.renderRotation = 90
    }
  ],
  [
    'duplicate source slot',
    (f) => {
      f.tokens.push(
        structuredClone(
          f.tokens.find((t: ReturnType<typeof JSON.parse>) => t.sourceItem.index === f.targetIndex)
        )
      )
    }
  ]
]
it.each(fencedSectionRefusals)('preserves the full section table without %s', (_name, mutate) => {
  const f = fencedSectionNativeExample()
  mutate(f)
  const before = refineFencedSectionExample(f, { ...f.context, sourcePage: undefined }),
    after = refineFencedSectionExample(f)
  expect(after).toEqual(before)
  expect(after.repairs).not.toContain('native-fenced-section-ownership-recovered')
})
it('keeps two-record fenced sections on their original model spans', () => {
  const f = fencedSectionNativeExample(2)
  expect(refineFencedSectionExample(f)).toEqual(
    refineFencedSectionExample(f, { ...f.context, sourcePage: undefined })
  )
})
