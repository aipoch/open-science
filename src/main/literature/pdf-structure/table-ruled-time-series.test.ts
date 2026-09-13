import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/ruled-time-series.jsonl')
  )
const refine = (x: ReturnType<typeof load>): ReturnType<typeof refineTable> =>
  refineTable(x.table, x.tokens, x.captions, [], x.rules)
it('recovers complete time-point records and assigns outcome labels to their native groups', () => {
  const t = refine(load())
  expect(t.grid).toHaveLength(15)
  expect(t.grid[4]).toEqual([
    'Outcome',
    '6 m',
    '72.5',
    '21.8',
    '67.4',
    '24.3',
    '5.1',
    '–9.7 – 19.9',
    '20',
    '20',
    'Little'
  ])
  expect(t.grid[5]).toEqual([
    '',
    '24 m',
    '74.8',
    '21.5',
    '61.6',
    '26.3',
    '13.2',
    '–2.8 – 29.1',
    '17',
    '20',
    'Moderate'
  ])
  expect(t.grid[6]).toEqual([
    'Psychosocial well-being',
    'BL',
    '51.8',
    '17.2',
    '53.5',
    '15.5',
    '–1.6',
    '–11.4 – 8.1',
    '24',
    '22',
    'No'
  ])
  expect(t.grid[3]).toEqual([
    '',
    '24 m',
    '63.4',
    '16.0',
    '50.90',
    '13.8',
    '12.54',
    '2.66 – 22.43',
    '18',
    '20',
    'Moderate'
  ])
  expect(t.grid.at(-1)).toEqual([
    '',
    '24 m',
    '59.8',
    '31.9',
    '46.9',
    '16.2',
    '12.9',
    '–6.2 – 32.1',
    '15',
    '16',
    'Moderate'
  ])
  for (const [row, rowSpan] of [
    [1, 3],
    [4, 2],
    [6, 3],
    [9, 3],
    [12, 3]
  ])
    expect(t.cells).toContainEqual(expect.objectContaining({ row, column: 0, rowSpan, colSpan: 1 }))
  expect(t.unassigned).toEqual([])
})
it.each([
  'missing-value',
  'duplicate-value',
  'unordered-time',
  'missing-frame',
  'foreign-label',
  'missing-caption'
])('declines unsafe time-series reconstruction: %s', (kind) => {
  const x = load()
  if (kind === 'missing-value')
    x.tokens = x.tokens.filter(
      (i: { text: string; baseline: number }) => !(i.text === '74.8' && i.baseline < 300)
    )
  if (kind === 'duplicate-value')
    x.tokens.push(
      structuredClone(
        x.tokens.find(
          (i: { text: string; baseline: number }) => i.text === '74.8' && i.baseline < 300
        )
      )
    )
  if (kind === 'unordered-time')
    x.tokens.find(
      (i: { text: string; baseline: number }) =>
        i.text === '24 m' && i.baseline > 190 && i.baseline < 210
    ).text = '3 m'
  if (kind === 'missing-frame')
    x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 139.54035) > 1)
  if (kind === 'foreign-label')
    x.tokens.push({
      ...structuredClone(x.tokens.find((i: { text: string }) => i.text === 'Outcome')),
      text: 'Unrelated annotation',
      rect: [55, 194, 190, 206],
      baseline: 206
    })
  if (kind === 'missing-caption') x.captions = []
  expect(refine(x).repairs).not.toContain('ruled-time-series-recovered')
})

const comparisons = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/ruled-time-comparisons.jsonl')
  )
it('shares wrapped outcome labels across their comparison records while retaining empty sample cells', () => {
  const x = comparisons(),
    t = refine(x)
  expect(t.grid.slice(1).map((r: string[]) => r.slice(1))).toEqual(
    x.table.grid.map((r: string[]) => r.slice(1))
  )
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 8, column: 0, rowSpan: 4, text: 'Psychosocial well-being' })
  )
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 12, column: 0, rowSpan: 6, text: 'Physical well-being. chest' })
  )
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 18, column: 0, rowSpan: 6, text: 'Sexual well-being' })
  )
  expect(t.unassigned).toEqual([])
})
it.each(['missing-measure', 'wrong-time-heading', 'missing-interval', 'missing-arm-count'])(
  'declines an incomplete comparison record: %s',
  (kind) => {
    const x = comparisons()
    if (kind === 'missing-measure')
      x.tokens = x.tokens.filter(
        (i: { text: string; baseline: number }) => !(i.text === '42.4' && i.baseline > 780)
      )
    if (kind === 'wrong-time-heading')
      x.tokens.find(
        (i: { text: string; baseline: number }) => i.text === '6 m' && i.baseline > 740
      ).text = '8 m'
    if (kind === 'missing-interval')
      x.tokens = x.tokens.filter(
        (i: { text: string; baseline: number }) => !(i.text === '7.8 – 23.0' && i.baseline > 780)
      )
    if (kind === 'missing-arm-count')
      x.tokens = x.tokens.filter(
        (i: { text: string; baseline: number }) =>
          !(i.text === '20' && Math.abs(i.baseline - 795.30345) < 0.01)
      )
    expect(refine(x).repairs).not.toContain('ruled-time-series-recovered')
  }
)
