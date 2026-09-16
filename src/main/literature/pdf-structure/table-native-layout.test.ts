import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { tableCaptionCropTop } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-geometry.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures', `${name}.jsonl`))
const parse = (name: string): ReturnType<typeof JSON.parse> => {
  const f = fixture(name),
    first = refineTable(f.table, f.items, f.captions, [], f.rules)
  const rect = [
    first.cropRect[0],
    Math.min(...first.rows.map((r: { rect: number[] }) => r.rect[1])),
    first.cropRect[2],
    Math.max(...first.rows.map((r: { rect: number[] }) => r.rect[3]))
  ].map((x) => x / 1.5)
  const notes = associateTableNotes(
    f.page,
    [{ rect }],
    f.rules.map((r: number[]) => r.map((x) => x / 1.5))
  )[0]
  return {
    ...refineTable(
      f.table,
      f.items,
      f.captions,
      notes.map((n: { rect: number[] }) => ({ ...n, rect: n.rect.map((x) => x * 1.5) })),
      f.rules
    ),
    notes
  }
}
it.each([
  'behavioral-sleep-comparison-with-method-note',
  'risk-group-headers-beside-independent-event-stub',
  'between-group-effects-with-explanatory-note'
])('cuts caption descenders in native whitespace for %s', (name) => {
  const f = fixture(name),
    t = parse(name)
  const firstText = Math.min(
    ...t.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects.map((r) => r[1]))
  )
  const captionBottom = Math.max(
    ...f.captions
      .filter((c: { rect: number[] }) => c.rect[3] <= firstText)
      .map((c: { rect: number[] }) => c.rect[3])
  )
  const top = tableCaptionCropTop(t, captionBottom, f.rules)
  expect(top).toBeGreaterThan(captionBottom + 1.5)
  expect(top).toBeLessThan(firstText)
})
it('preserves a native top border and a narrow caption gap without cutting source text', () => {
  const table = {
    cropRect: [0, 0, 100, 50],
    cells: [{ sourceRects: [[10, 20, 80, 30]] }],
    unassigned: []
  }
  expect(tableCaptionCropTop(table, 10, [[0, 12, 100, 12]])).toBe(12)
  expect(tableCaptionCropTop(table, 19.6, [])).toBeCloseTo(19.8)
  expect(tableCaptionCropTop(table, 21, [])).toBe(0)
  expect(table.cropRect).toEqual([0, 0, 100, 50])
})
it('keeps the entire last header inside the native ruled crop without absorbing its caption', () => {
  const f = fixture('behavioral-sleep-comparison-with-method-note')
  const t = parse('behavioral-sleep-comparison-with-method-note')
  const heading = f.items.find((i: { text: string }) => i.text === 'Wake After Sleep Onset (WASO)')
  expect(t.cropRect[2]).toBeGreaterThan(heading.rect[2])
  expect(t.cropRect[1]).toBe(f.table.cropRect[1])
  expect(t.grid[0][4]).toBe(heading.text)
  expect(t.grid).toHaveLength(17)
  expect(t.clipped).toEqual([])
  expect(t.issues).toEqual([])
})
it.each(['footer', 'caption', 'overhanging-label'])(
  'does not infer a wider table without its native %s evidence',
  (missing) => {
    const f = fixture('behavioral-sleep-comparison-with-method-note')
    if (missing === 'footer') f.rules = f.rules.filter((r: number[]) => r[1] < 700)
    if (missing === 'caption') f.captions = []
    if (missing === 'overhanging-label') {
      f.items.find((i: { text: string }) => i.text === 'Wake After Sleep Onset (WASO)').rect[2] =
        f.table.cropRect[2] - 1
    }
    const t = refineTable(f.table, f.items, f.captions, f.notes, f.rules)
    expect(t.cropRect[2]).toBe(f.table.cropRect[2])
  }
)
it('associates a median/range definition below the table without turning it into a record', () => {
  const t = parse('three-arm-outcomes-with-shared-significance')
  expect(t.notes.map((n: { text: string }) => n.text)).toEqual([
    'Values are median except those in parenthesis, which are minimum to maximum'
  ])
  expect(t.grid).toHaveLength(25)
  expect(t.grid.flat().some((s: string) => s.includes('Values are median'))).toBe(false)
  expect(t.clipped).toEqual([])
})
it('uses matching native borders to exclude a sliver of neighboring body prose', () => {
  const t = parse('risk-group-headers-beside-independent-event-stub')
  expect(t.cropRect[2]).toBeLessThan(536)
  expect(t.grid[0]).toEqual(['Event', 'High risk', '', 'Low risk'])
  expect(t.grid.at(-1)).toEqual(['Death', '1', '1', '1'])
  expect(t.unassigned).toEqual([])
  expect(t.clipped).toEqual([])
})
it('does not trim a genuine label crossing the proposed native side border', () => {
  const f = fixture('risk-group-headers-beside-independent-event-stub')
  f.items.push({
    text: 'Edge label',
    rect: [515, 200, 530, 212],
    height: 12,
    baseline: 212,
    horizontal: true
  })
  const t = refineTable(f.table, f.items, f.captions, f.notes, f.rules)
  expect(t.cropRect).toEqual(f.table.cropRect)
})
it('preserves a confidence-interval qualifier wrapped within an undivided native header', () => {
  const t = parse('between-group-effects-with-explanatory-note')
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 5)
  ).toMatchObject({ text: 'Difference 95% CI', rowSpan: 2, colSpan: 1 })
  expect(t.grid[0][4]).toBe('Difference')
  expect(t.grid[1][4]).toBe('Mean (SD)')
  expect(t.issues).not.toContain('span-conflicts-with-source-rows')
})
it.each(['divider', 'open-face', 'independent-heading'])(
  'rejects a header qualifier merge with %s evidence',
  (changed) => {
    const f = fixture('between-group-effects-with-explanatory-note')
    if (changed === 'divider') f.rules.push([702.4, 114.5, 807.4, 114.5])
    if (changed === 'open-face') f.rules = []
    if (changed === 'independent-heading') {
      f.items.find((i: { text: string }) => i.text === '95% CI').text = 'Independent outcome'
    }
    const t = refineTable(f.table, f.items, f.captions, f.notes, f.rules)
    expect(
      t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 5)
    ).toMatchObject({ rowSpan: 1 })
  }
)
it.each([
  ['ruled-attribute-list-with-hanging-entries', 22, 1],
  ['wide-utility-matrix-with-shared-relative-importance', 25, 19],
  ['percentage-distributions-with-independent-significance-rows', 18, 2],
  ['sectioned-mixed-effects-with-wrapped-coefficients', 17, 6],
  ['treatment-sessions-with-four-paragraph-topics', 25, 3],
  ['hospital-treatment-counts-with-three-header-tiers', 21, 13],
  ['numbered-interview-quotes-with-shared-themes', 6, 3],
  ['numbered-interview-quotes-with-shared-themes-continued', 3, 3],
  ['interview-assessments-with-independent-lettered-paragraphs', 6, 3],
  ['population-counts-with-nested-analysis-headers', 39, 10],
  ['graded-adverse-events-with-full-width-topic', 14, 7],
  ['repeated-treatment-groups-with-liver-statistics', 18, 10],
  ['repeated-treatment-groups-with-renal-statistics', 10, 10],
  ['toxicity-counts-with-risk-treatment-grade-tiers', 36, 7],
  ['knowledge-summary-with-repeated-measurement-headers', 9, 10],
  ['assessment-schedule-with-nested-period-headers', 20, 7],
  ['assessment-schedule-with-nested-period-headers-continued', 13, 7],
  ['implementation-measures-with-wrapped-narrative-stubs', 10, 2],
  ['paired-frequency-summary-with-wrapped-deviation-labels', 25, 6]
])('keeps native records and owns every token in %s', (name, rows, columns) => {
  const t = parse(String(name))
  expect(t.grid).toHaveLength(Number(rows))
  expect(t.grid.every((r: string[]) => r.length === columns)).toBe(true)
  expect(t.unassigned).toEqual([])
})
it('keeps every utility column and the relative importance shared by category levels', () => {
  const t = parse('wide-utility-matrix-with-shared-relative-importance')
  expect(
    t.cells.filter(
      (c: { column: number; row: number; rowSpan: number }) =>
        c.row > 1 && c.column > 0 && c.rowSpan > 1
    )
  ).toHaveLength(54)
  expect(t.grid.flat().some((s: string) => s.startsWith('−'))).toBe(true)
})
it('retains distinct significance rows and the original inequality symbols', () => {
  const t = parse('percentage-distributions-with-independent-significance-rows')
  expect(t.grid.filter((r: string[]) => /^p [=<]/.test(r[1]))).toEqual([
    ['', 'p < 0.01'],
    ['', 'p < 0.01'],
    ['', 'p = 0.001']
  ])
  expect(t.grid).toContainEqual(['≤5 cm', '0%'])
  expect(t.grid).toContainEqual(['>8 cm', '100%'])
  expect(parse('toxicity-grades-with-native-plus').grid).toContainEqual(['Grade 3+', '1 (2.5%)'])
})
it('restores both intercepts and the complete mixed-model coefficient labels', () => {
  const t = parse('sectioned-mixed-effects-with-wrapped-coefficients')
  expect(t.grid.filter((r: string[]) => r[0] === 'Intercept')).toEqual([
    ['Intercept', '83.2(1.3)**', '2.2(0.1)**', '82.3(6.6)**', '32.2(3.1)**', '31.4(3.1)**'],
    [
      'Intercept',
      '38.2(13.5)**',
      '0.1(<0.1)**',
      '1001.9(338.5)**',
      '200.3(77.8)**',
      '192.0(72.6)**'
    ]
  ])
  expect(t.grid.map((r: string[]) => r[0])).toEqual(
    expect.arrayContaining([
      'Fixed Effects',
      'Rate of Change',
      'Random Effects',
      'Occasion (Linear)',
      'Fit Statistics'
    ])
  )
})
it('keeps native parent spans independent from the event stub and later count header', () => {
  const risk = parse('risk-group-headers-beside-independent-event-stub')
  expect(risk.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 1, colSpan: 2, text: 'High risk' })
  )
  expect(risk.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 0, colSpan: 1, text: 'Event' })
  )
  const count = parse('continuous-measure-before-count-percentage-header')
  expect(count.cells).toContainEqual(expect.objectContaining({ text: 'Age (years)', rowSpan: 1 }))
})
it('keeps shared treatment statistics and preserves an anomalous source value verbatim', () => {
  const t = parse('three-arm-outcomes-with-shared-significance')
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 6, rowSpan: 3, text: '0.062' })
  )
  expect(t.grid.flat()).toContain('.0.028')
  for (const name of [
    'paired-knowledge-changes-with-shared-probability',
    'paired-perception-changes-with-shared-probability'
  ])
    expect(parse(name).cells).toContainEqual(
      expect.objectContaining({ row: 1, column: 4, rowSpan: 2 })
    )
  expect(parse('paired-side-effect-counts-with-shared-probabilities').cells).toContainEqual(
    expect.objectContaining({ row: 2, column: 3, rowSpan: 3, text: '0.384' })
  )
})
it('separates both population count records and retains the printed incomplete count', () => {
  const t = parse('population-counts-with-nested-analysis-headers')
  expect(t.grid[14]).toEqual([
    '2',
    '4 (2.02)',
    '33 (21.02)',
    '',
    '3 (2.16)',
    '21 (19.09)',
    '',
    '1 (1.69)',
    '12 (25.53)',
    ''
  ])
  expect(t.grid[15]).toEqual([
    '3',
    '0 (0)',
    '3 (1.91)',
    '',
    '0 (0)',
    '3 (2.73)',
    '',
    '0 (0)',
    '(0)',
    ''
  ])
})
it('recovers first demographic categories without making them column headers', () => {
  expect(parse('headerless-demographics-with-leading-age').grid[0][0]).toMatch(/^Age/)
  expect(parse('headerless-demographics-with-leading-gender').grid[0][0]).toBe('Gender, N (%)')
  expect(
    parse('short-clinical-comparison-with-leading-measurement')
      .grid.flat()
      .some((s: string) => s.startsWith('Age'))
  ).toBe(true)
})
it('keeps wrapped drug, sample-size, and treatment parent headers complete', () => {
  const t = parse('paired-frequency-summary-with-wrapped-deviation-labels')
  expect(t.cells).toContainEqual(
    expect.objectContaining({ text: 'Routine Care Group (n = 109)', colSpan: 2 })
  )
  expect(t.grid).toContainEqual(['Age Mean (SD)', '55.31 (8.47)', '', '58.43 (8.92)', '', '.03'])
  expect(parse('paired-treatment-changes-from-baseline').cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 3, text: 'Reference trastuzumab', colSpan: 2 })
  )
  expect(parse('response-comparison-with-wrapped-drug-heading').unassigned).toEqual([])
})
it.each([
  ['repeated-treatment-groups-with-liver-statistics', 'Data are reported as mean'],
  ['repeated-treatment-groups-with-renal-statistics', 'Creatinine'],
  ['behavioral-sleep-comparison-with-method-note', 'Behavioral sleep data'],
  ['sectioned-mixed-effects-with-wrapped-coefficients', 'Subjective sleep data'],
  ['parenthesized-deviations-with-explanatory-note', 'SDs are reported'],
  ['between-group-effects-with-explanatory-note', 'SDs are reported'],
  ['short-clinical-comparison-with-leading-measurement', 'Data are median'],
  ['odds-ratio-definition-below-short-comparison', 'Data are numbers'],
  ['response-comparison-with-wrapped-drug-heading', 'Valid percent was reported'],
  ['survival-analysis-with-cited-analysis-set-note', 'ITT'],
  ['hospital-treatment-counts-with-three-header-tiers', 'PT']
])('attaches the complete explanatory note in %s', (name, text) => {
  const t = parse(name)
  expect(t.notes.map((n: { text: string }) => n.text).join(' ')).toContain(text)
  expect(t.unassigned).toEqual([])
})
it.each([
  'citation-sidebar-with-publication-history',
  'abbreviations-beside-acknowledgements',
  'numbered-author-affiliations-with-institutions'
])('rejects uncaptioned prose in %s while accepting explicitly captioned tables', (name) => {
  const f = fixture(name),
    t = refineTable(f.table, f.items, [], [], f.rules)
  expect(hasTableEvidence(t, undefined, f.items)).toBe(false)
  expect(hasTableEvidence(t, { text: 'Table 1. Published data' }, f.items)).toBe(true)
})
it('recovers the complete captioned vector design beside an unrelated prose box', () => {
  const { page } = fixture('captioned-vector-design-beside-prose-box')
  const figures = associateFigures(page, findCaptionCandidates([page]))
  expect(figures).toHaveLength(1)
  expect(figures[0].graphicsCount).toBe(37)
  expect(figures[0].rect[0]).toBeCloseTo(304.61, 1)
  expect(figures[0].rect[3]).toBeCloseTo(695.1, 1)
})
it('does not turn an inline flowchart reference into a figure caption', () => {
  const { page } = fixture('inline-flowchart-reference-in-body-prose')
  expect(
    findCaptionCandidates([page]).filter((c: { lines: string[] }) =>
      /^Figure 1 represents/.test(c.lines[0])
    )
  ).toEqual([])
})

