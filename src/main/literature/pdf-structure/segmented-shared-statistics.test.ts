import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverSegmentedRecordGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-segmented-record-grid.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/shared-statistics-between-overlapping-cell-rules.jsonl'
    )
  )

it('uses native row borders for shared statistics and keeps sections separate from headers', () => {
  const x = fixture()
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.grid).toHaveLength(17)
  expect(result.grid.every((r: string[]) => r.length === 7)).toBe(true)
  expect(result.grid[2][0]).toBe('Primary outcome')
  expect(result.grid[10]).toEqual([
    'Hazard ratioc (95% CI)',
    '0.91 (0.71 to 1.17)',
    '',
    '0.90 (0.63 to 1.30)',
    '',
    '0.92 (0.65 to 1.31)',
    ''
  ])
  expect(result.grid[11]).toEqual(['P valued', 'NS', '', 'NS', '', 'NS', ''])
  expect(
    result.cells.filter(
      (c: { row: number; colSpan: number }) => [5, 6, 10, 11].includes(c.row) && c.colSpan === 2
    )
  ).toHaveLength(12)
  expect(
    result.cells
      .filter((c: { colSpan: number }) => c.colSpan === 7)
      .map((c: { text: string }) => c.text)
  ).toEqual(['Primary outcome', 'Secondary outcome', 'Response outcome', 'Response duration'])
  expect(result.grid[14][1]).toBe('8 (4.5) (1.9% to 8.6%)')
  expect(result.grid[16][1]).toBe('NR (NR to NR)')
  expect(
    result.cells
      .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((i) => i.text))
      .sort()
  ).toEqual(x.tokens.map((i: { text: string }) => i.text).sort())
})

it.each([
  'shifted-rule',
  'missing-rule',
  'missing-statistic',
  'missing-final-value',
  'duplicate',
  'crossing-rule',
  'wrong-header'
])('rejects contradictory segmented evidence: %s', (variant) => {
  const x = fixture()
  const tokens = x.tokens as { text: string; rect: number[] }[]
  if (variant === 'shifted-rule') x.rules.find((r: number[]) => r[1] > 300 && r[1] < 311)![2] += 20
  if (variant === 'missing-rule')
    x.rules.splice(
      x.rules.findIndex((r: number[]) => r[1] > 300 && r[1] < 311),
      1
    )
  if (variant === 'missing-statistic')
    tokens.splice(
      tokens.findIndex((i) => i.text === '0.91 (0.71 to 1.17)'),
      1
    )
  if (variant === 'missing-final-value')
    tokens.splice(
      tokens.findLastIndex((i) => i.text === 'NR (NR to NR)'),
      1
    )
  if (variant === 'duplicate') tokens.push(tokens.find((i) => i.text === '0.91 (0.71 to 1.17)')!)
  if (variant === 'crossing-rule')
    tokens.find((i) => i.text === '0.91 (0.71 to 1.17)')!.rect[3] += 10
  if (variant === 'wrong-header') tokens.find((i) => i.text === '239)')!.text = 'unknown)'
  expect(recoverSegmentedRecordGrid(x.table, tokens, x.rules)).toBeUndefined()
})
