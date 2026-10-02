import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverTwoCohortSectionGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/two-cohort-measure-sections-over-complete-visit-cycles.jsonl'
    )
  )

it('keeps physical measure headings and both complete native cohort cycles', () => {
  const x = fixture(),
    before = structuredClone(x)
  const result = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
  expect(result.grid).toHaveLength(17)
  expect(result.grid[1]).toEqual(['Section 1', '', '', ''])
  expect(result.grid[7][0]).toBe('Section 3')
  expect(result.grid[12][0]).toBe('Section 4')
  expect(result.grid.filter((r: string[]) => /^T\d$/.test(r[0]))).toHaveLength(12)
  expect(result.grid[7][3]).toBe('p = 1.65 (F = 1.72, d.f. = 3, 77)')
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(x).toEqual(before)
})

it('keeps a numeric plus classification separate from the following native section', () => {
  const x = fixture()
  const section = x.tokens.find((i: { text: string }) => i.text === 'Section 3')
  section.rect[2] = 110
  const lastVisit = x.tokens
    .filter(
      (i: { text: string; baseline: number }) =>
        /^T\d$/.test(i.text) && i.baseline < section.baseline
    )
    .at(-1)
  lastVisit.text = '2+/3+'
  x.tokens = x.tokens.filter(
    (i: { rect: number[]; baseline: number }) =>
      !(i.rect[0] > 250 && Math.abs(i.baseline - section.baseline) < 1)
  )
  const result = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
  expect(result.grid).toHaveLength(17)
  expect(result.grid[6][0]).toBe('2+/3+')
  expect(result.grid[7]).toEqual(['Section 3', '', '', ''])
  expect(result.unassigned).toEqual([])
})

it.each([
  'no-caption',
  'missing-footer',
  'incompatible-band',
  'missing-sample',
  'incomplete-record',
  'orphan-section'
])('declines a complete source rebuild with %s evidence', (variant) => {
  const x = fixture()
  if (variant === 'no-caption') x.captions = []
  if (variant === 'missing-footer') x.rules = x.rules.filter((r: number[]) => r[1] < 400)
  if (variant === 'incompatible-band') x.rules[x.rules.length - 1][0] += 2
  if (variant === 'missing-sample')
    x.tokens = x.tokens.filter((i: { text: string }) => !/^\(n/.test(i.text))
  if (variant === 'incomplete-record') {
    const first = x.tokens.find((i: { text: string }) => i.text === 'T1')
    x.tokens = x.tokens.filter(
      (i: { baseline: number; rect: number[] }) =>
        !(Math.abs(i.baseline - first.baseline) < 1 && i.rect[0] > 180 && i.rect[0] < 240)
    )
  }
  if (variant === 'orphan-section')
    x.tokens.push({
      text: 'Unowned label',
      horizontal: true,
      baseline: 260,
      height: 14.25,
      rect: [190, 245.75, 225, 260]
    })
  expect(recoverTwoCohortSectionGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
