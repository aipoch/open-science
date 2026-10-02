import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it('owns wrapped outcome labels and between-group estimates across alternating cohort rows', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/alternating-cohort-pairs-with-shared-between-group-statistics.jsonl'
    )
  )
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(
    r.cells.find((c: { text: string; rowSpan: number }) => c.text === 'Knee flexion (60°)')?.rowSpan
  ).toBe(2)
  expect(r.cells.find((c: { text: string; rowSpan: number }) => c.text === '0.0005')?.rowSpan).toBe(
    2
  )
  expect(
    r.cells.find((c: { text: string; rowSpan: number }) => c.text === '0.07 (0.03, 0.12)')?.rowSpan
  ).toBe(2)
  expect(r.grid.filter((v: string[]) => v[1] === 'B')).toHaveLength(3)
  expect(r.unassigned).toEqual([])
})
const { recoverWrappedRepeatedMeasures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
it('retains a raised significance marker and a blank second-row stub under an arm heading', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/alternating-cohort-pairs-with-shared-between-group-statistics.jsonl'
    )
  )
  f.tokens.find((i: { text: string }) => i.text === 'Group').text = 'Arm'
  const second = f.tokens.find((i: { text: string }) => i.text === 'B')
  f.tokens = f.tokens.filter(
    (i: { rect: number[]; baseline: number }) =>
      !(i.rect[2] < second.rect[0] - 10 && Math.abs(i.baseline - second.baseline) < 0.1)
  )
  f.tokens.find((i: { text: string }) => i.text === '0.70 (0.21)').text += '†'
  const table = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(table.cells).toContainEqual(expect.objectContaining({ text: 'Knee flexion', rowSpan: 2 }))
  expect(table.grid.flat()).toContain('0.70 (0.21)†')
  expect(table.unassigned).toEqual([])
})

it('keeps ordinary sparse rows ambiguous without a between-group header or alternating cohort pattern', () => {
  for (const mutation of ['header', 'group']) {
    const f = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/alternating-cohort-pairs-with-shared-between-group-statistics.jsonl'
      )
    )
    if (mutation === 'header')
      f.tokens.find((i: { text: string }) => i.text === 'Adjusted* difference').text =
        'Adjusted* value'
    else f.tokens.find((i: { text: string }) => i.text === 'B').text = 'C'
    expect(recoverWrappedRepeatedMeasures(f.table, f.tokens, f.rules)).toBeUndefined()
  }
})
