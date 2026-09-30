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

const { recoverIdentifierRecords, recoverSectionLocalColumns, recoverAdditiveCohortRecords } =
  await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
  )

it('restores omitted native counts and section probabilities with additive totals', () => {
  const t = parse('additive-cohort-counts-with-omitted-records')
  expect(t.unassigned).toEqual([])
  expect(t.grid).toContainEqual(['0', '55 (60)', '33 (39)', '88 (50)', ''])
  expect(t.grid).toContainEqual(['Age groups', '', '', '', '0.07'])
  expect(t.grid).toContainEqual(['CIRS-G⁎', '', '', '', '0.09'])
  expect(t.cells.find((c: { text: string }) => c.text === 'N (%)')).toMatchObject({ colSpan: 3 })
})

it('rejects additive reconstruction when a printed total disagrees', () => {
  const x = fixture('additive-cohort-counts-with-omitted-records')
  x.tokens.find((i: { text: string }) => i.text === '88 (50)').text = '89 (50)'
  expect(recoverAdditiveCohortRecords(x.table, x.tokens, x.rules)).toBeUndefined()
})

it('rejects identifier reconstruction when identifiers repeat', () => {
  const x = fixture('identifier-records-with-omitted-and-combined-rows')
  x.tokens.find((i: { text: string }) => i.text === '27').text = '25'
  expect(recoverIdentifierRecords(x.table, x.tokens, x.rules)).toBeUndefined()
})

it('rejects section reconstruction when a cohort measurement is absent', () => {
  const x = fixture('section-local-columns-with-changing-cohort-counts')
  x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '71 (64)')
  expect(recoverSectionLocalColumns(x.table, x.tokens, x.rules)).toBeUndefined()
})

it('requires native section dividers before changing local columns', () => {
  const x = fixture('section-local-columns-with-changing-cohort-counts')
  expect(recoverSectionLocalColumns(x.table, x.tokens, [])).toBeUndefined()
})

it('does not extend a partial ruled stub without its closing border', () => {
  const x = fixture('ruled-stub-with-sparse-followup-values')
  const closing = Math.max(
    ...x.rules.filter((r: number[]) => r[1] === r[3]).map((r: number[]) => r[1])
  )
  x.rules = x.rules.filter((r: number[]) => r[1] !== closing)
  const t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
  expect(t.cells.find((c: { text: string }) => c.text === 'Coaching Services')?.rowSpan).not.toBe(3)
})

it('requires a table caption before expanding a narrow prose header', () => {
  const x = fixture('open-header-above-narrow-prose-table')
  const t = refineTable(x.table, x.tokens, [], x.notes, x.rules)
  expect(t.grid[0]).not.toEqual(['Toxicity', 'Therapy B/Placebo Dose to Restart Treatment*'])
})

it('preserves all identifier records and bounds sparse ancestors independently', () => {
  const t = parse('identifier-records-with-omitted-and-combined-rows')
  expect(t.grid.slice(2).map((r: string[]) => r[2])).toEqual([
    '03',
    '09',
    '11',
    '16',
    '23',
    '25',
    '27',
    '28',
    '62',
    '63',
    '66',
    '67',
    '69',
    '72',
    '73',
    '77',
    '76',
    '78',
    '81',
    '83'
  ])
  expect(t.unassigned).toEqual([])
  expect(t.cells.find((c: { text: string }) => c.text === 'Site A')).toMatchObject({ rowSpan: 8 })
  expect(t.cells.find((c: { text: string }) => c.text === 'Site B')).toMatchObject({ rowSpan: 12 })
  expect(t.cells.find((c: { text: string }) => c.text === 'Variant Classification')).toMatchObject({
    colSpan: 2
  })
})

it('recovers a missing paired stub span from repeated ruled sections', () => {
  const t = parse('ruled-stub-with-missing-paired-span')
  expect(t.cells.find((c: { text: string }) => c.text === 'Information Services')).toMatchObject({
    rowSpan: 2
  })
})

