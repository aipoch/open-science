import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (
  name: string
): {
  table: object
  tokens: { text: string; rect: number[]; baseline: number; height: number }[]
  captions: object[]
  rules: number[][]
} =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))

it('retains a clipped confidence level in its wrapped column heading', () => {
  const x = fixture('clipped-confidence-prefix')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid[0]).toEqual(['Effect', '', 'Relative risks', '95% confidence limits', ''])
  expect(t.unassigned).toEqual([])
  expect(t.grid[1]).toEqual([
    'Study cohort',
    'Letter arm versus control arm',
    '1.41',
    '1.30',
    '1.54'
  ])
  for (const text of ['Risk', '95']) {
    const source = x.tokens.map((i) => (i.text === '95%' ? { ...i, text } : i))
    expect(refineTable(x.table, source, x.captions, [], x.rules).repairs).not.toContain(
      'leading-header-line-recovered'
    )
  }
})

it('retains a leading parent title above its aligned sample-size span', () => {
  const x = fixture('clipped-parent-title')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid[0][4]).toBe('Completed questionnaire in 2019 (n = 1624)')
  expect(
    t.cells.find((c: { text: string }) => c.text.startsWith('Completed questionnaire'))
  ).toMatchObject({ row: 0, column: 4, colSpan: 3 })
  expect(t.unassigned).toEqual([])
  const source = x.tokens.map((i) => (i.text === '1624)' ? { ...i, text: 'unknown)' } : i))
  expect(refineTable(x.table, source, x.captions, [], x.rules).repairs).not.toContain(
    'leading-header-line-recovered'
  )
})

it('joins repeated hanging treatment labels before the next section without moving measurements', () => {
  const x = fixture('wrapped-treatment-stub')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.filter((r: string[]) => r[0] === 'No endocrine therapy')).toHaveLength(5)
  expect(t.grid).toContainEqual([
    'No endocrine therapy',
    '23.5 ± 4.20',
    '',
    '23.13 ± 4.25',
    '23.92 ± 4.19',
    '.50'
  ])
  expect(t.grid).toContainEqual(['Emotional well-being', '', '', '', '', ''])
  expect(t.unassigned).toEqual([])
  const source = x.tokens.map((i) =>
    i.text === 'therapy' && i.rect[1] < 250 ? { ...i, text: 'therapy 2' } : i
  )
  const negative = refineTable(x.table, source, x.captions, [], x.rules)
  expect(negative.grid).toContainEqual(['therapy 2', '', '', '', '', ''])
})

it('retains left-aligned treatment parents across two child columns', () => {
  const x = fixture('left-aligned-arm-header')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid[0]).toEqual([
    '',
    'Lapatinib + capecitabine (N = 13) Number of patients (%)',
    '',
    'Lapatinib + topotecan (N = 9) Number of patients (%)',
    ''
  ])
  for (const column of [1, 3]) {
    expect(
      t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === column)
    ).toMatchObject({ colSpan: 2, rowSpan: 1 })
  }
  expect(t.grid).toContainEqual([
    'Subjects with any dose reduction',
    '0',
    '4 (31)',
    '3 (33)',
    '3 (33)'
  ])
})

it('separates a leading sample section from column headings without moving measurements', () => {
  const x = fixture('leading-sample-section')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.slice(0, 3)).toEqual([
    ['', 'Control', 'Intervention'],
    ['Not having breast cancer screening in 2017, n = 1397', '', ''],
    ['Screening rate in 2018, n (%)', '67/909 (7.4)', '259/488 (53.1)']
  ])
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 0)
  ).toMatchObject({ colSpan: 3, rowSpan: 1 })
  expect(t.unassigned).toEqual([])
  const noSample = x.tokens.map((i) => (i.text === '1397' ? { ...i, text: 'unknown' } : i))
  expect(refineTable(x.table, noSample, x.captions, [], x.rules).grid[0][0]).not.toBe('')
  const noPeers = x.tokens.map((i) =>
    i.text === '227' || i.text === '1624' ? { ...i, text: 'unknown' } : i
  )
  expect(refineTable(x.table, noPeers, x.captions, [], x.rules).grid[0][0]).not.toBe('')
})
