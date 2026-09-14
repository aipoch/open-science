import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNumberedMatrix } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-numbered-matrix.mjs')).href
)
const { recoverWrappedProportionGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-wrapped-proportion-grid.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
const refine = (x: ReturnType<typeof load>): ReturnType<typeof refineTable> =>
  refineTable(x.table, x.tokens, x.captions, [], x.rules)
it('restores a complete triangular matrix without synthesizing the empty half', () => {
  const x = load('numbered-correlation'),
    before = structuredClone(x),
    t = refine(x)
  expect(t.grid[0]).toEqual(['', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
  expect(t.grid.at(-1)).toEqual(['11. Comorbidity', '', '', '', '', '', '', '', '', '', '1.00'])
  expect(t.grid[2].slice(1)).toEqual([
    '1.00',
    '0.01',
    '−0.08',
    '−0.07',
    '−0.05',
    '−0.20b',
    '0.01',
    '−0.07',
    '−0.09',
    '0.00'
  ])
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(before)
})
it.each(['diagonal', 'heading', 'duplicate', 'footer'])(
  'rejects an incomplete matrix with %s',
  (kind) => {
    const x = load('numbered-correlation')
    if (kind === 'diagonal') x.tokens.find((i: { text: string }) => i.text === '1.00').text = '0.99'
    if (kind === 'heading') x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '11')
    if (kind === 'duplicate')
      x.tokens.push(structuredClone(x.tokens.find((i: { text: string }) => i.text === '1.00')))
    if (kind === 'footer') x.rules = []
    expect(recoverNumberedMatrix(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
  }
)
it('keeps wrapped percentages with their own records and separates the conditional heading', () => {
  const x = load('wrapped-survey-records'),
    before = structuredClone(x),
    t = refine(x)
  expect(t.grid).toEqual([
    ['', 'Intervention', 'Control', 'p value*'],
    [
      'Discussed results of mammogram with primary care provider',
      '78 (33.5%)',
      '56 (25.5%)',
      '.05'
    ],
    ['If yes, discussed:', '', '', ''],
    [
      'Whether you should get any additional screening tests for breast cancer in addition to a mammogram',
      '28 (35.9)',
      '12 (21.4)',
      '.07'
    ],
    ['Ultrasound', '14 (18.0)', '3 (5.4)', '.03'],
    ['Breast MRI', '11 (14.4)', '7 (12.5)', '.79']
  ])
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(before)
})
it.each(['missing-percent', 'extra-value', 'no-rules'])(
  'declines ambiguous wrapped proportions: %s',
  (kind) => {
    const x = load('wrapped-survey-records')
    if (kind === 'missing-percent')
      x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '(21.4)')
    if (kind === 'extra-value')
      x.tokens.push(structuredClone(x.tokens.find((i: { text: string }) => i.text === '12')))
    if (kind === 'no-rules') x.rules = []
    expect(recoverWrappedProportionGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
  }
)
it('recovers split-glyph time headings above the first measurement record', () => {
  const x = load('split-time-headings'),
    t = refine(x)
  expect(t.grid[0]).toEqual(['', '', 't0', 't1', 't2', 't3', 't4'])
  expect(t.grid[1].slice(2)).toEqual([
    '18.00±6.77',
    '18.47±5.71',
    '16.36±7.87',
    '13.48±7.84',
    '14.51±5.73'
  ])
  x.rules = []
  expect(refine(x).repairs).not.toContain('ruled-time-header-recovered')
})

it('preserves all numbered cases and keeps continuation cells with their identifier', () => {
  const x = load('numbered-case-records'),
    before = structuredClone(x),
    t = refine(x)
  expect(t.grid.filter((r: string[]) => /^\d+$/.test(r[0])).map((r: string[]) => r[0])).toEqual(
    Array.from({ length: 29 }, (_, n) => String(n + 1))
  )
  expect(t.grid.find((r: string[]) => r[0] === '5')?.[4]).toBe('IIIB (T2N1M0) /IV (T2N3M1) a')
  expect(t.grid.find((r: string[]) => r[0] === '17')?.[2]).toBe('3+ (IHC)/ 2+ (IHC)/FISH- b')
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(before)
})
it('recovers ruled paired deviations and every wrapped measurement label', () => {
  const x = load('paired-deviation-stubs'),
    t = refine(x)
  expect(t.grid[0]).toEqual(['', '500 μg', '1000 μg'])
  expect(t.grid).toContainEqual(['Lower large intestine wall', '0.005±0.001', '0.005±0.001'])
  expect(t.grid).toContainEqual(['Upper large intestine wall', '0.007±0.001', '0.008±0.002'])
  expect(t.grid.at(-2)).toEqual([
    'Effective Dose equivalent (mSv/MBq)',
    '0.017±0.004',
    '0.022±0.005'
  ])
  expect(t.unassigned).toEqual([])
})
it('uses explicitly named definition columns to retain the complete paragraph for each term', () => {
  const t = refine(load('term-definitions'))
  expect(t.grid.find((r: string[]) => r[0] === 'Utility')?.[1]).toBe(
    'A patient’s preference for a particular health outcome or health state; value ranges from 0 (dead) to 1 (perfect health)31,33'
  )
  expect(t.grid.find((r: string[]) => r[0] === 'Wholesale acquisition cost')?.[1]).toMatch(
    /^The manufacturer/
  )
  expect(t.grid.at(-1)?.[0]).toBe('Willingness-to-pay threshold')
})

it('retains a ruled table title and centered summary values over count/percent pairs', () => {
  const x = load('centered-count-summaries'),
    before = structuredClone(x),
    t = refine(x)
  expect(t.grid[0][0]).toBe('Demographic characteristics')
  expect(t.grid.find((r: string[]) => r[0] === 'Mean')).toEqual([
    'Mean',
    '55.7',
    '',
    '48.9',
    '',
    '52',
    '',
    '49',
    '',
    '51',
    ''
  ])
  const meanRow = t.grid.findIndex((r: string[]) => r[0] === 'Mean')
  expect(
    t.cells
      .filter((c: { row: number; column: number }) => c.row === meanRow && c.column > 0)
      .map((c: { colSpan: number }) => c.colSpan)
  ).toEqual([2, 2, 2, 2, 2])
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(before)
})
it.each(['ruled-narrative-instructions', 'ruled-narrative-continuation'])(
  'retains whole narrative paragraphs in native ruled bands: %s',
  (name) => {
    const x = load(name),
      before = structuredClone(x),
      t = refine(x)
    expect(t.grid[0]).toEqual(['Worst Grade Toxicity (CTCAE v5.0)', 'Management Guidelines'])
    expect(t.unassigned).toEqual([])
    expect(t.grid.flat().join(' ')).not.toContain('(continued on following page)')
    expect(x).toEqual(before)
    if (name === 'ruled-narrative-instructions') {
      const r = t.grid.findIndex((r: string[]) => r[0] === 'Anemia')
      expect(t.grid.slice(r, r + 3)).toEqual([
        ['Anemia', ''],
        ['Grade 3', 'Delay dose until resolution to grade ≤2, then maintain dose'],
        ['Grade 4', 'Delay dose until resolution to grade ≤2, then reduce dose by one level']
      ])
      expect(t.grid.find((r: string[]) => r[0] === 'Grade 3')?.[1]).toContain(
        '60 minutes for a 30-minute infusion'
      )
    } else {
      expect(t.grid[1][1]).toContain(
        'If resolved in >28 days from the day of onset, reduce dose by one level'
      )
      expect(t.grid[3][1]).toContain('methylprednisolone')
      expect(t.grid.at(-1)[1]).toContain('oral surgeon')
    }
  }
)

it('uses matching segmented header rules to recover sparse summary columns', () => {
  const x = load('segmented-numeric-summary'),
    before = structuredClone(x),
    t = refine(x)
  expect(t.grid[0]).toEqual([
    'Results, Discounted',
    'Denosumab',
    'Mix of Zoledronic Acid and Untreated*',
    'Difference'
  ])
  expect(t.grid).toContainEqual(['Costs, US$', '175,115', '166,072', '9,043'])
  expect(t.grid).toContainEqual(['Costs, US$', '136,820', '123,423', '13,396'])
  expect(t.grid.at(-1)).toEqual(['Net monetary benefit, US$', '5,782', '', ''])
  expect(t.grid).toHaveLength(11)
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(before)
})
it('keeps an independent time stub and repeated source-unit groups, including blank measurements', () => {
  const x = load('repeated-unit-columns'),
    before = structuredClone(x),
    t = refine(x)
  expect(t.grid).toHaveLength(6)
  expect(t.grid[2]).toEqual([
    '2 h',
    '26±10',
    '27±10',
    '35±9',
    '2.7±0.9',
    '3.3±0.8',
    '2.7±0.6',
    '3.1±0.3',
    '3.2±1.1',
    '2.4±0.8',
    '1.8±0.4',
    '0.8±0.3',
    '1.0±0.3'
  ])
  expect(t.grid.at(-1)).toEqual([
    '24 h',
    '',
    '29±10',
    '38±8',
    '',
    '1.4±0.5b',
    '1.2±0.4b',
    '',
    '2.4±1.0',
    '1.8±0.8',
    '',
    '0.6±0.2a',
    '1.0±0.3'
  ])
  expect(
    t.cells
      .filter((c: { row: number; column: number }) => c.row === 0 && c.column > 0)
      .map((c: { colSpan: number }) => c.colSpan)
  ).toEqual([3, 3, 3, 3])
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(before)
})
it('recovers a labeled significance record between existing rows without moving neighboring measurements', () => {
  const x = load('missing-p-record'),
    t = refine(x)
  expect(t.grid).toContainEqual(['Race', 'p = .312', 'p = .27', '', ''])
  expect(t.grid).toContainEqual(['Menopausal status', 'p = .3467', 'p = .18', '', ''])
  expect(t.unassigned).toEqual([])
  x.tokens = x.tokens.filter((i: { text: string }) => i.text !== 'Race')
  expect(refine(x).repairs).not.toContain('labeled-p-record-recovered')
})
it('retains repeated count-section titles, parent tiers and each complete toxicity record', () => {
  const x = load('repeated-count-sections'),
    before = structuredClone(x),
    t = refine(x)
  expect(t.grid).toHaveLength(16)
  expect(t.grid[0][0]).toMatch(/STUDY 1$/)
  expect(t.grid[8][0]).toMatch(/STUDY 2$/)
  expect(t.grid[6]).toEqual(['Epigastric pain', '2', '6.6', '2', '7', '0', '0', '0', '0'])
  expect(t.grid[14]).toEqual(['Epigastric pain', '0', '0', '1', '4.16', '0', '0', '0', '0'])
  expect(t.grid.at(-1)).toEqual(['Tachycardia', '0', '0', '0', '0', '0', '0', '0', '0'])
  expect(
    t.cells.filter((c: { row: number }) => c.row === 1).map((c: { colSpan: number }) => c.colSpan)
  ).toEqual([1, 4, 4])
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(before)
})
it.each([
  ['segmented-numeric-summary', 'recoverNativeHeaderGrid'],
  ['repeated-unit-columns', 'recoverRepeatedUnitGrid'],
  ['repeated-count-sections', 'recoverRepeatedCountSections']
])('declines native header recovery without its rule evidence: %s', async (name, fn) => {
  const module = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
  )
  const x = load(name)
  expect(module[fn](x.table, x.tokens, x.captions, [])).toBeUndefined()
  const bodyToken = x.tokens.find(
    (i: { text: string; rect: number[] }) =>
      /^\d+[,.±]/.test(i.text) &&
      i.rect[0] >= x.table.cropRect[0] &&
      i.rect[2] <= x.table.cropRect[2] &&
      i.rect[1] >= x.table.cropRect[1] &&
      i.rect[3] <= x.table.cropRect[3]
  )
  x.tokens.push(structuredClone(bodyToken))
  expect(module[fn](x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
it('rejects missing narrative separators rather than merging adjacent grade instructions', async () => {
  const { recoverRuledNarrativeGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
  )
  const x = load('ruled-narrative-instructions')
  const anemia = x.tokens.find((i: { text: string }) => i.text === 'Anemia')
  const after = x.rules
    .filter((r: number[]) => r[1] === r[3] && r[1] > anemia.rect[3])
    .sort((a: number[], b: number[]) => a[1] - b[1])[0]
  expect(
    recoverRuledNarrativeGrid(
      x.table,
      x.tokens,
      x.captions,
      x.rules.filter((r: number[]) => r[1] !== after[1])
    )
  ).toBeUndefined()
})
