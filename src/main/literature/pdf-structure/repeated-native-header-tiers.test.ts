import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
const visits = 'four-tier-sample-visits-with-continuous-native-underlines'
const limbs = 'stacked-comparison-marker-above-repeated-native-limb-headings'

it('owns a complete title and every sample-qualified visit above continuous Value and paired treatment tiers', () => {
  const f = load(visits),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[0][0]).toBe('Repeated outcome questionnaire – Summary scale')
  expect(r.cells).toContainEqual(expect.objectContaining({ row: 0, column: 0, colSpan: 11 }))
  expect(r.grid[1][9]).toBe('Visit 5 (n=48)')
  for (const row of [1, 2])
    expect(
      r.cells.filter((c: { row: number; colSpan: number }) => c.row === row && c.colSpan === 2)
    ).toHaveLength(5)
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 0, rowSpan: 3, text: 'Scores' })
  )
  expect(r.grid[3]).toEqual(['', 'IG', 'CG', 'IG', 'CG', 'IG', 'CG', 'IG', 'CG', 'IG', 'CG'])
  expect(r.grid[4].slice(0, 3)).toEqual(['Outcome alpha', '67.6', '70.7'])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    f.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
})

it.each(['missing leaf', 'missing sample', 'missing middle rule'])(
  'declines four tiers with %s',
  (kind) => {
    const f = load(visits)
    if (kind === 'missing leaf')
      f.tokens = f.tokens.filter(
        (i: { text: string; rect: number[] }) => !(i.text === 'CG' && i.rect[0] > 780)
      )
    if (kind === 'missing sample')
      f.tokens.find((i: { text: string }) => i.text === '(n=48)').text = '(unknown)'
    if (kind === 'missing middle rule')
      f.rules = f.rules.filter((r: number[]) => Math.abs(r[1] - 624.27795) > 0.1)
    const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(
      r.cells.some((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 11)
    ).toBe(false)
  }
)

it('retains the stacked native comparison marker above the repeated limb and probability headings', () => {
  const f = load(limbs),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[0][7]).toBe('IL* SG vs. CG')
  expect(r.grid[1]).toEqual(['', 'IL*', 'CL†', 'p', 'IL*', 'CL†', 'p', 'P'])
  expect(r.grid[2][0]).toBe('Measure‡_T1‡‡')
  expect(r.grid[2][1]).toBe('135.80° ± 17.48')
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    f.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
})

it('does not promote a detached upper marker into the comparison column', () => {
  const f = load(limbs)
  f.tokens.find(
    (i: { text: string; rect: number[] }) => i.text === 'IL*' && i.rect[0] > 700
  ).rect[0] -= 100
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[0][7]).not.toBe('IL* SG vs. CG')
})
