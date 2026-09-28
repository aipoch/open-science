import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledNarrativeGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
)
const { recoverNativeHeaderGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const { recoverSectionedCoefficientsGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-regression-grid.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
const refine = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  refineTable(f.models[0], f.tokens, f.captions, f.notes ?? [], f.rules)

it('recovers an unambiguous section without guessing an adjacent printed offset record', () => {
  const t = refine(fixture('native-section-beside-offset-regression-records'))
  expect(t.grid.some((r: string[]) => r[0] === 'Sedentary time (h/d)')).toBe(true)
  expect(t.unassigned).not.toContain('Sedentary time (h/d)')
  expect(t.unassigned).toContain('−0.22')
  expect(t.issues).toContain('ambiguous-cell-assignment')
})

it('rejects incomplete cohort pairs and unindented section children', () => {
  const missing = fixture('indented-treatment-sections-with-nested-counts')
  missing.tokens.splice(
    missing.tokens.findIndex((i: { text: string }) => i.text === '3 (3.5%)'),
    1
  )
  expect(
    recoverNativeHeaderGrid(missing.models[0], missing.tokens, missing.captions, missing.rules)
  ).toBeUndefined()
  const flat = fixture('indented-treatment-sections-with-nested-counts')
  const parent = flat.tokens.find((i: { text: string }) => i.text === 'Type of surgery')
  const child = flat.tokens.find((i: { text: string }) => i.text === 'BCS')
  child.rect = [
    parent.rect[0],
    child.rect[1],
    child.rect[2] - child.rect[0] + parent.rect[0],
    child.rect[3]
  ]
  expect(
    recoverNativeHeaderGrid(flat.models[0], flat.tokens, flat.captions, flat.rules)
  ).toBeUndefined()
})

it.each(['−1.954', '95% CI'])('rejects identifier coefficient recovery without %s', (text) => {
  const f = fixture('nested-outcome-stubs-beside-complete-identifier-records')
  f.tokens = f.tokens.filter((i: { text: string }) => i.text !== text)
  expect(recoverSectionedCoefficientsGrid(f.models[0], f.tokens, f.rules)).toBeUndefined()
})

it('retains summary conflicts when one measurement is missing', () => {
  const f = fixture('wide-followup-records-with-wrapped-summary-lines')
  f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '7.03')
  expect(refine(f).issues).toContain('overlapping-predicted-columns')
})

it('keeps indented clinical sections and their raised bar markers outside numeric records', () => {
  const t = refine(fixture('indented-clinical-sections-with-raised-bar-footnotes'))
  expect(t.cells.find((c: { text: string }) => c.text === 'Pain severity‖|')).toMatchObject({
    row: 16,
    column: 0,
    rowSpan: 1,
    colSpan: 5
  })
  expect(t.grid[17].slice(1)).toEqual([
    '0.0 (0.0–0.8) (N = 104)',
    '0.0 (0.0–0.0) (N = 104)',
    'Median D = 0.0 (0.0–0.0)',
    '0.087'
  ])
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})

it('anchors nested outcome stubs to complete identifier records', () => {
  const t = refine(fixture('nested-outcome-stubs-beside-complete-identifier-records'))
  expect(t.cells.find((c: { text: string }) => c.text === 'Total')).toMatchObject({
    row: 4,
    column: 1,
    rowSpan: 10
  })
  expect(t.cells.find((c: { text: string }) => c.text === 'PAOFI§')).toMatchObject({
    row: 4,
    column: 0,
    rowSpan: 30
  })
  expect(t.cells.find((c: { text: string }) => c.text === 'SM')).toMatchObject({
    row: 14,
    column: 1,
    rowSpan: 6
  })
  expect(t.grid).toHaveLength(34)
  expect(t.grid[4].slice(3, 7)).toEqual(['cg20108357', '−1.246', '−1.954', '−0.539'])
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})

it('recovers repeated cohort category stubs and centered group probabilities', () => {
  const t = refine(fixture('cohort-categories-with-centered-shared-probabilities'))
  expect(t.cells.find((c: { text: string }) => c.text === 'Race, n (%)')).toMatchObject({
    row: 2,
    column: 0,
    rowSpan: 3,
    colSpan: 1
  })
  expect(t.cells.find((c: { text: string }) => c.text === '0.318')).toMatchObject({
    row: 2,
    column: 4,
    rowSpan: 3,
    colSpan: 1
  })
  expect(t.cells.find((c: { text: string }) => c.text === '0.838')).toMatchObject({
    row: 7,
    column: 4,
    rowSpan: 5
  })
  // Individual subscale tests keep separate owners even under a shared stub.
  expect(t.cells.find((c: { text: string }) => c.text === '0.610')).toMatchObject({ rowSpan: 1 })
  expect(t.unassigned).toEqual([])
})

it.each([
  [
    'ruled-comparison-sections-below-two-tier-means',
    35,
    'Baseline Physical Activity (hours per week)'
  ],
  ['indented-treatment-sections-with-nested-counts', 43, 'Type of surgery'],
  ['terminal-record-below-four-column-count-sections', 11, 'Extent of surgery*']
])('separates native section headings from complete paired records in %s', (name, rows, label) => {
  const f = fixture(name as string),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(rows as number)
  const cell = t.cells.find((c: { text: string }) => c.text === label)
  expect(cell).toMatchObject({ column: 0, rowSpan: 1, colSpan: 3 })
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(f).toEqual(original)
})

it.each([
  ['clinical-followups-with-wrapped-negative-intervals', 56, '0.6482'],
  ['short-continued-clinical-followup-cycle', 6, '0.3289']
])(
  'retains clinical visit cycles, three header tiers and signed intervals in %s',
  (name, count, last) => {
    const f = fixture(name as string),
      original = structuredClone(f),
      t = refine(f)
    expect(t.grid).toHaveLength(count as number)
    expect(t.grid[0][1]).toBe('Observed information')
    expect(t.grid[1][1]).toBe('Intervention group')
    expect(t.grid[2][1]).toBe('Mean')
    expect(t.grid.at(-1).at(-1)).toBe(last)
    expect(t.grid.at(-1)[7]).toMatch(/^−0\.\d+ \(−0\.\d+; −0\.\d+\)$/)
    expect(t.unassigned).toEqual([])
    expect(t.issues).toEqual([])
    expect(f).toEqual(original)
  }
)

it('keeps all instruction lines with their duration anchor', () => {
  const t = refine(fixture('duration-anchors-with-wrapped-instruction-paragraphs'))
  expect(t.grid).toHaveLength(4)
  expect(t.grid[2].slice(0, 2)).toEqual(['Tai Chi Ruler movements', '35'])
  expect(t.grid[2][2]).toContain(
    '12 in total, synchronized with breathing technique and visualization'
  )
  expect(t.grid[2][2]).toMatch(/movement in each class$/)
  expect(t.grid[3][0]).toBe('Cool-down')
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})

it('retains a terminal narrative line partly overlapping the predicted last band', () => {
  const t = refine(fixture('review-record-with-partially-overlapping-terminal-line'))
  expect(t.grid.at(-1)[6]).toMatch(/lower proportion of bone metastasis$/)
  expect(t.unassigned).toEqual([])
})

it('uses complete native cells to restore a clipped units column', () => {
  const f = fixture('fully-ruled-parameters-with-clipped-units'),
    t = refine(f)
  expect(t.grid).toHaveLength(19)
  expect(t.grid[0]).toEqual(['Parameters', 'Values', 'Units'])
  expect(t.grid[1][2]).toBe('1/mmZ')
  expect(t.grid.flat()).toContain('years old')
  expect(t.cropRect[2]).toBeGreaterThan(f.models[0].cropRect[2] + 60)
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})

it('retains the final ruled schedule and its raised ordinals outside the detected right edge', () => {
  const t = refine(fixture('fully-ruled-schedules-with-clipped-ordinal-values'))
  expect(t.grid).toHaveLength(8)
  expect(t.grid.at(-1)[0]).toMatch(/^Physical examination schedule for women aged 50–59/)
  expect(t.grid.at(-1)[1]).toBe('{0th, 1st, 2nd, 3rd, 4th}')
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})

it('separates wrapped treatment parents from their count and percentage leaves', () => {
  const t = refine(fixture('multiline-treatment-parents-above-paired-leaves'))
  expect(t.grid).toHaveLength(7)
  expect(t.grid[1]).toEqual(['', 'n', '(%)', 'n', '(%)'])
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 2)
  ).toHaveLength(2)
  expect(t.issues).toEqual([])
})

