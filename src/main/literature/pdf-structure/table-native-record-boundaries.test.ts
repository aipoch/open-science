import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const runtime = (name: string): string =>
  pathToFileURL(resolve(`resources/pdf-structure/literature-pdf-${name}.mjs`)).href
const { refineTable } = await import(runtime('table-refine'))
const { recoverDemographicRecords } = await import(runtime('record-grid'))
const { recoverNativeHeaderGrid, recoverClippedColumnHeader } = await import(
  runtime('native-header-grid')
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures', `${name}.jsonl`))
const refine = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.items, f.captions, [], f.rules)

it('recovers a ruled continuation heading as one spanning cell', () => {
  const f = fixture('ruled-bulleted-table-continuation').source
  const result = refine(f)
  expect(result.grid[0]).toEqual(['Neurocognitive Factors', ''])
  expect(result.cells).toContainEqual(
    expect.objectContaining({ text: 'Neurocognitive Factors', row: 0, colSpan: 2 })
  )
  expect(result.unassigned).toEqual([])
  expect(recoverClippedColumnHeader(f.table, f.items, [])).toBeUndefined()
})

it('restores typed demographic records and section spans from native text', () => {
  const f = fixture('typed-characteristics-with-overlapping-records'),
    result = refine(f)
  expect(result.grid).toHaveLength(44)
  expect(result.clipped).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.unassigned).toEqual([])
  expect(result.grid).toContainEqual([
    'Months since AET initiation (AET start to enrollment)',
    '17.91 (8.64)'
  ])
  expect(result.grid).toContainEqual(['High school graduate/GED', '8 (8)'])
  expect(result.cells).toContainEqual(
    expect.objectContaining({ text: 'Employment status', colSpan: 2 })
  )
  expect(recoverDemographicRecords(f.table, f.items, f.captions, [])).toBeUndefined()
  f.items.find((i: { text: string }) => i.text === '17.91 (8.64)').text = 'unavailable'
  expect(recoverDemographicRecords(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})

it('separates overlapping adjusted records and preserves native significance markers', () => {
  const f = fixture('paired-adjustment-records-with-raised-significance'),
    result = refine(f)
  expect(result.grid).toHaveLength(35)
  expect(result.grid.filter((r: string[]) => r[1] === 'Adjusted')).toHaveLength(12)
  expect(result.grid.filter((r: string[]) => r[1] === 'Unadjusted')).toHaveLength(13)
  expect(result.unassigned).toEqual([])
  expect(result.grid).toContainEqual([
    '',
    'Adjusted',
    '51.27 (0.69)',
    '49.36 (0.68)',
    '0.04 (0.01, 3.82)',
    '47.82 (0.71)',
    '48.82 (0.71)',
    '0.42 (−2.79, 1.17)'
  ])
  expect(result.grid[5][3]).toBe('50.05 (0.87)*')
  expect(result.issues).toEqual([])
  expect(result.repairs).toContain('source-separated-model-span-discarded')
  expect(result.repairs).toContain('source-record-boundary-restored')
  f.items.find((i: { text: string }) => i.text === 'Adjusted').text = 'Unknown'
  expect(refine(f).repairs).not.toContain('source-record-boundary-restored')
})

it('uses matching native segments to separate cohort counts, statistics and probability', () => {
  const f = fixture('segmented-cohort-counts-with-section-statistics'),
    result = refine(f)
  expect(result.grid).toHaveLength(35)
  expect(result.grid[0]).toEqual(['', 'MBSR group (n = 30)', 'UC group (n = 30)', 't or χ2', 'P'])
  expect(result.grid).toContainEqual(['high school', '12', '13', '', ''])
  expect(result.grid).toContainEqual(['employment status', '', '', '1.822', '.61'])
  // This marker belongs to the external note, assigned by the caller's second pass.
  expect(result.unassigned).toEqual(['1'])
  expect(recoverNativeHeaderGrid(f.table, f.items, f.captions, f.rules.slice(0, 6))).toBeUndefined()
  f.items.find((i: { text: string }) => i.text === 'P').text = 'Outcome'
  expect(recoverNativeHeaderGrid(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})

it.each([
  ['centered-group-parent-above-cohort-samples', 1],
  ['centered-variable-stubs-with-repeated-summary-statistics', 2]
])('restores the centered parent without merging the probability column: %s', (name, column) => {
  const f = fixture(String(name)),
    original = structuredClone(f),
    result = refine(f)
  expect(result.unassigned).toEqual([])
  expect(result.cells).toContainEqual(
    expect.objectContaining({ text: 'Randomized groups', row: 0, column, colSpan: 2 })
  )
  expect(result.grid[1].at(-1)).toMatch(/^p-/)
  expect(f).toEqual(original)
  // A competing child baseline cannot establish two peer headings.
  const child = f.items.find((i: { text: string }) => i.text === 'UV Ink')
  child.baseline += child.height
  child.rect[1] += child.height
  child.rect[3] += child.height
  expect(refine(f).unassigned).toContain('Randomized groups')
})

it('joins the population title to its sample line only inside matching native rules', () => {
  const f = fixture('ruled-population-title-above-sample-count'),
    result = refine(f)
  expect(result.grid[0]).toEqual(['Characteristics', 'Radiation therapists N = 35 (%)'])
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  f.rules = []
  expect(refine(f).unassigned).toContain('Radiation therapists')
})

it('merges wrapped variable stubs across complete repeated statistic blocks', () => {
  const f = fixture('centered-variable-stubs-with-repeated-summary-statistics'),
    result = refine(f)
  const labels = [
    'Superior (-) / Inferior (+)',
    'Left (-) / Right (+)',
    'Anterior (+) / Posterior (-)'
  ]
  labels.forEach((text, n) =>
    expect(result.cells).toContainEqual(
      expect.objectContaining({ text, row: 2 + n * 4, column: 0, rowSpan: 4 })
    )
  )
  expect(result.grid[2].slice(1)).toEqual(['Mean', '0.11', '-0.01', '0.1395'])
  expect(result.grid.at(-1).slice(1)).toEqual(['Range', '-0.30 – 0.40', '-0.40 – 0.30', ''])
  expect(result.issues).not.toContain('span-conflicts-with-source-rows')
  f.items.find((i: { text: string }) => i.text === 'IQR').text = 'Missing statistic'
  expect(refine(f).cells).not.toContainEqual(
    expect.objectContaining({ text: labels[0], rowSpan: 4 })
  )
})

it('keeps a continuation word inside the data area available for review', () => {
  const f = fixture('typed-characteristics-with-overlapping-records')
  const marker = f.items.find((i: { text: string }) => i.text === '(Continues)')
  marker.rect[1] -= marker.height * 3
  marker.rect[3] -= marker.height * 3
  marker.baseline -= marker.height * 3
  const result = refine(f)
  expect([...result.grid.flat(), ...result.unassigned].join(' ')).toContain('(Continues)')
})
