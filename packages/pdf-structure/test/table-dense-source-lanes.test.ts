import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverDenseNumericAssignedRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href
)

type Item = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  sourceItem?: { text: string }
}

type Cell = { row: number; column: number; rowSpan: number; colSpan: number; rect: number[] }

function fixture(withEmptyLane = false): {
  items: Item[]
  cells: Cell[]
  rows: { rect: number[] }[]
  assignments: Map<Item, Cell>
  repairs: string[]
} {
  const rows = Array.from({ length: 3 }, (_, row) => ({
    rect: [0, row * 20, 200, (row + 1) * 20]
  }))
  const cells = rows.flatMap((_, row) =>
    Array.from({ length: 10 }, (_, column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 20, row * 20, (column + 1) * 20, (row + 1) * 20]
    }))
  )
  const items: Item[] = rows.flatMap((_, row) =>
    Array.from({ length: 8 }, (_, index) => {
      const column = index + 1 + (withEmptyLane && index >= 3 ? 1 : 0)
      return {
        text: `${index + 1}.25`,
        rect: [column * 20 + 3, row * 20 + 5, column * 20 + 15, row * 20 + 15],
        baseline: row * 20 + 15,
        height: 10,
        horizontal: true
      }
    })
  )
  const assignments = new Map(
    items.map((item, index) => {
      const row = Math.floor(index / 8)
      const column = Math.floor(item.rect[0] / 20)
      return [item, cells.find((cell) => cell.row === row && cell.column === column)!]
    })
  )
  return { items, cells, rows, assignments, repairs: [] as string[] }
}

it('reassigns a dense numeric row only to independently proven source lanes', () => {
  const input = fixture()
  input.assignments.set(input.items[1], input.cells[1])
  expect(recoverDenseNumericAssignedRows(input)).toBe(1)
  expect(input.assignments.get(input.items[1])).toBe(input.cells[2])
  expect(input.repairs).toEqual(['dense-numeric-row-columns-reassigned'])
})

it('does not compact a complete numeric baseline across an empty detector slot', () => {
  const input = fixture(true)
  const before = [...input.assignments]
  expect(recoverDenseNumericAssignedRows(input)).toBe(0)
  expect([...input.assignments]).toEqual(before)
  expect(input.repairs).toEqual([])
})

it('keeps overlapping source lanes unresolved despite a repeated numeric count', () => {
  const input = fixture()
  input.assignments.set(input.items[1], input.cells[1])
  input.cells[1].rect[2] = 55
  const before = [...input.assignments]
  expect(recoverDenseNumericAssignedRows(input)).toBe(0)
  expect([...input.assignments]).toEqual(before)
})

it.each(['local-split', 'source-owner'] as const)(
  'does not use %s fused-token geometry to prove a dense reassignment',
  (kind) => {
    const input = fixture()
    input.assignments.set(input.items[1], input.cells[1])
    const splitSourceItems = kind === 'local-split' ? [input.items[1]] : []
    if (kind === 'source-owner') input.items[1].sourceItem = { text: '1.25 2.25' }
    const before = [...input.assignments]
    expect(recoverDenseNumericAssignedRows({ ...input, splitSourceItems })).toBe(0)
    expect([...input.assignments]).toEqual(before)
  }
)
