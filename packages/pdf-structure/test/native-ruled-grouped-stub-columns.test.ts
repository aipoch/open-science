import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

type Token = {
  text: string
  rect: [number, number, number, number]
  baseline: number
  height: number
  horizontal: boolean
  sourceItem: { pageNumber: number; index: number; text: string }
}

type Rule = [number, number, number, number]

type Fixture = {
  pageItems: Token[]
  rules: Rule[]
  table: {
    id: string
    rowCount: number
    columnCount: number
    cropRect: [number, number, number, number]
    structure: { objects: Array<{ label: string; rect: [number, number, number, number] }> }
  }
}

const fixture = (): Fixture => {
  const crop: [number, number, number, number] = [100, 100, 424, 200]
  const oldEdges = [161, 211, 243, 269, 295, 323, 351, 382, 424]
  const metricCuts = [180, ...oldEdges.slice(1)]
  const pageItems: Token[] = []
  let index = 0
  const token = (text: string, x: number, y: number, width = 8): void => {
    pageItems.push({
      text,
      rect: [x, y - 7, x + width, y],
      baseline: y,
      height: 7,
      horizontal: true,
      sourceItem: { pageNumber: 7, index: index++, text }
    })
  }
  token('Measure', 205, 111, 28)
  token('Quality', 286, 111, 24)
  token('Dataset', 104, 117, 18)
  token('Method', 138, 117, 22)
  for (let column = 0; column < 8; column++)
    token(`Metric ${column + 1}`, (metricCuts[column] + metricCuts[column + 1]) / 2 - 9, 117, 18)

  for (const [row, baseline] of [128, 136, 144, 152, 168, 176, 184, 192].entries()) {
    token(`Model ${row + 1}`, 137, baseline, 30)
    for (let column = 0; column < 8; column++) {
      const center = (metricCuts[column] + metricCuts[column + 1]) / 2
      token(String((row + 1) * 10 + column), center - 4, baseline, 8)
    }
  }
  token('Set A', 104, 141, 18)
  token('Set B', 104, 181, 18)

  const rules: Rule[] = [
    [100, 100, 424, 100],
    [100, 120, 424, 120],
    [100, 160, 424, 160],
    [100, 200, 424, 200]
  ]
  for (const [left, right] of [
    [122, 158],
    [162, 198]
  ])
    for (const x of [125, 180, 238, 308, 365]) rules.push([x, left, x, right])

  return {
    pageItems,
    rules,
    table: {
      id: 'page-7-table-1',
      rowCount: 10,
      columnCount: 9,
      cropRect: crop,
      structure: {
        objects: [
          ...oldEdges.map((right, index) => ({
            label: 'table column',
            rect: [
              index ? oldEdges[index - 1] - crop[0] : 0,
              0,
              right - crop[0],
              crop[3] - crop[1]
            ] as [number, number, number, number]
          })),
          ...[100, 120, 160, 200].slice(0, -1).map((top, index) => ({
            label: 'table row',
            rect: [0, top - crop[1], crop[2] - crop[0], [120, 160, 200][index] - crop[1]] as [
              number,
              number,
              number,
              number
            ]
          }))
        ]
      }
    }
  }
}

const run = (f: Fixture): ReturnType<typeof refineTable> =>
  refineTable(f.table, f.pageItems, [], [], f.rules)

it('separates native paired stubs and assigns centered group labels to full record spans', () => {
  const f = fixture()
  const result = run(f)

  expect(result.repairs).toContain('native-ruled-grouped-stub-columns-recovered')
  expect(result.grid).toHaveLength(10)
  expect(result.grid[1].slice(0, 2)).toEqual(['Dataset', 'Method'])
  expect(result.grid.slice(2).map((row) => row.slice(1, 3))).toEqual(
    Array.from({ length: 8 }, (_, row) => [`Model ${row + 1}`, `${(row + 1) * 10}`])
  )
  const spans = result.cells.filter((cell) => cell.column === 0 && cell.rowSpan > 1)
  expect(spans.map((cell) => [cell.row, cell.rowSpan, cell.text])).toEqual([
    [2, 4, 'Set A'],
    [6, 4, 'Set B']
  ])
  const owners = result.cells.flatMap((cell) =>
    (cell.sourceItems ?? []).map((item) => `${item.pageNumber}:${item.index}:${item.text}`)
  )
  expect(owners.sort()).toEqual(
    f.pageItems
      .map(
        (item) => `${item.sourceItem.pageNumber}:${item.sourceItem.index}:${item.sourceItem.text}`
      )
      .sort()
  )
  expect(result.unassigned).toEqual([])
})

