import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { tableSourceItems, readSourceRow, hasUniqueRecordTokens } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)

function token(
  text: string,
  left: number,
  right: number,
  baseline = 10
): {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
} {
  return {
    text,
    rect: [left, baseline - 5, right, baseline],
    baseline,
    height: 5,
    horizontal: true
  }
}

it('keeps complete horizontal source tokens in reading order without changing the input', () => {
  const first = token('Label', 1, 8),
    next = token('0', 12, 14, 20),
    clipped = token('Clipped', -1, 2),
    vertical = { ...token('Vertical', 2, 4), horizontal: false },
    source = [next, clipped, vertical, first]
  const before = structuredClone(source)
  expect(tableSourceItems(source, [0, 0, 20, 20])).toEqual([first, next])
  expect(source).toEqual(before)
})

it('preserves literal zeroes, missing values and empty columns when checking records', () => {
  const source = [token('0', 11, 12), token('0', 1, 2), token('–', 31, 32)]
  expect(readSourceRow(source, [0, 10, 20, 30, 40])).toEqual(['0', '0', '', '–'])
  expect(source.map((i) => i.text)).toEqual(['0', '0', '–'])
  const fragments = [token('(', 14, 15), token('0 ', 11, 12), token('0)', 16, 18)]
  expect(readSourceRow(fragments, [0, 10, 20])).toEqual(['', '0(0)'])
  expect(fragments[1].text).toBe('0 ')
})

it.each([[0], [0, 10, 10, 20], [0, 20, 10], [0, NaN, 20], [0, Infinity]])(
  'declines invalid column boundaries %j',
  (...cuts) => {
    expect(readSourceRow([token('1', 1, 2)], cuts)).toBeUndefined()
  }
)

it('declines cross-column and out-of-range text instead of losing its ownership', () => {
  for (const item of [token('10', 9, 12), token('1', -2, -1), token('1', 20, 21), token('1', 4, 4)])
    expect(readSourceRow([item], [0, 10, 20])).toBeUndefined()
  const item = token('1', 1, 2)
  expect(readSourceRow([item, item], [0, 10])).toBeUndefined()
})

it('requires every source token to belong to exactly one record', () => {
  const first = token('0', 1, 2),
    second = token('0', 1, 2, 20),
    foreign = token('1', 11, 12)
  expect(hasUniqueRecordTokens([first, second], [[first], [second]])).toBe(true)
  expect(hasUniqueRecordTokens([first, second], [[first]])).toBe(false)
  expect(hasUniqueRecordTokens([first, second], [[first], [first, second]])).toBe(false)
  expect(hasUniqueRecordTokens([first, second], [[first], [second, foreign]])).toBe(false)
  expect(hasUniqueRecordTokens([first, second], [[first], [], [second]])).toBe(false)
  expect(hasUniqueRecordTokens([first, first], [[first]])).toBe(false)
})

const { splitOwnedSourceRow, splitOwnedSourceRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)

it('splits an exclusively owned source row using glyph centers without mutating input', () => {
  const upper = token('Section', 1, 8),
    lower = token('0', 11, 14, 20)
  const rows = [{ rect: [5, 7, 35, 22], origin: 'model' }]
  const items = [lower, upper]
  const before = structuredClone({ rows, items })
  expect(splitOwnedSourceRow(rows, items, [upper], [lower], [0, 40])).toEqual({
    index: 0,
    rows: [
      { rect: [0, 5, 40, 12.5], origin: 'source-text' },
      { rect: [0, 12.5, 40, 20], origin: 'source-text' }
    ]
  })
  expect({ rows, items }).toEqual(before)
})

it.each([
  'complete-overlap',
  'partial-overlap',
  'extra-text',
  'duplicate-token',
  'foreign-token',
  'empty-group',
  'reversed-groups'
])('declines a source split with %s evidence', (condition) => {
  const upper = token('Section', 1, 8),
    lower = token('0', 11, 14, 20)
  const rows = [{ rect: [0, 5, 40, 22], origin: 'model' }]
  const items = [upper, lower]
  let first = [upper],
    second = [lower]
  if (condition === 'complete-overlap') rows.push({ ...rows[0] })
  if (condition === 'partial-overlap') rows.push({ rect: [0, 5, 40, 12], origin: 'model' })
  if (condition === 'extra-text') items.push(token('*', 15, 17, 15))
  if (condition === 'duplicate-token') first = [upper, upper]
  if (condition === 'foreign-token') first = [{ ...upper }]
  if (condition === 'empty-group') first = []
  if (condition === 'reversed-groups') {
    first = [lower]
    second = [upper]
  }
  expect(splitOwnedSourceRow(rows, items, first, second, [0, 40])).toBeUndefined()
})

it('splits several complete source groups without losing or duplicating the final record', () => {
  const items = [token('Section', 1, 8), token('Mean', 2, 8, 20), token('Range', 2, 8, 30)]
  const rows = [{ rect: [0, 5, 40, 32] }]
  const groups = items.map((i) => [i])
  expect(
    splitOwnedSourceRows(rows, items, groups, [0, 40])?.rows.map((r: { rect: number[] }) => r.rect)
  ).toEqual([
    [0, 5, 40, 12.5],
    [0, 12.5, 40, 22.5],
    [0, 22.5, 40, 30]
  ])
  expect(splitOwnedSourceRows(rows, items, groups.slice(0, 2), [0, 40])).toBeUndefined()
  expect(splitOwnedSourceRows(rows, items, [...groups, groups[2]], [0, 40])).toBeUndefined()
  expect(
    splitOwnedSourceRows(rows, items, [groups[0], groups[2], groups[1]], [0, 40])
  ).toBeUndefined()
})
