import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
it.each(['omitted-sample-sizes-under-cohort-names', 'omitted-cohort-names-above-sample-sizes'])(
  'keeps both header tiers: %s',
  (name) => {
    const x = fixture(name),
      result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(result.unassigned).toEqual([])
    expect(
      result.grid[0].slice(1, 3).every((s: string) => /Label/.test(s) && /n\s*=/i.test(s))
    ).toBe(true)
  }
)
it('uses abutting header strokes and complete numeric rows to reject overlapping model columns', () => {
  const x = fixture('abutting-header-strokes-with-overlapping-model-columns'),
    result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toHaveLength(5)
  expect(result.grid.every((r: string[]) => r.length === 5)).toBe(true)
  expect(result.unassigned).toEqual([])
  expect(
    result.grid.slice(1).every((r: string[]) => r.slice(1).every((s) => /^\d+$/.test(s)))
  ).toBe(true)
})
