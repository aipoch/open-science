import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it('keeps a native abbreviation list with a wrapped definition in its own row', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/wrapped-abbreviation-definitions.jsonl'
    )
  )
  const t = refineTable(x.table, x.tokens, [], [], [])
  expect(t.grid).toHaveLength(10)
  expect(t.unassigned).toEqual([])
  expect(t.grid[8][1]).toContain('Definition 18 Definition 19')
  expect(hasTableEvidence(t, undefined, x.tokens)).toBe(true)
  const distant = x.tokens.map((i: { text: string }) =>
    i.text === 'List of abbreviations' ? { ...i, rect: [0, 0, 100, 10] } : i
  )
  expect(hasTableEvidence(t, undefined, distant)).toBe(false)
})
