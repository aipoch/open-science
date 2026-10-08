import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverPairedMetricHeaderGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const { reconcileSourceGroupedHeaders } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )

it('recovers two native paired-metric tiers and preserves all numeric records', () => {
  const f = fixture('wide-paired-metric-source-header')
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid[0]).toEqual([
    'Object',
    ...Array.from({ length: 9 }, (_, index) => [
      `Method ${String.fromCharCode(65 + index)}`,
      ''
    ]).flat()
  ])
  expect(result.grid[1]).toEqual(['', ...Array.from({ length: 9 }, () => ['ADDS', 'ADD']).flat()])
  expect(
    result.cells.filter(
      (cell: { row: number; colSpan: number }) => cell.row === 0 && cell.colSpan === 2
    )
  ).toHaveLength(9)
  const numericSource = f.tokens
    .filter((item: { text: string }) => /^\d+(?:\.\d+)?$/u.test(item.text))
    .map((item: { text: string }) => item.text)
  expect(result.grid.slice(2).flatMap((row: string[]) => row.slice(1))).toEqual(numericSource)
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.repairs).toContain('native-paired-metric-header-recovered')
})

it.each(['missing leaf', 'missing record value', 'misaligned parent', 'no closed frame'])(
  'declines paired header reconstruction with %s',
  (change) => {
    const f = fixture('wide-paired-metric-source-header')
    if (change === 'missing leaf')
      f.tokens.splice(
        f.tokens.findIndex((item: { text: string }) => item.text === 'ADD'),
        1
      )
    if (change === 'missing record value')
      f.tokens.splice(
        f.tokens.findIndex((item: { text: string }) => item.text === '89.0'),
        1
      )
    if (change === 'misaligned parent') {
      const parent = f.tokens.find((item: { text: string }) => item.text === 'Method A')
      parent.rect = parent.rect.map((value: number, index: number) => value + (index % 2 ? 0 : 100))
    }
    if (change === 'no closed frame') f.rules = f.rules.slice(0, 2)
    expect(recoverPairedMetricHeaderGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)

it('recovers a wrapped compute-cost header without moving numeric body values', () => {
  const f = fixture('wrapped-compute-cost-source-header')
  const original = structuredClone(f)
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid.slice(0, 2)).toEqual([
    ['Input frames', 'Model', 'Avg tokens per frame', 'FLOPs (T)', 'Memory(G)', ''],
    ['', '', '', '', 'Train', 'Infer']
  ])
  expect(result.grid[2]).toEqual(['', 'Model A', '196', '224.8', '15.4', '16.7'])
  expect(result.grid.at(-1)).toEqual(['', 'Model C', '16', '9969.5', 'oom', '33.6'])
  expect(
    result.cells.find(
      (cell: { row: number; column: number }) => cell.row === 0 && cell.column === 2
    )
  ).toMatchObject({ rowSpan: 2, colSpan: 1 })
  expect(
    result.cells.find(
      (cell: { row: number; column: number }) => cell.row === 0 && cell.column === 4
    )
  ).toMatchObject({ rowSpan: 1, colSpan: 2 })
  expect(result.repairs).toContain('source-wrapped-compute-header-recovered')
  expect(result.cropRect[1]).toBeLessThan(648.8272)
  expect(result.clipped).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.repairs).toContain('source-wrapped-header-ink-crop-recovered')
  expect(f).toEqual(original)
})

it.each(['missing token', 'incorrect column', 'no header divider'])(
  'does not force a wrapped compute header with %s',
  (change) => {
    const f = fixture('wrapped-compute-cost-source-header')
    if (change === 'missing token')
      f.tokens = f.tokens.filter((item: { text: string }) => item.text !== 'Train')
    if (change === 'incorrect column') {
      const token = f.tokens.find((item: { text: string }) => item.text === 'Infer')
      token.rect = token.rect.map((value: number, index: number) => value - (index % 2 ? 0 : 100))
    }
    if (change === 'no header divider') f.rules = []
    const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(result.repairs).not.toContain('source-wrapped-compute-header-recovered')
  }
)

