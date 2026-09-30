import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledColumnGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-column-grid.mjs')).href
)
const names = [
  'abutting-header-columns-with-cohort-subtotals',
  'floating-cohort-stub-with-repeated-subtotals'
]
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))

it.each(names)('restores independent cohort columns and subtotal spans in %s', (name) => {
  const x = fixture(name)
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const width = name === names[0] ? 7 : 9
  expect(result.grid).toHaveLength(8)
  expect(result.grid[0]).toHaveLength(width)
  expect(result.unassigned).toEqual([])
  expect(result.grid.slice(2).map((r: string[]) => r.slice(1, 3))).toEqual([
    ['Cat', '6'],
    ['Set', '10'],
    ['Together', '16'],
    ['Cat', '6'],
    ['Set', '10'],
    ['Together', '16']
  ])
  expect(
    result.cells
      .filter(
        (c: { row: number; rowSpan: number; column: number }) =>
          c.row >= 2 && c.column === 0 && c.rowSpan > 1
      )
      .map((c: { text: string; row: number; rowSpan: number }) => [c.text, c.row, c.rowSpan])
  ).toEqual([
    ['GA', 2, 3],
    ['GB', 5, 3]
  ])
  expect(
    result.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 2)
  ).toHaveLength((width - 3) / 2)
  expect(result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)).toHaveLength(
    x.tokens.length
  )
  expect(result.grid[2][width - 2]).toBe(width === 7 ? '25.83a' : '27.67a')
})

it.each([
  'count-sum',
  'category-cycle',
  'missing-value',
  'duplicate-token',
  'overlapping-token',
  'multiple-labels',
  'label-outside-block',
  'missing-parent-rule',
  'missing-frame',
  'wrong-header'
])('rejects abutting-column recovery with %s', (variant) => {
  const x = fixture(names[1])
  const tokens = x.tokens as { text: string; rect: number[]; baseline: number }[]
  if (variant === 'count-sum') tokens.find((i) => i.text === '16')!.text = '17'
  if (variant === 'category-cycle') tokens.find((i) => i.text === 'Set')!.text = 'Alt'
  if (variant === 'missing-value')
    tokens.splice(
      tokens.findIndex((i) => i.text === '7.69'),
      1
    )
  if (variant === 'duplicate-token') tokens.push(tokens.find((i) => i.text === '7.69')!)
  if (variant === 'overlapping-token') tokens.find((i) => i.text === '7.69')!.rect[2] += 30
  if (variant === 'multiple-labels')
    tokens.push({ ...tokens.find((i) => i.text === 'GA')!, text: 'GC' })
  if (variant === 'label-outside-block') {
    const label = tokens.find((i) => i.text === 'GB')!
    label.rect[1] -= 55
    label.rect[3] -= 55
    label.baseline -= 55
  }
  if (variant === 'missing-parent-rule') x.rules.splice(2, 1)
  if (variant === 'missing-frame') x.rules.splice(1, 1)
  if (variant === 'wrong-header') tokens.find((i) => i.text === 'SD')!.text = 'SE'
  expect(recoverRuledColumnGrid(x.table, tokens, x.captions, x.rules)).toBeUndefined()
})
