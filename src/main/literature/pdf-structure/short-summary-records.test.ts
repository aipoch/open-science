import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it('separates a short ruled summary including a negative mean from the preceding record', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/short-signed-summary-interval-records.jsonl'
    )
  )
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid.flat()).toContain('−0.9 ± 1.9')
  expect(t.grid.flat()).toContain('16.7 ± 4.9')
  expect(t.unassigned).toEqual([])
})
it.each([
  'sample-headings-over-paired-summary-values',
  'wrapped-sample-headings-over-count-percent-leaves'
])('keeps complete sample headings over their paired columns: %s', (name) => {
  const f = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
  const original = structuredClone(f)
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  const parents = t.cells.filter((c: { text: string }) => /Cohort [AB].*n\s*=/.test(c.text))
  expect(parents).toHaveLength(2)
  expect(parents.every((c: { colSpan: number }) => c.colSpan === 2)).toBe(true)
  expect(f).toEqual(original)
  if (name.startsWith('wrapped')) {
    expect(t.cells.find((c: { text: string }) => c.text === '59.0 ± 11.5')?.colSpan).toBe(2)
  }
})
