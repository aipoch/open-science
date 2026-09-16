import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const refine = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.tokens, f.captions, [], f.rules)

it('preserves the final in-table regression summary and its superscript', () => {
  const t = refine(fixture('regression-summary'))
  expect(t.unassigned).toEqual([])
  expect(t.grid.at(-1)).toEqual(['', 'R2 = 0.47**', ''])
  expect(t.cells.find((c: { text: string }) => c.text === 'R2 = 0.47**').textRuns).toContainEqual({
    text: '2',
    position: 'superscript'
  })
})

it('recovers missing demographic sections and a complete category without filling blanks', () => {
  const t = refine(fixture('category-model-gaps'))
  expect(t.unassigned).toEqual([])
  expect(t.grid).toContainEqual(['Employment status, n (%)', ''])
  expect(t.grid).toContainEqual(['White', '53 (94.6%)'])
  expect(t.grid).toHaveLength(36)
})

it('preserves the final qualitative record and both preceding wrapped clinical labels', () => {
  const t = refine(fixture('trailing-urine-row'))
  expect(t.unassigned).toEqual([])
  expect(t.grid.at(-1)).toEqual(['Urine analysis', 'Normal', 'Normal'])
  expect(t.grid).toContainEqual(['Leukopenia/ thrombocytopenia', '0', '0'])
  expect(t.grid).toContainEqual(['Potassium (mmol/L), mean ± SD', '4.2 ± 0.25', '4.1 ± 0.5'])
  expect(t.grid).toHaveLength(19)
})

it.each(['cropped-prose', 'cropped-disclosure', 'cropped-doi'])(
  'rejects non-table source content in %s',
  (name) => {
    const f = fixture(name),
      t = refine(f)
    expect(hasTableEvidence(t, undefined, f.tokens)).toBe(false)
    expect(hasTableEvidence(t, { lines: ['Table 1. Narrative comparison'] }, f.tokens)).toBe(true)
  }
)

it.each(['shifted-risk-columns', 'category-count-overlap'])(
  'uses closed native faces and preserves source tokens in %s',
  (name) => {
    const f = fixture(name),
      original = structuredClone(f),
      t = refine(f)
    expect(t.unassigned).toEqual([])
    expect(t.issues).toEqual([])
    expect(t.grid.every((row: string[]) => row.length === 4)).toBe(true)
    const tokens = t.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
    const signature = (i: { text: string; rect: number[] }): string =>
      JSON.stringify([i.text, i.rect])
    expect(new Set(tokens.map(signature)).size).toBe(tokens.length)
    expect(f).toEqual(original)
    if (name === 'shifted-risk-columns') {
      expect(t.grid[8].slice(1)).toEqual(['55 (89%) 7 (11%)', '108 (92%) 9 (8%)', '0.58'])
      expect(t.grid[11].slice(1)).toEqual(['57 (92%) 5 (8%)', '106 (92%) 9 (8%)', '1.00'])
      // The source itself omits the opening parenthesis; do not silently repair its value.
      expect(t.grid[10][1]).toBe('34 56%) 27 (44%)')
    } else {
      expect(t.grid[5].at(-1)).toBe('0.72')
      expect(t.cells.find((c: { text: string }) => c.text === 'Masood Score')).toMatchObject({
        colSpan: 4
      })
      expect(t.cells.find((c: { text: string }) => c.text === 'Frequencies')).toMatchObject({
        colSpan: 2
      })
      expect(t.cells.find((c: { text: string }) => c.text === '0.92')).toMatchObject({ rowSpan: 3 })
    }
  }
)

