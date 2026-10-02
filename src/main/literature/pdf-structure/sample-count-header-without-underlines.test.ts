import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/sample-cohort-titles-above-count-percentage-leaves-without-underlines.jsonl'
    )
  )

it('keeps sample-qualified cohort parents over independent count and percentage leaves without underlines', () => {
  const f = load()
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[0]).toEqual([
    'Measure',
    'Group Alpha (n = 349)',
    '',
    'Group Beta (n = 344)',
    '',
    'p-value'
  ])
  expect(r.grid[1]).toEqual(['', 'No.', '%', 'No.', '%', ''])
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 1, colSpan: 2, text: 'Group Alpha (n = 349)' })
  )
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 5, rowSpan: 2, text: 'p-value' })
  )
  expect(r.unassigned).toEqual([])
})

it.each(['missing-leaf', 'missing-sample', 'body-record'])(
  'declines the unruled parent proof with %s',
  (variant) => {
    const f = load()
    if (variant === 'missing-leaf')
      f.tokens = f.tokens.filter(
        (i: { text: string; rect: number[] }) => !(i.text === '%' && i.rect[0] > 600)
      )
    if (variant === 'missing-sample')
      f.tokens.find((i: { text: string }) => i.text.startsWith('Group Beta')).text = 'Group Beta'
    if (variant === 'body-record')
      f.tokens.find((i: { text: string }) => i.text.startsWith('Group Beta')).text = '349'
    const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(
      r.cells.some(
        (c: { text: string; colSpan: number }) =>
          c.text === 'Group Alpha (n = 349)' && c.colSpan === 2
      )
    ).toBe(false)
  }
)
