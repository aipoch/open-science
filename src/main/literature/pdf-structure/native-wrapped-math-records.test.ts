import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeWrappedMathRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-math-field-record-grid.mjs'))
    .href
)
const token = (text: string, x: number, y: number, width = 30): ReturnType<typeof JSON.parse> => ({
  text,
  rect: [x, y, x + width, y + 10],
  height: 10,
  baseline: y + 10,
  horizontal: true
})
const input = (): ReturnType<typeof JSON.parse> => ({
  table: {
    id: 'table',
    cropRect: [40, 70, 460, 200],
    structure: {
      objects: [
        ...[10, 90, 170].map((x) => ({
          label: 'table column',
          score: 0.9,
          rect: [x, 0, x + 75, 125]
        })),
        ...[8, 28, 44, 60, 76, 92, 108].map((y) => ({
          label: 'table row',
          score: 0.9,
          rect: [0, y, 420, y + 14]
        }))
      ]
    }
  },
  tokens: [
    token('State', 50, 80),
    token('Count', 130, 80),
    token('Configurations', 250, 80, 100),
    ...Array.from({ length: 3 }, (_, n) => [
      token('Item' + n, 50, 105 + n * 32),
      token(String(10 + n), 130, 105 + n * 32),
      token('a b + c d', 200, 105 + n * 32, 200),
      token('d e + f g', 200, 121 + n * 32, 180)
    ]).flat()
  ],
  rules: [
    [40, 73, 460, 73],
    [40, 75, 460, 75],
    [40, 99, 460, 99],
    [40, 197, 460, 197]
  ],
  captions: [
    { lines: ['Table 1: Synthetic wrapped mathematical records.'], rect: [40, 55, 460, 65] }
  ]
})
it('folds mathematical continuation lines into their independently anchored source record', () => {
  const f = input(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(4)
  expect(r.grid[0]).toEqual(['State', 'Count', 'Configurations'])
  expect(r.grid.slice(1).map((r: string[]) => r.slice(0, 2))).toEqual([
    ['Item0', '10'],
    ['Item1', '11'],
    ['Item2', '12']
  ])
  expect(
    r.grid.slice(1).every((r: string[]) => r[2].includes('a b + c d') && r[2].includes('d e + f g'))
  ).toBe(true)
  expect(r.unassigned).toEqual([])
})
it('declines orphan continuation, incomplete anchors and text crossing a source gutter', () => {
  const f = input()
  expect(recoverNativeWrappedMathRecords(f.table, f.tokens, [], f.rules)).toBeUndefined()
  expect(
    recoverNativeWrappedMathRecords(
      f.table,
      f.tokens.slice(0, 4).concat(f.tokens.slice(5)),
      f.captions,
      f.rules
    )
  ).toBeUndefined()
  const g = input()
  g.tokens[6].rect[0] = 140
  expect(recoverNativeWrappedMathRecords(g.table, g.tokens, g.captions, g.rules)).toBeUndefined()
  const h = input()
  h.tokens[3].text = ''
  expect(recoverNativeWrappedMathRecords(h.table, h.tokens, h.captions, h.rules)).toBeUndefined()
})