it('declines open native faces and text-bearing strips between parallel rules', async () => {
  const { recoverRuledHeaderGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-stub-grid.mjs')).href
  )
  const f = fixture('category-count-overlap')
  expect(
    recoverRuledHeaderGrid(
      f.table,
      f.tokens,
      f.captions,
      f.rules.filter((r: number[]) => r[0] < 760)
    )
  ).toBeUndefined()
  f.tokens.push({
    text: 'I',
    rect: [350.5, 300, 351.5, 310],
    baseline: 310,
    height: 10,
    horizontal: true
  })
  expect(recoverRuledHeaderGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it('does not turn a separated footnote or a different statistic into an in-table R-squared row', () => {
  const f = fixture('regression-summary')
  f.rules.push([183, 236, 632, 236])
  expect(refine(f).unassigned).toContain('R')
  const g = fixture('regression-summary')
  g.tokens.find((i: { text: string }) => i.text === 'R').text = 'T'
  expect(refine(g).unassigned).toContain('T')
})

it('declines incomplete clinical pairs and preserves numeric or captioned tables in prose guards', () => {
  const f = fixture('trailing-urine-row')
  f.tokens = f.tokens.filter(
    (i: { text: string; rect: number[] }) => i.text !== 'Normal' || i.rect[0] < 700
  )
  expect(refine(f).unassigned).toContain('Normal')
  const g = fixture('cropped-prose'),
    t = refine(g)
  t.grid[0][1] = '12 (34%)'
  expect(hasTableEvidence(t, undefined, g.tokens)).toBe(true)
})

it('requires repeated section and count evidence before adding demographic rows', async () => {
  const { recoverCountedCategoryGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
  )
  const f = fixture('category-model-gaps')
  expect(recoverCountedCategoryGrid(f.table, f.tokens, f.captions, [])).toBeUndefined()
  f.tokens.find((i: { text: string }) => i.text === '53 (94.6%)').text = 'Unknown'
  expect(recoverCountedCategoryGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it.each([
  'regression-summary',
  'category-model-gaps',
  'trailing-urine-row',
  'shifted-risk-columns',
  'category-count-overlap',
  'clipped-treatment-header'
])('accounts for every enclosed source token once in %s', (name) => {
  const f = fixture(name),
    original = structuredClone(f),
    t = refine(f)
  const rects = t.cells.map((c: { rect: number[] }) => c.rect)
  const left = Math.min(...rects.map((r: number[]) => r[0]))
  const top = Math.min(...rects.map((r: number[]) => r[1]))
  const right = Math.max(...rects.map((r: number[]) => r[2]))
  const bottom = Math.max(...rects.map((r: number[]) => r[3]))
  const source = f.tokens.filter(
    (i: { rect: number[] }) =>
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      (i.rect[1] + i.rect[3]) / 2 >= top &&
      (i.rect[1] + i.rect[3]) / 2 <= bottom
  )
  const signature = (i: { text: string; rect: number[] }): string =>
    JSON.stringify([i.text, i.rect])
  expect(
    t.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(signature)
      .sort()
  ).toEqual(source.map(signature).sort())
  expect(f).toEqual(original)
})

it('recovers a bracket-wrapped source row while preserving malformed source values', () => {
  const f = fixture('clipped-treatment-header'),
    original = structuredClone(f),
    t = refine(f)
  // The PDF itself renders count/percentage concatenations and displaced
  // closing brackets. Source distance alone cannot establish the scientific pairs.
  expect(t.unassigned).toEqual([])
  expect(t.grid).toContainEqual(['ET treatment', '[14 (45.2) ]', '[51 (65.4) ]', ''])
  expect(t.issues).toContain('text-crosses-crop-boundary')
  expect(t.grid.flat()).toContain('(41.9)18')
  expect(f).toEqual(original)
})

it.each(['missing-bracket', 'separating-rule', 'incomplete-values', 'missing-peers'])(
  'does not recover bracket-wrapped source records with %s',
  (mode) => {
    const f = fixture('clipped-treatment-header')
    if (mode === 'missing-bracket')
      f.tokens = f.tokens.filter(
        (i: { text: string; rect: number[] }) =>
          !(i.text === ']' && i.rect[1] > 750 && i.rect[1] < 765 && i.rect[0] < 300)
      )
    if (mode === 'separating-rule') f.rules.push([55, 750, 433, 750])
    if (mode === 'incomplete-values')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '[51 (65.4)')
    if (mode === 'missing-peers')
      for (const i of f.tokens)
        if (i.text === 'ET treatment' && i.rect[1] > 800) i.text = 'Other treatment'
    expect(refine(f).unassigned).toContain('ET treatment')
  }
)
