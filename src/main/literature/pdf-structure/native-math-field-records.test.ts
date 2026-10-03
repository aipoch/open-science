import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeMathFieldRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-math-field-record-grid.mjs'))
    .href
)
const token = (
  text: string,
  x: number,
  y: number,
  width: number,
  height = 10
): ReturnType<typeof JSON.parse> => ({
  text,
  rect: [x, y, x + width, y + height],
  height,
  baseline: y + height,
  horizontal: true
})
const input = (): ReturnType<typeof JSON.parse> => ({
  table: {
    id: 'table',
    cropRect: [40, 70, 540, 157],
    structure: {
      objects: [
        ...[
          [10, 110],
          [115, 210],
          [215, 290],
          [295, 330],
          [335, 390],
          [395, 500]
        ].map(([a, b]) => ({
          label: 'table column',
          score: 0.9,
          rect: [a, 5, b, 82]
        })),
        ...[
          [8, 27],
          [28, 44],
          [45, 63],
          [64, 84]
        ].map(([a, b]) => ({ label: 'table row', score: 0.9, rect: [5, a, 500, b] }))
      ]
    }
  },
  tokens: [
    ...['Metric', 'Storage', 'Apply', 'Refresh'].map((t, n) =>
      token(t, [50, 185, 315, 450][n], 80, 40)
    ),
    ...['Full', 'O(ab)', 'O(ab)', 'O(ab)'].map((t, n) => token(t, [50, 185, 315, 450][n], 105, 40)),
    ...['Diagonal', 'O(a)', 'O(a)', 'O(a)'].map((t, n) =>
      token(t, [50, 185, 315, 450][n], 123, 40)
    ),
    ...['Factor', 'O(a+b)', 'O(a+bc)', 'O(a+b+c)'].map((t, n) =>
      token(t, [50, 185, 315, 450][n], 141, 65)
    )
  ],
  captions: [{ lines: ['Table 1: Synthetic matrix operations.'], rect: [40, 160, 540, 170] }],
  rules: [
    [40, 75, 540, 75],
    [40, 99, 540, 99],
    [40, 155, 540, 155]
  ]
})
it('recovers complete mathematical fields without detector cuts inside expressions', () => {
  const f = input()
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid).toEqual([
    ['Metric', 'Storage', 'Apply', 'Refresh'],
    ['Full', 'O(ab)', 'O(ab)', 'O(ab)'],
    ['Diagonal', 'O(a)', 'O(a)', 'O(a)'],
    ['Factor', 'O(a+b)', 'O(a+bc)', 'O(a+b+c)']
  ])
  expect(result.unassigned).toEqual([])
})

it('declines incomplete fields, overlapping source gutters and unsupported frames', () => {
  const f = input()
  expect(
    recoverNativeMathFieldRecords(f.table, f.tokens.slice(0, -1), f.captions, f.rules)
  ).toBeUndefined()
  expect(recoverNativeMathFieldRecords(f.table, f.tokens, [], f.rules)).toBeUndefined()
  expect(
    recoverNativeMathFieldRecords(f.table, f.tokens, f.captions, f.rules.slice(0, 2))
  ).toBeUndefined()
  f.tokens[14].rect[2] = 455
  expect(recoverNativeMathFieldRecords(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it('retains source overbar accents without creating physical records', () => {
  const f = input(),
    accent = token('¯', 198, 74.2, 5)
  for (const item of f.tokens.slice(0, 4)) {
    item.rect[1] -= 3
    item.rect[3] -= 3
    item.baseline -= 3
  }
  f.tokens.push(accent)
  const grid = recoverNativeMathFieldRecords(f.table, f.tokens, f.captions, f.rules)
  expect(grid.rows).toHaveLength(4)
  expect(grid.ownedTokens.has(accent)).toBe(true)
  accent.rect[0] = 270
  accent.rect[2] = 275
  expect(recoverNativeMathFieldRecords(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it('recovers a continued repeated measurement table only with complete independent leaves', () => {
  const f = input()
  f.tokens = [
    ...['Example', 'Point', 'Engine', 'Estimate', 'Reference'].map((t, n) =>
      token(t, [50, 150, 250, 350, 450][n], 80, 50)
    ),
    ...Array.from({ length: 8 }, (_, r) =>
      ['Trial' + r, 'c=1', '0.51', '0.50', '—'].map((t, n) =>
        token(t, [50, 150, 250, 350, 450][n], 105 + r * 18, 40)
      )
    ).flat()
  ]
  f.table.cropRect[3] = 247
  f.rules[2] = [40, 245, 540, 245]
  const grid = recoverNativeMathFieldRecords(f.table, f.tokens, [], f.rules)
  expect(grid.rows).toHaveLength(9)
  expect(grid.columns).toHaveLength(5)
  expect(grid.ownedTokens.size).toBe(f.tokens.length)
  f.tokens[12].text = 'unknown'
  expect(recoverNativeMathFieldRecords(f.table, f.tokens, [], f.rules)).toBeUndefined()
})
