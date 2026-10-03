import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverCompleteNativeLeafRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-complete-record-grid.mjs'))
    .href
)
type Token = { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean }
const token = (text: string, x: number, y: number, width: number): Token => ({
  text,
  rect: [x, y, x + width, y + 10],
  height: 10,
  baseline: y + 10,
  horizontal: true
})
it('declines when a source field crosses the native gutter or the complete frame is absent', () => {
  const f = input()
  f.tokens[7].rect[2] = 400
  expect(recoverCompleteNativeLeafRecords(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  const g = input()
  expect(
    recoverCompleteNativeLeafRecords(g.table, g.tokens, g.captions, g.rules.slice(0, 2))
  ).toBeUndefined()
  expect(recoverCompleteNativeLeafRecords(g.table, g.tokens, [], g.rules)).toBeUndefined()
})
const input = (): ReturnType<typeof JSON.parse> => ({
  table: {
    id: 'table',
    cropRect: [40, 70, 550, 145],
    structure: {
      objects: [
        ...[
          [10, 115],
          [120, 200],
          [205, 270],
          [250, 340],
          [345, 425],
          [430, 500]
        ].map(([a, b]) => ({
          label: 'table column',
          score: 0.9,
          rect: [a, 55, b, 72]
        })),
        { label: 'table row', score: 0.9, rect: [10, 55, 500, 72] }
      ]
    }
  },
  tokens: [
    ...['Model', 'Dimension', 'Target', 'Estimate', 'SD'].map((t, n) =>
      token(t, [50, 175, 270, 380, 490][n], 80, [35, 65, 50, 60, 25][n])
    ),
    ...['Alpha', '1', '0.73', '0.70', '0.02'].map((t, n) =>
      token(t, [50, 210, 295, 390, 495][n], 105, [35, 5, 25, 25, 25][n])
    ),
    ...['Beta', '0.6', '[0.60, 0.64]', '0.62', '0.03'].map((t, n) =>
      token(t, [50, 190, 255, 390, 495][n], 125, [30, 20, 95, 25, 25][n])
    )
  ],
  rules: [
    [40, 75, 550, 75],
    [40, 98, 550, 98],
    [40, 142, 550, 142]
  ],
  captions: [{ lines: ['Table 1: Synthetic complete records.'], rect: [40, 149, 550, 159] }]
})
it('uses complete native header and record lanes rather than overlapping model cuts', () => {
  const f = input()
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toEqual([
    ['Model', 'Dimension', 'Target', 'Estimate', 'SD'],
    ['Alpha', '1', '0.73', '0.70', '0.02'],
    ['Beta', '0.6', '[0.60, 0.64]', '0.62', '0.03']
  ])
  expect(r.unassigned).toEqual([])
})
