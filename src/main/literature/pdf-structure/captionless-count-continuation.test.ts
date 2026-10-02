import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/captionless-count-percent-continuation-with-overlapping-predictions.jsonl'
    )
  )
it('retains a bounded captionless count/percent continuation with independently proved native columns', () => {
  const f = fixture(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(hasTableEvidence(r, undefined, f.tokens)).toBe(true)
  expect(r.grid.find((v: string[]) => v[0] === 'Invasive ductal with mixed type')).toEqual([
    'Invasive ductal with mixed type',
    '2',
    '0.57',
    '2',
    '0.58',
    ''
  ])
  expect(r.unassigned).toEqual([])
})
const { recoverCohortDistributionRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
it('does not infer a captionless comparison from inconsistent count/percentage pairs or an open boundary', () => {
  for (const mutation of ['fraction', 'border']) {
    const f = fixture()
    if (mutation === 'fraction')
      f.tokens.find((i: { text: string }) => i.text === '87.11').text = '77.11'
    else f.rules = f.rules.slice(0, -1)
    expect(recoverCohortDistributionRecords(f.table, f.tokens, f.rules)).toBeUndefined()
  }
})
