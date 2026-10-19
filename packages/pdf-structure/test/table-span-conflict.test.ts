import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable, reconcileResolvedSpanDiagnostics, recoverCenteredGroupedHeaderSpans } =
  await import(pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href)
const { resolveTableCellMerges } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-merges.mjs')).href
)
const token = (text: string, rect: number[]): object => ({
  text,
  rect,
  height: rect[3] - rect[1],
  baseline: rect[3],
  horizontal: true
})
const table = (spans: number[][]): object => ({
  id: 'span-conflict',
  cropRect: [0, 0, 300, 90],
  structure: {
    objects: [
      ...[0, 30, 60].map((y) => ({ label: 'table row', rect: [0, y, 300, y + 30] })),
      ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 90] })),
      ...spans.map((rect) => ({ label: 'table spanning cell', rect }))
    ]
  }
})

it.each([false, true])(
  'retains a valid horizontal merge after rejecting a source-conflicting vertical alternative (reverse: %s)',
  (reverse) => {
    const spans = [
      [0, 0, 200, 30],
      [100, 0, 200, 90]
    ]
    const result = refineTable(table(reverse ? spans.reverse() : spans), [
      token('Group heading', [40, 10, 160, 20]),
      token('First', [110, 40, 150, 50]),
      token('Second', [110, 70, 150, 80])
    ])
    expect(result.cells[0]).toMatchObject({ row: 0, column: 0, colSpan: 2, text: 'Group heading' })
    expect(result.grid.slice(1)).toEqual([
      ['', 'First', ''],
      ['', 'Second', '']
    ])
    expect(result.unassigned).toEqual([])
    expect(result.issues).toContain('span-conflicts-with-source-rows')
    expect(result.reviewCandidate).toBe(false)
    expect(result.issues).not.toContain('conflicting-spanning-cells')
  }
)

it('retains a valid vertical merge after rejecting an alternative that combines independent columns', () => {
  const result = refineTable(
    table([
      [0, 0, 100, 60],
      [0, 0, 300, 30]
    ]),
    [
      token('Shared label', [10, 10, 70, 20]),
      token('10', [110, 10, 140, 20]),
      token('20', [210, 10, 240, 20]),
      token('30', [110, 40, 140, 50])
    ]
  )
  expect(result.cells[0]).toMatchObject({ rowSpan: 2, colSpan: 1, text: 'Shared label' })
  expect(result.grid).toEqual([
    ['Shared label', '10', '20'],
    ['', '30', ''],
    ['', '', '']
  ])
  expect(result.issues).toContain('span-conflicts-with-source-columns')
  expect(result.reviewCandidate).toBe(false)
  expect(result.unassigned).toEqual([])
})

it('keeps genuinely ambiguous overlapping merges unresolved regardless of prediction order', () => {
  const spans = [
    [0, 0, 200, 30],
    [0, 0, 100, 60]
  ]
  for (const alternatives of [spans, [...spans].reverse()]) {
    const result = refineTable(table(alternatives), [token('Label', [10, 10, 70, 20])])
    expect(result.cells).toHaveLength(9)
    expect(
      result.cells.every(
        (cell: { rowSpan: number; colSpan: number }) => cell.rowSpan === 1 && cell.colSpan === 1
      )
    ).toBe(true)
    expect(result.issues).toContain('conflicting-spanning-cells')
    expect(result.reviewCandidate).toBe(false)
  }
})

it('preserves empty cells without inventing merges', () => {
  const source = table([])
  const result = refineTable(source, [
    token('Label', [10, 10, 70, 20]),
    token('42', [210, 70, 240, 80])
  ])
  expect(result.cells).toHaveLength(9)
  expect(result.grid).toEqual([
    ['Label', '', ''],
    ['', '', ''],
    ['', '', '42']
  ])
})

it.each([
  { span: [0, 0, 200, 30], issue: 'span-conflicts-with-source-columns' },
  { span: [0, 0, 100, 60], issue: 'span-conflicts-with-source-rows' }
])('retains $issue even when a dense singleton grid is complete', ({ span, issue }) => {
  const rows = Array.from({ length: 12 }, (_, row) => ({
    label: 'table row',
    rect: [0, row * 30, 400, (row + 1) * 30]
  }))
  const columns = Array.from({ length: 4 }, (_, column) => ({
    label: 'table column',
    rect: [column * 100, 0, (column + 1) * 100, 360]
  }))
  const items = rows.flatMap((_, row) =>
    columns.map((_, column) =>
      token(
        column ? ['Low', 'Medium', 'High'][column - 1] : `Label ${String.fromCharCode(65 + row)}`,
        [column * 100 + 10, row * 30 + 10, column * 100 + 70, row * 30 + 20]
      )
    )
  )
  const result = refineTable(
    {
      id: 'dense-unresolved-merge',
      cropRect: [0, 0, 400, 360],
      structure: {
        objects: [...rows, ...columns, { label: 'table spanning cell', rect: span }]
      }
    },
    items
  )
  expect(result.grid).toHaveLength(12)
  expect(result.cells).toHaveLength(48)
  expect(result.unassigned).toEqual([])
  expect(result.issues).toContain(issue)
  expect(result.reviewCandidate).toBe(false)
})