it.each([
  'missing native stub rail',
  'unequal ruled groups',
  'group label crosses a group fence',
  'numeric glyph crosses a column lane',
  'source glyph crosses the crop boundary',
  'missing model grid rows'
])('rejects incomplete grouped evidence: %s', (variant) => {
  const f = fixture()
  if (variant === 'missing model grid rows') {
    f.table.rowCount = 0
    f.table.columnCount = 0
    f.table.structure.objects = []
  } else if (variant === 'missing native stub rail') {
    f.rules = f.rules.filter((rule) => !(rule[0] === 180 && rule[2] === 180))
  } else if (variant === 'unequal ruled groups') {
    f.pageItems = f.pageItems.filter((item) => item.text !== 'Set B')
  } else if (variant === 'group label crosses a group fence') {
    const label = f.pageItems.find((item) => item.text === 'Set A')!
    label.rect[1] = 159
    label.rect[3] = 164
  } else if (variant === 'numeric glyph crosses a column lane') {
    const numeric = f.pageItems.find((item) => item.text === '10')!
    numeric.rect[0] = 174
    numeric.rect[2] = 185
  } else {
    f.pageItems.push({
      text: 'edge',
      rect: [98, 130, 105, 137],
      baseline: 137,
      height: 7,
      horizontal: true,
      sourceItem: { pageNumber: 7, index: 999, text: 'edge' }
    })
  }
  const result = run(f)
  expect(result.repairs).not.toContain('native-ruled-grouped-stub-columns-recovered')
})

const groupedSpanFixture = (groupSizes: number[]): Fixture => {
  const finalBottom = 130 + groupSizes.reduce((sum, size) => sum + size * 8 + 7, 0)
  const crop: [number, number, number, number] = [100, 100, 424, finalBottom]
  const edges = [125, 160, 193, 226, 259, 292, 325, 358, 391, 424]
  const pageItems: Token[] = []
  let index = 0
  const token = (text: string, x: number, baseline: number, width = 8): void => {
    pageItems.push({
      text,
      rect: [x, baseline - 6, x + width, baseline],
      baseline,
      height: 6,
      horizontal: true,
      sourceItem: { pageNumber: 6, index: index++, text }
    })
  }
  token('Dataset', 102, 108, 20)
  token('Method', 130, 108, 22)
  token('Success Rate', 250, 108, 54)
  for (let metric = 0; metric < 4; metric++)
    token(`Metric ${metric + 1}`, 192 + metric * 66, 116, 28)
  for (let metric = 0; metric < 8; metric++)
    token(metric % 2 ? 'Std.' : 'Mean', 166 + metric * 33, 124, 20)

  const baselines: number[] = []
  const boundaries = [130]
  let nextRecord = 1
  for (const [group, size] of groupSizes.entries()) {
    const top = boundaries.at(-1)!
    for (let offset = 0; offset < size; offset++) {
      const baseline = top + 8 + offset * 8
      baselines.push(baseline)
      token(`Method ${nextRecord}`, 130, baseline, 24)
      for (let metric = 0; metric < 8; metric++)
        token(`${nextRecord}.${metric + 1}`, 167 + metric * 33, baseline, 18)
      nextRecord++
    }
    const bottom = top + size * 8 + 7
    boundaries.push(bottom)
    token(`Group ${String.fromCharCode(65 + group)}`, 102, top + 8 + Math.floor(size / 2) * 8, 22)
  }

  const rowRects = [
    [100, 110],
    [110, 120],
    [120, 130],
    ...baselines.map((baseline) => [baseline - 7, baseline + 1])
  ]
  const f: Fixture = {
    pageItems,
    rules: [
      [100, 100, 424, 100],
      [100, 130, 424, 130],
      ...boundaries.slice(1).map((y): Rule => [100, y, 424, y]),
      [125, 130, 125, finalBottom],
      [160, 130, 160, finalBottom]
    ],
    table: {
      id: 'page-6-table-1',
      rowCount: 3 + baselines.length,
      columnCount: 10,
      cropRect: crop,
      structure: {
        objects: [
          ...edges.map((right, column) => ({
            label: 'table column',
            rect: [
              column ? edges[column - 1] - crop[0] : 0,
              0,
              right - crop[0],
              crop[3] - crop[1]
            ] as [number, number, number, number]
          })),
          ...rowRects.map(([top, bottom]) => ({
            label: 'table row',
            rect: [0, top - crop[1], crop[2] - crop[0], bottom - crop[1]] as [
              number,
              number,
              number,
              number
            ]
          }))
        ]
      }
    }
  }
  return f
}

