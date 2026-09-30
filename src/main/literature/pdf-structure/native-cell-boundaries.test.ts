import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverClosedCellGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-column-grid.mjs')).href
)
const run = (name: string): ReturnType<typeof JSON.parse> => {
  const x = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
  return refineTable(x.table, x.tokens, x.captions, [], x.rules)
}
it('uses closed native cells for parent headers and their raised markers', () => {
  const t = run('closed-grid-with-raised-parent-header')
  expect(t.grid[0]).toHaveLength(7)
  expect(
    t.cells.map(({ row, column, colSpan }: { row: number; column: number; colSpan: number }) => ({
      row,
      column,
      colSpan
    }))
  ).toEqual(expect.arrayContaining([expect.objectContaining({ row: 0, column: 5, colSpan: 2 })]))
})
it('retains all ten columns of a two-row volume continuation', () => {
  const t = run('closed-short-volume-table-continuation')
  expect(t.grid).toHaveLength(2)
  expect(t.grid[0]).toHaveLength(10)
  expect(t.grid[0].at(-1)).toBe('0.99')
  expect(t.unassigned).toEqual([])
})
it('joins a wrapped label when adjacent numeric records have uniform leading', () => {
  const t = run('uniform-leading-wrapped-stub-tail')
  expect(t.grid).toContainEqual([
    'Fruit, servings per 1000 kcal/day',
    '1.3, 0.8, 12',
    '2.5, 0.9, 11',
    '1.2, 0.8, 11',
    '.007',
    '.013'
  ])
})
it('does not merge the independent numeric cells of an indented treatment row', () => {
  const t = run('independent-treatment-row-rejected-model-span')
  expect(
    t.cells.some(
      (c: { text: string; colSpan: number }) => c.colSpan > 1 && c.text.startsWith('Web 12.0')
    )
  ).toBe(false)
  expect(t.grid).toContainEqual([
    'Web',
    '12.0 (10 to 15)',
    '0.0 (-2.0 to 1.0)',
    '',
    '0.0 (-4.0 to 2.0)',
    ''
  ])
})
it('preserves section labels and the final record of a single-column ruled table', () => {
  const t = run('ruled-single-column-milestones')
  expect(t.unassigned).toEqual([])
  expect(t.grid).toContainEqual(['Lung Cancer'])
  expect(t.grid.at(-1)).toEqual([
    'No radiation treatments actually received within 90 days of breast cancer surgery'
  ])
})
it('declines a horizontal-only grid without predicted columns while preserving its native input', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/ruled-single-column-milestones.jsonl'
    )
  )
  x.table.structure.objects = x.table.structure.objects.filter(
    (o: { label: string }) => o.label !== 'table column'
  )
  const before = structuredClone(x)
  expect(recoverClosedCellGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.cells).toEqual([])
  expect(t.issues).toContain('missing-row-or-column')
  expect(t.unassigned).toEqual(
    expect.arrayContaining([
      'Lung Cancer',
      'No radiation treatments actually received within 90 days of breast cancer surgery'
    ])
  )
  expect(x).toEqual(before)
})
it('keeps a long final record within its complete native cell band', () => {
  const t = run('segmented-shaded-cells-long-final-record')
  expect(t.unassigned).toEqual([])
  expect(t.grid.at(-1)[1]).toContain('but predominantly yellowish in colour')
})
it('uses repeated native segment endpoints to separate ordinal and description columns', () => {
  const t = run('segmented-shaded-grade-and-description-columns')
  expect(t.grid[0]).toHaveLength(5)
  expect(t.grid[1].slice(0, 2)).toEqual(['0', 'No bleeding'])
  expect(t.unassigned).toEqual([])
})
it('keeps means and deviations in one source value column', () => {
  const t = run('single-value-column-split-at-deviation-sign')
  expect(t.grid[0]).toEqual(['Characteristic', 'Value'])
  expect(t.grid).toContainEqual(['Age, years', '60 ± 10.8'])
  expect(t.grid.at(-1)).toEqual([
    'Interval from surgery or radiation to lymphedema, months',
    '10 ± 36.6'
  ])
  expect(t.grid.every((r: string[]) => r.some(Boolean))).toBe(true)
})
it.each([
  'isotope-parent-headings-above-leaf-row',
  'scripted-repeated-leaves-under-isotope-parents',
  'cohort-parents-with-offset-statistical-stub'
])('preserves repeated leaf headers and independent parent spans: %s', (name) => {
  const t = run(name)
  expect(t.grid[0]).toHaveLength(5)
  expect(t.unassigned).toEqual([])
  expect(t.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ row: 0, column: 1, colSpan: 2 }),
      expect.objectContaining({ row: 0, column: 3, colSpan: 2 }),
      expect.objectContaining({ row: 0, column: 0, rowSpan: 2 })
    ])
  )
})
it.each([
  'repeated-statistics-with-wrapped-comparison-footer',
  'shared-cohort-stubs-with-missing-native-header'
])('bounds cohort spans by complete statistic cycles: %s', (name) => {
  const t = run(name)
  expect(t.unassigned).toEqual([])
  expect(t.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: 'No', rowSpan: 6 }),
      expect.objectContaining({ text: 'Yes', rowSpan: 6 })
    ])
  )
  expect(t.grid[0][0]).toMatch(/^Subclinical heart/)
  expect(t.grid.at(-1)[0]).toMatch(/Mann–Whitney U test/)
})
it.each([
  'paired-interval-arms-with-shared-effect-estimates',
  'paired-interval-arms-with-nested-outcome-heading'
])('preserves each paired arm and its shared scalar cells: %s', (name) => {
  const t = run(name)
  expect(t.unassigned).toEqual([])
  expect(t.grid.some((r: string[]) => r[0] === 'Booklet Web')).toBe(false)
  expect(
    t.cells.filter((c: { column: number; rowSpan: number }) => c.column === 3 && c.rowSpan === 2)
  ).toHaveLength(name.includes('nested') ? 8 : 6)
  if (name.includes('nested')) expect(t.grid.some((r: string[]) => r[0] === 'POMS')).toBe(true)
})
it('keeps all lines of a short numeric table header together', () => {
  const t = run('wrapped-header-above-short-numeric-pairs')
  expect(t.grid).toEqual([
    ['Months', 'Progression-free proportion'],
    ['5', '50%'],
    ['12', '25%'],
    ['20', '5%']
  ])
  expect(t.unassigned).toEqual([])
})
it('retains the final symbol rating and its shared wrapped category', () => {
  const t = run('symbol-rating-matrix-with-wrapped-category-stubs')
  expect(t.unassigned).toEqual([])
  expect(t.grid.at(-1)).toEqual(['', 'Compression', '', '', '', '', '', '++'])
  expect(t.cells).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Method of cooling', rowSpan: 2 })])
  )
})
it('retains a category heading with its probability above indented percentage records', () => {
  const t = run('unowned-category-heading-with-shared-probability')
  expect(t.grid).toContainEqual(['Race', '', '', '', '0.53'])
  expect(t.unassigned).toEqual([])
})
