import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { recoverClippedColumnHeader } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const { recoverRuledHeaderBands, recoverClosedNativeHeaderBands } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (name: string): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures', `${name}.jsonl`))
it('recovers clipped parent titles using independent underlines and repeated complete leaf labels', () => {
  const f = load('clipped-underlined-cohort-titles-above-repeated-leaf-labels')
  const h = recoverClippedColumnHeader(f.table, f.tokens, f.rules, f.captions)
  expect(h?.spans).toHaveLength(2)
  expect(h?.rect[1]).toBeLessThan(Math.min(...f.tokens.map((i: { rect: number[] }) => i.rect[1])))
  f.tokens.find((i: { text: string }) => i.text === 'SD/%').text = 'Unrelated value'
  expect(recoverClippedColumnHeader(f.table, f.tokens, f.rules, f.captions)).toBeUndefined()
})
it('owns independent parent underlines and wrapped leaf statistics without a full header divider', () => {
  const f = load('unboxed-underlined-parent-titles-with-wrapped-leaf-statistics')
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[1]).toEqual([
    'Measurements',
    'n',
    'Est. mean ∆',
    '0.95 CI',
    'n',
    'Est. mean ∆',
    '0.95 CI',
    'Est. mean ∆',
    '0.95 CI',
    'p value',
    '%'
  ])
  expect(
    r.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 3)
  ).toHaveLength(3)
  expect(r.unassigned).toEqual([])
  expect(r.grid.filter((v: string[]) => v[0] === '1RM leg extension (kg)')).toHaveLength(1)
})
it('preserves three tiers and native closed population faces with wrapped names', () => {
  const f = load('closed-three-tier-population-header-with-wrapped-parent-names')
  const h = recoverRuledHeaderBands(f.tokens, f.cuts, f.rules, f.top, f.bottom)
  expect(h?.rows).toHaveLength(3)
  expect(h?.spans).toContainEqual({ row: 0, column: 1, rowSpan: 1, colSpan: 4 })
  expect(h?.spans).toContainEqual({ row: 0, column: 5, rowSpan: 1, colSpan: 4 })
  f.rules = f.rules.filter((r: number[]) => !(r[0] === r[2] && r[0] < f.cuts[1]))
  expect(recoverClosedNativeHeaderBands(f.tokens, f.cuts, f.rules, f.top, f.bottom)).toBeUndefined()
})
it('keeps sibling cohort names separate when one continuous rule underlines both', () => {
  const f = load('independent-cohort-names-sharing-a-continuous-underline')
  const h = recoverRuledHeaderBands(f.tokens, f.cuts, f.rules, f.top, f.bottom)
  expect(h?.rows).toHaveLength(2)
  expect(h?.spans.some((s: { colSpan: number }) => s.colSpan > 1)).toBe(false)
})
it('owns a shared summary heading below independent cohort names', () => {
  const f = load('shared-summary-heading-below-independent-cohort-names')
  const h = recoverRuledHeaderBands(f.tokens, f.cuts, f.rules, f.top, f.bottom)
  expect(h?.rows).toHaveLength(2)
  expect(h?.spans).toContainEqual({ row: 1, column: 1, rowSpan: 1, colSpan: 2 })
  expect(h?.spans.some((s: { row: number; colSpan: number }) => s.row === 0 && s.colSpan > 1)).toBe(
    false
  )
})
