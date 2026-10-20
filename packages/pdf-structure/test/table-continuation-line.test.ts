import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { populateTableCellText } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href
)

it('retains a gap line that could continue the previous row or lead the next row', () => {
  const token = (
    text: string,
    x: number,
    y: number,
    width: number
  ): {
    text: string
    rect: number[]
    baseline: number
    height: number
    horizontal: boolean
  } => ({
    text,
    rect: [x, y, x + width, y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  })
  const rows = [{ rect: [0, 0, 300, 35] }, { rect: [0, 48, 300, 80] }]
  const columnRects = [
    [0, 0, 100, 80],
    [100, 0, 300, 80]
  ]
  const cells = rows.flatMap((row, rowIndex) =>
    columnRects.map((rect, column) => ({
      row: rowIndex,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [rect[0], row.rect[1], rect[2], row.rect[3]],
      items: [],
      text: ''
    }))
  )
  // The next record can read "custom policy with constraints". Geometry and
  // the preceding unterminated "default" do not prove an upward continuation.
  const items = [
    token('Policy', 10, 22, 60),
    token('default', 110, 22, 150),
    token('custom', 110, 34, 30),
    token('policy', 144, 34, 40),
    token('Alternative', 10, 48, 60),
    token('with constraints', 110, 48, 150)
  ]
  const issues = new Set<string>()
  const repairs: string[] = []
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems: items,
    rows,
    columnRects,
    headerRows: [],
    rules: [],
    bottom: 80,
    issues,
    repairs
  })
  expect(unassigned).toEqual(['custom', 'policy'])
  expect(cells.find((cell) => cell.row === 0 && cell.column === 1)?.text).toBe('default')
  expect(cells.find((cell) => cell.row === 1 && cell.column === 1)?.text).toBe('with constraints')
  expect(issues).toContain('unassigned-source-text')
})