it('clears source-span diagnostics after trusted repairs settle a complete grid', () => {
  const issues = new Set([
    'overlapping-predicted-columns',
    'span-conflicts-with-source-columns',
    'span-conflicts-with-source-rows',
    'conflicting-spanning-cells',
    'nonrectangular-spanning-cell'
  ])
  const repairs = ['header-span-inferred', 'text-supported-row-recovered']
  const cells = [
    { row: 0, column: 0, rowSpan: 1, colSpan: 2 },
    { row: 0, column: 2, rowSpan: 1, colSpan: 1 },
    { row: 1, column: 0, rowSpan: 1, colSpan: 1 },
    { row: 1, column: 1, rowSpan: 1, colSpan: 1 },
    { row: 1, column: 2, rowSpan: 1, colSpan: 1 }
  ]
  expect(
    reconcileResolvedSpanDiagnostics({
      cells,
      rows: [{}, {}],
      columns: [{}, {}, {}],
      unassigned: [],
      issues,
      repairs
    })
  ).toBe(true)
  expect(issues).toEqual(new Set())
  expect(repairs).toContain('resolved-span-conflicts-discarded')
})

it('recovers a uniquely underlined grouped header from source ownership', () => {
  const rows = [{ rect: [0, 0, 400, 20] }, { rect: [0, 20, 400, 40] }]
  const columns = Array.from({ length: 4 }, (_, column) => ({
    rect: [column * 100, 0, (column + 1) * 100, 40]
  }))
  const title = [token('Grouped', [175, 3, 205, 10]), token('header', [180, 11, 220, 18])]
  const childTokens = ['A', 'B', 'C', 'D'].map((text, column) =>
    token(text, [column * 100 + 20, 24, column * 100 + 40, 32])
  )
  const cells = [
    {
      row: 0,
      column: 0,
      rowSpan: 1,
      colSpan: 1,
      rect: [0, 0, 100, 20],
      text: '',
      sourceTokens: []
    },
    {
      row: 0,
      column: 1,
      rowSpan: 1,
      colSpan: 1,
      rect: [100, 0, 200, 20],
      text: '',
      sourceTokens: []
    },
    {
      row: 0,
      column: 2,
      rowSpan: 1,
      colSpan: 1,
      rect: [200, 0, 300, 20],
      text: 'Grouped header',
      sourceTokens: title
    },
    {
      row: 0,
      column: 3,
      rowSpan: 1,
      colSpan: 1,
      rect: [300, 0, 400, 20],
      text: '',
      sourceTokens: []
    },
    ...childTokens.map((source, column) => ({
      row: 1,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 100, 20, (column + 1) * 100, 40],
      text: source.text,
      sourceTokens: [source]
    }))
  ]
  const issues = new Set(['span-conflicts-with-source-columns'])
  const repairs: string[] = []
  expect(
    recoverCenteredGroupedHeaderSpans({
      cells,
      rows,
      columns,
      items: [...title, ...childTokens],
      headerRows: [0, 1],
      rules: [[100, 19, 300, 19]],
      unassigned: [],
      issues,
      repairs
    })
  ).toBe(1)
  expect(cells.find((cell) => cell.row === 0 && cell.text === 'Grouped header')).toMatchObject({
    column: 1,
    colSpan: 2
  })
  expect(repairs).toContain('source-centered-grouped-header-span-recovered')
  expect(issues).toContain('span-conflicts-with-source-columns')
})

