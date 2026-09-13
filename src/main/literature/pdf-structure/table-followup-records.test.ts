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

it('anchors a displaced treatment span to the start of its repeated follow-up series', () => {
  const x = fixture('displaced-followup-stub')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.slice(-3)).toEqual([
    ['', '12 months', '3.61 ± 2.09', '3.16 ± 1.92', '.87'],
    ['No endocrine therapy', '6 months', '4.80 ± 1.83', '1.73 ± 1.83', '.24'],
    ['', '12 months', '3.71 ± 1.94', '2.52 ± 1.80', '.65']
  ])
  expect(
    t.cells.find(
      (c: { row: number; column: number }) => c.row === t.grid.length - 2 && c.column === 0
    )
  ).toMatchObject({ rowSpan: 2, colSpan: 1 })
  expect(t.unassigned).toEqual([])
  const changed = x.tokens.map((i) =>
    i.text === '12 months' && i.rect[1] > 720 ? { ...i, text: '12 weeks' } : i
  )
  const differentUnit = refineTable(x.table, changed, x.captions, [], x.rules)
  expect(differentUnit.grid.at(-2)[0]).toBe('')
  expect(differentUnit.grid.at(-3)[0]).toBe('No endocrine therapy')
  const noPeers = x.tokens.map((i) =>
    i.text === '6 months' && i.rect[1] < 700 ? { ...i, text: 'Baseline' } : i
  )
  expect(refineTable(x.table, noPeers, x.captions, [], x.rules).repairs).not.toContain(
    'followup-stub-span-recovered'
  )
})

it('recovers a count record with an explicit unavailable comparison and preserves its marker', () => {
  const x = fixture('overlap-unavailable-count')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toContainEqual(['Moderate impairment', '1', 'NEc'])
  expect(t.grid).toContainEqual(['Use of PPIs, n', '', ''])
  expect(t.unassigned).toEqual([])
  const row = t.grid.findIndex((r: string[]) => r[0] === 'Moderate impairment')
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === row && c.column === 2).textRuns
  ).toContainEqual({ text: 'c', position: 'superscript' })
  const prose = x.tokens.map((i) => (i.text === 'NE' ? { ...i, text: 'pending' } : i))
  expect(refineTable(x.table, prose, x.captions, [], x.rules).unassigned).toContain(
    'Moderate impairment'
  )
  const noSection = x.tokens.map((i) =>
    i.text === 'Use of PPIs, n' ? { ...i, text: 'Unrelated paragraph' } : i
  )
  expect(refineTable(x.table, noSection, x.captions, [], x.rules).unassigned).toContain(
    'Moderate impairment'
  )
})

it('keeps a repeated parenthetical statistic definition with its measurement label', () => {
  const x = fixture('overlap-unavailable-count')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toContainEqual([
    'eGFR, mL/min/1.73 m2, median (2.5th-97.5th percentile)',
    '84.7 (45.4-163.5)a',
    '84.9 (47.1-143.0)'
  ])
  expect(t.grid).not.toContainEqual(['(2.5th-97.5th percentile)', '', ''])
  const noPeers = x.tokens.map((i) =>
    /^(BW|Age),/.test(i.text) ? { ...i, text: i.text.replace('median', 'mean') } : i
  )
  expect(refineTable(x.table, noPeers, x.captions, [], x.rules).grid).toContainEqual([
    '(2.5th-97.5th percentile)',
    '',
    ''
  ])
  expect(
    refineTable(x.table, x.tokens, x.captions, [], [...x.rules, [70, 203, 790, 203]]).grid
  ).toContainEqual(['(2.5th-97.5th percentile)', '', ''])
})