it.each([
  [
    'repeated-treatment-groups-with-liver-statistics',
    'repeated-treatment-groups-with-renal-statistics'
  ],
  [
    'knowledge-summary-with-repeated-measurement-headers',
    'paired-perception-changes-with-shared-probability',
    'paired-knowledge-changes-with-shared-probability'
  ]
])('keeps each caption above its own native header in %s', async (...names) => {
  const { associateTableCaptions } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
  )
  const inputs = names.map(fixture),
    tables = names.map(parse)
  const rectangles = tables.map((t) => ({
    rect: [
      t.cropRect[0],
      Math.min(...t.rows.map((r: { rect: number[] }) => r.rect[1])),
      t.cropRect[2],
      Math.max(...t.rows.map((r: { rect: number[] }) => r.rect[3]))
    ].map((x) => x / 1.5)
  }))
  const f = inputs[0]
  const captions = associateTableCaptions(
    f.page,
    rectangles,
    f.captions.map((c: { rect: number[] }) => ({ ...c, rect: c.rect.map((x) => x / 1.5) })),
    f.rules.map((r: number[]) => r.map((x) => x / 1.5))
  )
  expect(
    captions.map(
      (c: { caption?: { lines: string[] } }) => c.caption?.lines[0].match(/^Table \d+/)?.[0]
    )
  ).toEqual(names.map((_, n) => `Table ${n + 1}`))
})
it('restores a boxed prompt and every independent session and implementation paragraph', () => {
  expect(parse('boxed-questionnaire-prompt-above-column-headings').cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 0, colSpan: 3 })
  )
  expect(
    parse('treatment-sessions-with-four-paragraph-topics')
      .grid.flat()
      .filter((s: string) => /^Session [1-6]/.test(s))
  ).toHaveLength(6)
  expect(parse('implementation-domains-with-shared-climate-label').cells).toContainEqual(
    expect.objectContaining({ text: 'Implementation Climate', rowSpan: 2 })
  )
  expect(
    parse('implementation-measures-with-wrapped-narrative-stubs')
      .grid.flat()
      .some((s: string) =>
        s.startsWith('User feedback survey (intervention group only): 17 questions, 15')
      )
  ).toBe(true)
})
it('keeps unadjusted and adjusted hazard estimates under their own parents', () => {
  for (const name of [
    'adjusted-risk-with-underlined-parent-headings',
    'adjusted-risk-with-separated-probability-and-interval'
  ]) {
    const t = parse(name)
    expect(t.unassigned).toEqual([])
    expect(
      t.cells.some(
        (c: { text: string; colSpan: number }) => /Unadjusted/.test(c.text) && c.colSpan === 2
      )
    ).toBe(true)
    expect(
      t.cells.some(
        (c: { text: string; colSpan: number }) => /Adjusted/.test(c.text) && c.colSpan === 2
      )
    ).toBe(true)
  }
  expect(
    parse('adjusted-risk-with-separated-probability-and-interval').grid.some(
      (r: string[]) => r.includes('0.177') && r.includes('0.96 (0.69–1.28)')
    )
  ).toBe(true)
})

it('includes the complete final assessment above a native footer just outside the model crop', () => {
  const t = parse('assessment-schedule-with-nested-period-headers')
  expect(t.grid.at(-1)).toEqual([
    'Financial distress (mean), measured using the National Medical Center and Beckman Research Institute QoL Instrument Breast Cancer Patient Version25',
    '✓',
    '',
    '✓',
    '✓',
    '✓',
    '✓'
  ])
  expect(t.cropRect[3]).toBeGreaterThan(
    fixture('assessment-schedule-with-nested-period-headers').table.cropRect[3]
  )
})
