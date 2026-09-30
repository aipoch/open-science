import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverClinicalCountSections } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
function fixture(name: string): ReturnType<typeof readPdfFixture> {
  return readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
}
it('anchors sparse parent labels to complete native count records instead of overlapping model spans', () => {
  const f = fixture('shifted-parent-labels-in-count-summary-table')
  const original = structuredClone(f)
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.rows[0].rect[1]).toBeGreaterThanOrEqual(94.8)
  for (const [parent, child] of [
    ['Therapy class, n (%)', 'Yes'],
    ['Biomarker status, n (%)', 'Positive'],
    ['Affected side, n (%)', 'Left']
  ]) {
    const row = result.grid.findIndex((r: string[]) => r[0] === parent)
    expect(row).toBeGreaterThan(0)
    expect(result.grid[row][1]).toBe(child)
    expect(
      result.cells.find((c: { row: number; column: number }) => c.row === row && c.column === 0)
        ?.rowSpan
    ).toBe(2)
  }
  expect(result.grid.some((r: string[]) => r.every((s) => !s))).toBe(false)
  expect(result.grid.at(-1).slice(2, 4)).toEqual(['12 (%27.3)', '12 (%27.3)'])
  expect(result.grid.at(-2).slice(2, 4)).toEqual(['1 (%2.3)', '0 (%0)'])
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(original)
})

it('keeps an overhanging closing parenthesis with the shared parent label', () => {
  const f = fixture('count-summary-stub-with-overhanging-parenthesis')
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  const row = result.grid.findIndex((r: string[]) => r[0] === 'Employment status, n (%)')
  expect(row).toBeGreaterThan(0)
  expect(result.grid[row][1]).toBe('Full time')
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === row && c.column === 0)
      ?.rowSpan
  ).toBe(2)
  expect(result.unassigned).toEqual([])
})

it('separates complete nested comparison records while preserving the dash-only parent row', () => {
  const f = fixture('collapsed-nested-comparison-records')
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid.at(-3)).toEqual(['History of screening', '–', '–'])
  expect(result.grid.at(-2)).toEqual([
    '1–2 years ago versus never',
    '3.69 [2.12, 6.42]****',
    '2.71 [1.41, 5.18]***'
  ])
  expect(result.grid.at(-1)).toEqual([
    'Greater than two years ago versus never',
    '1.66 [0.97, 2.84]*',
    '1.27 [0.68, 2.38]'
  ])
  expect(result.unassigned).toEqual([])
})

it.each(['missing-rule', 'missing-value', 'ambiguous-parent', 'unowned-category'])(
  'rejects rebuilding nested counts with %s',
  (variant) => {
    const f = fixture('shifted-parent-labels-in-count-summary-table')
    if (variant === 'missing-rule') f.rules = []
    if (variant === 'missing-value')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '14 (%31.8)')
    if (variant === 'ambiguous-parent')
      f.tokens.find((i: { text: string }) => i.text === 'Therapy class,')!.rect[2] += 240
    if (variant === 'unowned-category') {
      const first = f.tokens.findIndex((i: { text: string }) => i.text === 'Lymphedema stage,')
      const baseline = f.tokens[first].baseline
      f.tokens = f.tokens.filter(
        (i: { rect: number[]; baseline: number }) =>
          i.rect[0] > 300 || Math.abs(i.baseline - baseline) > 1
      )
    }
    expect(recoverClinicalCountSections(f.table, f.tokens, f.rules)).toBeUndefined()
  }
)

it.each(['incomplete-interval', 'no-indent', 'missing-rule'])(
  'preserves unresolved nested comparisons with %s',
  (variant) => {
    const f = fixture('collapsed-nested-comparison-records')
    if (variant === 'incomplete-interval')
      f.tokens.find((i: { text: string }) => i.text.startsWith('1.66 ['))!.text = '1.66 [0.97,'
    if (variant === 'missing-rule') f.rules = []
    if (variant === 'no-indent') {
      const parent = f.tokens.find((i: { text: string }) => i.text === 'History of screening')!
      for (const token of f.tokens.filter((i: { text: string }) =>
        i.text.includes('versus never')
      )) {
        const dx = token.rect[0] - parent.rect[0]
        token.rect[0] -= dx
        token.rect[2] -= dx
      }
    }
    const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(
      result.grid.some(
        (r: string[]) => r[0] === 'History of screening' && r[1] === '–' && r[2] === '–'
      )
    ).toBe(false)
  }
)