it('separates the header from the first record of a captionless descriptive continuation', () => {
  const t = refine(fixture('captionless-descriptive-continuation-with-merged-header'))
  expect(t.grid).toHaveLength(7)
  expect(t.grid[0]).toEqual(['Variable', 'N', 'Mean (SD) or N (%)', 'Range'])
  expect(t.grid[1]).toEqual(['TENSE angry interactions', '150', '6.57 (8.06)', '0–36'])
  expect(t.issues).toEqual([])
})

it('uses native nested faces without losing the clipped final test column', () => {
  const f = fixture('closed-nested-domains-with-clipped-test-column'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(12)
  expect(t.grid.every((r: string[]) => r.length === 6)).toBe(true)
  expect(t.cells).toContainEqual(
    expect.objectContaining({ text: 'Quality of Life by SF-36', row: 1, rowSpan: 10 })
  )
  expect(t.cells).toContainEqual(
    expect.objectContaining({ text: 'Physical health', row: 1, rowSpan: 5 })
  )
  expect(t.cells).toContainEqual(
    expect.objectContaining({ text: 'Mental health', row: 6, rowSpan: 5 })
  )
  expect(t.grid[1].slice(2)).toEqual(['Pre', '71.94 ± 18.64', '70.37 ± 21.93', '0.748'])
  expect(t.grid.at(-1).at(-1)).toBe('0.091')
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(f).toEqual(original)
})

it('normalizes empty double borders and retains shared tests without merging adjacent stubs', () => {
  const t = refine(fixture('double-bordered-demographics-with-shared-tests'))
  expect(t.grid).toHaveLength(8)
  expect(t.grid[1]).toEqual(['Age (years)', '', '50.37 ± 10.13', '45.34 ± 11.79', '0.060'])
  expect(t.cells).toContainEqual(
    expect.objectContaining({ text: 'ASA physical status', rowSpan: 2 })
  )
  expect(t.cells).toContainEqual(expect.objectContaining({ text: '0.632', rowSpan: 2 }))
  expect(t.grid.at(-1)[0]).toBe('GSNP')
  expect(t.issues).toEqual([])
})

it('retains all toxicity records and treats explicit missing statistics as source values', () => {
  const t = refine(fixture('ruled-toxicity-records-with-dropped-symptoms'))
  expect(t.grid).toHaveLength(15)
  expect(t.grid).toContainEqual(['Myalgia/asthenia', '16 (29.6)', '3 (5.5)', '–', '–'])
  expect(t.grid.at(-1)).toEqual(['Lung fibrosis', '1 (1.8)', '–', '–', '–'])
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})

it('keeps a stub-only heading and interleaved count sections in source order', () => {
  const t = refine(fixture('stub-only-count-heading-with-section-gaps'))
  expect(t.grid).toHaveLength(26)
  expect(t.grid[0]).toEqual(['Characteristic', ''])
  expect(t.grid[8]).toEqual(['Number of disease sites per patient', ''])
  expect(t.grid.slice(9, 12)).toEqual([
    ['1', '24'],
    ['2', '19'],
    ['≥ 3', '11']
  ])
  expect(t.unassigned).toEqual([])
})

it('preserves regression sections and source-defined missing estimates', () => {
  const t = refine(fixture('outdented-regression-sections-with-missing-values'))
  expect(t.grid).toHaveLength(15)
  expect(t.grid[3]).toEqual(['Taxane treatment', '', '', '', '', ''])
  expect(t.grid[4].slice(-2)).toEqual(['Not estimated', '0.998'])
  expect(t.grid.at(-1)[0]).toBe('Premenopause')
  expect(t.issues).toEqual([])
})

it('separates every ruled count section even when only one record follows', () => {
  const t = refine(fixture('terminal-count-section-before-single-record'))
  expect(t.grid).toHaveLength(39)
  expect(t.grid[20]).toEqual(['Metabolism and nutrition disorders, n (%)', '', '', '', '', '', ''])
  expect(t.grid[21]).toEqual([
    'Decreased appetite',
    '28 (18.92)',
    '28 (25.93)',
    '0.22',
    '0 (0.00)',
    '0 (0.00)',
    'NA'
  ])
  expect(t.grid.at(-2)[0]).toBe('Psychiatric disorders, n (%)')
  expect(t.grid.at(-1)[0]).toBe('Insomnia')
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})

it('extends the crop to retain the full range endpoint supported by a native border', () => {
  const f = fixture('range-endpoint-clipped-by-detector'),
    t = refine(f)
  const token = f.tokens.find((i: { text: string }) => i.text === '121.04–1991.10')
  expect(t.cropRect[2]).toBeGreaterThanOrEqual(token.rect[2])
  expect(t.grid.flat()).toContain(token.text)
  expect(t.issues).toEqual([])
})

it.each(['uncaptioned-numbered-section-outline', 'bibliography-columns-with-journal-volume-runs'])(
  'rejects the unstructured detector candidate in %s without rejecting captioned data',
  (name) => {
    const f = fixture(name),
      t = refine(f)
    expect(hasTableEvidence(t, undefined, f.tokens)).toBe(false)
    expect(hasTableEvidence(t, { lines: ['Table 1. Comparisons'] }, f.tokens)).toBe(true)
  }
)

it('keeps a single-column parent separate from its child and spans centered statistic sections', () => {
  const f = fixture('ruled-statistic-faces-with-single-column-parent-header'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(22)
  expect(t.grid[0][7]).toBe('Three-Way Interaction')
  expect(t.grid[1][7]).toBe('Time×Menopausal Status×Group')
  expect(t.cells.find((c: { text: string }) => c.text === 'Wake after sleep onset').colSpan).toBe(8)
  expect(t.grid[11].slice(1)).toEqual([
    '2,176',
    '2,183',
    '1,186',
    '4,173',
    '2,183',
    '2,176',
    '4,173'
  ])
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(f).toEqual(original)
})

it('joins wrapped cohort leaves below a native group underline without joining records', () => {
  const f = fixture('wrapped-cohort-leaves-beneath-native-group-underline'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid[1]).toEqual([
    '',
    'No family history',
    'Prostate cancer',
    'Breast cancer',
    'Prostate and breast cancer',
    'P-value'
  ])
  expect(t.grid[2].slice(1)).toEqual(['5008 (77.9)', '717 (11.1)', '581 (9.0)', '121 (1.9)', ''])
  expect(t.issues).toEqual([])
  expect(f).toEqual(original)
})

it('recovers native cohort tiers without a duplicate count column', () => {
  const f = fixture('nested-cohorts-with-duplicate-count-columns'),
    original = structuredClone(f)
  const t = refine(f)
  expect(t.grid).toHaveLength(19)
  expect(t.grid.every((r: string[]) => r.length === 19)).toBe(true)
  expect(t.grid[4].slice(7, 13)).toEqual(['445.00', '66.80', '13', '434.90', '29.67', '5'])
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 6)
  ).toHaveLength(3)
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 1 && c.colSpan === 3)
  ).toHaveLength(6)
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(f).toEqual(original)
})

