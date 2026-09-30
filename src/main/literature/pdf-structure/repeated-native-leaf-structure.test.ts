import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))
const parse = (name: string): ReturnType<typeof JSON.parse> => {
  const x = fixture(name)
  return refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
}

it('recovers three header tiers and removes a column absent from native measurements', () => {
  const t = parse('repeated-leaf-headings-with-an-empty-model-column')
  expect(t.grid[0]).toHaveLength(14)
  expect(t.unassigned).toEqual([])
  expect(
    t.cells.find((c: { text: string }) => c.text === 'Walking Adherence (End of Therapy)')
  ).toMatchObject({ colSpan: 12 })
  expect(t.grid.at(-1).slice(1)).toEqual([
    '27',
    '−2',
    '1',
    '0.48',
    '1.37',
    '4',
    '23',
    '−2',
    '1',
    '1.05',
    '1.56',
    '4',
    '0.27'
  ])
})

it('keeps coarse response cells above repeated fine measurement columns', () => {
  const t = parse('coarse-response-records-above-fine-measurements')
  expect(t.unassigned).toEqual([])
  expect(t.grid[0]).toHaveLength(16)
  expect(t.cells.find((c: { text: string }) => c.text === '44 (47.3)')).toMatchObject({
    colSpan: 3
  })
  expect(t.cells.find((c: { text: string }) => c.text === 'pCR breast and nodes')).toMatchObject({
    rowSpan: 1
  })
  expect(
    t.cells.some((c: { text: string }) => c.text.includes('Therapy A + Therapy B From Week 2'))
  ).toBe(true)
})

it('separates repeated arm records from their spanning visit labels', () => {
  const t = parse('paired-arm-stubs-inside-one-model-column')
  expect(t.grid[0]).toHaveLength(6)
  expect(t.cells.find((c: { text: string }) => c.text === 'End of treatment')).toMatchObject({
    rowSpan: 2,
    column: 0
  })
  expect(t.grid.filter((r: string[]) => r[1] === 'Arm A')).toHaveLength(3)
})

it('keeps repeated wrapped measurements and overhanging unit sections intact', () => {
  const t = parse('repeated-biomarker-records-with-displaced-unit-tails')
  expect(t.unassigned).toEqual([])
  expect(
    t.cells.some(
      (c: { text: string; colSpan: number }) =>
        c.text.includes('Urine 8-oxodG') && c.text.includes('Cr)') && c.colSpan === 9
    )
  ).toBe(true)
  expect(
    t.grid.filter((r: string[]) => r[0] === 'Mean absolute change from baseline (SD)')
  ).toHaveLength(4)
  expect(t.grid.some((r: string[]) => r[0].startsWith('(baseline-adjusted)'))).toBe(false)
})

it('recovers paired grade headers and sparse ancestors over complete count records', () => {
  const t = parse('graded-events-with-sparse-ancestor-stubs')
  expect(t.unassigned).toEqual([])
  expect(t.rows[0].rect[1]).toBeGreaterThan(
    fixture('graded-events-with-sparse-ancestor-stubs').captions[0].rect[3]
  )
  expect(t.grid[0]).toHaveLength(20)
  expect(t.cells.find((c: { text: string }) => c.text === 'Dose Cohort')).toMatchObject({
    row: 2,
    rowSpan: 18
  })
  expect(t.cells.find((c: { text: string }) => c.text === 'Diarrhea')).toMatchObject({ colSpan: 2 })
  expect(t.grid.at(-1)[3]).toBe('All Course')
})

it('keeps each wrapped sum and aggregate percentage in its native count record', () => {
  const t = parse('count-matrix-continuation-with-wrapped-sums')
  expect(t.unassigned).toEqual([])
  expect(t.grid[0]).toHaveLength(18)
  expect(t.grid[0][2]).toBe('5 + 2 + 0')
  expect(t.grid[1][1]).toBe('All Courses')
  expect(t.grid[1][2]).toBe('5 + 2 + 8')
  expect(
    t.cells.some((c: { text: string }) => c.text.includes('28') && c.text.includes('39.4%'))
  ).toBe(true)
})

it('recovers numbered model headings and the locally wider interval cells', () => {
  const t = parse('numbered-regression-models-with-local-estimate-widths')
  expect(t.unassigned).toEqual([])
  expect(t.cells.find((c: { text: string }) => c.text === 'Model 2')).toMatchObject({ colSpan: 11 })
  expect(t.cells.find((c: { text: string }) => c.text === '1.147 (1.036, 1.269)')).toMatchObject({
    colSpan: 3
  })
  expect(
    t.grid.filter((r: string[]) => r[0] === 'Change B to M in Intratumoral TILs')
  ).toHaveLength(2)
})