it('retains an independent body column conflict after restoring a grouped header', () => {
  const rows = [0, 20, 40].map((top) => ({ rect: [0, top, 400, top + 20] }))
  const columns = [0, 1, 2, 3].map((column) => ({
    rect: [column * 100, 0, (column + 1) * 100, 60]
  }))
  const title = [token('Grouped', [175, 3, 205, 10]), token('header', [180, 11, 220, 18])]
  const leaves = ['A', 'B', 'C', 'D'].map((text, column) =>
    token(text, [column * 100 + 20, 24, column * 100 + 40, 32])
  )
  const body = [token('North', [20, 44, 60, 52]), token('South', [120, 44, 160, 52])]
  const cells = [0, 1, 2].flatMap((row) =>
    [0, 1, 2, 3].map((column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 100, row * 20, (column + 1) * 100, row * 20 + 20],
      text:
        row === 0
          ? column === 2
            ? 'Grouped header'
            : ''
          : row === 1
            ? ['A', 'B', 'C', 'D'][column]
            : ['North', 'South', '', ''][column],
      sourceTokens:
        row === 0
          ? column === 2
            ? title
            : []
          : row === 1
            ? [leaves[column]]
            : body[column]
              ? [body[column]]
              : [],
      items: []
    }))
  )
  const items = [...title, ...leaves, ...body]
  const issues = new Set<string>()
  const repairs: string[] = []
  resolveTableCellMerges({
    proposals: [
      { origin: 'model-span', slots: cells.filter((cell) => cell.row === 2 && cell.column < 2) }
    ],
    baseCells: cells,
    items,
    rows,
    headerRows: [0, 1],
    headerRuns: new Map(),
    rules: [],
    populatedColumns: new Set([0, 1, 2, 3]),
    issues,
    repairs
  })
  expect(issues).toEqual(new Set(['span-conflicts-with-source-columns']))
  const unchangedBody = structuredClone(cells.filter((cell) => cell.row === 2))
  expect(
    recoverCenteredGroupedHeaderSpans({
      cells,
      rows,
      columns,
      items,
      headerRows: [0, 1],
      rules: [[100, 19, 300, 19]],
      unassigned: [],
      issues,
      repairs
    })
  ).toBe(1)
  expect(cells.filter((cell) => cell.row === 2)).toEqual(unchangedBody)
  expect(issues).toContain('span-conflicts-with-source-columns')
})

it('retains source-span diagnostics without trusted repair evidence', () => {
  const issues = new Set(['span-conflicts-with-source-rows'])
  const repairs: string[] = []
  expect(
    reconcileResolvedSpanDiagnostics({
      cells: [{ row: 0, column: 0, rowSpan: 1, colSpan: 1 }],
      rows: [{}],
      columns: [{}],
      unassigned: [],
      issues,
      repairs
    })
  ).toBe(false)
  expect(issues).toEqual(new Set(['span-conflicts-with-source-rows']))
})

it.each(['outside owner', 'crossing leaf', 'missing native source', 'overlap', 'ambiguous'])(
  'refuses a grouped header with %s evidence',
  (kind) => {
    const title = [token('Parent', [175, 3, 205, 10]), token('heading', [180, 11, 220, 18])]
    const leaves = [0, 1, 2, 3].map((c) => token(`Leaf ${c}`, [c * 100 + 20, 24, c * 100 + 40, 32]))
    const parentColumn = kind === 'outside owner' ? 0 : 2
    const cells = [0, 1].flatMap((row) =>
      [0, 1, 2, 3].map((column) => ({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column * 100, row * 20, (column + 1) * 100, (row + 1) * 20],
        text: row ? `Leaf ${column}` : column === parentColumn ? 'Parent heading' : '',
        sourceTokens: row ? [leaves[column]] : column === parentColumn ? title : []
      }))
    )
    if (kind === 'crossing leaf') leaves[1].rect = [120, 24, 240, 32]
    const items = [...title, ...leaves]
    if (kind === 'missing native source') items.splice(items.indexOf(leaves[1]), 1)
    const issues = new Set(['span-conflicts-with-source-columns'])
    if (kind === 'overlap') issues.add('overlapping-predicted-columns')
    if (kind === 'ambiguous') issues.add('ambiguous-cell-assignment')
    const before = structuredClone(cells)
    const repairs: string[] = []
    expect(
      recoverCenteredGroupedHeaderSpans({
        cells,
        rows: [{ rect: [0, 0, 400, 20] }, { rect: [0, 20, 400, 40] }],
        columns: [0, 1, 2, 3].map((c) => ({ rect: [c * 100, 0, (c + 1) * 100, 40] })),
        items,
        headerRows: [0, 1],
        rules: [[100, 19, 300, 19]],
        unassigned: [],
        issues,
        repairs
      })
    ).toBe(0)
    expect(cells).toEqual(before)
    expect(repairs).toEqual([])
    expect(issues).toContain('span-conflicts-with-source-columns')
  }
)

