import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { populateTableCellText, recoverNativeInlineSmallCaps } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href
)

type NativeItem = {
  text: string
  rect: number[]
  height: number
  baseline: number
  horizontal: boolean
  sourceItem: { pageNumber: number; index: number; text: string }
}
type Cell = {
  row: number
  column: number
  rowSpan: number
  colSpan: number
  rect: number[]
  items: NativeItem[]
  text: string
}
type Fixture = {
  rows: { rect: number[] }[]
  columnRects: number[][]
  cells: Cell[]
  items: NativeItem[]
  pageItems: NativeItem[]
  assignments: Map<NativeItem, Cell>
  ambiguousAssignments: Set<NativeItem>
  rules: number[][]
  repairs: string[]
  headerRows: number[]
  bottom: number
  issues: Set<string>
}

const setup = (): Fixture => {
  const token = (
    text: string,
    index: number,
    x: number,
    y: number,
    width: number,
    height: number
  ): NativeItem => ({
    text,
    rect: [x, y, x + width, y + height],
    height,
    baseline: y + height,
    horizontal: true,
    sourceItem: { pageNumber: 1, index, text }
  })
  const rows = [{ rect: [0, 0, 160, 20] }, { rect: [0, 19, 160, 40] }]
  const columnRects = [
    [0, 0, 60, 40],
    [60, 0, 160, 40]
  ]
  const cells = rows.flatMap((row, r) =>
    columnRects.map((column, c) => ({
      row: r,
      column: c,
      rowSpan: 1,
      colSpan: 1,
      rect: [column[0], row.rect[1], column[2], row.rect[3]],
      items: [],
      text: ''
    }))
  )
  const items = [
    token('A', 1, 2, 12, 8, 12),
    token('LP', 2, 10.6, 14.4, 14, 9.6),
    token('H', 3, 25.2, 12, 7, 12),
    token('A', 4, 32.8, 14.4, 13, 9.6),
    token('.', 5, 46.4, 12, 3, 12),
    token('2', 10, 80, 2, 8, 10),
    token('next', 11, 2, 28, 24, 10),
    token('3', 12, 80, 28, 8, 10)
  ]
  const assignments = new Map([
    [items[0], cells[0]],
    [items[2], cells[0]],
    [items[4], cells[0]],
    [items[5], cells[1]],
    [items[6], cells[2]],
    [items[7], cells[3]]
  ])
  return {
    rows,
    columnRects,
    cells,
    items,
    pageItems: items.slice(),
    assignments,
    ambiguousAssignments: new Set([items[1], items[3]]),
    rules: [] as number[][],
    repairs: [] as string[],
    headerRows: [],
    bottom: 40,
    issues: new Set<string>()
  }
}

it('preserves native small-cap fragments between two already-owned font runs', () => {
  const f = setup()
  const unassigned = populateTableCellText(f)
  expect(unassigned).toEqual([])
  expect(f.cells[0].text).toBe('ALPHA.')
  expect(f.cells[2].text).toBe('next')
  expect(f.repairs).toContain('native-inline-small-caps-recovered')
})

it.each([
  'cross-owner',
  'baseline',
  'missing-source',
  'overlap',
  'space',
  'horizontal-rule',
  'vertical-rule',
  'index-gap',
  'derived-source',
  'duplicate-source',
  'competing-owner',
  'ambiguous-anchor'
])('declines native inline fragments with %s evidence', (mode) => {
  const f = setup()
  if (mode === 'cross-owner') f.assignments.set(f.items[2], f.cells[2])
  if (mode === 'baseline') f.items[2].baseline += 2
  if (mode === 'missing-source')
    for (const item of f.items) Reflect.deleteProperty(item, 'sourceItem')
  if (mode === 'overlap') f.items[2].rect = [24, 12, 34, 24]
  if (mode === 'space') f.items[2].text = f.items[2].sourceItem.text = 'H '
  if (mode === 'horizontal-rule') f.rules.push([0, 18, 60, 18])
  if (mode === 'vertical-rule') f.rules.push([28, 0, 28, 40])
  if (mode === 'index-gap') f.items[2].sourceItem.index += 20
  if (mode === 'derived-source') f.items[2].sourceItem.text = 'WHOLE'
  if (mode === 'ambiguous-anchor') f.ambiguousAssignments.add(f.items[2])
  if (mode === 'duplicate-source') f.pageItems.push({ ...f.items[2] })
  if (mode === 'competing-owner') {
    const competitor = {
      ...f.items[2],
      rect: [12, 12, 44, 24],
      sourceItem: { pageNumber: 1, index: 30, text: 'H' }
    }
    f.items.push(competitor)
    f.pageItems.push(competitor)
    f.assignments.set(competitor, f.cells[2])
  }
  expect(recoverNativeInlineSmallCaps(f)).toBe(0)
  expect(f.assignments.has(f.items[1])).toBe(false)
  expect(f.assignments.has(f.items[3])).toBe(false)
})

it('does not let a newly recovered fragment become proof for another fragment', () => {
  const f = setup()
  f.assignments.delete(f.items[2])
  expect(recoverNativeInlineSmallCaps(f)).toBe(0)
  expect(f.assignments.has(f.items[1])).toBe(false)
  expect(f.assignments.has(f.items[2])).toBe(false)
  expect(f.assignments.has(f.items[3])).toBe(false)
})
