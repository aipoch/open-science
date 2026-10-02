import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverResourceCohortRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/repeated-cohort-resource-with-wrapped-stub.jsonl'
    )
  )
it('locates the wrapped shared stub at the first arm of its own three-arm cycle', (): void => {
  const f = fixture(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  const owner = r.cells.find((c: { text: string }) => c.text.startsWith('Aggregate'))
  expect(owner).toMatchObject({ row: 7, column: 0, rowSpan: 3, colSpan: 1 })
  expect(r.grid[7][1]).toBe('Alpha')
  expect(r.grid[7][3]).toBe('29781 (23872)/24685')
  expect(r.grid[8][3]).toBe('31520 (25141)/27556')
  expect(r.unassigned).toEqual([])
  expect(r.cropRect[3]).toBeCloseTo(337.6343726, 5)
})
for (const name of [
  'caption',
  'sequence',
  'numeric',
  'footer',
  'competing',
  'foreign',
  'missing-lane'
] as const)
  it(`rejects incomplete resource proof: ${name}`, (): void => {
    const f = fixture()
    if (name === 'caption') f.captions = []
    if (name === 'sequence')
      f.tokens.find(
        (t: { text: string; rect: number[]; baseline: number; height: number }) => t.text === 'Beta'
      )!.text = 'Other'
    if (name === 'numeric')
      f.tokens.find(
        (t: { text: string; rect: number[]; baseline: number; height: number }) =>
          t.text === '29781 (23872)/24685'
      )!.text = 'Unmeasured'
    if (name === 'footer')
      f.rules = f.rules.filter((r: number[]) => Math.abs(r[1] - 337.1343726) > 1)
    if (name === 'competing') f.rules.push([70.5825, 339, 823.18048, 339])
    if (name === 'foreign') {
      const t = f.tokens.at(-1)!
      f.tokens.push({ ...t, text: 'Foreign source', baseline: 329, rect: [70, 318, 170, 329] })
    }
    if (name === 'missing-lane')
      f.tokens = f.tokens.filter(
        (t: { text: string; rect: number[]; baseline: number; height: number }) => t.text !== '66'
      )
    expect(recoverResourceCohortRecords(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  })