it.each([
  'visit-sections-with-wrapped-joint-statistics',
  'continued-visits-with-multilevel-effect-headers'
])('preserves source header tiers and complete statistic records in %s', (name) => {
  const f = fixture(name),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid[2].slice(4)).toEqual([
    'Score (95% Cl)',
    'P value',
    'F test (df)',
    'P value',
    'F test (df)',
    'P value',
    'F test (df)',
    'P value'
  ])
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 1 && c.colSpan === 2)
  ).toHaveLength(4)
  if (name === 'visit-sections-with-wrapped-joint-statistics') {
    expect(t.grid).toHaveLength(25)
    const row = t.grid.findIndex((r: string[]) => r[0] === 'FACT-Bh total score')
    expect(t.grid[row].slice(6)).toEqual([
      '6.55 (1,96)',
      '.01',
      '36.49 (2,100)',
      '<.001',
      '14.82 (2,100)',
      '<.001'
    ])
    expect(t.grid[row - 1].slice(6)).toEqual(['', '', '', '', '', ''])
    expect(t.grid[5][4]).toBe('–11.67 (–16.99 to –6.36)')
  } else {
    expect(t.grid).toHaveLength(17)
    expect(t.grid[3][0]).toBe('T1')
    expect(t.grid[4][0]).toBe('T2')
    expect(t.grid[5][0]).toBe('Functional well-being')
  }
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(f).toEqual(original)
})

it('rejects a columnless prose detection without dereferencing an absent stub', () => {
  const f = fixture('columnless-prose-detection-with-wide-headings')
  const t = refine(f)
  expect(hasTableEvidence(t, undefined, f.tokens)).toBe(false)
})

