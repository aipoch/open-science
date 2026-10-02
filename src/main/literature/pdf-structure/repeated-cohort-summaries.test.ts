import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/repeated-before-after-cohorts-with-collapsed-model-rows.jsonl'
    )
  )

it('separates each complete cohort measurement and spans only the repeated outcome and probability', () => {
  const f = fixture()
  const table = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(table.grid).toHaveLength(7)
  expect(table.grid[2]).toEqual(['', 'Cohort B', '14.5 ± 15.9', '9.1 ± 9.3', ''])
  expect(table.cells).toContainEqual(
    expect.objectContaining({ column: 0, row: 1, rowSpan: 3, text: 'Outcome A (U/L)' })
  )
  expect(table.cells).toContainEqual(
    expect.objectContaining({ column: 4, row: 4, rowSpan: 3, text: '0.1' })
  )
  expect(table.unassigned).toEqual([])
})

it('does not infer shared statistics when the printed cohort sequence changes', () => {
  const f = fixture()
  f.tokens.findLast((i: { text: string }) => i.text === 'Cohort C').text = 'Different cohort'
  const table = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(table.cells).not.toContainEqual(
    expect.objectContaining({ column: 4, row: 4, rowSpan: 3, text: '0.1' })
  )
})
