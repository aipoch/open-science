import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
import { copyPdfTable } from '../../../shared/pdf-table-copy'

const runtime = (name: string): string =>
  pathToFileURL(resolve(`resources/pdf-structure/literature-pdf-${name}.mjs`)).href
const { refineTable } = await import(runtime('table-refine'))
const {
  recoverRuledComparisonRecords,
  recoverAlleleDistributionGrid,
  recoverRuledIntervalRecords
} = await import(runtime('native-header-grid'))
const { recoverRepeatedRegressionGrid } = await import(runtime('regression-grid'))
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const refine = (name: string): ReturnType<typeof JSON.parse> => {
  const f = load(name)
  return refineTable(f.table, f.tokens, f.captions, [], f.rules)
}

it.each([
  ['paired-count-and-percentage', 21, 9],
  ['allele-distribution-columns', 17, 17],
  ['repeated-regression-intervals', 20, 19],
  ['nested-regression-models', 25, 13],
  ['longitudinal-category-records', 43, 11],
  ['continued-physical-health-records', 25, 11],
  ['symptom-category-statistics', 72, 4],
  ['sentinel-node-categories', 58, 4],
  ['omitted-lens-record', 9, 3],
  ['header-and-baseline-intervals', 4, 5],
  ['parallel-criteria-bullets', 4, 2],
  ['headerless-receptor-records', 17, 4],
  ['underlined-grade-comparisons', 29, 4],
  ['shared-event-count-header', 11, 6],
  ['split-event-count-header', 11, 6]
] as const)('recovers source rows and columns: %s', (name, rows, columns) => {
  const t = refine(name)
  expect(t.grid).toHaveLength(rows)
  expect(t.grid.every((r: string[]) => r.length === columns)).toBe(true)
  expect(t.unassigned).toEqual([])
  expect(t.issues.filter((i: string) => i !== 'text-crosses-crop-boundary')).toEqual([])
})

it('retains reference rows, wrapped intervals and all repeated statistic columns', () => {
  const t = refine('repeated-regression-intervals')
  expect(t.grid[3]).toEqual([
    '',
    ...Array.from({ length: 6 }, () => ['Estimate', '95% CI', 'P-value']).flat()
  ])
  expect(t.grid[5]).toEqual([
    'Homozygous T/T',
    ...Array.from({ length: 6 }, () => ['ref', '', '']).flat()
  ])
  expect(t.grid.flat()).toContain('(1.00001, 3.46)')
  expect(t.grid.at(-1)).toEqual([
    'Homozygous C/C',
    ...Array.from({ length: 6 }, () => ['-', '', '']).flat()
  ])
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 6)
  ).toHaveLength(3)
})

it('keeps genotype counts, missing genotype columns and paired count headers', () => {
  const t = refine('allele-distribution-columns')
  expect(t.grid[1][11]).toBe('CC (n=0)')
  expect(t.grid[1][15]).toBe('CC (n=0)')
  expect(t.grid.at(-1)[0]).toBe('Missing')
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 4)
  ).toHaveLength(4)
  const paired = refine('paired-count-and-percentage')
  expect(
    paired.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 2)
  ).toHaveLength(4)
  expect(paired.grid.flat()).toContain('Baseline ECOG performance status')
})

it('keeps baseline separate from its header and retains printed decimal punctuation', () => {
  const t = refine('header-and-baseline-intervals')
  expect(t.grid[0]).toEqual(['hsCRP', 'EVOO (n=15)', 'ELOO (n=15)', 'Control (n=15)', 'p'])
  expect(t.grid[1]).toEqual([
    'Baseline (mg/L)',
    '9.45 (0.20, 126.90)',
    '8.80 (0.90, 115.20)',
    '9.60 (1.30, 80.70)',
    '0,8501'
  ])
  expect(
    t.cells
      .find((c: { row: number; column: number }) => c.row === 1 && c.column === 4)
      .textRuns.at(-1)
  ).toEqual({ text: '1', position: 'superscript' })
})

it('separates criteria while preserving bullet paragraphs in the copied table', () => {
  const t = refine('parallel-criteria-bullets')
  expect(t.grid[2][0]).toBe('• Age > 50 y')
  expect(t.grid[1][1]).toContain('\n• Additional use')
  expect(t.grid[3][0]).toContain('\n⋄ Type 2 diabetes mellitus')
  const table = {
    rowCount: t.grid.length,
    columnCount: 2,
    cells: t.cells.map((c: { colSpan: number }) => ({ ...c, columnSpan: c.colSpan, regions: [] })),
    unassignedText: [],
    issues: []
  }
  expect(copyPdfTable(table, 'html', '')).toContain('Age &gt; 50 y')
})

it('recovers the omitted lens record and the wrapped first receptor label', () => {
  expect(refine('omitted-lens-record').grid).toContainEqual(['Lens, cataract', '5', '5'])
  expect(refine('headerless-receptor-records').grid[0]).toEqual([
    'Oestrogen Receptor positive',
    '17 (85%)',
    '19 (100%)',
    '0.59'
  ])
  for (const name of ['shared-event-count-header', 'split-event-count-header']) {
    const t = refine(name)
    expect(
      t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1)
    ).toMatchObject({ colSpan: 2, text: 'Number of events' })
  }
  expect(
    refine('underlined-grade-comparisons').cells.find(
      (c: { row: number; column: number }) => c.row === 0 && c.column === 1
    )
  ).toMatchObject({ colSpan: 2, text: 'Group (%)' })
})

it.each([
  ['longitudinal-category-records', recoverRuledComparisonRecords],
  ['allele-distribution-columns', recoverAlleleDistributionGrid],
  ['header-and-baseline-intervals', recoverRuledIntervalRecords],
  ['repeated-regression-intervals', recoverRepeatedRegressionGrid]
] as const)('requires native borders and a caption: %s', (name, recover) => {
  const f = load(name)
  expect(recover(f.table, f.tokens, f.captions, [])).toBeUndefined()
  expect(recover(f.table, f.tokens, [], f.rules)).toBeUndefined()
})
