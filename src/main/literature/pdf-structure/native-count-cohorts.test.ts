import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it.each([
  'count-cohorts-with-omitted-section-and-empty-model-rows',
  'fractional-count-cohorts-with-wrapped-treatment-stubs',
  'clipped-count-column-below-native-header-rule'
])('retains all measured count records and independent sections: %s', (name) => {
  const x = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.unassigned.filter((s: string) => !s.startsWith('(Table'))).toEqual([])
  expect(t.grid.every((r: string[]) => r.some((s) => s.trim()))).toBe(true)
  expect(
    t.grid.filter((r: string[]) => r.slice(1).every((s) => /\d/.test(s))).length
  ).toBeGreaterThan(20)
})
