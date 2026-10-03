import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { populateTableCellText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-raised-radical-overbar-line.jsonl'
    )
  )
  return { ...x, pageItems: x.items, issues: new Set(), repairs: [] }
}
it('keeps a raised literal radical on its native overbar operand line', () => {
  const x = fixture(),
    before = JSON.stringify(x.items)
  expect(populateTableCellText(x)).toEqual([])
  expect(x.cells[0].text).toBe('value = t/√m follows.')
  expect(x.cells[0].sourceRects).toHaveLength(4)
  expect(x.cells[0].textRuns).toBeUndefined()
  expect(JSON.stringify(x.items)).toBe(before)
})
it('preserves separate row ownership across a horizontal cell divider', () => {
  const x = fixture()
  x.cells = [
    { row: 0, column: 0, rowSpan: 1, colSpan: 1, rect: [0, 0, 120, 35], items: [] },
    { row: 1, column: 0, rowSpan: 1, colSpan: 1, rect: [0, 35, 120, 60], items: [] }
  ]
  x.rows = [{ rect: [0, 0, 120, 35] }, { rect: [0, 35, 120, 60] }]
  x.rules.push([0, 35, 120, 35])
  expect(populateTableCellText(x)).toEqual([])
  expect(x.cells[0].text).toBe('√')
  expect(x.cells[1].text).not.toContain('√')
})
it.each(['no bar', 'foreign bar', 'crossing column rule', 'detached operand', 'competing operand'])(
  'leaves an unproved radical diagnostic: %s',
  (variant) => {
    const x = fixture()
    if (variant === 'no bar') x.rules = []
    if (variant === 'foreign bar') x.rules[0] = [72, 32.2, 108, 32.2]
    if (variant === 'crossing column rule') x.rules.push([59, 0, 59, 60])
    if (variant === 'detached operand') {
      x.items[2].rect[0] += 8
      x.items[2].rect[2] += 8
    }
    if (variant === 'competing operand') x.items.push({ ...x.items[2], text: 'k' })
    const unassigned = populateTableCellText(x)
    expect(unassigned).toContain('√')
    expect(x.cells[0].text).not.toContain('√')
  }
)
