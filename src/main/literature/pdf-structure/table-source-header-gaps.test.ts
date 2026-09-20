import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const refine = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.tokens, f.captions, [], f.rules)

it('keeps a flush wrapped category with its three counts and the next category separate', () => {
  const f = fixture('wrapped-education'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.unassigned).toEqual([])
  expect(t.grid[5]).toEqual([
    '',
    'High school or technical secondary school',
    '7 (19.4)',
    '7 (19.4)',
    '5 (13.9)',
    '',
    ''
  ])
  expect(t.grid[6]).toEqual([
    '',
    'College and undergraduate',
    '6 (16.7)',
    '6 (16.7)',
    '8 (22.2)',
    '',
    ''
  ])
  expect(t.grid).toHaveLength(18)
  expect(f).toEqual(original)
})

it('preserves an inline count header as its own row before the count records', () => {
  const f = fixture('split-count-header'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.unassigned).toEqual([])
  expect(t.grid[5]).toEqual(['', 'n (%)', 'n (%)'])
  expect(t.grid[6]).toEqual(['Regular NSAID user', '18 (9.0)', '14 (7.0)'])
  expect(t.grid[7]).toEqual(['Regular statin user', '25 (12.5)', '21 (10.5)'])
  expect(t.grid).toHaveLength(12)
  expect(f).toEqual(original)
})

it('recovers repeated leaf columns and all underlined parent headers without an empty model column', () => {
  const f = fixture('repeated-year-header'),
    original = structuredClone(f),
    t = refine(f)
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(t.grid).toHaveLength(14)
  expect(t.grid.every((r: string[]) => r.length === 15)).toBe(true)
  expect(t.grid[2]).toEqual([
    'Weight,d kg',
    'I',
    '358',
    '61.9',
    '7.4',
    '−0.39',
    '61.2',
    '7.6',
    '−2.81',
    '62.5',
    '7.8',
    '−1.92',
    '63.1',
    '8.4',
    '−1.58'
  ])
  for (const [i, text] of [
    'Baseline',
    'Years 1 or 2',
    'Years 4 or 5 or 6',
    'Years 8 or 9 or 10'
  ].entries())
    expect(t.cells.find((c: { text: string }) => c.text === text)).toMatchObject({
      row: 0,
      column: 3 + i * 3,
      colSpan: 3,
      rowSpan: 1
    })
  expect(f).toEqual(original)
})

it.each(['wrapped-education', 'split-count-header', 'repeated-year-header'])(
  'retains every native token exactly once in %s',
  (name) => {
    const f = fixture(name),
      t = refine(f)
    const signature = ({
      text,
      rect,
      height,
      baseline
    }: {
      text: string
      rect: number[]
      height: number
      baseline: number
    }): string => JSON.stringify({ text, rect, height, baseline })
    expect(
      t.cells
        .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
        .map(signature)
        .sort()
    ).toEqual(f.tokens.map(signature).sort())
  }
)

it('does not attach a separate category or cross a native row divider', () => {
  const f = fixture('wrapped-education')
  const token = f.tokens.find((i: { text: string }) => i.text === 'secondary school')
  token.text = 'Secondary school'
  expect(
    refine(f)
      .grid.flat()
      .some((s: string) => s.includes('technical Secondary'))
  ).toBe(false)
  token.text = 'secondary school'
  f.rules.push([250, token.rect[1] - 1, 400, token.rect[1] - 1])
  expect(
    refine(f)
      .grid.flat()
      .some((s: string) => s.includes('technical secondary'))
  ).toBe(false)
})

it('does not invent a repeated count heading from a partial label or different measure', () => {
  for (const replacement of ['n = 200', 'Mean']) {
    const f = fixture('split-count-header')
    const token = f.tokens.find(
      (i: { text: string; rect: number[] }) => i.text === '(%)' && i.rect[1] > 280
    )
    token.text = replacement
    expect(
      refine(f).grid.some((r: string[]) => r[0] === '' && r[1] === 'n (%)' && r[2] === 'n (%)')
    ).toBe(false)
  }
})

it('declines unsupported native columns, unequal children and ambiguous source ownership', async () => {
  const { recoverRepeatedHeaderGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
  )
  const recover = (f: ReturnType<typeof fixture>): unknown =>
    recoverRepeatedHeaderGrid(f.table, f.tokens, f.captions, f.rules)
  const f = fixture('repeated-year-header')
  expect(recover(f)).toBeDefined()
  expect(recover({ ...f, captions: [] })).toBeUndefined()
  expect(recover({ ...f, rules: [] })).toBeUndefined()
  expect(
    recover({
      ...f,
      rules: f.rules.filter((r: number[]) => Math.abs(r[1] - 284.385) > 0.1 || r[0] > 500)
    })
  ).toBeUndefined()
  const changed = structuredClone(f)
  changed.tokens.find((i: { text: string }) => i.text === 'Mean').text = 'Median'
  expect(recover(changed)).toBeUndefined()
  expect(recover({ ...f, tokens: [...f.tokens, f.tokens[0]] })).toBeUndefined()
  const crossing = structuredClone(f)
  crossing.tokens.find((i: { text: string }) => i.text === '61.9').rect[2] = 445
  expect(recover(crossing)).toBeUndefined()
  const partial = structuredClone(f)
  partial.tokens = partial.tokens.filter((i: { text: string }) => i.text !== '61.9')
  expect(recover(partial)).toBeUndefined()
})
