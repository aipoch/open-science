import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { recoverSegmentedLeafHeaderBand } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-segmented-header-band.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/segmented-wrapped-count-percentage-leaf-header.jsonl'
    )
  )
it('uses matched native segments to preserve a wrapped count and percentage leaf header', () => {
  const x = fixture()
  const proof = recoverSegmentedLeafHeaderBand(x.table, x.items, x.captions, x.rules)
  expect(proof.cropRect[1]).toBeCloseTo(539.06835, 5)
  expect(proof.columnRects).toHaveLength(3)
  expect(proof.headerRect[3]).toBeCloseTo(583.3557, 5)
  const result = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(result.grid[0]).toEqual([
    'Measured Outcome and Sample Finding',
    'No. of Measured Samples',
    'Percentage'
  ])
  expect(result.grid.slice(1).flat()).toContain('49')
  expect(result.unassigned).toEqual([])
})
it('rejects missing or mismatched native segment endpoints', () => {
  for (const change of ['missing', 'shifted']) {
    const x = fixture()
    if (change === 'missing') x.rules.splice(0, 1)
    else x.rules[0][2] -= 8
    expect(recoverSegmentedLeafHeaderBand(x.table, x.items, x.captions, x.rules)).toBeUndefined()
  }
})
it('rejects parent-child rules or text crossing the native leaf lanes', () => {
  const underlined = fixture()
  underlined.rules.push([468.75, 560, 750.0655, 560])
  expect(
    recoverSegmentedLeafHeaderBand(
      underlined.table,
      underlined.items,
      underlined.captions,
      underlined.rules
    )
  ).toBeUndefined()
  const parent = fixture()
  parent.items[0].rect[2] = 730
  expect(
    recoverSegmentedLeafHeaderBand(parent.table, parent.items, parent.captions, parent.rules)
  ).toBeUndefined()
})
it('requires the original caption and at least two complete native numerical records', () => {
  const x = fixture()
  expect(recoverSegmentedLeafHeaderBand(x.table, x.items, [], x.rules)).toBeUndefined()
  const partial = x.items.filter((i: { text: string }) => i.text !== '3.1')
  expect(recoverSegmentedLeafHeaderBand(x.table, partial, x.captions, x.rules)).toBeUndefined()
})
it('does not infer a leaf band from unrelated upper labels', () => {
  const x = fixture()
  x.items[0].text = 'Measurements'
  expect(recoverSegmentedLeafHeaderBand(x.table, x.items, x.captions, x.rules)).toBeUndefined()
})