const token = (
  text: string,
  x: number,
  y: number,
  width = 30
): {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
} => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const groupedSource = (retrieval = false): ReturnType<typeof JSON.parse> => {
  const count = retrieval ? 14 : 8
  const columnRects = Array.from({ length: count }, (_, column) => [
    column * 100,
    0,
    (column + 1) * 100,
    150
  ])
  const rows = [0, 20, 50, 70, 90, 110].map((top, row) => ({
    rect: [0, top, count * 100, [20, 50, 70, 90, 110, 130][row]],
    origin: 'model'
  }))
  const cells = rows.flatMap((row, index) =>
    columnRects.map((rect, column) => ({
      row: index,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [rect[0], row.rect[1], rect[2], row.rect[3]],
      text: index > 1 ? (column ? String(index * 10 + column) : `Model ${index}`) : '',
      sourceTokens: [],
      sourceRects: []
    }))
  )
  const pageItems = retrieval
    ? [
        token('Model', 10, 17),
        token('ReBias', 1310, 17),
        token('%', 1340, 17, 5),
        token('↓', 1345, 17, 5),
        token('Benchmark Spatial Retrieval', 210, 5, 300),
        token('Benchmark Temporal Retrieval', 810, 5, 300),
        ...[1, 4, 7, 10].map((column, index) =>
          token(index % 2 ? 'Video-to-Text' : 'Text-to-Video', column * 100 + 40, 23, 200)
        ),
        ...Array.from({ length: 12 }, (_, index) =>
          token(['R@1', 'R@5', 'R@10'][index % 3], (index + 1) * 100 + 10, 37)
        )
      ]
    : [
        token('Memory Bank', 10, 10, 80),
        token('Memory Capacity', 130, 5, 150),
        token('Benchmark', 450, 5, 200)
      ]
  if (!retrieval) {
    const leaves = ['', 'mt', 'mmain', 'ms', 'SP', 'TP', 'STP', 'Overall']
    for (const cell of cells) if (cell.row === 1) cell.text = leaves[cell.column]
  }
  const rules = retrieval
    ? [
        [100, 21, 1300, 21],
        [0, 49, 1400, 49]
      ]
    : [
        [100, 5, 100, 40],
        [400, 5, 400, 40]
      ]
  return {
    cells,
    rows,
    columnRects,
    headerRows: [0, 1],
    pageItems,
    rules,
    captions: [],
    unassigned: [],
    repairs: []
  }
}

it.each([false, true])(
  'keeps independently delimited memory groups with omitted stub %s',
  (omitStub) => {
    const f = groupedSource()
    if (omitStub)
      f.cells = f.cells.filter(
        (cell: { row: number; column: number }) => cell.row !== 1 || cell.column !== 0
      )
    const body = JSON.stringify(f.cells.filter((cell: { row: number }) => cell.row > 1))
    expect(reconcileSourceGroupedHeaders(f)).toBe(1)
    expect(
      f.cells
        .filter((cell: { row: number }) => cell.row === 0)
        .map((cell: { text: string; colSpan: number; rowSpan: number }) => [
          cell.text,
          cell.colSpan,
          cell.rowSpan
        ])
    ).toEqual([
      ['Memory Bank', 1, 2],
      ['Memory Capacity', 3, 1],
      ['Benchmark', 4, 1]
    ])
    expect(JSON.stringify(f.cells.filter((cell: { row: number }) => cell.row > 1))).toBe(body)
  }
)

it.each([
  'missing separator',
  'misaligned parent',
  'missing leaf',
  'overlapping leaf',
  'nonempty stub'
])('preserves memory diagnostics with %s', (change) => {
  const f = groupedSource()
  if (change === 'missing separator') f.rules.pop()
  if (change === 'misaligned parent') f.pageItems[2].rect = [200, 5, 350, 15]
  if (change === 'missing leaf')
    f.cells = f.cells.filter(
      (cell: { row: number; column: number }) => cell.row !== 1 || cell.column !== 2
    )
  if (change === 'overlapping leaf')
    f.cells.find(
      (cell: { row: number; column: number }) => cell.row === 1 && cell.column === 1
    ).colSpan = 2
  if (change === 'nonempty stub')
    f.cells.find(
      (cell: { row: number; column: number }) => cell.row === 1 && cell.column === 0
    ).text = 'Other'
  expect(reconcileSourceGroupedHeaders(f)).toBe(0)
})

