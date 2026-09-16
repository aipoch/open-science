import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledColumnGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-column-grid.mjs')).href
)
const { recoverRuledCategoryGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
type Token = { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }
type Cell = {
  row: number
  column: number
  rowSpan: number
  colSpan: number
  rect: number[]
  text: string
  sourceTokens: Token[]
  textRuns?: { text: string; position: string }[]
}
type Fixture = {
  table: { cropRect: number[]; structure: { objects: { label: string; rect: number[] }[] } }
  tokens: Token[]
  captions: { lines: string[] }[]
  rules: number[][]
}
const fixture = (name: string): Fixture =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
const refine = (
  f: Fixture
): {
  grid: string[][]
  cells: Cell[]
  issues: string[]
  unassigned: string[]
  rows: { rect: number[] }[]
} => refineTable(f.table, f.tokens, f.captions, [], f.rules)
const cases = [
  ['repeated-activity-statistics', 47, 10],
  ['repeated-symptom-statistics', 32, 10],
  ['grouped-neurotoxicity', 12, 8],
  ['wrapped-comparison-summary', 7, 5],
  ['wrapped-protocol-actions', 13, 3],
  ['multiline-shared-kit', 16, 4],
  ['ruled-demographic-header', 17, 4]
] as const

it.each(cases)(
  'restores %s records, headers and every source token exactly once',
  (name, rows, columns) => {
    const f = fixture(name),
      original = structuredClone(f),
      t = refine(f)
    expect(t.grid).toHaveLength(rows)
    expect(t.grid[0]).toHaveLength(columns)
    expect(t.issues).toEqual([])
    expect(t.unassigned).toEqual([])
    const top = t.rows[0].rect[1],
      bottom = t.rows.at(-1)!.rect[3]
    const assigned = t.cells.flatMap((c) => c.sourceTokens)
    const left = Math.min(...t.cells.map((c) => c.rect[0])),
      right = Math.max(...t.cells.map((c) => c.rect[2]))
    const source = f.tokens.filter(
      (i) =>
        i.rect[0] >= left &&
        i.rect[2] <= right + 0.1 &&
        i.rect[1] >= top - 2 &&
        i.rect[3] <= bottom + 0.1
    )
    expect(assigned.map((i) => i.text).sort()).toEqual(source.map((i) => i.text).sort())
    expect(f).toEqual(original)
  }
)

it('keeps nested statistics headers and all repeated before/after/summary records', () => {
  const t = refine(fixture('repeated-activity-statistics'))
  expect(t.cells.filter((c) => c.row === 0 && c.rowSpan === 2)).toHaveLength(5)
  expect(
    t.cells.filter((c) => c.row === 0 && c.colSpan > 1).map((c) => [c.column, c.colSpan])
  ).toEqual([
    [5, 2],
    [7, 3]
  ])
  expect(t.grid.filter((r) => r[1] === 'Before')).toHaveLength(15)
  expect(t.grid.filter((r) => r[1] === 'After')).toHaveLength(15)
  expect(t.grid.filter((r) => r[0].startsWith('mean value difference'))).toHaveLength(15)
  expect(t.cells.find((c) => c.text.startsWith('Participating in hobbies'))).toMatchObject({
    rowSpan: 2,
    colSpan: 1,
    text: 'Participating in hobbies or leisure activities'
  })
  expect(t.grid.some((r) => r[0] === 'Total scores' && r[1] === 'Before')).toBe(true)
})

it('orders a split comma and superscript letters after their numeric anchor', () => {
  const t = refine(fixture('wrapped-comparison-summary'))
  const cell = t.cells.find((c) => c.row === 4 && c.column === 1)!
  expect(cell.text).toBe('18.00 (-21.75, 54.00)a,b')
  expect(cell.textRuns).toEqual([
    { text: '18.00 (-21.75, 54.00)', position: 'normal' },
    { text: 'a,b', position: 'superscript' }
  ])
  expect(t.grid[5]).toEqual(['H (Kruskal–Wallis H test)', '39.922', '', '', ''])
  // Literal source values are not corrected to fit statistical expectations.
  expect(refine(fixture('repeated-symptom-statistics')).grid[2][3]).toBe('7.64 ± 3.712')
})

it('preserves wrapped action names, complete paragraphs and exact period spans', () => {
  const t = refine(fixture('wrapped-protocol-actions'))
  expect(
    t.cells.filter((c) => c.column === 0 && c.row > 0).map((c) => [c.text, c.rowSpan])
  ).toEqual([
    ['Week 1', 2],
    ['Week 2', 4],
    ['Week 3', 6]
  ])
  expect(t.grid[9][1]).toBe('Stand with horizontal chest expansion')
  expect(t.grid[12][1]).toBe('Standing position hip abduction')
  expect(t.grid[2][2]).toMatch(/and change to the other leg\.$/)
  expect(t.grid[12][2]).toMatch(/30◦ for 3 s/)
})

it('merges the centered multiline kit label across the entire body', () => {
  const t = refine(fixture('multiline-shared-kit'))
  expect(t.cells.find((c) => c.column === 0 && c.row === 1)).toMatchObject({
    rowSpan: 15,
    text: 'Human Myokine Magnetic Bead Panel (HMYOMAG-56K) Merck Millipore, Burlington, MA, USA'
  })
  expect(t.grid.at(-1)).toEqual(['', 'Osteocrin/Musclin', 'OSTN', 'H0STCRN-MAG'])
})

it('separates sparse count headers from records and joins bottom-aligned category labels', () => {
  const t = refine(fixture('ruled-demographic-header'))
  expect(t.grid[0]).toEqual(['', '', 'Count', '%'])
  expect(t.grid[1]).toEqual(['Clinical T', 'T1', '6', '10.0%'])
  expect(t.grid[10]).toEqual(['Biological Type', 'Luminal A hormone receptor +ve', '22', '36.7%'])
  expect(t.cells.filter((c) => c.row > 0 && c.column === 0).map((c) => c.rowSpan)).toEqual([
    5, 2, 2, 5, 2
  ])
})

it.each(cases.slice(0, 5))(
  'declines %s column recovery with missing or contradictory rules',
  (name) => {
    const f = fixture(name)
    expect(recoverRuledColumnGrid(f.table, f.tokens, [], f.rules)).toBeUndefined()
    expect(recoverRuledColumnGrid(f.table, f.tokens, f.captions, [])).toBeUndefined()
    const rules = f.rules.map((r) => [
      r[0],
      r[1],
      r[2] + (r[0] > f.table.cropRect[0] + 20 ? 4 : 0),
      r[3]
    ])
    expect(recoverRuledColumnGrid(f.table, f.tokens, f.captions, rules)).toBeUndefined()
  }
)

it('declines schedule recovery when wrapping and record boundaries conflict', () => {
  const f = fixture('wrapped-protocol-actions')
  f.tokens.find((i) => i.text === 'chest expansion')!.text = 'Chest expansion'
  expect(recoverRuledColumnGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it.each(['rule', 'alignment', 'record'])(
  'does not merge independent centered-column records with %s evidence',
  (condition) => {
    const f = fixture('multiline-shared-kit')
    if (condition === 'rule') f.rules.push([58, 1010, 829, 1010])
    if (condition === 'alignment') f.tokens.find((i) => i.text === 'Human Myokine')!.rect[0] += 20
    if (condition === 'record')
      f.tokens.push({
        ...f.tokens.find((i) => i.text === 'Apelin')!,
        text: 'Another kit',
        rect: [90, 879.1, 190, 894.1]
      })
    expect(refine(f).cells.some((c) => c.column === 0 && c.rowSpan === 15)).toBe(false)
  }
)

it('declines category recovery when a count has no paired percentage', () => {
  const f = fixture('ruled-demographic-header')
  f.tokens = f.tokens.filter((i) => i.text !== '36.7%')
  expect(recoverRuledCategoryGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
