import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it.each([
  'underlined-cohort-parents-above-summary-leaves',
  'underlined-parent-above-comparison-models'
])('uses native underlines for parent spans: %s', (name) => {
  const x = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.cells.some(
      (c: { row: number; column: number; colSpan: number }) =>
        c.row === 0 && c.column === 1 && c.colSpan === 2
    )
  ).toBe(true)
  expect(t.grid[1][1]).not.toEqual('')
})
it('keeps unequal child counts under independently underlined left-aligned parents', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/left-aligned-parent-bands-with-unequal-child-counts.jsonl'
    )
  )
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.cells
      .filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan > 1)
      .map((c: { column: number; colSpan: number }) => [c.column, c.colSpan])
  ).toEqual([
    [1, 3],
    [4, 2]
  ])
})
