import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/repeated-summary-effects-with-missed-sparse-visit.jsonl'
    )
  )
it('owns every repeated timepoint and keeps three mean/SD and effect/CI pairs independent', () => {
  const f = load(),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid).toHaveLength(10)
  expect(t.grid.filter((r: string[]) => r[1] === '3 month')).toHaveLength(2)
  expect(t.grid.find((r: string[]) => r[0] === 'Second measure')?.[1]).toBe('Baseline')
  expect(t.cells.find((c: { text: string }) => c.text === 'Hedges’ g (95% CI)')?.colSpan).toBe(6)
  expect(t.unassigned).toEqual([])
})
const { recoverWrappedRepeatedMeasures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
it.each(['shared heading', 'timepoint sequence', 'native closure', 'whole cell gutter'])(
  'declines repeated effects without %s',
  (kind) => {
    const f = load()
    if (kind === 'shared heading')
      f.tokens.find((i: { text: string }) => i.text.includes('Hedges'))!.text = 'Other'
    if (kind === 'timepoint sequence')
      f.tokens.filter((i: { text: string }) => i.text === '3 month').at(-1)!.text = '4 month'
    if (kind === 'native closure') f.rules = f.rules.filter((r: number[]) => r[1] !== 320)
    if (kind === 'whole cell gutter')
      f.tokens.find((i: { text: string }) => i.text === 'Second measure')!.rect[2] += 180
    expect(recoverWrappedRepeatedMeasures(f.table, f.tokens, f.rules)).toBeUndefined()
  }
)