it('does not treat a local grouped-header repair as proof of unrelated table conflicts', () => {
  const issues = new Set(['span-conflicts-with-source-rows', 'overlapping-predicted-columns'])
  const repairs = ['source-centered-grouped-header-span-recovered']
  expect(
    reconcileResolvedSpanDiagnostics({
      cells: [{ row: 0, column: 0, rowSpan: 1, colSpan: 1 }],
      rows: [{}],
      columns: [{}],
      unassigned: [],
      issues,
      repairs
    })
  ).toBe(false)
  expect(issues.size).toBe(2)
})

it('retains source conflicts while an unresolved span remains', () => {
  const issues = new Set(['span-conflicts-with-source-columns', 'unresolved-spanning-cells'])
  const repairs = ['wrapped-header-recovered', 'ruled-final-continuation-recovered']
  expect(
    reconcileResolvedSpanDiagnostics({
      cells: [{ row: 0, column: 0, rowSpan: 1, colSpan: 1 }],
      rows: [{}],
      columns: [{}],
      unassigned: [],
      issues,
      repairs
    })
  ).toBe(false)
  expect(issues).toEqual(
    new Set(['span-conflicts-with-source-columns', 'unresolved-spanning-cells'])
  )
})

it('deduplicates a rectangular merge and retains its text exactly once', () => {
  const result = refineTable(
    table([
      [0, 0, 200, 60],
      [0, 0, 200, 60]
    ]),
    [
      token('Shared block', [40, 25, 160, 35]),
      token('10', [210, 10, 240, 20]),
      token('20', [210, 40, 240, 50])
    ]
  )
  expect(result.cells[0]).toMatchObject({ rowSpan: 2, colSpan: 2, text: 'Shared block' })
  expect(result.cells).toHaveLength(6)
  expect(result.grid).toEqual([
    ['Shared block', '', '10'],
    ['', '', '20'],
    ['', '', '']
  ])
  expect(result.issues).toEqual([])
})

it('retains a centered wrapped label in a vertical merged cell without joining independent row values', () => {
  const result = refineTable(table([[0, 0, 100, 60]]), [
    token('Shared', [10, 19, 65, 29]),
    token('label', [10, 31, 60, 41]),
    token('10', [110, 10, 140, 20]),
    token('20', [110, 40, 140, 50])
  ])
  expect(result.cells[0]).toMatchObject({ rowSpan: 2, colSpan: 1, text: 'Shared label' })
  expect(result.grid.slice(0, 2)).toEqual([
    ['Shared label', '10', ''],
    ['', '20', '']
  ])
})

it.each([0, 1])(
  'does not mistake adjacent numeric values for a wrapped label in column %s',
  (column) => {
    const x = column * 100
    const result = refineTable(table([[x, 0, x + 100, 60]]), [
      token('10', [x + 10, 19, x + 40, 29]),
      token('20', [x + 10, 31, x + 40, 41])
    ])
    expect(result.grid[0][column]).toBe('10')
    expect(result.grid[1][column]).toBe('20')
    expect(result.issues).toContain('span-conflicts-with-source-rows')
  }
)

it.each([false, true])(
  'reconciles a ruled header/body boundary in either source order: %s',
  async (reverse) => {
    const { reconcileUnresolvedTableSpans } = await import(
      pathToFileURL(resolve('resources/literature-pdf-table-cell-merges.mjs')).href
    )
    const header = { text: 'Treatment', rect: [0, 0, 30, 10] },
      value = { text: '4.13', rect: [0, 20, 30, 30] }
    const cells = [
      { row: 0, column: 0, text: 'Treatment', sourceTokens: [header] },
      { row: 1, column: 0, text: '4.13', sourceTokens: [value] }
    ]
    const check = (
      items: (typeof header)[],
      rules: number[][]
    ): { issues: Set<string>; repairs: string[] } => {
      const issues = new Set<string>(),
        repairs: string[] = []
      reconcileUnresolvedTableSpans({
        spans: [{ rect: [0, 0, 40, 40] }],
        cells,
        items,
        rows: [],
        rules,
        issues,
        repairs
      })
      return { issues, repairs }
    }
    const items = reverse ? [value, header] : [header, value]
    expect(check(items, [[0, 15, 40, 15]]).issues.size).toBe(0)
    expect(check(items, []).issues.has('unresolved-spanning-cells')).toBe(true)
    const wrapped = { text: 'continued', rect: [0, 16, 30, 26] }
    cells[0].sourceTokens.push(wrapped)
    expect(
      check([...items, wrapped], [[0, 15, 40, 15]]).issues.has('unresolved-spanning-cells')
    ).toBe(true)
  }
)
