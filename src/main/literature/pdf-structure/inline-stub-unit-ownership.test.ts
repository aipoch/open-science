import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverParenthesizedStubUnitCut } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/inline-stub-unit-before-three-cohort-means.jsonl'
    )
  )
const cuts = [77, 326.8026197552681, 493.5424399226904, 629.0197854787111, 747.7394430264831, 814]
it('keeps independently painted inline units in the measured stub', (): void => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const row = r.grid.find((v: string[]) => v[0].includes('Measure interval'))
  expect(row?.[0]).toContain('(mean±SD)')
  expect(row?.slice(1)).toEqual(['41.1±40.7', '40.9±40.6', '53.4±40.4', '3.77'])
  expect(r.unassigned).toEqual([])
  const owners = r.cells.flatMap((c: { sourceRects: number[][] }) =>
    c.sourceRects.map((v) => JSON.stringify(v))
  )
  expect(new Set(owners).size).toBe(x.tokens.length)
  expect(owners.length).toBe(x.tokens.length)
})
for (const mode of [
  'unit',
  'font',
  'gap',
  'foreign',
  'value',
  'sample',
  'closing',
  'competing-closing'
] as const)
  it(`rejects incomplete inline-unit ownership: ${mode}`, (): void => {
    const x = fixture()
    if (mode === 'unit') x.tokens.find((i: { text: string }) => i.text === 'SD)')!.text = 'Unit'
    if (mode === 'font') x.tokens.find((i: { text: string }) => i.text === 'SD)')!.height *= 1.5
    if (mode === 'gap') x.tokens.find((i: { text: string }) => i.text === 'SD)')!.rect[0] += 3
    if (mode === 'foreign') {
      const i = x.tokens.find((i: { text: string }) => i.text === 'SD)')!
      x.tokens.push({ ...i, text: '4', rect: [370, 200, 380, 212], baseline: 212 })
    }
    if (mode === 'value')
      x.tokens.find((i: { text: string }) => i.text === '41.1')!.text = 'Estimate'
    if (mode === 'sample') x.tokens.find((i: { text: string }) => i.text === 'N')!.text = 'Unit'
    if (mode === 'closing') x.rules = x.rules.filter((r: number[]) => r[1] < 790)
    if (mode === 'competing-closing') x.rules.push([87.42, 799, 804.727, 799])
    expect(
      recoverParenthesizedStubUnitCut(x.tokens, cuts, x.rules, x.table.cropRect)
    ).toBeUndefined()
  })
