import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const run = (name: string): ReturnType<typeof JSON.parse> => {
  const x = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
  return refineTable(x.table, x.tokens, x.captions, [], x.rules)
}
it('preserves whole narrative cells delimited by segmented native gutters', () => {
  const t = run('segmented-gutters-with-long-eligibility-records')
  expect(t.grid).toHaveLength(10)
  expect(t.unassigned).toEqual([])
  expect(t.grid[4][0]).toContain('při screeningu zjištěný DCIS')
  expect(t.grid.at(-1)[1]).toContain('informovaný souhlas')
})
it('recovers paired native parent headings and independent final dose records', () => {
  const t = run('segmented-gutters-under-paired-parent-headings')
  expect(t.unassigned).toEqual([])
  expect(t.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ row: 0, column: 0, colSpan: 3, text: 'APBI' }),
      expect.objectContaining({ row: 0, column: 3, colSpan: 3, text: 'WBI' })
    ])
  )
  expect(t.grid.slice(-2)).toEqual([
    ['hrudní stěna', 'Dmax', '36 Gy', '', '', ''],
    ['kůže', 'Dmax', '36 Gy', '', '', '']
  ])
})
it('bounds wrapped category stubs without shifting a later group onto the preceding row', () => {
  const t = run('segmented-gutters-with-shared-wrapped-stubs')
  expect(t.unassigned).toEqual([])
  expect(t.grid[1]).toEqual([
    'Věk (roky)',
    'medián (rozmezí)',
    '65 (51–78)',
    '66 (52–77)',
    '64 (51–78)',
    '0,159'
  ])
  expect(t.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: 'Histologie', rowSpan: 3 }),
      expect.objectContaining({ text: 'PR (%)', rowSpan: 2 }),
      expect.objectContaining({ text: 'Ki67 (%)', rowSpan: 2 })
    ])
  )
})
it('preserves raised note markers inside paired shared scalar estimates', () => {
  const t = run('paired-interval-arms-with-raised-scalar-notes')
  expect(t.unassigned).toEqual([])
  expect(t.cells).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: '0.54a', rowSpan: 2, column: 3 })])
  )
})
it('uses abutting native header strokes while retaining explicitly separated blank statistic cells', () => {
  const t = run('abutting-strokes-with-regression-parent-headings')
  expect(t.unassigned).toEqual([])
  expect(t.cells).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Multivariate Analysis', colSpan: 2 })])
  )
  expect(t.cells.find((c: { text: string }) => c.text === '0.541').rowSpan).toBe(1)
})
it.each([
  ['study-paragraphs-split-into-model-rows', 4],
  ['continued-study-paragraphs-with-wrapped-year', 4],
  ['single-study-paragraph-with-unassigned-tails', 2]
])('retains complete cited study paragraphs: %s', (name, count) => {
  const t = run(String(name))
  expect(t.grid).toHaveLength(Number(count))
  expect(t.unassigned).toEqual([])
  expect(t.grid.every((r: string[]) => r.length === 8)).toBe(true)
  expect(t.grid.slice(1).every((r: string[]) => /^Author/.test(r[0]))).toBe(true)
})
it('extends a numbered overview to its explicit continuation marker', () => {
  const t = run('numbered-study-table-clipped-before-continuation-marker')
  expect(t.grid).toHaveLength(5)
  expect(t.unassigned).toEqual([])
  expect(t.cropRect[3]).toBeGreaterThan(740)
  expect(t.grid.at(-1).at(-1)).toContain('baseline to weeks 1 and 12')
})
it('keeps the first line of every study in a numbered continuation', () => {
  const t = run('numbered-study-continuation-with-lost-record-start')
  expect(t.grid).toHaveLength(3)
  expect(t.unassigned).toEqual([])
  expect(t.grid.at(-1)[0]).toContain('20-10004')
  expect(t.grid.at(-1)[2]).toBe('52 weeks')
})
it('separates independent demographic source records inside a merged model row', () => {
  const t = run('cohort-summaries-with-merged-demographic-records')
  expect(t.unassigned).toEqual([])
  expect(t.grid).toContainEqual(['Ageb', '57.6 (9.1)', '56.0 (9.2)', '59.8 (8.6)', '0.035'])
  expect(t.grid).toContainEqual([
    'Years of education',
    '15.5 (2.4)',
    '15.4 (2.4)',
    '15.6 (2.5)',
    '0.753'
  ])
})
it('removes phantom continuation columns while retaining complete interval summaries', () => {
  const t = run('cohort-continuation-with-phantom-columns')
  expect(t.unassigned).toEqual([])
  expect(t.grid.every((r: string[]) => r.length === 5)).toBe(true)
  expect(t.grid).toContainEqual(['Surgery and radiation', '8 (7.4)', '6 (9.8)', '2 (4.3)', ''])
  expect(t.grid.at(-1)[4]).toBe('0.373')
})
it('retains a clipped page-terminal category and its probability inside native column ends', () => {
  const t = run('page-terminal-category-clipped-across-native-columns')
  expect(t.unassigned).toEqual([])
  expect(t.grid.at(-1)).toEqual(['Vitamin D Concentration (ng/mL)', '', '', '', '0.011'])
  expect(t.cropRect[3]).toBeGreaterThan(1030)
})
it('retains both shared tracer stubs over repeated cutoff measurements', () => {
  const t = run('repeated-measure-cutoffs-with-shared-tracer-stubs')
  expect(t.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: '18F-Alfatide II', rowSpan: 2 }),
      expect.objectContaining({ text: '18F-FDG', rowSpan: 2 })
    ])
  )
})
it('reconstructs offset native header faces without merging across a repeated cohort heading', () => {
  const t = run('closed-grid-with-offset-repeated-header-faces')
  expect(t.grid).toHaveLength(28)
  expect(t.grid[3][1]).toBe('1st measure')
  expect(t.grid[3][4]).toBe('r2')
  expect(t.grid[4][0]).toBe('V1 (dm3)')
  expect(t.grid.every((r: string[]) => r.length === 12)).toBe(true)
  expect(t.unassigned).toEqual([])
  expect(t.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ row: 0, column: 1, colSpan: 11, text: 'Cohort Alpha (n=30)' }),
      expect.objectContaining({ row: 15, column: 1, colSpan: 11, text: 'Cohort Beta (n=30)' }),
      expect.objectContaining({ row: 2, column: 1, colSpan: 4, text: 'Operator A' })
    ])
  )
  expect(t.cells.some((c: { row: number; rowSpan: number }) => c.row === 14 && c.rowSpan > 1)).toBe(
    false
  )
})
it('separates cohort header text and joins a caption-witnessed wrapped label', () => {
  const t = run('ruled-cohort-header-with-overlapping-stub')
  expect(t.grid[0].slice(0, 3)).toEqual(['Characteristics', 'Cohort-only group', 'Wellbeing group'])
  expect(t.grid[6]).toEqual(['Age at study Enrollment, y', '56, 10', '55, 8', '50, 7', '0.305'])
  expect(t.grid[12].slice(0, 2)).toEqual(['Family history of breast cancerc', '4 (33%)'])
  expect(t.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        row: 2,
        column: 0,
        colSpan: 5,
        text: 'Demographic Characteristics'
      })
    ])
  )
  expect(t.unassigned).toEqual([])
})
it('keeps change estimates separate from a two-column P-value parent heading', () => {
  const t = run('ruled-comparison-header-with-shared-p-value')
  expect(t.grid[0].slice(3)).toEqual(['Change', 'P Value for Difference', ''])
  expect(t.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ row: 0, column: 4, colSpan: 2, text: 'P Value for Difference' })
    ])
  )
  expect(
    t.grid.some((r: string[]) => r[0] === 'Fruit, servings per 1000 kcal/day' && r[4] === '.007')
  ).toBe(true)
  expect(t.unassigned).toEqual([])
})
it('retains one shared probability across a complete ordinal distribution', () => {
  const t = run('ruled-cohort-header-with-overlapping-stub')
  expect(t.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ row: 16, column: 4, rowSpan: 3, text: '0.104d' })
    ])
  )
})
it.each(['incomplete-counts', 'independent-probability', 'native-rule', 'missing-category'])(
  'does not infer shared ordinal statistics with %s',
  (reason) => {
    const x = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/ruled-cohort-header-with-overlapping-stub.jsonl'
      )
    )
    type Token = { text: string; baseline: number; height: number; rect: number[] }
    const first = x.tokens.find((t: Token) => /^Stage I\s/.test(t.text)) as Token
    const last = x.tokens.find((t: Token) => /^Stage III\s/.test(t.text)) as Token
    const probability = x.tokens.find((t: Token) => t.text === '0.104') as Token
    if (reason === 'incomplete-counts') {
      const count = x.tokens.find(
        (t: Token) => /^5\s*\(42%\)$/.test(t.text) && Math.abs(t.baseline - first.baseline) < 1
      ) as Token
      count.text = '4 (33%)'
    } else if (reason === 'independent-probability') {
      const offset = first.baseline - probability.baseline
      x.tokens.push({
        ...probability,
        text: '0.321',
        baseline: probability.baseline + offset,
        rect: probability.rect.map((v, n) => (n % 2 ? v + offset : v))
      })
    } else if (reason === 'native-rule') {
      const y = (first.baseline + probability.rect[1]) / 2
      x.rules.push([probability.rect[0] - 10, y, probability.rect[2] + 10, y])
    } else last.text = last.text.replace('III', 'IV')
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(
      t.cells.some((c: { column: number; rowSpan: number }) => c.column === 4 && c.rowSpan === 3)
    ).toBe(false)
  }
)
it.each(['missing-note', 'native-separator'])(
  'does not reassign body markers with %s',
  (reason) => {
    const x = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/ruled-cohort-header-with-overlapping-stub.jsonl'
      )
    )
    const marker = x.tokens.find(
      (t: { text: string; rect: number[] }) => t.text === 'c' && t.rect[1] < 900
    )
    if (reason === 'missing-note')
      x.tokens = x.tokens.filter((t: { rect: number[] }) => t.rect[1] < 900)
    else x.rules.push([marker.rect[0], marker.rect[1] - 1, marker.rect[0], marker.rect[3] + 10])
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(t.grid[12][0]).toBe('Family history of breast cancer')
  }
)
it('merges shared statistic paragraphs while retaining both measured arms and low subscripts', () => {
  const t = run('paired-measurements-with-wrapped-shared-statistics')
  expect(t.grid).toHaveLength(11)
  expect(t.grid[1].slice(1, 5)).toEqual(['ArmA', '137.05 (3.50)', '140.20 (3.38)', '142.96 (3.16)'])
  expect(t.grid[2].slice(1, 5)).toEqual(['ArmB', '135.82 (3.50)', '139.57 (3.38)', '140.21 (3.16)'])
  expect(t.grid[3][6]).toBe('−1.26 (0.77), −2.78 to 0.27')
  expect(t.cells.filter((c: { rowSpan: number }) => c.rowSpan === 2)).toHaveLength(20)
  expect(t.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: 'Total mood disturbance: POMS-SV', rowSpan: 2 })
    ])
  )
  expect(t.grid[9][5]).toContain('η2p = 0.12')
  expect(t.unassigned).toEqual([])
  expect(t.clipped).toEqual([])
})
it('joins a wrapped sample label inside an undivided native header face', () => {
  const t = run('wrapped-sample-label-beside-ruled-parent-headings')
  expect(t.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ row: 0, column: 1, rowSpan: 2, text: 'Lean mass loss, n = 87' })
    ])
  )
  expect(t.grid[1].slice(2, 4)).toEqual(['Control, n = 54', 'Exercise, n = 46'])
})
it('preserves a real rule through an otherwise wrapped sample header', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/wrapped-sample-label-beside-ruled-parent-headings.jsonl'
    )
  )
  const first = x.tokens.find((t: { text: string }) => t.text === 'Lean mass')
  x.rules.push([first.rect[0] - 3, first.rect[3], first.rect[2] + 3, first.rect[3]])
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.cells.some((c: { column: number; rowSpan: number }) => c.column === 1 && c.rowSpan === 2)
  ).toBe(false)
})
