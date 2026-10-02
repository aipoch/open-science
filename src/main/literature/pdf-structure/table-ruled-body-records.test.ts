import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const runtime = (name: string): string =>
  pathToFileURL(resolve(`resources/pdf-structure/literature-pdf-${name}.mjs`)).href
const { refineTable } = await import(runtime('table-refine'))
const { recoverRuledBodyRecords } = await import(runtime('ruled-body-records'))
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const refine = (name: string): ReturnType<typeof JSON.parse> => {
  const f = load(name)
  return refineTable(f.table, f.tokens, f.captions, f.notes, f.rules)
}

it('recovers the omitted measurement and keeps its section separate on a continuation', () => {
  const t = refine('continued-cohort-unit-records')
  expect(t.grid).toContainEqual([
    '1RM leg extension (kg)',
    '46',
    '43.1',
    '(7.7)',
    '22',
    '44.3',
    '(9.4)'
  ])
  expect(t.grid).toContainEqual(['Physical function', '', '', '', '', '', ''])
  expect(t.unassigned).toEqual([])
})

it('keeps sparse reference records and complete intervals independent of model rows', () => {
  const t = refine('sparse-reference-hazard-records')
  expect(t.grid).toContainEqual(['No response', 'Ref.', '', '', '', '', ''])
  expect(t.grid).toContainEqual(['Other', 'Ref.', '', '', '', '', ''])
  expect(t.grid.find((r: string[]) => r[0].startsWith('Elapsed months'))?.slice(1)).toEqual([
    '1.42',
    '(0.97, 2.08)',
    '.0812',
    '—',
    '',
    '—'
  ])
  expect(t.grid).toContainEqual(['Yes', '0.74', '(0.43, 1.27)', '.3011', '—', '', '—'])
  expect(t.cells).toContainEqual(expect.objectContaining({ text: '683.924', colSpan: 3 }))
  expect(t.unassigned).toEqual([])
})

it('recovers a missing nested count record without swallowing the following section', () => {
  const t = refine('nested-count-section-records')
  expect(t.grid).toContainEqual(['', 'Unspecified', '33 (8)', '19 (7)', '52 (8)'])
  expect(t.unassigned).toEqual([])
})

it('attaches each wrapped odds interval to its own estimate, including the terminal interval', () => {
  const t = refine('wrapped-odds-interval-records')
  expect(t.grid.find((r: string[]) => r[0] === 'Pneumonitis')?.[4]).toBe('0.640 (0.25 to 1.67)')
  expect(t.grid.at(-1)?.[4]).toBe('0.653 (0.47 to 0.90)')
  expect(t.grid).toHaveLength(5)
  expect(t.unassigned).toEqual([])
})

it('starts the organ rowspan at its printed first metric', () => {
  const t = refine('organ-metric-record-ownership')
  const heart = t.cells.find((c: { text: string }) => c.text === 'Heart')
  expect(t.grid[heart.row][1]).toBe('Mean dose (Gy)')
  expect(t.grid[heart.row - 1][1]).toBe('V5 (%)')
  expect(heart.rowSpan).toBe(4)
  expect(t.unassigned).toEqual([])
})

it('separates adjacent summaries and returns the parenthetical tail to the preceding label', () => {
  const t = refine('paired-summary-and-parenthetical-tail-records')
  expect(t.grid).toContainEqual([
    'Minor surgery (98)',
    '1.5 (0.0–6.0) (48)',
    '0.0 (0.0–6.0) (50)',
    '0.8149 (MW)'
  ])
  expect(t.grid.find((r: string[]) => r[0].startsWith('Incidence density'))?.[0]).toMatch(
    /\(107\)$/
  )
  expect(t.grid).toContainEqual(['24 h After surgery', '', '', ''])
  expect(t.unassigned).toEqual([])
})

it.each([
  'nested-count-section-records',
  'wrapped-odds-interval-records',
  'organ-metric-record-ownership'
])('leaves unsupported native layouts to existing recovery: %s', (name) => {
  const f = load(name)
  expect(recoverRuledBodyRecords(f.table, f.tokens, [])).toBeUndefined()
  const changed = f.tokens.find(
    (i: { text: string; rect: number[] }) =>
      /^\d/.test(i.text) && i.rect[1] > f.table.cropRect[1] + 120
  )
  changed.text = 'unexplained prose'
  expect(recoverRuledBodyRecords(f.table, f.tokens, f.rules)).toBeUndefined()
})

