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

it('keeps same-line benchmark parent groups as spans over leaf headers', () => {
  const columns = Array.from({ length: 17 }, (_, index) => index * 100)
  const table = {
    id: 'anonymous-multilevel-header',
    page: 1,
    cropRect: [0, 0, 1600, 300],
    structure: {
      objects: [
        ...columns.slice(1).map((right, index) => ({
          label: 'table column',
          score: 0.99,
          rect: [columns[index], 20, right, 260]
        })),
        { label: 'table column header', score: 0.99, rect: [0, 20, 1600, 90] },
        { label: 'table row', score: 0.99, rect: [0, 20, 1600, 90] },
        { label: 'table row', score: 0.99, rect: [0, 90, 1600, 120] }
      ]
    }
  }
  const tokens = [
    token('Structure Comprehension', 150, 450, 30),
    token('Property Prediction (MAE', 650, 900, 30),
    token('↓', 905, 920, 30),
    token(')', 922, 932, 30),
    token('Molecular Optimization', 1200, 1500, 30),
    token('Setting', 10, 80, 70)
  ]
  for (let column = 1; column < 16; column++)
    tokens.push(token(`Metric ${column}`, columns[column] + 10, columns[column] + 80, 70))
  tokens.push(token('Model', 10, 70, 110))
  for (let column = 1; column < 16; column++)
    tokens.push(token(String(column), columns[column] + 25, columns[column] + 70, 110))
  const result = refineTable(
    table,
    tokens,
    [{ page: 1, lines: ['Table 1. Anonymous benchmark.'], rect: [0, 0, 240, 12] }],
    [],
    [
      [0, 20, 1600, 20],
      [0, 160, 1600, 160]
    ]
  )
  const parentCells = result.cells.filter(
    (cell: { row: number; colSpan: number }) => cell.row === 0 && cell.colSpan > 1
  )
  expect(parentCells.map((cell: { text: string }) => cell.text)).toEqual([
    'Structure Comprehension',
    'Property Prediction (MAE↓)',
    'Molecular Optimization'
  ])
  expect(parentCells.every((cell: { colSpan: number }) => cell.colSpan >= 2)).toBe(true)
  expect(
    parentCells.reduce((total: number, cell: { colSpan: number }) => total + cell.colSpan, 0)
  ).toBe(15)
  expect(result.unassigned).toHaveLength(0)
})