it('reconciles independent memory parents through native body recovery and owns each source once', () => {
  const f = fixture('independent-memory-source-header')
  const original = structuredClone(f)
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.measuredRuns)
  expect(result.repairs).toContain('native-body-records-recovered')
  expect(result.repairs).toContain('text-supported-study-records-recovered')
  expect(result.repairs).toContain('source-independent-memory-headers-recovered')
  expect(result.grid.slice(0, 2)).toEqual([
    ['Memory Bank', 'Memory Capacity', '', '', 'Dataset', '', '', ''],
    ['', 'mt', 'mmain', 'ms', 'SP', 'TP', 'STP', 'Overall']
  ])
  expect(result.grid.slice(2)).toEqual(f.table.grid.slice(1))
  expect(
    result.cells
      .filter((cell: { row: number }) => cell.row === 0)
      .map((cell: { column: number; colSpan: number; rowSpan: number }) => [
        cell.column,
        cell.colSpan,
        cell.rowSpan
      ])
  ).toEqual([
    [0, 1, 2],
    [1, 3, 1],
    [4, 4, 1]
  ])
  const headerCells = result.cells.filter((cell: { row: number }) => cell.row < 2)
  const owned = headerCells.flatMap((cell: { sourceTokens: { text: string; rect: number[] }[] }) =>
    cell.sourceTokens.map((item) => JSON.stringify([item.text, item.rect]))
  )
  const source = f.tokens
    .filter((item: { rect: number[] }) => item.rect[3] <= result.rows[1].rect[3])
    .map((item: { text: string; rect: number[] }) => JSON.stringify([item.text, item.rect]))
  expect(owned.toSorted()).toEqual(source.toSorted())
  expect(new Set(owned).size).toBe(owned.length)
  for (const [column, script] of [
    [1, 't'],
    [2, 'main'],
    [3, 's']
  ]) {
    expect(
      result.cells.find(
        (cell: { row: number; column: number }) => cell.row === 1 && cell.column === column
      ).textRuns
    ).toEqual([
      { text: 'm', position: 'normal' },
      { text: script, position: 'subscript' }
    ])
  }
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(original)
})

it('separates independent retrieval roots, direction groups and rank leaves', () => {
  const f = groupedSource(true)
  const body = f.cells
    .filter((cell: { row: number }) => cell.row > 1)
    .map((cell: { column: number; text: string }) => [cell.column, cell.text])
  expect(reconcileSourceGroupedHeaders(f)).toBe(1)
  expect(
    f.cells
      .filter((cell: { row: number; colSpan: number }) => cell.row === 0 && cell.colSpan === 6)
      .map((cell: { text: string }) => cell.text)
  ).toEqual(['Benchmark Spatial Retrieval', 'Benchmark Temporal Retrieval'])
  expect(
    f.cells.filter((cell: { row: number; colSpan: number }) => cell.row === 1 && cell.colSpan === 3)
  ).toHaveLength(4)
  expect(f.cells.filter((cell: { row: number }) => cell.row === 2)).toHaveLength(12)
  expect(
    f.cells
      .filter((cell: { row: number }) => cell.row > 2)
      .map((cell: { column: number; text: string }) => [cell.column, cell.text])
  ).toEqual(body)
})

it.each(['missing tier rule', 'wrong rank order', 'crossing group', 'body owned by header'])(
  'declines retrieval header recovery with %s',
  (change) => {
    const f = groupedSource(true)
    if (change === 'missing tier rule') f.rules.shift()
    if (change === 'wrong rank order')
      f.pageItems.find((item: { text: string }) => item.text === 'R@5').text = 'R@1'
    if (change === 'crossing group')
      f.pageItems.find((item: { text: string }) => item.text === 'Text-to-Video').rect = [
        500, 23, 800, 33
      ]
    if (change === 'body owned by header') f.cells[0].sourceRects = [[10, 80, 30, 90]]
    expect(reconcileSourceGroupedHeaders(f)).toBe(0)
  }
)
