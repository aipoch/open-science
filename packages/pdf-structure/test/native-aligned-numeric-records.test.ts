import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverNativeAlignedNumericRecords } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href
)

type Band = { rect: number[] }
type Slot = Band & { row: number; column: number; rowSpan: number; colSpan: number }
type NumberItem = Band & {
  baseline: number
  height: number
  text: string
  horizontal: boolean
  sourceItem: { index: number; pageNumber: number; text: string }
}

function numericRecords(): {
  items: NumberItem[]
  cells: Slot[]
  rows: Band[]
  assignments: Map<NumberItem, Slot>
  headerRows: number[]
  ambiguousAssignments: Set<NumberItem>
  rules: number[][]
  splitSourceItems: NumberItem[]
  repairs: string[]
} {
  const cuts = [0, 40, 80, 120, 160, 211, 240, 280, 320]
  const rows = [
    [8, 30],
    [33, 43],
    [47, 58],
    [60, 69]
  ].map(([top, bottom]) => ({
    rect: [0, top, 320, bottom]
  }))
  const cells = rows.flatMap(({ rect }, row) =>
    cuts.slice(0, -1).map((x, column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [x, rect[1], cuts[column + 1], rect[3]]
    }))
  )
  const items = rows.slice(1).flatMap(({ rect }, row) =>
    cuts.slice(0, -1).map((_, column) => {
      const x = column * 40 + 4
      const y = rect[1] + (row === 1 ? 2 : 0)
      const text = column === 3 ? '2.6e-4' : '1.25'
      return {
        rect: [x, y, x + 12, y + 10],
        baseline: y + 10,
        height: 10,
        text,
        horizontal: true,
        sourceItem: { index: row * 8 + column, pageNumber: 1, text }
      }
    })
  )
  const assignments = new Map(
    items.map((item, n) => [item, cells[n + 8 - (n % 8 === 5 ? 1 : 0)]] as const)
  )
  assignments.delete(items[13])
  assignments.delete(items[14])
  return {
    items,
    cells,
    rows,
    assignments,
    headerRows: [0],
    ambiguousAssignments: new Set([items[13], items[14]]),
    rules: [14, 32, 76].map((y) => [0, y, 320, y]),
    splitSourceItems: [],
    repairs: []
  }
}

it('assigns distinct native number runs to repeated left-aligned columns', () => {
  const grid = numericRecords()
  recoverNativeAlignedNumericRecords(grid)
  expect(grid.items.map((item) => grid.assignments.get(item))).toEqual(grid.cells.slice(8))
  expect(grid.ambiguousAssignments.size).toBe(0)
  expect(grid.repairs).toContain('native-aligned-numeric-records-recovered')
})

it.each(['blank', 'merged', 'divider'])('does not infer lanes with a %s', (kind) => {
  const grid = numericRecords()
  if (kind === 'blank') grid.items.splice(13, 1)
  if (kind === 'merged') grid.cells[13].colSpan = 2
  if (kind === 'divider') grid.rules.push([200, 32, 200, 76])
  const prior = new Map(grid.assignments)
  recoverNativeAlignedNumericRecords(grid)
  expect(grid.assignments).toEqual(prior)
  expect(grid.repairs).toEqual([])
})
