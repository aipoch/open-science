import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Fixture = {
  table: { cropRect: number[] }
  tokens: { text: string; rect: number[]; height: number; baseline: number }[]
  captions: { lines: string[] }[]
  rules: number[][]
}
const { recoverVerticalRuleGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-column-grid.mjs')).href
)
type Cell = {
  row: number
  column: number
  rowSpan: number
  colSpan: number
  text: string
  sourceTokens: Fixture['tokens']
}
const fixture = (name: string): Fixture =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const refine = (
  f: Fixture
): { grid: string[][]; cells: Cell[]; issues: string[]; unassigned: string[] } =>
  refineTable(f.table, f.tokens, f.captions, [], f.rules)

it('preserves native column dividers through section headings', () => {
  const f = fixture('section-span-conflicts'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(t.grid).toHaveLength(31)
  expect(t.cells.find((c) => c.text === 'AJCC T stage')).toMatchObject({ colSpan: 1, rowSpan: 1 })
  expect(t.grid.find((r) => r[0] === 'T1')).toEqual(['T1', '7515 (44.66)', '7473 (44.41)', '.2665'])
  expect(f).toEqual(original)
})

it('keeps two-tier headers and reference values inside their native column boundaries', () => {
  const t = refine(fixture('paired-section-spans'))
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(t.grid).toHaveLength(32)
  expect(t.cells.find((c) => c.text === 'Univariate Analysis')).toMatchObject({
    row: 0,
    column: 1,
    colSpan: 2
  })
  expect(t.cells.find((c) => c.text === 'Multivariate Analysis')).toMatchObject({
    row: 0,
    column: 3,
    colSpan: 2
  })
  expect(t.cells.filter((c) => c.text === 'Reference')).toHaveLength(8)
  for (const cell of t.cells.filter((c) => c.text === 'Reference'))
    expect(cell).toMatchObject({ column: 1, colSpan: 4, rowSpan: 1 })
  expect(t.grid.find((r) => r[0] === 'N0')).toEqual(['N0', 'Reference', '', '', ''])
})

it.each(['section-span-conflicts', 'paired-section-spans'])(
  'owns every source token once in %s',
  (name) => {
    const f = fixture(name)
    const recovered = recoverVerticalRuleGrid(f.table, f.tokens, f.captions, f.rules)
    const source = f.tokens.filter(
      (i) =>
        i.rect[0] >= f.table.cropRect[0] &&
        i.rect[2] <= f.table.cropRect[2] &&
        i.rect[1] >= f.table.cropRect[1] &&
        i.rect[3] <= f.table.cropRect[3]
    )
    expect(recovered.ownedTokens).toEqual(new Set(source))
    const result = refine(f)
    const assigned = result.cells.flatMap((c) => c.sourceTokens)
    expect(assigned).toHaveLength(source.length)
    const signature = ({ text, rect, baseline, height }: Fixture['tokens'][number]): string =>
      JSON.stringify({ text, rect, baseline, height })
    expect(assigned.map(signature).sort()).toEqual(source.map(signature).sort())
    for (const item of source) {
      const [x, y] = [(item.rect[0] + item.rect[2]) / 2, (item.rect[1] + item.rect[3]) / 2]
      expect(
        result.cells.filter((c) => {
          const r = recovered.rows[c.row],
            last = recovered.rows[c.row + c.rowSpan - 1]
          const col = recovered.columns[c.column],
            end = recovered.columns[c.column + c.colSpan - 1]
          return x >= col[0] && x < end[2] && y >= r[1] && y < last[3]
        })
      ).toHaveLength(1)
    }
  }
)

it('declines incomplete separators and multiple independent values in an open face', () => {
  const f = fixture('paired-section-spans')
  const recover = (f: Fixture): unknown =>
    recoverVerticalRuleGrid(f.table, f.tokens, f.captions, f.rules)
  expect(recover({ ...f, captions: [] })).toBeUndefined()
  expect(recover({ ...f, rules: [] })).toBeUndefined()
  const first = f.tokens.find((i) => i.text === 'Reference')!
  const partial = [440, first.rect[1], 440, (first.rect[1] + first.rect[3]) / 2]
  expect(recover({ ...f, rules: [...f.rules, partial] })).toBeUndefined()
  // Removing an actual data divider cannot turn two numeric values into one cell.
  const noDivider = f.rules.filter(
    (r) => r[0] !== r[2] || Math.abs(r[0] - 440.1) > 1 || r[1] > 193 || r[3] < 180
  )
  expect(recover({ ...f, rules: noDivider })).toBeUndefined()
  const independent = {
    ...first,
    text: 'Independent',
    rect: [700, first.rect[1], 750, first.rect[3]]
  }
  expect(recover({ ...f, tokens: [...f.tokens, independent] })).toBeUndefined()
})

it('recovers a clipped native header without moving existing model boxes in page space', () => {
  const f = fixture('clipped-resource-header'),
    original = structuredClone(f)
  const result = refine(f)
  expect(result.grid[0]).toEqual(['REAGENT or RESOURCE', 'SOURCE', 'IDENTIFIER'])
  expect(result.grid[2]).toEqual([
    'Human tumor fresh and frozen samples',
    'Institut Curie, KU Leuven and Institut Bordet',
    'N/A'
  ])
  expect(result.issues).not.toContain('text-crosses-crop-boundary')
  expect(result.unassigned).toEqual([])
  expect(result.cells.filter((c) => c.row === 0)).toHaveLength(3)
  expect(f).toEqual(original)
})

it('does not extend a crop for an unruled or misaligned leading text band', async () => {
  const { recoverClippedColumnHeader } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
  )
  const f = fixture('clipped-resource-header')
  // The production facade coalesces overlapping native underline segments.
  const divider = [79.7, 257.03, 797, 257.03]
  expect(recoverClippedColumnHeader(f.table, f.tokens, [divider])).toBeDefined()
  expect(recoverClippedColumnHeader(f.table, f.tokens, [])).toBeUndefined()
  expect(
    recoverClippedColumnHeader(
      f.table,
      f.tokens.filter((i) => i.text !== 'SOURCE'),
      [divider]
    )
  ).toBeUndefined()
  expect(
    recoverClippedColumnHeader(
      f.table,
      f.tokens.map((i) => (i.text === 'SOURCE' ? { ...i, baseline: i.baseline + i.height } : i)),
      [divider]
    )
  ).toBeUndefined()
})

