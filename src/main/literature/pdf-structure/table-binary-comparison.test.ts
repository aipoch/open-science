import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverBinaryComparisonGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-binary-comparison-grid.mjs')).href
)
const token = (text: string, x: number, y: number, width = 25): object => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const caption = [{ lines: ['Table 1. Diagnostic comparisons'], rect: [0, 0, 600, 10] }]
const model = (columns: number): object => ({
  cropRect: [0, 0, columns * 100, 500],
  structure: {
    objects: [
      ...Array.from({ length: columns }, (_, c) => ({
        label: 'table column',
        rect: [c * 100, 0, (c + 1) * 100, 500]
      })),
      { label: 'table row', rect: [0, 0, columns * 100, 500] }
    ]
  }
})
it('restores an omitted diagnostic stub column and both repeated binary matrices', () => {
  const items = [0, 1].flatMap((block) => [
    token('Reference +', 110, 20 + block * 120, 60),
    token('Reference −', 210, 20 + block * 120, 60),
    ...['Index +', 'Index −'].flatMap((label, r) => [
      token(label, 5, 45 + block * 120 + r * 25, 45),
      token(String(20 + r), 110, 45 + block * 120 + r * 25),
      token(String(4 + r), 210, 45 + block * 120 + r * 25)
    ])
  ])
  const matrixModel = {
    cropRect: [0, 0, 400, 500],
    structure: {
      objects: [
        ...[
          [0, 200],
          [200, 300],
          [300, 400]
        ].map(([a, b]) => ({ label: 'table column', rect: [a, 0, b, 500] })),
        { label: 'table row', rect: [0, 0, 400, 500] }
      ]
    }
  }
  const result = refineTable(matrixModel, items, caption)
  expect(result.grid[1]).toEqual(['Index +', '20', '4', ''])
  expect(result.grid[4]).toEqual(['Index +', '20', '4', ''])
  expect(result.unassigned).toEqual([])
  expect(recoverBinaryComparisonGrid(model(3), items, [])).toBeUndefined()
  expect(recoverBinaryComparisonGrid(model(3), items.slice(0, -1), caption)).toBeUndefined()
})
it('keeps repeated comparison parents over their own plus/minus columns', () => {
  const items = [0, 1].flatMap((block) => [
    token(block ? 'Lesion > 10' : 'Total cases', 5, 10 + block * 150, 80),
    token('MethodA n = 40', 110, 35 + block * 150, 120),
    token('MethodB n = 40', 310, 35 + block * 150, 120),
    token('P value', 510, 35 + block * 150, 45),
    ...['+', '−', '+', '−'].map((s, c) => token(s, 110 + c * 100, 55 + block * 150, 8)),
    ...['Histopathology +, n = 20', 'Histopathology − , n = 20'].flatMap((s, r) => [
      token(s, 5, 80 + block * 150 + r * 25, 90),
      ...[1, 2, 3, 4].map((c) => token('10', c * 100 + 10, 80 + block * 150 + r * 25))
    ])
  ])
  const result = refineTable(model(6), items, caption)
  expect(result.cells.filter((c: { colSpan: number }) => c.colSpan === 2)).toHaveLength(4)
  expect(result.cells.filter((c: { colSpan: number }) => c.colSpan === 6)).toHaveLength(2)
  expect(result.unassigned).toEqual([])
})
