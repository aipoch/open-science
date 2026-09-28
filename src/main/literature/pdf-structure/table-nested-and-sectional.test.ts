import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const {
  recoverNestedMeasureRecords,
  recoverPairedOutcomeRecords,
  recoverRuledCategoricalRecords,
  recoverRuledComparisonPanel,
  separateAdjacentNumericPanel
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
const { findCaptionedNumericTableRegions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
)
const names = [
  'nested-stubs-with-wrapped-measures-and-paired-treatment-records',
  'continued-nested-stubs-with-unlabelled-opening-records',
  'sectioned-outcomes-with-paired-ratios-and-shared-probabilities',
  'lower-numeric-panel-overlapping-an-adjacent-panel-record',
  'categorical-sections-with-raised-markers-and-split-exponents',
  'recovered-panel-with-three-underlined-populations'
]
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
const refine = (index: number): ReturnType<typeof refineTable> => {
  const x = load(names[index])
  return refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
}
const spans = (t: ReturnType<typeof refineTable>): unknown[] =>
  t.cells
    .filter((c: { rowSpan: number; colSpan: number }) => c.rowSpan > 1 || c.colSpan > 1)
    .map((c: { text: string; row: number; column: number; rowSpan: number; colSpan: number }) => [
      c.text,
      c.row,
      c.column,
      c.rowSpan,
      c.colSpan
    ])
it.each(names)('preserves every source token without mutating the failed input in %s', (name) => {
  const x = load(name),
    before = structuredClone(x),
    t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(x).toEqual(before)
})
it('restores wrapped measures and complete treatment records below nested stubs', () => {
  const t = refine(0)
  expect(t.grid).toHaveLength(46)
  expect(t.grid[5]).toEqual([
    '',
    '',
    '',
    'APOE4 −',
    'Placebo',
    '23.13 (16.1)',
    '125.78 (32.1)',
    '31.34 (13.1)',
    '24.88 (40.6)'
  ])
  expect(t.grid[17][2]).toBe('Digit span (number correct)')
  expect(spans(t)).toEqual(
    expect.arrayContaining([
      ['Attention', 1, 0, 14, 1],
      ['CRT', 2, 1, 13, 1],
      ['Total (ms)', 3, 2, 4, 1],
      ['APOE4 −', 5, 3, 2, 1]
    ])
  )
})
it('retains unlabelled continuation records without inventing preceding-page ancestors', () => {
  const t = refine(1)
  expect(t.grid).toHaveLength(27)
  expect(t.grid[1]).toEqual([
    '',
    '',
    '',
    '',
    'Tamoxifen',
    '− 1.50 (0.9)',
    '− 4.12 (0.9)',
    '− 0.25 (0.9)',
    '0.50 (0.9)'
  ])
  expect(t.grid[26].slice(4)).toEqual([
    'Tamoxifen',
    '45.77 (66.9)',
    '− 52.12 (37.3)',
    '− 84.87 (32.1)',
    '− 37.42 (38.4)'
  ])
  expect(spans(t)).toContainEqual(['MWM', 5, 1, 22, 1])
})
it('keeps section titles, wrapped event labels, both adjusted ratios and paired probability spans', () => {
  const t = refine(2)
  expect(t.grid).toHaveLength(45)
  expect(t.grid[29]).toEqual([
    'Adjusted HR (95% CI) 6',
    '1 (ref)',
    '0.47 (0.27-0.83)',
    '1 (ref)',
    '0.41 (0.23-0.74)'
  ])
  expect(t.grid[34][0]).toBe('- Systemic progression without LM prog. as first event')
  expect(spans(t)).toEqual(
    expect.arrayContaining([
      ['LM-related progression-free survival (LM-PFS)', 18, 0, 1, 5],
      ['P=0·04', 28, 1, 1, 2],
      ['P=0.009', 28, 3, 1, 2]
    ])
  )
})
it('separates neighboring panel records and restores each four-column age header', () => {
  const t = refine(3)
  expect(t.cropRect[1]).toBeCloseTo(249.9517, 3)
  expect(t.grid).toHaveLength(6)
  expect(t.grid[5]).toEqual([
    'A/A',
    '0',
    '3',
    '—',
    '0.026',
    '16',
    '28',
    '1.21 (0.65–2.24)',
    '0.044'
  ])
  expect(spans(t)).toContainEqual(['Age > 40', 1, 5, 1, 4])
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 1)
  ).toMatchObject({ colSpan: 4 })
})
it('recovers section markers, true nine-column layout and complete raised signed exponents', () => {
  const t = refine(4)
  expect(t.grid).toHaveLength(16)
  expect(t.grid.every((r: string[]) => r.length === 9)).toBe(true)
  expect(t.grid[10]).toEqual([
    '4',
    'G',
    'C',
    'A',
    'T',
    'G',
    '0.067',
    '−0.39 (−0.57/−0.21)',
    '3 × 10−5'
  ])
  expect(t.grid[12][8]).toBe('2 × 10−3')
  expect(spans(t)).toContainEqual(['HapMap, all populations (n = 210)b', 6, 0, 1, 9])
})
it('keeps native panel borders and all three underlined populations in the newly detected table', () => {
  const t = refine(5)
  expect(t.cropRect[3]).toBeCloseTo(249.9517, 3)
  expect(t.grid[5]).toEqual([
    'A/A',
    '12',
    '17',
    '1.46 (0.70–3.08)',
    '5',
    '14',
    '1.28 (0.47–3.57)',
    '17',
    '31',
    '1.41 (0.78–2.50)',
    '0.007'
  ])
  expect(spans(t)).toEqual(
    expect.arrayContaining([
      ['Israel', 1, 1, 1, 3],
      ['New York', 1, 4, 1, 3],
      ['Total data combined', 1, 7, 1, 4]
    ])
  )
})
it.each([
  [0, recoverNestedMeasureRecords],
  [2, recoverPairedOutcomeRecords],
  [4, recoverRuledCategoricalRecords],
  [5, recoverRuledComparisonPanel]
])('declines reconstruction of fixture %s without native rule evidence', (index, recover) => {
  const x = load(names[index as number])
  expect((recover as typeof recoverNestedMeasureRecords)(x.table, x.tokens, [])).toBeUndefined()
})
it('does not separate a neighboring record without a proven native separator', () => {
  const x = load(names[3])
  expect(separateAdjacentNumericPanel(x.table, x.tokens, [])).toBe(x.table)
})
const discovery = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/captioned-numeric-panel-above-a-detected-sibling.jsonl'
    )
  )
