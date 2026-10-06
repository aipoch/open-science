import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

const token = (text: string, x: number, y: number): object => ({
  text,
  rect: [x, y, x + Math.max(5, text.length * 5), y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true,
  font: 'Fixture-Regular'
})

it('recovers a clipped symbolic matrix header across all model columns', () => {
  const columnWidth = 20
  const table = {
    id: 'anonymous-clipped-matrix',
    page: 1,
    cropRect: [0, 20, 220, 180],
    structure: {
      objects: [
        ...Array.from({ length: 11 }, (_, column) => ({
          label: 'table column',
          score: 0.99,
          rect: [column * columnWidth, 0, (column + 1) * columnWidth, 160]
        })),
        { label: 'table row', score: 0.99, rect: [0, 20, 220, 40] },
        { label: 'table row', score: 0.99, rect: [0, 40, 220, 60] }
      ]
    }
  }
  const headers = ['A0', 'B0', 'E1', 'E2', 'A∞', 'B∞', 'E5', 'E6', 'A−1', 'B−1', 'LDres']
  const tokens = [
    ...headers.flatMap((text, column) =>
      text === 'LDres'
        ? [token('L', column * columnWidth + 2, 12), token('Dres', column * columnWidth + 8, 12)]
        : [token(text, column * columnWidth + 2, 12)]
    ),
    ...headers.map((_, column) =>
      token(column === 0 ? 'A0' : String(column), column * columnWidth + 2, 42)
    )
  ]
  const result = refineTable(table, tokens, [], [], [[0, 40, 220, 40]])
  expect(result.cropRect[1]).toBeLessThan(20)
  expect(result.grid[0]).toEqual(headers)
  expect(result.unassigned).toEqual([])
})
