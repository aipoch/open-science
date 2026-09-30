import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledCategoricalRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))

it('uses a native rule covering the text when crop padding makes it appear too short', () => {
  const x = fixture('inset-header-rule-with-unequal-wrapped-parents')
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  for (const column of [1, 3])
    expect(
      result.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === column)
    ).toMatchObject({ colSpan: 2, rowSpan: 1 })
  expect(result.grid[1]).toEqual(['', 'Any grade', 'Grade ≥3', 'Any grade', 'Grade ≥3'])
})

it('separates the ruled header and independent probabilities from the first category', () => {
  const x = fixture('ruled-category-groups-with-partial-shared-statistics')
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toHaveLength(9)
  expect(result.grid[0]).toEqual([
    '',
    'Grade',
    '4-Sessions Group n = 27',
    '12-Sessions Group n = 33',
    'p-Value'
  ])
  expect(result.grid.slice(1, 3).map((r: string[]) => r[4])).toEqual(['0.18 *', '0.04 **'])
  expect(
    result.cells
      .filter((c: { column: number; rowSpan: number }) => c.column === 0 && c.rowSpan > 1)
      .map((c: { rowSpan: number }) => c.rowSpan)
  ).toEqual([2, 2, 3])
  expect(result.cells.find((c: { text: string }) => c.text === '0.46 c')).toMatchObject({
    rowSpan: 3
  })
  expect(result.unassigned).toEqual([])
  expect(result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)).toHaveLength(
    x.tokens.length
  )
})

it.each(['short-border', 'missing-parent-rule'])('rejects an inset header with %s', (variant) => {
  const x = fixture('inset-header-rule-with-unequal-wrapped-parents')
  if (variant === 'short-border')
    x.rules = x.rules
      .filter((r: number[]) => r[1] < 260 || r[0] < 820)
      .map((r: number[]) => (r[1] < 260 ? r : [r[0], r[1], Math.min(r[2], 820), r[3]]))
  else x.rules = x.rules.filter((r: number[]) => !(r[1] < 250 && r[0] < 700))
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1)
  ).toMatchObject({ colSpan: 1 })
})

it.each(['category-rule', 'count', 'statistic', 'sample', 'category', 'extra-text', 'gutter'])(
  'rejects ruled category recovery with contradictory %s evidence',
  (variant) => {
    const x = fixture('ruled-category-groups-with-partial-shared-statistics')
    const tokens = x.tokens as { text: string; rect: number[]; baseline: number; height: number }[]
    if (variant === 'category-rule')
      x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 411.399) > 0.1)
    if (variant === 'count') tokens.find((i) => i.text === '17 (63%) *')!.text = '17'
    if (variant === 'statistic') {
      const stat = tokens.find((i) => i.text === '0.46')!
      stat.rect[1] -= 18
      stat.rect[3] -= 18
      stat.baseline -= 18
    }
    if (variant === 'sample') tokens.find((i) => i.text === '= 27')!.text = '= ?'
    if (variant === 'category') tokens.find((i) => i.text === '1 Scale A')!.text = 'Note'
    if (variant === 'extra-text')
      tokens.push({
        ...tokens[0],
        text: 'Unowned annotation',
        rect: [70, 594, 180, 599],
        baseline: 599,
        height: 5
      })
    if (variant === 'gutter') tokens.find((i) => i.text === '= 33')!.rect[2] = 780
    expect(recoverRuledCategoricalRecords(x.table, tokens, x.rules)).toBeUndefined()
  }
)
