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
      'src/main/literature/pdf-structure/fixtures/source-grids/paired-count-cohorts-with-spanning-mean-summary-records.jsonl'
    )
  )

it('keeps native count pairs under each qualified cohort and spans whole mean/SD measurements', () => {
  const f = load(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[1]).toEqual(['', 'No.', '%', 'No.', '%', ''])
  for (const [column, text] of [
    [1, 'Treatment A (n = 349)'],
    [3, 'Treatment B (n = 344)']
  ])
    expect(r.cells).toContainEqual(expect.objectContaining({ row: 0, column, colSpan: 2, text }))
  expect(r.grid[3]).toEqual(['Age, years (Mean ± SD)', '52.9 ± 8.7', '', '52.4 ± 9.0', '', '0.418'])
  for (const column of [1, 3])
    expect(r.cells).toContainEqual(expect.objectContaining({ row: 3, column, colSpan: 2 }))
  expect(r.grid[5]).toEqual(['Category A', '30', '8.60', '21', '6.10', '0.209'])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    f.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
})

it('requires two complete sample-qualified cohorts before assigning count pair ownership', () => {
  const f = load()
  f.tokens.find((i: { text: string }) => i.text.startsWith('Treatment B')).text = 'Unrelated detail'
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(
    r.cells.some(
      (c: { text: string; colSpan: number }) => c.text === 'Unrelated detail' && c.colSpan === 2
    )
  ).toBe(false)
})