it('retains cohort ranges, effects and scale labels in complete score records', () => {
  const t = refine('repeated-score-summary-ranges')
  const support = t.grid.find((r: string[]) => r[0].startsWith('Support subscore'))
  expect(support).toEqual([
    'Support subscore (question 7, 8, 9) Scale 0–100',
    '25 (8.3 to 33.3)',
    '25 (8.3 to 37.5)',
    '0.657',
    '− 1.82 (− 3.9 to 0.2), 0.08'
  ])
  const uncertain = t.grid.find((r: string[]) => r[0].startsWith('Uncertainty subscore'))
  expect(uncertain?.[1]).toBe('25 (0 to 41.7)')
  expect(t.unassigned).toEqual([])
})

it('separates each dose and retains the wrapped study title above its own records', () => {
  const t = refine('dose-records-with-wrapped-section-title')
  expect(t.grid).toContainEqual(['START-pilot', '', '', '', '', '', '', '', '', ''])
  expect(t.grid).toContainEqual([
    '42.9 Gy',
    '14/99 (14.1)',
    '13.9 (8.1-23.3)',
    '17.0 (10.4-27.3)',
    '1.95 (0.82-4.66)',
    '0.13',
    '2/56 (3.6)',
    '0.24',
    '2/27 (7.4)',
    '0.57'
  ])
  expect(t.unassigned).toEqual([])
})

it('uses the native closing border to keep note indices out of dose records', () => {
  const t = refine('dose-records-above-note-index-tail')
  expect(t.grid).toContainEqual(['START-A', '', '', '', '', '', ''])
  expect(t.grid).toContainEqual(['Swelling in arm or hand', '', '', '', '', '', ''])
  expect(t.grid).toContainEqual([
    '41.6 Gy',
    '24/78 (30.8)',
    '31.4 (22.1-43.6)',
    '1.03 (0.60-1.77)',
    '0.92',
    '5/58 (8.6)',
    '0.13'
  ])
  expect(t.unassigned).toEqual([])
})

it('preserves a sparse primary-outcome record independently of the preceding yes/no record', () => {
  const t = refine('study-comparison-with-sparse-primary-record')
  expect(t.grid).toContainEqual(['Treatment B used', 'No', 'No', 'No', 'No', 'Yes'])
  expect(t.grid).toContainEqual(['Primary end point (VAS, NRS)', '', '', 'VAS pain score', '', ''])
  expect(t.unassigned).toEqual([])
})

it('uses abutting horizontal cell strokes to retain paired outcome records and wrapped sections', () => {
  const f = load('horizontal-cell-strokes-with-paired-outcome-stubs')
  const t = refineTable(f.table, f.tokens, f.captions, f.notes, f.rules)
  expect(t.grid[0]).toEqual(['Primary outcome', 'Active', 'Treatment B', 'P value*'])
  expect(t.grid).toHaveLength(17)
  expect(t.grid[12]).toEqual(['', '1 (1–3)', '3.5 (2–5)', '0.14'])
  expect(t.cells.find((c: { text: string }) => c.text === 'Arrival at PACU (T0)')).toMatchObject({
    row: 11,
    rowSpan: 2,
    colSpan: 1
  })
  expect(t.cells.find((c: { text: string }) => c.text === 'Secondary outcomes')).toMatchObject({
    colSpan: 4
  })
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
})

it.each(['cell-edge', 'additional-value', 'header', 'gutter'])(
  'declines a horizontal cell grid with contradictory %s evidence',
  (variant) => {
    const f = load('horizontal-cell-strokes-with-paired-outcome-stubs')
    if (variant === 'cell-edge')
      f.rules = f.rules.filter((r: number[]) => !(r[0] > 260 && r[1] > 380 && r[1] < 384))
    if (variant === 'additional-value') {
      const source = f.tokens.find((i: { text: string }) => i.text === '0.14')
      f.tokens.push({ ...source, text: '17', rect: [350, 395, 357, 405], baseline: 405 })
    }
    if (variant === 'header')
      f.tokens.find((i: { text: string }) => i.text === 'Active').text = '14'
    if (variant === 'gutter')
      f.tokens.find((i: { text: string }) => i.text === '3.5 (2–5)').rect[0] = 260
    expect(recoverRuledBodyRecords(f.table, f.tokens, f.rules)).toBeUndefined()
  }
)