const { hasHorizontalTableRuleBetween } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-rules.mjs')).href
)

it('keeps source-band endpoints open when checking intervening rules', () => {
  const borders = [
    [0, 10, 100, 10],
    [0, 20, 100, 20]
  ]
  expect(hasHorizontalTableRuleBetween(borders, 10, 20)).toBe(false)
  expect(hasHorizontalTableRuleBetween([...borders, [0, 15, 100, 15]], 10, 20)).toBe(true)
  expect(hasHorizontalTableRuleBetween(borders, 20, 10)).toBe(false)
  expect(hasHorizontalTableRuleBetween(borders, 10, 10)).toBe(false)
})

it('does not mistake vertical or slightly slanted rules for a horizontal separator', () => {
  const rules = [
    [0, 11, 0, 19],
    [0, 15, 100, 15.01],
    [0, 5, 100, 5]
  ]
  expect(hasHorizontalTableRuleBetween(rules, 10, 20)).toBe(false)
  expect(hasHorizontalTableRuleBetween([], 10, 20)).toBe(false)
})

it('keeps separator presence distinct from full edge coverage and preserves source rules', () => {
  const rules = [
    [50, 15, 60, 15],
    [0, 10, 100, 10]
  ]
  const original = structuredClone(rules)
  expect(hasHorizontalTableRuleBetween(rules, 10, 20)).toBe(true)
  expect(rules).toEqual(original)
})
