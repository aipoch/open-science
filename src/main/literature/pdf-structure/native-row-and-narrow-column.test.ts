import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
it('recovers complete measurements falling between shifted model row bands', () => {
  const x = fixture('shifted-row-bands-with-raised-unit'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  for (const row of [
    ['Waist circumference (cm), mean (SD)', '96.8 (9.2)'],
    ['Proportion (%) of fat mass', '39.7 (5.4)'],
    ['Fat-free mass (kg), mean (SD)', '43.8 (3.8)']
  ])
    expect(t.grid).toContainEqual(row)
  expect(t.unassigned).toEqual([])
})
it('recovers a signed category even when none of its tokens belong to a model row', () => {
  const x = fixture('missing-signed-category-between-sections'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toContainEqual(['PR+', '21 (78%)', '12 (44%)'])
  expect(t.grid).toContainEqual(['PR -', '6 (22%)', '15 (56%)'])
  expect(t.unassigned).toEqual([])
})
it('keeps degrees of freedom and probability as separate native columns', () => {
  const x = fixture('adjacent-degrees-of-freedom-and-probability'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid[0].slice(-2)).toEqual(['df', 'p'])
  expect(t.grid.find((r: string[]) => r[0] === 'Education')?.slice(-3)).toEqual([
    '3.34',
    '3',
    '.34'
  ])
})
it('recovers a missing numerical category between ordered neighboring scores', () => {
  const x = fixture('missing-numeric-score-in-ordered-categories'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toContainEqual(['90', '23 (29)', '18 (23)', '41 (26)'])
})
it('joins wrapped slash-delimited stubs without turning their tails into sections', () => {
  const x = fixture('wrapped-stubs-with-slash-continuations'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.some((r: string[]) => r[0] === '<High School/ GED' && r[1] === '3 (11)')).toBe(true)
  expect(t.grid.some((r: string[]) => r[0] === 'GED')).toBe(false)
})
it('keeps parenthesized scale ranges with their measurement labels', () => {
  const x = fixture('wrapped-stub-ranges-and-section-headings'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.grid.some((r: string[]) => r[0] === 'Dispositional optimism (0–32)' && r[1] === '17.80 (7.0)')
  ).toBe(true)
  expect(t.grid.some((r: string[]) => r[0] === 'Socio-demographic variables')).toBe(true)
})
it('does not join a wrapped-looking stub across an explicit native rule', () => {
  const x = fixture('wrapped-stubs-with-slash-continuations'),
    tail = x.tokens.find((t: { text: string }) => t.text === 'GED')
  const rule = [x.table.cropRect[0], tail.rect[1] - 1, x.table.cropRect[2], tail.rect[1] - 1]
  const t = refineTable(x.table, x.tokens, x.captions, [], [...x.rules, rule])
  expect(t.grid.some((r: string[]) => r[0] === 'GED')).toBe(true)
})
it('preserves data columns when a wrapped stub tail was predicted as a full-width section', () => {
  const x = fixture('wrapped-stubs-with-slash-continuations'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toContainEqual([
    '≥High School/ GED',
    '25 (89)',
    '13 (87)',
    '12 (92)',
    '',
    '20 (83)',
    '9 (82)',
    '11 (85)',
    '',
    ''
  ])
})
it('uses repeated hanging indentation to join capitalized and terminal stub continuations', () => {
  const x = fixture('wrapped-stubs-with-slash-continuations'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  for (const label of [
    'Household Income (N, %)',
    'Years Since Diagnosis (M, SD)',
    'Radiation Therapy',
    'Hormonal Therapy'
  ])
    expect(t.grid.some((r: string[]) => r[0] === label)).toBe(true)
  expect(t.grid.find((r: string[]) => r[0] === 'Years Since Diagnosis (M, SD)')?.[1]).toBe(
    '7.8 (4.7)'
  )
  expect(t.grid.find((r: string[]) => r[0] === 'Hormonal Therapy')?.[1]).toBe('9 (32)')
  expect(t.grid.some((r: string[]) => r[0] === 'Treatment (N, %)')).toBe(true)
})
it('does not learn hanging continuations from a single indented tail', () => {
  const x = fixture('wrapped-stubs-with-slash-continuations')
  for (const token of x.tokens) {
    if (token.text === 'GED' || token.text.startsWith('Income (')) {
      token.rect[0] -= 6
      token.rect[2] -= 6
    }
  }
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.some((r: string[]) => r[0] === 'Hormonal Therapy')).toBe(false)
})
it('keeps an explicit rule between a measured label and its hanging tail', () => {
  const x = fixture('wrapped-stubs-with-slash-continuations'),
    tail = x.tokens.filter((t: { text: string }) => t.text === 'Therapy').at(-1),
    rule = [x.table.cropRect[0], tail.rect[1] - 1, x.table.cropRect[2], tail.rect[1] - 1],
    t = refineTable(x.table, x.tokens, x.captions, [], [...x.rules, rule])
  expect(t.grid.some((r: string[]) => r[0] === 'Hormonal Therapy')).toBe(false)
  expect(t.grid.some((r: string[]) => r[0] === 'Radiation Therapy')).toBe(true)
})
