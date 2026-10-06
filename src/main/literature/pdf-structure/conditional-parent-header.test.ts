import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

const token = (text: string, x: number, right: number, baseline: number): object => ({
  text,
  rect: [x, baseline - 10, right, baseline],
  baseline,
  height: 10,
  horizontal: true,
  font: 'Fixture-Regular'
})

const fixture = (): ReturnType<typeof JSON.parse> => {
  const columns = [0, 60, 120, 180, 240, 300]
  const rows = [50, 70, 90, 110]
  const table = {
    id: 'anonymous-conditional-header',
    page: 1,
    cropRect: [0, 20, 300, 160],
    structure: {
      objects: [
        ...columns.slice(1).map((right, index) => ({
          label: 'table column',
          score: 0.99,
          rect: [columns[index], 0, right, 140]
        })),
        { label: 'table column header', score: 0.99, rect: [0, 30, 300, 28] },
        ...rows.map((top) => ({
          label: 'table row',
          score: 0.99,
          rect: [0, top - 20, 300, top - 2]
        }))
      ]
    }
  }
  const tokens = [
    token('45 s', 100, 130, 46),
    token('120 s', 220, 260, 46),
    token('Metric', 5, 50, 60),
    token('same', 70, 105, 60),
    token('cross', 130, 165, 60),
    token('same', 190, 225, 60),
    token('cross', 250, 285, 60)
  ]
  for (const [row, label] of ['A', 'B', 'C'].entries()) {
    const baseline = 80 + row * 20
    tokens.push(
      token(label, 5, 35, baseline),
      token('1', 70, 80, baseline),
      token('2', 130, 140, baseline),
      token('3', 190, 200, baseline),
      token('4', 250, 260, baseline)
    )
  }
  return {
    table,
    tokens,
    captions: [{ page: 1, lines: ['Table 1. Conditional metrics.'], rect: [0, 0, 220, 12] }],
    rules: [20, 160].map((y) => [0, y, 300, y])
  }
}

it('preserves paired time parents as spans over their leaf metric columns', () => {
  const f = fixture()
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid[0]).toEqual(['', '45 s', '', '120 s', ''])
  expect(
    result.cells.filter(
      (cell: { row: number; colSpan: number }) => cell.row === 0 && cell.colSpan === 2
    )
  ).toHaveLength(2)
  expect(result.unassigned).toHaveLength(0)
})