it.each([
  [6, 6],
  [3, 4],
  [2, 3, 4]
])(
  'spans centered dataset labels across %i native record groups without rewriting three header tiers',
  (...groupSizes: number[]) => {
    const f = groupedSpanFixture(groupSizes)
    const { pageItems } = f
    const result = run(f)
    expect(result.grid).toHaveLength(3 + groupSizes.reduce((sum, size) => sum + size, 0))
    expect(result.grid.slice(0, 3).map((row) => row[0])).toEqual(['Dataset', '', ''])
    expect(
      result.cells
        .filter((cell) => cell.column === 0 && cell.rowSpan > 1)
        .map((cell) => [cell.row, cell.rowSpan, cell.text])
    ).toEqual(
      groupSizes.map((size, index) => [
        3 + groupSizes.slice(0, index).reduce((sum, value) => sum + value, 0),
        size,
        `Group ${String.fromCharCode(65 + index)}`
      ])
    )
    const bodyOwners = result.cells
      .filter((cell) => cell.row >= 3)
      .flatMap((cell) =>
        (cell.sourceItems ?? []).map((item) => `${item.pageNumber}:${item.index}:${item.text}`)
      )
      .sort()
    expect(bodyOwners).toEqual(
      pageItems
        .filter((item) => item.baseline > 130)
        .map(
          (item) => `${item.sourceItem.pageNumber}:${item.sourceItem.index}:${item.sourceItem.text}`
        )
        .sort()
    )
    for (const cell of result.cells.filter(
      (candidate) => candidate.column === 0 && candidate.rowSpan > 1
    ))
      expect(
        result.cells.filter(
          (candidate) =>
            candidate !== cell &&
            candidate.column === 0 &&
            candidate.row >= cell.row &&
            candidate.row < cell.row + cell.rowSpan
        )
      ).toEqual([])
    for (let left = 0; left < result.cells.length; left++)
      for (let right = left + 1; right < result.cells.length; right++) {
        const a = result.cells[left]
        const b = result.cells[right]
        expect(
          a.row < b.row + b.rowSpan &&
            b.row < a.row + a.rowSpan &&
            a.column < b.column + b.colSpan &&
            b.column < a.column + a.colSpan
        ).toBe(false)
      }
  }
)

it.each(['missing between-group fence', 'label glyph crosses group fence'])(
  'keeps centered labels unspanned with %s',
  (variant) => {
    const f = groupedSpanFixture([3, 4])
    if (variant === 'missing between-group fence') {
      f.rules = f.rules.filter((rule) => rule[1] !== 161)
    } else {
      const label = f.pageItems.find((item) => item.text === 'Group A')!
      label.rect[1] = 160
      label.rect[3] = 162
    }
    const result = run(f)
    expect(result.repairs).not.toContain('native-ruled-grouped-stub-spans-recovered')
    expect(
      result.cells.filter(
        (cell) => cell.column === 0 && cell.rowSpan >= (cell.text === 'Group A' ? 3 : 4)
      )
    ).toEqual([])
  }
)
