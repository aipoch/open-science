import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable, reconcileResolvedSpanDiagnostics } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
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
      pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-merges.mjs')).href
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
