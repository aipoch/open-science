import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

it('keeps centered record labels when model rows stop short of complete value columns', () => {
  const item = (text: string, x: number, y: number, width = 10): object => ({
    text,
    rect: [x, y, x + width, y + 8],
    height: 8,
    baseline: y + 8,
    horizontal: true
  })
  const items = [
    item('Method', 5, 3, 30),
    item('Metric', 52, 3, 25),
    item('A', 91, 3),
    item('B', 131, 3),
    ...[20, 32, 48, 60].flatMap((y, n) => [
      item(n % 2 ? 'Rate' : 'Score', 52, y, 25),
      item(String(10 + n), 91, y),
      item(String(20 + n), 131, y)
    ]),
    item('Alpha', 5, 26, 25),
    item('Beta', 5, 54, 25)
  ]
  const table = {
    id: 'page-1-table-1',
    cropRect: [0, 0, 150, 75],
    structure: {
      objects: [
        ...[
          [0, 46],
          [46, 85],
          [85, 120],
          [120, 150]
        ].map(([a, b]) => ({ label: 'table column', rect: [a, 0, b, 75] })),
        ...[3, 20, 32, 48, 60].map((y) => ({ label: 'table row', rect: [0, y - 2.5, 132, y + 9] })),
        { label: 'table column header', rect: [0, 0, 150, 14] },
        ...[20, 48].map((y) => ({ label: 'table spanning cell', rect: [0, y - 1, 46, y + 21] }))
      ]
    }
  }
  const result = refineTable(table, items, [
    { page: 1, lines: ['Table 1: Comparison.'], rect: [0, -15, 150, -5] }
  ])
  expect(result.grid).toHaveLength(5)
  expect(result.grid.slice(1).map((row: string[]) => row.slice(1))).toEqual([
    ['Score', '10', '20'],
    ['Rate', '11', '21'],
    ['Score', '12', '22'],
    ['Rate', '13', '23']
  ])
  expect(
    result.cells
      .filter((cell: { text: string }) => ['Alpha', 'Beta'].includes(cell.text))
      .map((cell: { row: number; rowSpan: number }) => [cell.row, cell.rowSpan])
  ).toEqual([
    [1, 2],
    [3, 2]
  ])
  expect(result.unassigned).toEqual([])
})
