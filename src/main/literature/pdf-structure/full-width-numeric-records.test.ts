import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { remapSourceRowSpans } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
it('keeps complete values in their lanes after inserting a wrapped comparison section', (): void => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/source-span-after-wrapped-section.jsonl'
    )
  )
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toContainEqual([
    'Wrapped measurement continuation',
    '36 (89%)',
    '24 (92%)',
    '49 (80%)',
    '2.1'
  ])
  const section = r.grid.find((row: string[]) => row[0].includes('Option vs remainder'))
  expect(section?.slice(1).every((value: string) => !value)).toBe(true)
  expect(
    r.cells
      .filter((cell: { text: string; colSpan: number }) => /36 \(89%\)|225\.2/.test(cell.text))
      .every((cell: { colSpan: number }) => cell.colSpan === 1)
  ).toBe(true)
})
it('drops a removed stub span instead of assigning it to a surviving measured row', (): void => {
  const header = {},
    head = {},
    tail = {},
    next = {}
  const grid = { spans: [{ row: 2, column: 0, rowSpan: 1, colSpan: 5 }], headerRows: [0] }
  remapSourceRowSpans(grid, [header, head, tail, next], [header, head, next])
  expect(grid.spans).toEqual([])
  expect(grid.headerRows).toEqual([0])
})
it('preserves span identity when a new independent source row precedes it', (): void => {
  const header = {},
    section = {},
    record = {}
  const grid = { spans: [{ row: 1, column: 0, rowSpan: 1, colSpan: 5 }], headerRows: [0] }
  remapSourceRowSpans(grid, [header, section, record], [header, {}, section, record])
  expect(grid.spans).toEqual([{ row: 2, column: 0, rowSpan: 1, colSpan: 5 }])
})
