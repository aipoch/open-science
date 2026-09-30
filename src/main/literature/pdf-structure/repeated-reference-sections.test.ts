import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it('keeps a wrapped outcome heading above its repeated coefficient and reference records', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/wrapped-outcome-sections-with-repeated-reference-rows.jsonl'
    )
  )
  const original = structuredClone(f)
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid.flat()).toContain('Activity interference with ADL')
  expect(result.grid.flat()).not.toContain('with ADL')
  expect(result.grid.filter((row: string[]) => row[3] === 'Referent')).toHaveLength(9)
  expect(result.grid).toHaveLength(37)
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(original)
})

it('does not infer a reference record from an arbitrary word beside a zero coefficient', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/wrapped-outcome-sections-with-repeated-reference-rows.jsonl'
    )
  )
  f.tokens.find((item: { text: string }) => item.text === 'Referent')!.text = 'Unresolved'
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid.flat()).not.toContain('Activity interference with ADL')
  expect(result.grid.flat()).toContain('Unresolved')
})
