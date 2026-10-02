import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRepeatedVisitGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-repeated-visit-grid.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/three-visits-with-sparse-time-effect.jsonl'
    )
  )
it('keeps all three sparse time-effect records and their two native probabilities', (): void => {
  const f = fixture(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(16)
  for (const row of [5, 10, 15])
    expect(r.grid[row]).toEqual(['p-value for time effect', '˂1.112', '˂1.112', '', '', '', ''])
  const assigned = r.cells.flatMap((c: { sourceRects: number[][] }) =>
    c.sourceRects.map((v) => JSON.stringify(v))
  )
  expect(new Set(assigned).size).toBe(assigned.length)
  expect(assigned.length).toBe(f.tokens.length)
  expect(r.unassigned).toEqual([])
  expect(
    r.cells.filter((c: { column: number; rowSpan: number }) => c.column === 6 && c.rowSpan === 3)
  ).toHaveLength(3)
})
for (const name of [
  'caption',
  'footer',
  'sequence',
  'probability',
  'section',
  'shared-statistic'
] as const)
  it(`rejects incomplete time-effect cycle proof: ${name}`, (): void => {
    const f = fixture()
    if (name === 'caption') f.captions = []
    if (name === 'footer') f.rules = []
    if (name === 'sequence')
      f.tokens.find(
        (t: { text: string; rect: number[]; baseline: number; height: number }) =>
          t.text === '2' && t.height < 10 && t.rect[0] < 100
      )!.text = '9'
    if (name === 'probability')
      f.tokens = f.tokens.filter(
        (t: { text: string; rect: number[]; baseline: number; height: number }) =>
          !(t.text === '1.112' && t.baseline > 360 && t.baseline < 380 && t.rect[0] > 310)
      )
    if (name === 'section')
      f.tokens = f.tokens.filter(
        (t: { text: string; rect: number[]; baseline: number; height: number }) =>
          t.text !== 'Outcome B'
      )
    if (name === 'shared-statistic') {
      const t = f.tokens.find(
        (t: { text: string; rect: number[]; baseline: number; height: number }) =>
          t.rect[0] > 710 && t.baseline < 200 && t.rect[3] > 145
      )!
      f.tokens.push({
        ...t,
        baseline: t.baseline + 24,
        rect: [t.rect[0], t.rect[1] + 24, t.rect[2], t.rect[3] + 24]
      })
    }
    expect(recoverRepeatedVisitGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  })
