import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/${name}.jsonl`))
const refine = (name: string): ReturnType<typeof JSON.parse> => {
  const f = fixture(name)
  return refineTable(f.table, f.items, f.captions, f.notes, f.rules)
}
it('retains sparse section statistics and all repeated toxicity grades', () => {
  const a = refine('two-arm-counts-with-sparse-section-statistics')
  expect(a.grid[26]).toEqual(['HER2', '', '', '1'])
  expect(a.unassigned).toEqual([])
  const b = refine('repeated-toxicity-grades-with-section-statistics')
  expect(b.grid).toHaveLength(61)
  expect(b.grid[1]).toEqual(['Nausea', '', '', '0.35'])
  expect(b.grid[12]).toEqual(['GIII-IV', '0 (0)', '0 (0)', ''])
  expect(b.grid[24]).toEqual(['GIII-GIV', '11 (18.96)', '11 (18.96)', ''])
  expect(b.unassigned).toEqual([])
})
it('splits independently labelled follow-ups and preserves their shared outcome cell', () => {
  const t = refine('ruled-followup-series-with-shared-outcomes')
  expect(t.grid).toHaveLength(61)
  expect(t.grid[1]).toEqual(['Role limitation', 'Baseline', '50 (0-100)', '66.67 (0-100)', '0.49'])
  expect(t.grid[2]).toEqual(['', 'FU1', '66.7 (0-100)', '66.67 (0-100)', '0.91'])
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 0)?.rowSpan
  ).toBe(3)
  expect(t.unassigned).toEqual([])
})
it.each([
  ['paired-analysis-headers-with-wrapped-proportions', 22],
  ['paired-analysis-headers-with-deviations', 16],
  ['paired-analysis-headers-with-inline-proportions', 20]
])('retains parent groups and records in %s', (name, rows) => {
  const t = refine(String(name))
  expect(t.grid).toHaveLength(Number(rows))
  for (const [column, text] of [
    [1, 'ITT analysis'],
    [4, 'PP analysis']
  ] as const) {
    const cell = t.cells.find(
      (c: { row: number; column: number }) => c.row === 0 && c.column === column
    )
    expect(cell).toMatchObject({ text, colSpan: 3, rowSpan: 1 })
  }
  expect(t.unassigned).toEqual([])
})
it('recovers the small native ruled table even when inference emits no rows', () => {
  const t = refine('short-segmented-numeric-table-without-model-rows')
  expect(t.grid.slice(1)).toEqual([
    ['Duloxetine', '5', '15', '20'],
    ['Control', '5', '15', '20']
  ])
  expect(t.grid[0]).toHaveLength(4)
  expect(t.unassigned).toEqual([])
})
it.each([
  ['longitudinal-trial-with-statistical-notes', 'Surgery type was significant in the model'],
  [
    'longitudinal-trial-with-posthoc-notes',
    'Subscribed letters representing significant difference'
  ],
  ['wrapped-abbreviations-with-following-lettered-note', 'Due to missing data'],
  ['outdented-abbreviation-continuation', 'reduction intervention.'],
  ['multivariable-analysis-note-and-glossary', 'HR hazard ratio, CI confidence interval'],
  ['tall-review-header-with-lettered-outcome-rows', '8-year LRR reported for DCIS patients'],
  ['grouped-correlations-with-wrapped-cohort-labels', '0.001'],
  ['manuscript-meal-summary-with-unheaded-notes', 'completion']
])('keeps complete notes in %s', (name, ending) => {
  const f = fixture(name),
    t = refine(name)
  const rect = [
    t.cropRect[0],
    Math.min(...t.rows.map((r: { rect: number[] }) => r.rect[1])),
    t.cropRect[2],
    Math.max(...t.rows.map((r: { rect: number[] }) => r.rect[3]))
  ].map((v) => v / 1.5)
  const notes = associateTableNotes(
    f.page,
    [{ rect }],
    f.rules.map((r: number[]) => r.map((v) => v / 1.5))
  )[0]
  const text = notes.map((n: { text: string }) => n.text).join(' ')
  expect(text).toContain(ending)
  expect(text).not.toContain('To our knowledge')
  expect(text).not.toContain('the day, competence')
  if (name === 'wrapped-abbreviations-with-following-lettered-note') expect(notes).toHaveLength(2)
})

it.each([
  [
    'supplement-timepoints-with-scripted-section-labels',
    22,
    'Any product with herbal ingredients, c, e'
  ],
  ['micronutrient-timepoints-with-sparse-statistics', 31, 'Calcium']
])('restores all timepoint sections without absorbing notes in %s', (name, count, label) => {
  const t = refine(String(name))
  expect(t.grid).toHaveLength(Number(count))
  expect(t.cells.find((c: { text: string }) => c.text === label)?.colSpan).toBe(7)
  expect(t.grid.at(-1)?.[0]).toBe('T1')
  expect(t.unassigned).toEqual([])
})
it('retains nested section rows before and between complete statistical records', () => {
  const t = refine('nested-age-comparisons-with-outcome-sections')
  expect(t.grid).toHaveLength(20)
  for (const text of ['Death*', 'Underlying cause', 'Any mention', 'Cancer incidence**'])
    expect(t.cells.find((c: { text: string }) => c.text === text)?.colSpan).toBe(13)
  expect(t.unassigned).toEqual([])
})
it('keeps hanging label lines with their complete repeated measurement baseline', () => {
  const t = refine('outdented-abbreviation-continuation')
  expect(t.grid).toHaveLength(21)
  expect(t.grid[2][0]).toBe('5-a-day fruits and vegetables in the past month, No. (%)')
  expect(t.grid.at(-1)[0]).toContain('45 y only, No. (%)')
  for (const column of [1, 3, 5, 7])
    expect(
      t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === column)
        ?.colSpan
    ).toBe(2)
  expect(t.unassigned).toEqual([])
})
it('restores a tall column heading across its neighboring two-tier header', () => {
  const t = refine('tall-wrapped-header-beside-grouped-columns')
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 3)
  ).toMatchObject({
    text: 'Dermatitis grading according to Radiation Ttherapy Oncology Group (RTOG)',
    rowSpan: 2
  })
  expect(t.grid[2].slice(1, 4)).toEqual(['14 (70)', '16 (80)', '0'])
  expect(t.unassigned).toEqual([])
})
it('separates sparse count, percentage, summary and range columns', () => {
  const t = refine('sparse-summary-with-count-percentage-and-range')
  expect(t.grid[0]).toEqual(['', 'n', '%', 'Mean (SD)', 'Range'])
  expect(t.grid[3]).toEqual(['Premenopausal', '183', '45.1', '', ''])
  expect(t.grid.at(-1)).toEqual(['Social function', '371', '', '93 (15)', '0-100'])
  expect(t.unassigned).toEqual([])
})
it('retains every printed correlation column and leaves the source label typo intact', () => {
  const t = refine('correlation-triangle-with-repeated-source-labels')
  expect(t.grid[0]).toHaveLength(13)
  expect(t.grid[0].slice(-2)).toEqual(['SF 3', 'SF 5'])
  expect(t.grid.at(-1).slice(-2)).toEqual(['0.41**', '0.53**'])
  expect(t.grid.filter((r: string[]) => r[0] === 'EF 3')).toHaveLength(2)
})
it('recovers an unowned staged record without splitting an already owned multiline BMI record', () => {
  const t = refine('staged-cohort-with-unowned-superscripted-record')
  expect(t.grid.some((r: string[]) => r[0] === 'StageIA')).toBe(true)
  expect(t.unassigned).toEqual([])
  const bmi = refine('wrapped-body-mass-index-with-owned-values')
  expect(bmi.grid.filter((r: string[]) => /^BMI/.test(r[0]))).toHaveLength(1)
  expect(bmi.grid[2]).toEqual([
    'BMI (kg/m2)',
    '23.7 (22.5–25.9)',
    '23.3 (22.2–24.2)',
    '-1.338',
    '0.181'
  ])
  expect(bmi.unassigned).toEqual([])
})

const sourceCell = (
  table: ReturnType<typeof JSON.parse>,
  text: string
): ReturnType<typeof JSON.parse> => table.cells.find((c: { text: string }) => c.text === text)

it.each([
  ['paired-cohort-summary-with-source-parent-rules', 54],
  ['paired-cohort-summary-with-source-parent-rules-continued', 5]
])('keeps the same source parent hierarchy in %s', (name, count) => {
  const t = refine(String(name))
  expect(t.grid).toHaveLength(Number(count))
  expect(sourceCell(t, 'Group A')).toMatchObject({ row: 0, column: 1, colSpan: 2 })
  expect(sourceCell(t, 'Group B')).toMatchObject({ row: 0, column: 3, colSpan: 2 })
  expect(t.unassigned).toEqual([])
})
it('uses treatment underlines without claiming the outdented row-name column', () => {
  const t = refine('underlined-treatment-groups-beside-outdented-stub')
  expect(sourceCell(t, 'Duloxetine group (N %)')).toMatchObject({ column: 1, colSpan: 3 })
  expect(sourceCell(t, 'Control group (N %)')).toMatchObject({ column: 4, colSpan: 3 })
  expect(sourceCell(t, 'PNQ score')).toMatchObject({ column: 0 })
})
it('retains every closed cohort field and its single shared significance cell', () => {
  const t = refine('closed-cohort-characteristics-with-shared-significance')
  expect(t.grid).toHaveLength(10)
  expect(t.grid.at(-1)[1]).toContain('E : 2 6.9%')
  expect(sourceCell(t, 'NS*')).toMatchObject({ column: 4, row: 1, rowSpan: 9 })
  expect(t.unassigned).toEqual([])
})
it('keeps a complete multi-session description under its original stub', () => {
  const t = refine('narrow-stub-intervention-description')
  expect(t.grid).toHaveLength(9)
  expect(t.grid[2][0]).toBe('What')
  for (const text of [
    'Session on anxiety:',
    'Session on fatigue:',
    'Session on motivation:',
    'body scan).'
  ])
    expect(t.grid[2][1]).toContain(text)
  expect(t.grid[6][0]).toBe('When and how much')
  expect(t.unassigned).toEqual([])
})
it('retains all followup estimates and the parent over both treatment columns', () => {
  const t = refine('repeated-followups-with-adjusted-estimates')
  expect(t.grid).toHaveLength(54)
  expect(sourceCell(t, 'Adjusted predicted estimates (SE)')).toMatchObject({
    column: 1,
    colSpan: 2
  })
  expect(t.grid[37]).toEqual([
    '3 months after rehabilitation',
    '52.2 (2.6)',
    '58.8 (2.6)',
    '-6.6',
    '-14.0; 0.8',
    '0.079'
  ])
  expect(t.unassigned).toEqual([])
})
it('keeps a hanging pathology label in the preceding counted record', () => {
  const t = refine('pathology-counts-with-hanging-stub-continuation')
  expect(t.grid).toHaveLength(29)
  expect(t.grid[11]).toEqual([
    'Mucinous adenocarcinoma with invasive breast carcinoma NST',
    '0',
    '0',
    '1(3)',
    '0'
  ])
  expect(t.unassigned).toEqual([])
})
it('keeps wrapped postoperative values and significance lists out of the next biomarker', () => {
  const t = refine('perioperative-biomarkers-with-wrapped-significance')
  expect(t.grid).toHaveLength(11)
  expect(t.grid[8][4]).toBe('1364.97(868.04-1902.74)£')
  expect(t.grid[9][4]).toBe('100.59(62.12–136.80)')
  expect(sourceCell(t, 'MMP-9 (ng ml−1)')).toMatchObject({ row: 7, rowSpan: 2 })
  expect(t.unassigned).toEqual([])
})
it('separates postoperative outcome sections while retaining unexplained source values as unassigned', () => {
  const t = refine('postoperative-days-with-wrapped-outcome-sections')
  expect(t.grid).toHaveLength(19)
  expect(sourceCell(t, 'QoR-15 dimen-sions Pain')).toMatchObject({ colSpan: 5 })
  expect(t.grid.at(-1)).toEqual([
    'POD2',
    '34.0 (32.0–37.0)',
    '38.0 (36.0–39.0)',
    '-3 (-4 to -1)',
    '0.000*'
  ])
  // The PDF visibly repeats these values below the last labelled outcome.
  expect(t.unassigned).toEqual(['0.789', '0.018*', '0.000*'])
})
it.each([
  'parallel-recommendations-with-independent-paragraphs',
  'parallel-recommendations-with-independent-paragraphs-continued'
])('preserves complete narrative blocks in %s', (name) => {
  const t = refine(name)
  expect(t.grid).toHaveLength(12)
  expect(t.unassigned).toEqual([])
  expect(
    t.cells.some(
      (c: { text: string; colSpan: number }) =>
        c.colSpan === 2 && /^Clinical Question/.test(c.text) && c.text.endsWith('?')
    )
  ).toBe(true)
  expect(t.grid.flat().join(' ')).toContain(
    name.endsWith('continued')
      ? 'confirm or adjudicate ER results'
      : 'Validation must be done using a clinically validated ER'
  )
})
it('joins an unfinished narrative stub with its hanging continuation', () => {
  const t = refine('narrative-result-with-unfinished-stub')
  expect(t.grid).toHaveLength(3)
  expect(t.grid[2][0]).toBe('No internal controls and ER is 0%–10%')
  expect(t.grid[2][1]).toContain('confirmation of ER status.')
})
it('recovers an unowned demographic record beside a centered group label', () => {
  const t = refine('demographic-groups-with-centered-stub-and-missing-record')
  expect(t.grid.find((r: string[]) => r[1] === 'Secondary')).toEqual([
    '',
    'Secondary',
    '45 (42.4)',
    '72 (39.7)',
    '64 (39.8)',
    '181 (40.4)'
  ])
  expect(t.unassigned).toEqual([])
})
it('restores the omitted regression header and the last wrapped label', () => {
  const t = refine('regression-with-omitted-header-and-wrapped-final-stub')
  expect(t.grid[0]).toEqual(['', '', 'Crude OR (95% CI)', 'Adjusted* OR (95% CI)', 'P Value'])
  expect(t.grid.at(-1)[1]).toContain('cost reduction')
  expect(t.unassigned).toEqual([])
})
it('retains the shared odds header and centered estimates for the final wrapped record', () => {
  const t = refine('stratified-odds-with-centered-values-and-shared-header')
  expect(t.grid).toHaveLength(9)
  expect(sourceCell(t, 'Adjusted Odds Ratio (95% CI)')).toMatchObject({
    row: 0,
    column: 1,
    colSpan: 2
  })
  expect(t.grid.at(-1)).toEqual([
    'Tailored education, doctor’s reminder and cost reduction',
    '1.7 (0.6 – 4.7)',
    '3.2 (1.3 – 7.5)'
  ])
  expect(t.unassigned).toEqual([])
})
it('retains native repeated deviation units below the header labels', () => {
  const t = refine('repeated-deviation-units-below-header-labels')
  expect(t.grid[0][2]).toBe('Baseline Mean(SD)')
  expect(t.grid[0][3]).toBe('Week 6 Mean(SD)')
  expect(t.unassigned).toEqual([])
})
it('splits independently valued regression records with wrapped comparison labels', () => {
  const t = refine('paired-regression-with-wrapped-comparison-stubs')
  expect(t.grid).toHaveLength(7)
  expect(t.grid[2][1]).toBe('1.42')
  expect(t.grid[3]).toEqual([
    'Histological DCIS size >30 versus ≤30*',
    '4.81',
    '2.05–11.3',
    '<0.001',
    '10.73',
    '3.14–36.75',
    '<0.001'
  ])
})
it('keeps pooled diagnostic intervals across their binary count columns', () => {
  const t = refine('binary-counts-with-shared-diagnostic-intervals')
  expect(t.grid[5]).toEqual([
    'Specificity (95% c.i.)',
    '',
    '56.7 (44.0–68.8)',
    '',
    '60.0 (42.1–76.1)',
    '',
    '53.1 (34.7–70.9)',
    ''
  ])
  expect(sourceCell(t, '56.7 (44.0–68.8)')).toMatchObject({ column: 2, colSpan: 2 })
  expect(t.unassigned).toEqual([])
})
it('restores omitted cohort labels above the patient counts', () => {
  const t = refine('recurrence-cohorts-with-omitted-parent-labels')
  expect(t.grid[0]).toEqual([
    '',
    'Entire cohort',
    '',
    'No-radiation cohort',
    '',
    'Radiation cohort',
    ''
  ])
  expect(t.grid.some((r: string[]) => r[0] === 'Radiologic' && r[1] === '7.13')).toBe(true)
  expect(t.unassigned).toEqual([])
})
it('preserves three header tiers and every repeated measurement independently', () => {
  const t = refine('repeated-measures-with-sparse-section-statistics')
  expect(t.grid).toHaveLength(45)
  expect(sourceCell(t, 'Groups')).toMatchObject({ row: 0, column: 1, colSpan: 4 })
  expect(sourceCell(t, 'Experimental')).toMatchObject({ row: 1, column: 1, colSpan: 2 })
  expect(t.grid[41][0]).toBe('Arrival 1st week (T2)')
  expect(t.grid[42][0]).toBe('After 2nd NMT (T2)')
  expect(t.unassigned).toEqual([])
})
it('recovers trailing intervals without borrowing text from the following page', () => {
  const t = refine('rotated-outcome-records-with-trailing-intervals')
  expect(t.grid.at(-1)[0]).toBe('Dyspnoea')
  expect(t.grid.at(-1).slice(1, 4)).toEqual(['6.66 (0–100)', '5.00 (0–100)', '3.33 (0–66.66)'])
  expect(t.unassigned).toEqual([])
})

it('requires complete source evidence before replacing paired numeric and narrative grids', async () => {
  const { recoverFollowupGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-record-grid.mjs')).href
  )
  const { recoverBinaryComparisonGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-binary-comparison-grid.mjs')).href
  )
  const { recoverRuledNarrativeGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
  )
  const a = fixture('perioperative-biomarkers-with-wrapped-significance')
  const missing = a.items.findIndex((i: { text: string }) => i.text === 'Preoperative')
  expect(missing).toBeGreaterThanOrEqual(0)
  expect(
    recoverFollowupGrid(
      a.table,
      a.items.filter((_: unknown, n: number) => n !== missing),
      a.captions,
      a.rules
    )
  ).toBeUndefined()
  const b = fixture('binary-counts-with-shared-diagnostic-intervals')
  expect(b.items.some((i: { text: string }) => i.text.startsWith('56.7'))).toBe(true)
  expect(
    recoverBinaryComparisonGrid(
      b.table,
      b.items.filter((i: { text: string }) => !i.text.startsWith('56.7')),
      b.captions
    )
  ).toBeUndefined()
  const c = fixture('parallel-recommendations-with-independent-paragraphs')
  expect(
    recoverRuledNarrativeGrid(
      c.table,
      c.items,
      c.captions,
      c.rules.filter((r: number[]) => r[0] !== r[2])
    )
  ).toBeUndefined()
})

it('keeps subgroup pairs and their common estimate header aligned', () => {
  const t = refine('subgroup-estimates-with-shared-timepoints')
  expect(t.grid).toHaveLength(21)
  expect(sourceCell(t, 'Adjusted predicted estimates (SE)')).toMatchObject({
    row: 0,
    column: 2,
    colSpan: 4
  })
  expect(t.grid[20]).toEqual([
    '',
    'Low depression (<7)',
    '37',
    '4.3 (0.6)',
    '31',
    '3.8 (0.6)',
    '0.5',
    '-1.2; 2.2',
    '0.590'
  ])
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 17 && c.column === 0)
  ).toMatchObject({ text: 'End of rehabilitation', rowSpan: 2 })
  expect(t.unassigned).toEqual([])
})
it('keeps paired group statistics with their own two observations', () => {
  const t = refine('paired-between-and-within-group-statistics')
  expect(t.grid).toHaveLength(14)
  expect(sourceCell(t, '−0.20')).toMatchObject({ row: 3, column: 3, rowSpan: 2 })
  expect(sourceCell(t, '−3.00')).toMatchObject({ row: 10, column: 3, rowSpan: 2 })
  expect(sourceCell(t, 'Within group')).toMatchObject({ row: 5, column: 6, rowSpan: 9 })
  expect(t.grid[13].slice(0, 3)).toEqual(['', '5th week CK', '105.57 (46.05)'])
  expect(t.unassigned).toEqual([])
})
it('separates underlined review outcomes beside tall independent headings', () => {
  const t = refine('tall-review-header-with-lettered-outcome-rows')
  expect(t.grid).toHaveLength(8)
  expect(sourceCell(t, 'Reported LRR')).toMatchObject({ row: 0, column: 8, colSpan: 2 })
  expect(sourceCell(t, 'Time interval for which LRR reported (years)')).toMatchObject({
    column: 7,
    rowSpan: 2,
    colSpan: 1
  })
  expect(t.grid[1].slice(8, 10)).toEqual(['MRI (%)', 'No MRI (%)'])
  expect(t.grid[4].slice(8)).toEqual(['6b', '6b', '0.51'])
  expect(sourceCell(t, 'Solin et al. 200825')).toMatchObject({ rowSpan: 2 })
  expect(t.unassigned).toEqual([])
})
it('retains wrapped cohort stubs and the final correlation label', () => {
  const t = refine('grouped-correlations-with-wrapped-cohort-labels')
  expect(t.grid).toHaveLength(9)
  expect(sourceCell(t, 'Resistance exercise')).toMatchObject({ row: 1, rowSpan: 4 })
  expect(sourceCell(t, 'Sedentary control')).toMatchObject({ row: 5, rowSpan: 4 })
  expect(t.grid[8]).toEqual(['', 'Energy intake, kcal', '-0.207', '-0.185', '-0.478', '-0.156'])
  expect(t.unassigned).not.toContain('intake, kcal')
})
it('retains source group underlines and complete survey statements', () => {
  const t = refine('three-level-outcome-groups-with-inset-underlines')
  expect(t.grid).toHaveLength(44)
  expect(sourceCell(t, 'Groups')).toMatchObject({ row: 0, column: 2, colSpan: 2 })
  expect(t.grid.at(-1)).toEqual(['Heart disease', '8 (20)', '3 (15)', '5 (25)', ''])
  const survey = refine('bulleted-survey-with-centered-factor-labels')
  expect(survey.grid).toHaveLength(13)
  expect(sourceCell(survey, 'Question or Statement Posed*')).toMatchObject({
    row: 0,
    column: 1,
    colSpan: 2
  })
  for (const [text, row, rowSpan] of [
    ['Knowledge', 1, 3],
    ['Attitudes', 4, 2],
    ['Beliefs', 6, 5],
    ['Barriers', 11, 2]
  ] as const)
    expect(sourceCell(survey, text)).toMatchObject({ row, column: 0, rowSpan, colSpan: 1 })
  expect(survey.grid.slice(1).every((r: string[]) => r[1] === '•' && r[2].length > 20)).toBe(true)
  expect(survey.grid[12][2]).toBe('I can find time for a mammogram if I wish to go for one.')
  expect(survey.unassigned).toEqual([])
  expect(survey.issues).toEqual([])
})
it.each([
  'shifted-center',
  'missing-bullet',
  'missing-inner-bullet',
  'crossing-column',
  'extra-stub',
  'missing-caption'
])('rejects unsupported centered bullet groups: %s', async (kind) => {
  const { recoverRuledNarrativeGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
  )
  const f = fixture('bulleted-survey-with-centered-factor-labels')
  const before = structuredClone(f)
  expect(recoverRuledNarrativeGrid(f.table, f.items, f.captions, f.rules)).toBeDefined()
  expect(f).toEqual(before)
  if (kind === 'shifted-center') {
    const stub = f.items.find((i: { text: string }) => i.text === 'Beliefs')
    stub.rect[1] += 4
    stub.rect[3] += 4
    stub.baseline += 4
  }
  if (kind === 'missing-bullet')
    f.items.splice(
      f.items.findIndex((i: { text: string }) => i.text === '•'),
      1
    )
  if (kind === 'missing-inner-bullet') {
    const bullet = f.items.filter((i: { text: string }) => i.text === '•')[4]
    f.items.splice(f.items.indexOf(bullet), 1)
  }
  if (kind === 'crossing-column')
    f.items.find((i: { text: string }) => i.text.startsWith('I am fearful')).rect[0] -= 35
  if (kind === 'extra-stub') {
    const stub = structuredClone(f.items.find((i: { text: string }) => i.text === 'Barriers'))
    stub.rect[1] += 15
    stub.rect[3] += 15
    stub.baseline += 15
    f.items.push(stub)
  }
  if (kind === 'missing-caption') f.captions = []
  expect(recoverRuledNarrativeGrid(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})
it.each([
  ['subgroup-estimates-with-shared-timepoints', 'Low depression (<'],
  ['paired-between-and-within-group-statistics', '105.57 (46.05)'],
  ['grouped-correlations-with-wrapped-cohort-labels', '-0.156']
])('does not recover incomplete paired evidence in %s', async (name, missing) => {
  const { recoverFollowupGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-record-grid.mjs')).href
  )
  const f = fixture(name)
  const items = f.items.filter((i: { text: string }) => i.text !== missing)
  expect(recoverFollowupGrid(f.table, items, f.captions, f.rules)).toBeUndefined()
})
it('requires the native review parent underline', async () => {
  const { recoverNativeHeaderGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
  )
  const f = fixture('tall-review-header-with-lettered-outcome-rows')
  expect(recoverNativeHeaderGrid(f.table, f.items, f.captions, [])).toBeUndefined()
})
