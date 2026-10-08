import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/user-study-paired-percentages.jsonl'
    )
  )

it('recovers only the four native-measured User Study pairs without duplicating source ownership', () => {
  const f = fixture(),
    before = structuredClone(f),
    result = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.runs)
  const byMethod = new Map(result.grid.map((row: string[]) => [row[0], row.slice(-2)]))
  expect(byMethod.get('Method Beta')).toEqual(['61.4%', '43.9%'])
  expect(byMethod.get('Method Gamma')).toEqual(['14.1%', '27.0%'])
  expect(byMethod.get('Method Delta')).toEqual(['', ''])
  expect(byMethod.get('Method Epsilon')).toEqual(['42.2%', '35.6%'])
  expect(byMethod.get('Method Zeta')).toEqual(['49.2%', '52.1%'])
  expect(result.unassigned).toEqual(['57.7% 61.7%'])
  expect(result.issues).toContain('unassigned-source-text')
  expect(result.repairs).toContain('user-study-paired-percentages-recovered')
  for (const run of f.runs.filter((r: { text: string }) => r.text !== '57.7% 61.7%')) {
    const cells = result.cells.filter((c: { sourceTokens: { sourceToken?: { text: string } }[] }) =>
      c.sourceTokens.some((t) => t.sourceToken?.text === run.text)
    )
    expect(cells).toHaveLength(2)
    const parts = cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens),
      rects = cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
    expect(new Set(parts).size).toBe(2)
    expect(new Set(rects.map((r: number[]) => r.join(','))).size).toBe(2)
    for (const cell of cells) {
      expect(cell.sourceTokens).toHaveLength(1)
      expect(cell.sourceTokens[0].text).toBe(cell.text)
      expect(cell.sourceRects).toEqual([cell.sourceTokens[0].rect])
      expect(cell.sourceRects[0][0]).toBeGreaterThanOrEqual(cell.rect[0])
      expect(cell.sourceRects[0][2]).toBeLessThanOrEqual(cell.rect[2])
    }
  }
  expect(f).toEqual(before)
  const reversed = refineTable(
    f.table,
    [...f.tokens].reverse(),
    f.captions,
    [],
    f.rules,
    [...f.runs].reverse()
  )
  expect(reversed.grid).toEqual(result.grid)
  expect(reversed.unassigned).toEqual(result.unassigned)
})

it('retains all original paired runs as unassigned without native measurement witnesses', () => {
  const f = fixture(),
    result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.repairs).not.toContain('user-study-paired-percentages-recovered')
  expect(result.unassigned).toHaveLength(5)
  expect(result.grid.find((r: string[]) => r[0] === 'Method Beta').slice(-2)).toEqual(['', ''])
})

it.each([
  'absent',
  'nonfinite',
  'bad literal',
  'multiple matches',
  'crossed lane',
  'invalid second part'
])('preserves the whole pair atomically with %s native evidence', (variant) => {
  const f = fixture(),
    run = f.runs.find((r: { text: string }) => r.text === '61.4% 43.9%')
  if (variant === 'absent') f.runs = f.runs.filter((r: unknown) => r !== run)
  if (variant === 'nonfinite') run.gaps[0].right = Infinity
  if (variant === 'bad literal') run.literalGlyphs[0] = '9'
  if (variant === 'multiple matches') f.runs.push(structuredClone(run))
  if (variant === 'crossed lane') {
    run.gaps[0].left = 720
    run.gaps[0].right = 730
  }
  if (variant === 'invalid second part') run.gaps[0].right = run.rect[2]
  const before = structuredClone(f),
    result = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.runs)
  expect(result.grid.find((r: string[]) => r[0] === 'Method Beta').slice(-2)).toEqual(['', ''])
  expect(result.unassigned).toEqual(expect.arrayContaining(['61.4% 43.9%', '57.7% 61.7%']))
  expect(result.grid.find((r: string[]) => r[0] === 'Method Gamma').slice(-2)).toEqual([
    '14.1%',
    '27.0%'
  ])
  expect(result.repairs).toContain('user-study-paired-percentages-recovered')
  expect(f).toEqual(before)
})

it('does not infer paired percentages without both User Study leaf headers', () => {
  const f = fixture()
  f.tokens = f.tokens.filter((token: { text: string }) => !token.text.includes('≡'))
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.repairs).not.toContain('user-study-paired-percentages-recovered')
})