it.each(['broken-cycle', 'crossing-gutter', 'duplicate-source-token'])(
  'declines repeated-record recovery with %s',
  async (variant) => {
    const { recoverRepeatedVisitGrid } = await import(
      pathToFileURL(resolve('resources/pdf-structure/literature-pdf-repeated-visit-grid.mjs')).href
    )
    const f = fixture('nested-cohorts-with-duplicate-count-columns')
    if (variant === 'broken-cycle')
      f.tokens.find((i: { text: string }) => i.text === 'T4').text = 'T5'
    if (variant === 'crossing-gutter')
      f.tokens.find((i: { text: string }) => i.text === '421.78').rect[2] += 50
    if (variant === 'duplicate-source-token')
      f.tokens.push(f.tokens.find((i: { text: string }) => i.text === 'T4'))
    expect(recoverRepeatedVisitGrid(f.models[0], f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)

it('retains every entry in a captioned three-level theme outline', () => {
  const f = fixture('indented-theme-outline'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(19)
  expect(t.grid[0]).toEqual(['Emotional stress of dealing with double jeopardy'])
  expect(t.grid.at(-1)).toEqual([
    'Fertility preservation educational materials not available and accessible'
  ])
  expect(t.grid.flat()).toContain('Fertility preservation cost')
  expect(t.grid.flat()).toContain(
    'Need for donor sperm in embryo cryopreservation for single women'
  )
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(f).toEqual(original)
})
it.each(['no-caption', 'one-indent', 'paragraph-continuation', 'overlapping-baselines'])(
  'requires complete outline evidence with %s',
  (variant) => {
    const f = fixture('indented-theme-outline')
    if (variant === 'no-caption') f.captions = []
    if (variant === 'one-indent') for (const i of f.tokens) i.rect[0] = 107.19
    const entry = f.tokens.find((i: { text: string }) => i.text === 'Mental and physical demands')
    if (variant === 'paragraph-continuation') entry.text = 'mental and physical demands'
    if (variant === 'overlapping-baselines') {
      entry.rect[1] -= 15
      entry.rect[3] -= 15
      entry.baseline -= 15
    }
    expect(recoverRuledNarrativeGrid(f.models[0], f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)
it('separates repeated statistic headers and preserves the data below them', () => {
  const f = fixture('paired-statistic-headers-with-mitered-rules'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid[0]).toEqual(['', 'Moderate to severe distress', '', 'Weekly step counts', ''])
  expect(t.grid[1]).toEqual(['', 'B (SE)', 'P value', 'B (SE)', 'P value'])
  for (const column of [1, 3])
    expect(
      t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === column)
        ?.colSpan
    ).toBe(2)
  expect(t.grid.at(-1)).toEqual([
    'Antihormonal therapy',
    '–0.829 (0.159)',
    '<.001',
    '–0.009 (0.041)',
    '.83'
  ])
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(f).toEqual(original)
})
it.each(['clipped-two-column-introduction', 'clipped-questionnaire-outline'])(
  'rejects uncaptioned prose in %s while retaining explicit table and measured evidence',
  (name) => {
    const f = fixture(name),
      t = refine(f)
    expect(hasTableEvidence(t, undefined, f.tokens)).toBe(false)
    expect(hasTableEvidence(t, { lines: ['Table 1. Results'] }, f.tokens)).toBe(true)
    const measured = { ...t, grid: t.grid.map((row: string[]) => [row[0], '12 (30)']) }
    expect(hasTableEvidence(measured, undefined, f.tokens)).toBe(true)
  }
)

it.each(['paired-coefficients-with-joint-test', 'paired-coefficients-with-sparse-native-label'])(
  'keeps each coefficient, standard error and native label in its own record for %s',
  (name) => {
    const f = fixture(name),
      original = structuredClone(f),
      t = refine(f)
    const nc = t.grid.findIndex((r: string[]) => r[0] === 'N.C')
    expect(nc).toBeGreaterThan(0)
    expect(t.grid[nc].slice(1).every((s: string) => /^-?\d/.test(s))).toBe(true)
    expect(t.grid[nc + 1].slice(1).every((s: string) => /^\(\d/.test(s))).toBe(true)
    expect(
      t.cells.find((c: { row: number; column: number }) => c.row === nc && c.column === 0)?.rowSpan
    ).toBe(2)
    expect(t.grid.at(-1)[0]).toBe('P-value: Joint Test (Cross Equation)')
    expect(t.unassigned.every((s: string) => /coefficients|Standard errors/.test(s))).toBe(true)
    expect(t.issues).not.toContain('conflicting-spanning-cells')
    expect(f).toEqual(original)
  }
)
it('recovers all four dated follow-up columns, their parent and both intervention records', () => {
  const f = fixture('dated-followup-with-collapsed-time-column'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(47)
  expect(t.grid[1].slice(4, 8)).toEqual([
    '3-month M (SD)',
    '6-month M (SD)',
    '9-month M (SD)',
    '12-month M (SD)'
  ])
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 4)?.colSpan
  ).toBe(4)
  expect(t.grid[3].slice(4, 8)).toEqual(['9.6 (5.4)', '9.0 (5.6)', '11.6 (9.6)', '7.0 (4.8)'])
  expect(t.grid[12][4]).toBe('9.5 (7.8)')
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(f).toEqual(original)
})

it('keeps the count section at a page break available for continuation combining', () => {
  const t = refine(fixture('page-ending-count-section'))
  expect(t.grid.at(-1)).toEqual(['Medication use, N (%)', '', '', ''])
  expect(
    t.cells.find(
      (c: { row: number; column: number }) => c.row === t.grid.length - 1 && c.column === 0
    )?.colSpan
  ).toBe(4)
  expect(t.unassigned).toEqual([])
})
it('recovers a sampled group header above its model row despite neighboring superscripts', () => {
  const t = refine(fixture('wrapped-sampled-intervention-header'))
  expect(t.grid[0][2]).toBe('Exercise Intervention, N = 37')
  expect(t.unassigned).toEqual([])
})
it('retains separate values when a numeric category is incorrectly predicted as a section', () => {
  const t = refine(fixture('numeric-category-predicted-as-section'))
  expect(t.grid).toContainEqual(['1', '0 (0.0)', '2 (1.5)', '1 (0.8)', '3 (0.8)'])
  expect(t.grid).toContainEqual(['Education', '', '', '', ''])
})
it('joins bibliography references and continuation fragments in an explicit long footnote', async () => {
  const { associateTableNotes } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
  )
  const f = fixture('bibliographic-references-in-long-footnote'),
    original = structuredClone(f),
    t = refine(f)
  const rect = [
    t.cropRect[0],
    Math.min(...t.rows.map((r: { rect: number[] }) => r.rect[1])),
    t.cropRect[2],
    Math.max(...t.rows.map((r: { rect: number[] }) => r.rect[3]))
  ].map((x) => x / 1.5)
  const notes = associateTableNotes(
    f.page,
    [{ rect }],
    f.rules.map((r: number[]) => r.map((x) => x / 1.5))
  )[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toContain(
    'Test, 13 verbal fluency with the Controlled Oral Word Association Test, 14 attention'
  )
  expect(notes[0].text).toContain(
    '18 The PROMIS Pain Interference-Short Form 6 assessed pain intensity. 19'
  )
  expect(notes[0].text).toMatch(/was not violated for any of the models\.$/)
  expect(f).toEqual(original)
})

it.each([
  ['sampled-phases-over-recovered-count-records', 2, 2],
  ['paired-followup-mean-error-headers', 2, 4],
  ['three-visit-intervention-control-headers', 3, 2],
  ['overlapping-phase-header-predictions', 2, 2]
] as const)('recovers repeated child headings in %s', (name, parents, width) => {
  const f = fixture(name),
    original = structuredClone(f),
    t = refine(f)
  const top = t.cells.filter((c: { row: number }) => c.row === 0)
  expect(top).toHaveLength(parents + 1)
  expect(top[0].rowSpan).toBe(2)
  expect(top.slice(1).every((c: { colSpan: number }) => c.colSpan === width)).toBe(true)
  expect(t.grid[1].slice(1).every(Boolean)).toBe(true)
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(f).toEqual(original)
})
it('keeps every numbered entry in the two independent narrative columns', () => {
  const f = fixture('parallel-numbered-narrative-lists'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(13)
  expect(t.grid[0]).toEqual(['Yoga poses', ''])
  expect(t.cells[0].colSpan).toBe(2)
  expect(t.grid.at(-1)).toEqual(['12. Boat', '24. Final guided relaxation during corpse pose'])
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(f).toEqual(original)
})
it('does not reconstruct a parallel list with a missing or repeated native number', () => {
  const f = fixture('parallel-numbered-narrative-lists')
  f.tokens.find((i: { text: string }) => i.text === '24').text = '23'
  expect(recoverRuledNarrativeGrid(f.models[0], f.tokens, f.captions, f.rules)).toBeUndefined()
})
it('recovers a ruled n (%) heading above demographic sections', () => {
  const t = refine(fixture('clipped-count-percentage-heading'))
  expect(t.grid[0]).toEqual(['', 'n (%)'])
  expect(t.grid[1]).toEqual(['Age grouping', ''])
  expect(t.grid.at(-1)).toEqual(['Total', '100%'])
  expect(t.unassigned).toEqual([])
})
it('keeps the full author header and all independently wrapped study fields', () => {
  const f = fixture('cited-study-paragraph-comparison'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(4)
  expect(t.grid[0][0]).toBe('First Author')
  expect(t.grid[1][3]).toBe('Patients with early-stage breast cancer (N = 182)')
  expect(t.grid[1][5]).toContain('59% hair preservation with cooling and taxanes')
  expect(t.grid[3][5]).toContain('20%-43% hair preservation with anthracycline-based therapy')
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(f).toEqual(original)
})

it('keeps a section count qualifier with its label and preserves the independent P value', () => {
  const t = refine(fixture('count-label-crossing-empty-columns'))
  expect(t.grid[12]).toEqual(['Education, highest level, N (%)', '', '', '0.954'])
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 12 && c.column === 0)?.colSpan
  ).toBe(3)
  expect(t.grid[13]).toEqual(['Secondary', '57 (20.4)', '44 (19.6)', '–'])
})
it('keeps vertically offset counts and percentages in their complete native records', () => {
  const f = fixture('paired-counts-and-percentage-lines'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(3)
  expect(t.grid[1]).toEqual([
    'SW frequency 0–7 times',
    '72',
    '23 (31.9%)',
    '49 (68.1%)',
    '16 (22.2%)',
    '56 (77.8%)'
  ])
  expect(t.grid[2]).toEqual([
    'SW frequency 8–9 times',
    '153',
    '86 (56.2%)',
    '67 (43.8%)',
    '60 (39.2%)',
    '93 (60.8%)'
  ])
  expect(t.unassigned).toEqual([])
  expect(t.issues).not.toContain('span-conflicts-with-source-rows')
  expect(f).toEqual(original)
})

it.each([
  ['wrapped-interaction-below-paired-estimate-headings', 16, 'Condition × Time × Role'],
  ['moderator-records-below-wrapped-parent-headings', 17, 'Rel × Condition × Time × Role']
])(
  'recovers paired estimate headings and complete interaction records: %s',
  (name, count, last) => {
    const f = fixture(String(name)),
      original = structuredClone(f),
      t = refine(f)
    expect(t.grid).toHaveLength(count)
    expect(t.grid[0][9]).toBe('Relationship satisfaction')
    expect(t.grid[1].slice(1).map((v: string) => v.toLowerCase())).toEqual(
      Array.from({ length: 5 }, () => ['b', 't (df)']).flat()
    )
    expect(t.grid.at(-1)[0]).toBe(last)
    expect(
      t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 9)?.colSpan
    ).toBe(2)
    expect(t.unassigned).toEqual([])
    expect(t.issues).toEqual([])
    expect(f).toEqual(original)
  }
)
it('requires the native parent underlines before reconstructing paired statistical headers', async () => {
  const { recoverNativeHeaderGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
  )
  const f = fixture('moderator-records-below-wrapped-parent-headings')
  f.rules = f.rules.filter((r: number[]) => r[2] - r[0] > 500)
  expect(recoverNativeHeaderGrid(f.models[0], f.tokens, f.captions, f.rules)).toBeUndefined()
})

it.each([
  ['paired-participant-timepoint-sections', 27, 'Relationship satisfaction'],
  ['paired-participant-mean-error-sections', 11, 'Well-being']
])('keeps all sections in a paired participant table: %s', (name, count, section) => {
  const f = fixture(String(name)),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(count)
  const row = t.grid.findIndex((r: string[]) => r[0] === section)
  expect(row).toBeGreaterThan(1)
  expect(t.grid[row].slice(1)).toEqual(['', '', '', ''])
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === row && c.column === 0)?.colSpan
  ).toBe(5)
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(f).toEqual(original)
})
it('retains a cited row definition after significance notes without swallowing unrelated prose', async () => {
  const { associateTableNotes } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
  )
  const f = fixture('unmarked-definition-after-significance-notes'),
    t = refine(f)
  const rect = [t.cropRect[0], t.rows[0].rect[1], t.cropRect[2], t.rows.at(-1).rect[3]].map(
    (v) => v / 1.5
  )
  const notes = (): { text: string }[] =>
    associateTableNotes(
      f.page,
      [{ rect }],
      f.rules.map((r: number[]) => r.map((v) => v / 1.5))
    )[0]
  expect(notes().at(-1)?.text).toBe(
    'Breast-conserving surgery includes lumpectomy, quadrantectomy, partial mastectomy, segmental mastectomy; Receipt of chemotherapy, radiation, surgery, endocrine therapy, and immunotherapy is for the week before baseline assessment.'
  )
  const line = f.page.lines.find((l: { text: string }) =>
    l.text.startsWith('Breast-conserving surgery includes')
  )
  line.text = line.text.replace('Breast-conserving surgery', 'Future research')
  expect(notes()).toHaveLength(3)
})

it.each([
  [
    'shared-category-statistics-and-wrapped-stubs',
    21,
    'Age (year, mean ± SD)',
    't = 0.41, P = 0.68'
  ],
  ['shared-complication-statistics', 10, 'Endometrial thickness', 'χ2 = 1.24, P = 0.54']
])('owns the whole category statistic in %s', (name, rows, label, statistic) => {
  const f = fixture(String(name)),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(rows)
  expect(t.grid[1][0]).toBe(label)
  expect(t.grid[1][4]).toBe(statistic)
  expect(
    t.cells.filter((c: { column: number; rowSpan: number }) => c.column === 4 && c.rowSpan > 1)
      .length
  ).toBeGreaterThanOrEqual(4)
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(f).toEqual(original)
})
it.each([
  ['visit-statistics-below-sample-headings', 13, 3],
  ['repeated-visit-outcome-stubs', 17, 4]
])('preserves every repeated outcome stub in %s', (name, rows, span) => {
  const f = fixture(String(name)),
    t = refine(f)
  expect(t.grid).toHaveLength(rows)
  expect(t.grid[0][2]).toBe('Remifemin group N = 42')
  expect(t.grid[0][3]).toBe('Control group N = 43')
  expect(
    t.cells
      .filter((c: { column: number; rowSpan: number }) => c.column === 0 && c.rowSpan === span)
      .map((c: { text: string }) => c.text)
  ).toEqual(['E2', 'FSH', 'LH', 'KMI'])
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
})
it('requires complete category test and P-value pairs', async () => {
  const { recoverAlignedNumericGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-aligned-numeric-grid.mjs')).href
  )
  const f = fixture('shared-category-statistics-and-wrapped-stubs')
  f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '= 0.68')
  expect(recoverAlignedNumericGrid(f.models[0], f.tokens, f.captions, f.rules)).toBeUndefined()
})

it.each([
  ['paired-regressions-under-numbered-parent-headings', 13, 4],
  ['grouped-regression-with-omitted-final-error-row', 11, 3],
  ['repeated-outcome-regression-panels', 28, 8]
])('retains native parents and coefficient/error pairs in %s', (name, rows, pairs) => {
  const f = fixture(String(name)),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(rows)
  expect(
    t.cells.filter((c: { column: number; rowSpan: number }) => c.column === 0 && c.rowSpan === 2)
  ).toHaveLength(pairs)
  expect(
    t.cells.filter(
      (c: { text: string; colSpan: number }) => c.text === 'Total Sample' && c.colSpan === 2
    ).length
  ).toBeGreaterThan(0)
  expect(t.grid.at(-1)[0]).toBe('Observations')
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(f).toEqual(original)
})
it('rejects an incomplete interior standard-error row', async () => {
  const { recoverRepeatedRegressionGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-regression-grid.mjs')).href
  )
  const f = fixture('paired-regressions-under-numbered-parent-headings')
  const missing = f.tokens.findIndex((i: { text: string }) => i.text === '(0.010)')
  expect(missing).toBeGreaterThan(-1)
  f.tokens.splice(missing, 1)
  expect(recoverRepeatedRegressionGrid(f.models[0], f.tokens, f.captions, f.rules)).toBeUndefined()
})
it.each([
  ['header-definition-below-double-bottom-rule', 'cycles.'],
  ['inset-note-touching-double-bottom-rule', 'surrounding months.']
])('keeps the complete native explanatory note: %s', async (name, ending) => {
  const { associateTableNotes } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
  )
  const f = fixture(name),
    t = refine(f)
  const rect = [t.cropRect[0], t.rows[0].rect[1], t.cropRect[2], t.rows.at(-1).rect[3]].map(
    (v) => v / 1.5
  )
  const notes = associateTableNotes(
    f.page,
    [{ rect }],
    f.rules.map((r: number[]) => r.map((v) => v / 1.5))
  )[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text.endsWith(ending)).toBe(true)
  const final = refineTable(
    f.models[0],
    f.tokens,
    f.captions,
    notes.map((n: { text: string; rect: number[] }) => ({
      ...n,
      rect: n.rect.map((v) => v * 1.5)
    })),
    f.rules
  )
  expect(final.issues).toEqual([])
  expect(final.unassigned).toEqual([])
})

it.each([
  ['inline-coefficients-with-reference-sections', 34, 3],
  ['paired-inline-coefficients-with-blank-stub', 32, 7],
  ['count-rate-contrasts-under-cohort-parents', 9, 10],
  ['count-rate-contrasts-with-sparse-control', 8, 10],
  ['repeated-outcome-count-rate-contrasts', 16, 4],
  ['overlapping-count-rate-contrast-columns', 16, 7]
])('preserves native coefficient and count records in %s', (name, rows, columns) => {
  const f = fixture(String(name)),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(rows)
  expect(t.grid.every((r: string[]) => r.length === columns)).toBe(true)
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(f).toEqual(original)
})
it('preserves an explicitly printed zero coefficient without inventing its missing stub', () => {
  const t = refine(fixture('paired-inline-coefficients-with-blank-stub'))
  expect(t.grid).toContainEqual(['', '0.000', '(0.000)', '0.000', '(0.000)', '0.000', '(0.000)'])
})
it('keeps standard errors with their contrast and sparse control cells blank', () => {
  const t = refine(fixture('count-rate-contrasts-under-cohort-parents'))
  expect(t.grid[4]).toEqual([
    'Logo',
    '5,296',
    '46.51',
    '-1.07 (0.970)',
    '3,227',
    '48.1',
    '-0.3 (1.25)',
    '2,069',
    '44.0',
    '-2.4 (1.54)'
  ])
  expect(
    t.cells.some((c: { column: number; colSpan: number }) => c.column === 1 && c.colSpan === 3)
  ).toBe(true)
  expect(t.grid.at(-1).filter((s: string) => s === '')).toHaveLength(3)
})
it('restores the reference population column in a wide repeated-cohort table', () => {
  const t = refine(fixture('wide-cohort-comparison-with-reference-population'))
  expect(t.grid).toHaveLength(39)
  expect(t.grid.every((r: string[]) => r.length === 14)).toBe(true)
  expect(t.grid[1].at(-1)).toBe('France')
  expect(t.cells.filter((c: { colSpan: number }) => c.colSpan === 6)).toHaveLength(2)
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
it('retains both wrapped full-width sections in a boxed checklist', () => {
  const f = fixture('boxed-checklist-with-wrapped-section-titles'),
    t = refine(f)
  expect(t.grid).toHaveLength(9)
  expect(t.grid[4][0]).toBe(
    'Uninformed choice—inadequate knowledge and/or inconsistent attitudes+intentions'
  )
  expect(t.cells.filter((c: { colSpan: number }) => c.colSpan === 4)).toHaveLength(2)
  expect(t.grid[5]).toEqual(['Accept screening', '- / ✓', '-', '✓'])
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
it('requires every checklist value and matching native rule segments', () => {
  const f = fixture('boxed-checklist-with-wrapped-section-titles')
  f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '✓')
  expect(recoverRuledNarrativeGrid(f.models[0], f.tokens, f.captions, f.rules)).toBeUndefined()
})
it.each([
  ['outcome-section-after-complete-count-record', 'Informed choice* (composite outcome)'],
  ['outdented-section-after-binary-count-record', 'Stabilized on antidepressant medication']
])('separates the complete count row from its following section: %s', (name, label) => {
  const t = refine(fixture(name))
  expect(t.grid.filter((r: string[]) => r[0] === label)).toHaveLength(1)
  expect(
    t.grid
      .find((r: string[]) => r[0] === label)
      .slice(1)
      .every((s: string) => s === '')
  ).toBe(true)
  expect(t.unassigned).toEqual([])
})
it('retains split native means and wrapped demographic stubs', () => {
  const t = refine(fixture('paired-participant-demographics-with-wrapped-stubs'))
  expect(t.grid[2]).toEqual([
    'Age (years)',
    '54.4 (9.9)',
    '55.5 (11.1)',
    '55.8 (10.9)',
    '57.1 (11.6)'
  ])
  expect(t.grid.flat()).toContain('Hawaiian/Pacific Islander')
  expect(t.grid.flat()).toContain('Relationship length (years)')
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
it('retains the sparse threshold record and both sampled parent headings', () => {
  const t = refine(fixture('sampled-arms-with-sparse-category-tests'))
  expect(t.grid).toContainEqual(['≥9', '7', '4', '', '1', '2', ''])
  expect(t.grid[2][1]).toBe('57.8 (30–84)')
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 3)
  ).toHaveLength(2)
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
it('groups each arm without absorbing the separate comparison P-value', () => {
  const t = refine(fixture('paired-arms-with-separate-comparison-test'))
  expect(t.grid[0]).toEqual(['', 'Intervention', '', '', '', 'Control', '', '', '', ''])
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 4)
  ).toHaveLength(2)
  expect(t.grid[2][9]).toBe('Between groups')
  expect(t.issues).toEqual([])
})
it.each([
  'grouped-domains-with-multilevel-change-headings',
  'grouped-domain-slopes-with-bottom-description'
])('keeps the domain boundary and source explanation in %s', (name) => {
  const f = fixture(name),
    t = refine(f)
  expect(t.grid.find((r: string[]) => r[1] === 'Financial problemsb')[0]).toBe('')
  expect(t.grid.find((r: string[]) => r[1] === 'Body imagea')[0]).toBe('BR-23')
  expect(f.notes[0].text).toMatch(/^Health-related quality of life measured by/)
  expect(t.grid.flat().join(' ')).not.toContain('Health-related quality of life measured by')
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
it('keeps narrative headers separate and respects each native domain boundary', () => {
  const t = refine(fixture('independently-ruled-narrative-test-domains'))
  expect(t.grid[0]).toEqual([
    'Test Domain',
    'Online Test',
    'Main Outcome Measures',
    'Traditional Equivalent'
  ])
  expect(t.grid[9][0]).toBe('Executive functioning')
  expect(t.grid[11][0]).toBe('Motor functioning')
  expect(t.grid[2][2]).toBe('')
  expect(t.cells.filter((c: { rowSpan: number }) => c.rowSpan > 1)).toHaveLength(4)
  expect(t.issues).toEqual([])
})
it('keeps each training paragraph across its two independently ruled week bands', () => {
  const t = refine(fixture('shared-training-paragraphs-across-week-bands'))
  expect(
    t.cells.filter((c: { column: number; rowSpan: number }) => c.column === 2 && c.rowSpan === 2)
  ).toHaveLength(2)
  expect(t.grid[1][2]).toMatch(/^One circuit.*repetitions\.$/)
  expect(t.grid[3][2]).toMatch(/^Two circuits.*45 seconds\.$/)
  expect(t.grid[2][2]).toBe('')
  expect(t.grid[4][2]).toBe('')
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
it.each(['complete', 'wrapped', 'reduced'])(
  'retains every paired-visit statistic with a %s sample header',
  (variant) => {
    const t = refine(fixture(`paired-visit-changes-${variant}-sample-header`))
    expect(t.grid).toHaveLength(9)
    expect(t.cells.filter((c: { rowSpan: number }) => c.rowSpan === 2)).toHaveLength(24)
    expect(t.grid[0][2]).toMatch(/^Exercise Intervention, N =/)
    expect(t.issues).toEqual([])
    expect(t.unassigned).toEqual([])
  }
)
it('keeps the common count heading and wrapped interval sample size together', () => {
  const t = refine(fixture('mixed-count-and-interval-sample-headings'))
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1).colSpan
  ).toBe(3)
  expect(t.grid.find((r: string[]) => r[0] === 'Emotion')).toEqual([
    'Emotion',
    'Mean (95% CI) n=121',
    'n=131',
    'n=122',
    ''
  ])
  expect(t.grid.filter((r: string[]) => r[0] === '' && r[1] === 'n=121')).toHaveLength(0)
  expect(t.unassigned).toEqual([])
})
it('restores an underlined confidence-interval parent in a captionless continuation', () => {
  const f = fixture('captionless-interval-parent-with-native-underline'),
    t = refine(f)
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 3, colSpan: 2, text: '95% CI' })
  )
  expect(t.grid[1].slice(3, 5)).toEqual(['Lower', 'Upper'])
  expect(t.unassigned).toEqual([])
  const noUnderline = structuredClone(f)
  noUnderline.rules = []
  expect(refine(noUnderline).unassigned).toContain('95% CI')
})
it('recovers a missing leading heading in a two-column grading list', () => {
  const t = refine(fixture('leading-section-before-repeated-grading-records'))
  expect(t.grid).toHaveLength(12)
  expect(t.grid[0][0]).toBe('Acute nausea grade:')
  expect(t.grid[5][0]).toBe('Acute vomiting grade:')
  expect(t.unassigned).toEqual([])
})
it('pairs left-aligned timepoint parents with each count and mean leaf', () => {
  const t = refine(fixture('left-aligned-timepoints-above-count-and-mean-leaves'))
  for (const [n, column] of [1, 3, 5, 7].entries())
    expect(t.cells).toContainEqual(
      expect.objectContaining({ row: 0, column, colSpan: 2, text: `T${n}` })
    )
  expect(t.grid).toHaveLength(4)
  expect(t.issues).toEqual([])
})
it('separates repeated mean cycles from their section-level ANOVA values', () => {
  const t = refine(fixture('repeated-mean-cycles-with-section-level-anova'))
  expect(t.grid).toHaveLength(13)
  expect(t.grid[9]).toEqual(['Well-being score', '', '', '', '', 'P = 0.001**'])
  expect(t.grid[11].slice(0, 3)).toEqual(['Sham group', '3.3 ± 1.6', '3.3 ± 1.8'])
  expect(t.grid[12]).toEqual(['Student t test', '0.338', '0.001**', '0.001**', '0.001**', ''])
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
it('retains numeric category labels and standalone records in sectioned risk estimates', () => {
  const t = refine(fixture('categorical-risk-records-with-section-probabilities'))
  expect(t.grid).toHaveLength(49)
  expect(t.grid).toContainEqual(['2010', '30.1 (28.5–31.8)', '0.64 (0.49–0.83)', ''])
  expect(t.grid).toContainEqual([
    'Comorbidities present',
    '20.6 (19.2–22.1)',
    '1.25 (0.97–1.59)',
    '.08'
  ])
  expect(t.grid.at(-1)).toEqual(['IV', '43.6 (41.9–45.4)', 'Ref', ''])
  expect(t.issues).toEqual([])
})
it('switches merged descriptive stubs to nested category pairs without losing NA records', () => {
  const t = refine(fixture('cohort-counts-switching-to-paired-category-stubs'))
  expect(t.grid).toHaveLength(48)
  expect(t.grid).toContainEqual([
    'Eltávolított nem SLN száma – átlag (szórás)',
    '',
    '12,5 (5–31)',
    'NA',
    ''
  ])
  expect(t.cells).toContainEqual(expect.objectContaining({ text: 'ER-státusz', rowSpan: 2 }))
  expect(t.grid.at(-1)).toEqual(['', 'Negatív', '216 (88)', '190 (83)', ''])
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
it('owns wrapped case descriptions and every nested qualitative assay result', () => {
  const f = fixture('numbered-cases-with-qualitative-assay-cycles'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.grid).toHaveLength(31)
  expect(t.cells).toContainEqual(
    expect.objectContaining({ text: '10', row: 28, column: 0, rowSpan: 3 })
  )
  expect(t.grid[1][5]).toMatch(/spindle cell differentiation& focal squamous differentiation$/)
  expect(t.grid.at(-1).slice(6, 8)).toEqual(['Her2neu', '−'])
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(f).toEqual(original)
})
it('keeps terminal four-column records after source-backed section recovery', () => {
  const t = refine(fixture('terminal-record-below-four-column-count-sections'))
  expect(t.grid).toHaveLength(11)
  expect(t.grid.at(-1).slice(0, 3)).toEqual(['Length of stay (d)', '5 (4–7)', '4 (2–6)'])
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
})
it('preserves both native header tiers and section rows inside a closed grid', () => {
  const t = refine(fixture('closed-grid-with-two-header-tiers-and-section-rows'))
  expect(t.grid).toHaveLength(8)
  expect(t.grid[0]).toEqual(['', 'Mean', 'Range'])
  expect(t.grid[1]).toEqual(['', 'Simulated (recorded)', 'Simulated (recorded)'])
  expect(t.grid.at(-1)[0]).toBe('In control arm')
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
it('rejects incomplete source cycles and categorical estimates instead of inventing missing values', async () => {
  const { recoverNumberedCaseGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-aligned-numeric-grid.mjs')).href
  )
  const cases = fixture('numbered-cases-with-qualitative-assay-cycles')
  const last = cases.tokens.findLastIndex((i: { text: string }) => i.text === 'Her2neu')
  cases.tokens.splice(last, 1)
  expect(
    recoverNumberedCaseGrid(cases.models[0], cases.tokens, cases.captions, cases.rules)
  ).toBeUndefined()
  const { recoverRegressionGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-regression-grid.mjs')).href
  )
  const risk = fixture('categorical-risk-records-with-section-probabilities')
  risk.tokens = risk.tokens.filter((i: { text: string }) => i.text !== '0.64 (0.49–0.83)')
  expect(recoverRegressionGrid(risk.models[0], risk.tokens, risk.captions)).toBeUndefined()
})
it('validates complete paired summaries after recovering wrapped SD and SE lines', () => {
  const t = refine(fixture('wide-followup-records-with-wrapped-summary-lines'))
  expect(t.grid.at(-1)).toEqual([
    'Return of PRO results',
    '74',
    '3.05 (0.39)',
    '62',
    '3.11 (0.40)',
    '53',
    '3.13 (0.42)',
    '29',
    '3.14 (0.35)',
    '0.06 (0.07)',
    '.36',
    '–0.02 (0.07)',
    '.78',
    '0.09 (0.09)',
    '.31'
  ])
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})

it('keeps fragmented section qualifiers and repeated wrapped group labels in their source records', () => {
  const t = refine(fixture('wide-followup-records-with-wrapped-summary-lines'))
  expect(t.grid[2][0]).toBe('Psychological distress (HADSa total; P=.94b)')
  expect(t.grid[2].slice(1).every((s: string) => !s)).toBe(true)
  const record = t.grid.find((r: string[]) => r[1] === '76' && r[2] === '3.22 (0.44)')
  expect(record[0]).toBe('Return of PRO results + Living with lymphoma')
  expect(t.grid.some((r: string[]) => r[0] === 'with lymphoma')).toBe(false)
  expect(t.unassigned).toEqual([])
})