it('recovers full-width count sections and cohort-wide interval summaries', () => {
  const t = parse('clinical-count-sections-with-interval-summaries')
  expect(t.unassigned).toEqual([])
  expect(t.cells.find((c: { text: string }) => c.text === 'Capecitabine (n = 160)')).toMatchObject({
    colSpan: 2
  })
  expect(t.cells.find((c: { text: string }) => c.text === 'Histology grade')).toMatchObject({
    colSpan: 5
  })
  expect(t.cells.find((c: { text: string }) => c.text === '3.3 (2.5-5.0)')).toMatchObject({
    colSpan: 2
  })
})

it('removes artificial empty count rows and keeps complete repeated headers', () => {
  const t = parse('clinical-counts-with-repeated-summary-headers')
  expect(t.unassigned).toEqual([])
  expect(t.grid.some((r: string[]) => r.every((s) => !s))).toBe(false)
  expect(t.grid[0]).toEqual([
    'Patient Characteristics',
    'Study Arm [27] # (%)',
    'Fixed Recommendation Arm [27] # (%)'
  ])
  expect(t.cells.find((c: { text: string }) => c.text === 'ER status')).toMatchObject({
    colSpan: 3
  })
})

it('does not extend a measured cohort stub into separate factor tests', () => {
  const t = parse('cohort-stub-spanning-independent-factor-tests')
  const stubs = t.cells.filter(
    (c: { text: string; column: number }) => c.text === 'Control' && c.column === 0
  )
  expect(stubs).toHaveLength(3)
  expect(stubs.every((c: { rowSpan: number }) => c.rowSpan === 1)).toBe(true)
})

const {
  recoverRepeatedLeafSections,
  recoverNestedCountRecords,
  recoverNumberedModelSections,
  recoverWrappedRepeatedMeasures
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)

it('requires native parent underlines and complete measurements for leaf reconstruction', () => {
  const x = fixture('repeated-leaf-headings-with-an-empty-model-column')
  expect(recoverRepeatedLeafSections(x.table, x.tokens, [])).toBeUndefined()
  x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '0.0033')
  expect(recoverRepeatedLeafSections(x.table, x.tokens, x.rules)).toBeUndefined()
})

it('rejects a missing count rather than filling it from neighboring cohorts', () => {
  const x = fixture('graded-events-with-sparse-ancestor-stubs')
  const token = x.tokens.find((i: { text: string }) => i.text === '5 + 4')
  expect(token).toBeDefined()
  x.tokens = x.tokens.filter((i: unknown) => i !== token)
  expect(recoverNestedCountRecords(x.table, x.tokens)).toBeUndefined()
})

it('requires segmented native boundaries for locally changing model columns', () => {
  const x = fixture('numbered-regression-models-with-local-estimate-widths')
  expect(recoverNumberedModelSections(x.table, x.tokens, [])).toBeUndefined()
})

it('does not merge unindented standalone labels into repeated measurement records', () => {
  const x = fixture('repeated-biomarker-records-with-displaced-unit-tails')
  for (const i of x.tokens.filter((i: { text: string }) =>
    /from baseline|comparison\)|baseline-adjusted/.test(i.text)
  )) {
    const dx = i.rect[0] - 123.2
    i.rect[0] -= dx
    i.rect[2] -= dx
  }
  expect(recoverWrappedRepeatedMeasures(x.table, x.tokens, x.rules)).toBeUndefined()
})
it('keeps local cohort headers and tests separate across summary and count sections', () => {
  const t = parse('mixed-cohort-summaries-with-section-local-tests')
  expect(t.unassigned).toEqual([])
  expect(t.cells.find((c: { text: string }) => c.text === 'Statistical analysis')).toMatchObject({
    column: 4,
    colSpan: 2
  })
  expect(t.cells.find((c: { text: string }) => c.text === '10 cm above the elbow')).toMatchObject({
    rowSpan: 1
  })
  expect(t.cells.find((c: { text: string }) => c.text === '7.240')).toMatchObject({ rowSpan: 1 })
  expect(t.grid.some((r: string[]) => r.every((s) => !s))).toBe(false)
})
it('joins a linking-word prefix to its complete scale record', () => {
  const t = parse('scale-label-prefix-before-complete-cohort-record')
  expect(t.grid.find((r: string[]) => r[0] === 'Attitude towards behaviour (1–49)')?.[1]).toBe(
    '25.64 (11.4)'
  )
  expect(t.grid.some((r: string[]) => r[0] === 'Generalized distress')).toBe(true)
})
it('separates an outdented unit section from the preceding wrapped probability record', () => {
  const t = parse('repeated-measurements-with-section-absorbed-by-probability-row')
  expect(t.unassigned).toEqual([])
  expect(
    t.cells.find((c: { text: string }) => c.text === 'Serum cholesterol (mg dL−1)')
  ).toMatchObject({ colSpan: 9 })
  expect(
    t.cells.find((c: { text: string }) => c.text.startsWith('Total urinary tea polyphenols'))
  ).toMatchObject({ colSpan: 9 })
  expect(
    t.grid.filter((r: string[]) => r[0] === 'Mean absolute change from baseline (SD)')
  ).toHaveLength(3)
})