it('extends a partial ruled stub across sparse followup values', () => {
  const t = parse('ruled-stub-with-sparse-followup-values')
  expect(t.cells.find((c: { text: string }) => c.text === 'Study Info only (N=118)')).toMatchObject(
    { column: 2, colSpan: 1 }
  )
  expect(t.cells.find((c: { text: string }) => c.text === 'Coaching Services')).toMatchObject({
    rowSpan: 3
  })
})

it('keeps two-cohort records aligned after three-cohort sections', () => {
  const t = parse('section-local-columns-with-changing-cohort-counts')
  expect(t.grid[0]).toHaveLength(6)
  expect(t.unassigned).toEqual([])
  expect(t.grid.map((r: string[]) => r.filter(Boolean))).toContainEqual([
    'Median OS, months',
    '23.6',
    '24.1'
  ])
  expect(t.grid.map((r: string[]) => r.filter(Boolean))).toContainEqual([
    'ADL',
    '<100 n = 24',
    '100 n = 125'
  ])
})

it('retains every shifted probability and section sample heading', () => {
  const t = parse('section-local-columns-with-shifted-probabilities')
  expect(t.grid[0]).toHaveLength(5)
  expect(t.unassigned).toEqual([])
  expect(t.grid.map((r: string[]) => r.filter(Boolean))).toContainEqual([
    'Number with TTP event (%)',
    '15 (45)',
    '38 (72)',
    '.005'
  ])
  expect(t.grid.filter((r: string[]) => r.some((s) => s.includes('n =')))).toHaveLength(7)
})

it('recovers a matching section above an identical numeric threshold sequence', () => {
  const t = parse('repeated-numeric-threshold-section-span')
  expect(t.cells.find((c: { text: string }) => c.text === 'With arm dropping')).toMatchObject({
    colSpan: 5
  })
})

it('keeps a regression probability out of a record with no paired estimate', () => {
  const t = parse('probability-span-across-absent-regression-pair')
  const r = t.grid.findIndex((r: string[]) => r[0] === 'Growth pattern')
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === r && c.column === 4)
  ).toMatchObject({ text: '<0.01', rowSpan: 1 })
  expect(t.grid[r + 1].slice(3)).toEqual(['', ''])
})

it('attaches an outdented parenthetical tail to its measured record', () => {
  const t = parse('outdented-parenthetical-record-tail')
  expect(
    t.grid.find((r: string[]) => r[0].endsWith('treatments (oophorectomy)'))?.slice(1)
  ).toEqual(['13 (21.3 %)', '19 (31.7 %)', '32 (26.5 %)', '0.22'])
})
it('keeps an independently underlined cohort title out of the blank stub', () => {
  const t = parse('underlined-single-column-parent')
  expect(t.cells.find((c: { text: string }) => c.text === 'Therapy A Alone')).toMatchObject({
    column: 1,
    colSpan: 1
  })
})
it('separates a complete first record below the native header border', () => {
  const t = parse('native-header-border-through-model-row')
  expect(t.grid).toContainEqual(['Any SAE*', '9 (13.8)', '5 (16.7)', '78 (20.6)', '23 (12.0)'])
})
it('separates a first section below the native header border', () => {
  const t = parse('native-header-border-before-section')
  expect(t.grid).toContainEqual(['AEs associated with discontinuation*', '', '', '', ''])
})
it('recovers both headings above a narrow prose table', () => {
  const t = parse('open-header-above-narrow-prose-table')
  expect(t.grid[0]).toEqual(['Toxicity', 'Therapy B/Placebo Dose to Restart Treatment*'])
  expect(t.unassigned).toEqual([])
})
it('keeps a printed range with its preceding measured label', () => {
  const t = parse('range-tail-assigned-to-following-record')
  expect(t.grid).toContainEqual(['Histologic Grade', '', ''])
  expect(t.grid).toContainEqual(['I', '8 (30%)', '2 (7%)'])
  expect(t.grid).toContainEqual(['Surgery⁎', '', ''])
  expect(t.grid).toContainEqual([
    'FSI: Total Disruption Index (range 0–70)',
    '10.19 (10.7)',
    '15.5 (14.4)'
  ])
})
