import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it.each([
  ['sparse-schedule-with-multiline-assessments', 33],
  ['sparse-schedule-with-inline-session-annotations', 6]
])('keeps each marked assessment as one record: %s', (name, count) => {
  const x = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.unassigned).toEqual([])
  expect(t.grid).toHaveLength(count)
  expect(t.grid.flat().every((s: string) => !s.includes('✓ ✓'))).toBe(true)
  expect(t.grid.flat().join('').split('✓').length - 1).toBe(
    x.tokens.filter((i: { text: string }) => i.text === '✓').length
  )
})
