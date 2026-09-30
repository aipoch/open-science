import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it.each([
  ['wrapped-acquisition-parameters-with-value-continuations', 11],
  ['paired-limb-sections-with-wrapped-measurements', 12],
  ['repeated-before-after-records-in-merged-model-row', 7]
])('keeps source-owned records and their continuations: %s', (name, count) => {
  const x = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toHaveLength(count as number)
  expect(t.unassigned).toEqual([])
  const input = x.tokens
    .map((i: { text: string }) => i.text)
    .join('')
    .replace(/[\s-]/g, '')
  const output = t.grid.flat().join('').replace(/[\s-]/g, '')
  expect([...output].sort()).toEqual([...input].sort())
})
