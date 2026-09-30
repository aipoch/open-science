import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it('recovers every native visit/change/probability row and keeps outcome ownership across complete cycles', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/repeated-visit-change-probability-cycles.jsonl'
    )
  )
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.unassigned).toEqual([])
  expect(t.grid.filter((r: string[]) => r[1]?.toLowerCase() === 'changes')).toHaveLength(17)
  expect(t.grid.filter((r: string[]) => r[1] === 'Baseline')).toHaveLength(17)
  expect(
    t.cells
      .filter(
        (c: { column: number; rowSpan: number; text: string }) =>
          c.column === 0 && /^Metric /.test(c.text)
      )
      .every((c: { rowSpan: number }) => c.rowSpan === 4)
  ).toBe(true)
})