it('discovers the omitted numeric panel above a sibling with a different column layout', () => {
  const x = discovery(),
    regions = findCaptionedNumericTableRegions(x.items, x.rules, x.detectedRects)
  expect(regions).toHaveLength(1)
  expect(regions[0][1]).toBeCloseTo(114.3563, 3)
  expect(regions[0][3]).toBeCloseTo(249.9517, 3)
  expect(
    findCaptionedNumericTableRegions(x.items, x.rules, [...x.detectedRects, ...regions])
  ).toEqual([])
})
it.each([
  'missing-caption',
  'missing-borders',
  'incomplete-record',
  'misaligned-record',
  'unheaded-final-field'
])('declines omitted panel discovery with %s', (variant) => {
  const x = discovery()
  if (variant === 'missing-caption')
    x.items = x.items.filter((i: { text: string }) => !/^Table/.test(i.text))
  if (variant === 'missing-borders') x.rules = []
  if (variant === 'incomplete-record')
    x.items = x.items.filter((i: { text: string }) => !['1,211', '1,173'].includes(i.text))
  if (variant === 'misaligned-record')
    x.items.find((i: { text: string }) => i.text === '1,211').x += 25
  if (variant === 'unheaded-final-field')
    x.items = x.items.filter(
      (i: { x: number; baseline: number }) => !(i.x > 770 && i.baseline < 200)
    )
  expect(findCaptionedNumericTableRegions(x.items, x.rules, x.detectedRects)).toEqual([])
})

const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
it('retains an unnumbered statistical definition and its wrapped task key without absorbing body prose', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/unnumbered-statistical-definition-with-wrapped-task-key.jsonl'
    )
  )
  const notes = associateTableNotes(f.page, f.tables, f.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toBe(
    'Numbers represent least squared means (standard errors) for difference scores (challenge drug minus placebo). See text for challenge drug effects. Cognitive tasks are choice reaction time (CRT) test, digit span (DS), fluency test (FT), Buschke selective reminding test (SRT), virtual Morris water maze (MWM).'
  )
  const first = f.page.lines.find((l: { text: string }) => l.text.startsWith('Numbers represent'))
  first.text = 'Numbers represent participants assigned to different groups.'
  expect(associateTableNotes(f.page, f.tables, f.rules)[0]).toEqual([])
})
