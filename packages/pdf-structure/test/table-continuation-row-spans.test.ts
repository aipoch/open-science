import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverDenseNumericContinuationRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href
)

function fixture(anchorAtRemovedRow = false): {
  rows: { rect: number[] }[]
  columnRects: number[][]
  cells: { row: number; column: number; rowSpan: number; colSpan: number; rect: number[] }[]
  items: {
    text: string
    horizontal: boolean
    baseline: number
    height: number
    rect: number[]
    sourceItem: { pageNumber: number; index: number; text: string }
  }[]
  assignments: Map<object, object>
  repairs: string[]
} {
  const rows = Array.from({ length: 6 }, (_, row) => ({ rect: [0, row * 20, 160, (row + 1) * 20] }))
  const columnRects = Array.from({ length: 8 }, (_, column) => [
    column * 20,
    0,
    (column + 1) * 20,
    120
  ])
  const cells = rows.flatMap((row, index) =>
    columnRects.map((rect, column) => ({
      row: index,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [rect[0], row.rect[1], rect[2], row.rect[3]]
    }))
  )
  const owner = cells.find(
    (cell) => cell.row === (anchorAtRemovedRow ? 3 : 1) && cell.column === 0
  )!
  owner.rowSpan = anchorAtRemovedRow ? 2 : 3
  owner.rect[3] = (owner.row + owner.rowSpan) * 20
  for (let index = cells.length - 1; index >= 0; index--)
    if (
      cells[index].column === 0 &&
      cells[index].row > owner.row &&
      cells[index].row < owner.row + owner.rowSpan
    )
      cells.splice(index, 1)
  const sourceItem = { pageNumber: 1, index: 1, text: '0.70 1.04' }
  const items = ['0.70', '1.04'].map((text, index) => ({
    text,
    horizontal: true,
    baseline: 48,
    height: 10,
    rect: [42 + index * 20, 42, 59 + index * 20, 52],
    sourceItem
  }))
  const assignments = new Map<object, object>(
    items.map((item, index) => [
      item,
      cells.find((cell) => cell.row === 3 && cell.column === index + 2)!
    ])
  )
  return { rows, columnRects, cells, items, assignments, repairs: [] }
}

it('projects an existing spanning owner when its empty detector row is removed', () => {
  const input = fixture()
  const owner = input.cells.find((cell) => cell.row === 1 && cell.column === 0)!
  const followingOwner = input.cells.find((cell) => cell.row === 4 && cell.column === 0)!
  const source = input.items[0].sourceItem
  recoverDenseNumericContinuationRows({
    ...input,
    headerRows: [0],
    ambiguousAssignments: new Set()
  })
  expect(input.repairs).toContain('dense-numeric-continuation-row-removed')
  expect(input.rows).toHaveLength(5)
  expect(owner.rowSpan).toBe(2)
  expect(followingOwner.row).toBe(3)
  expect(owner.row + owner.rowSpan).toBe(followingOwner.row)
  expect(input.items[0].sourceItem).toBe(source)
  expect(input.assignments.get(input.items[0])).toBe(
    input.cells.find((cell) => cell.row === 2 && cell.column === 2)
  )
  const occupied = new Set<string>()
  for (const cell of input.cells)
    for (let row = cell.row; row < cell.row + cell.rowSpan; row++) {
      const slot = `${row}:${cell.column}`
      expect(occupied.has(slot)).toBe(false)
      occupied.add(slot)
    }
})

it('keeps an empty detector row that anchors a span over surviving rows', () => {
  const input = fixture(true)
  const owner = input.cells.find((cell) => cell.row === 3 && cell.column === 0)!
  recoverDenseNumericContinuationRows({
    ...input,
    headerRows: [0],
    ambiguousAssignments: new Set()
  })
  expect(input.repairs).toContain('dense-numeric-continuation-row-reassigned')
  expect(input.repairs).not.toContain('dense-numeric-continuation-row-removed')
  expect(input.rows).toHaveLength(6)
  expect(input.cells).toContain(owner)
  expect(owner.rowSpan).toBe(2)
})

it('projects a spanning owner once for each removed detector row', () => {
  const input = fixture()
  const owner = input.cells.find((cell) => cell.row === 1 && cell.column === 0)!
  const followingOwner = input.cells.find((cell) => cell.row === 5 && cell.column === 0)!
  const header = input.cells.find((cell) => cell.row === 0 && cell.column === 0)!
  owner.rowSpan = 4
  owner.rect[3] = 100
  input.cells.splice(
    input.cells.findIndex((cell) => cell.row === 4 && cell.column === 0),
    1
  )
  const sourceItem = { pageNumber: 1, index: 2, text: '2.70 3.04' }
  const more = ['2.70', '3.04'].map((text, index) => ({
    text,
    horizontal: true,
    baseline: 108,
    height: 10,
    rect: [42 + index * 20, 102, 59 + index * 20, 112],
    sourceItem
  }))
  input.items.push(...more)
  for (const [index, item] of more.entries())
    input.assignments.set(
      item,
      input.cells.find((cell) => cell.row === 4 && cell.column === index + 2)!
    )
  recoverDenseNumericContinuationRows({
    ...input,
    headerRows: [0],
    ambiguousAssignments: new Set()
  })
  expect(
    input.repairs.filter((repair) => repair === 'dense-numeric-continuation-row-removed')
  ).toHaveLength(2)
  expect(input.rows).toHaveLength(4)
  expect(owner.rowSpan).toBe(2)
  expect(followingOwner.row).toBe(3)
  expect(owner.row + owner.rowSpan).toBe(followingOwner.row)
  expect(header.row).toBe(0)
  expect(header.rowSpan).toBe(1)
  for (const item of more) expect(input.assignments.get(item)).toMatchObject({ row: 3 })
})
