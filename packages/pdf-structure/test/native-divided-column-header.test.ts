import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverClippedColumnHeader } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-header-grid.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

function fixture(divided: boolean, straddles = false): ReturnType<typeof JSON.parse> {
  const cropRect = [20, 48, 230, 160]
  const object = (label: string, r: number[]): ReturnType<typeof JSON.parse> => ({
    label,
    score: 1,
    rect: r.map((v, n) => v - cropRect[n % 2])
  })
  const table = {
    id: 'table',
    cropRect,
    structure: {
      objects: [
        object('table column', [20, 50, 88, 160]),
        object('table column', [88, 50, 230, 160]),
        ...[72, 92, 112, 132].map((y) => object('table row', [20, y, 230, y + 18])),
        object('table spanning cell', [20, 50, 230, 72])
      ]
    }
  }
  const item = (text: string, rect: number[], index: number): ReturnType<typeof JSON.parse> => ({
    text,
    rect,
    baseline: rect[3] - 1,
    height: rect[3] - rect[1],
    horizontal: true,
    sourceItem: { pageNumber: 1, text, index }
  })
  const items = [
    item('Observed outcome', divided && !straddles ? [98, 51, 198, 65] : [70, 51, 150, 65], 0),
    ...[72, 92, 112, 132].flatMap((y, n) => [
      item('Category', [25, y + 3, 75, y + 17], n * 2 + 1),
      item('Observed response', [98, y + 3, 202, y + 17], n * 2 + 2)
    ])
  ]
  const rules = [
    [20, 50, 230, 50],
    [20, 53, 230, 53],
    [20, 72, 230, 72],
    [20, 160, 230, 160],
    [20, 53.3, 20, 71.7],
    [230, 53.3, 230, 71.7],
    [88, 72.3, 88, 94],
    ...(divided ? [[88, 53.3, 88, 71.7]] : [])
  ]
  return { table, items, rules }
}

it('keeps a blank left header face when the native divider crosses the header', () => {
  const { table, items, rules } = fixture(true)
  expect(recoverClippedColumnHeader(table, items, rules)?.dividedHeaderCut).toBe(88)
  const result = refineTable(table, items, [], [], rules)
  expect(result.grid[0]).toEqual(['', 'Observed outcome'])
  expect(result.cells.filter((c: { row: number }) => c.row === 0)).toMatchObject([
    { column: 0, colSpan: 1, text: '', sourceRects: [] },
    { column: 1, colSpan: 1, text: 'Observed outcome', sourceItems: [items[0].sourceItem] }
  ])
})

it.each([false, true])(
  'keeps a centered source heading merged when no empty header face is proved',
  (divided) => {
    const { table, items, rules } = fixture(divided, true)
    expect(recoverClippedColumnHeader(table, items, rules)?.spans).toEqual([[20, 50, 230, 72]])
    const result = refineTable(table, items, [], [], rules)
    expect(result.cells.filter((c: { row: number }) => c.row === 0)).toMatchObject([
      { column: 0, colSpan: 2, text: 'Observed outcome' }
    ])
  }
)
