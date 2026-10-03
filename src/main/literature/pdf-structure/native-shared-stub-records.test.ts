import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeSegmentedStubRecords } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-shared-stub-record-grid.mjs')
  ).href
)
const token = (text: string, x: number, y: number, width = 30): ReturnType<typeof JSON.parse> => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const input = (): ReturnType<typeof JSON.parse> => ({
  table: {
    id: 'table',
    cropRect: [40, 70, 460, 165],
    structure: {
      objects: [
        ...[
          [5, 65],
          [70, 165],
          [170, 285],
          [290, 415]
        ].map(([a, b]) => ({ label: 'table column', score: 0.9, rect: [a, 0, b, 95] })),
        ...[
          [0, 25],
          [26, 64],
          [65, 94]
        ].map(([a, b]) => ({ label: 'table row', score: 0.9, rect: [0, a, 420, b] }))
      ]
    }
  },
  tokens: [
    ...['Group', 'Mode', 'Score', 'Rate'].map((t, n) => token(t, [50, 130, 250, 370][n], 75)),
    ...Array.from({ length: 4 }, (_, n) =>
      ['Train' + n, '0.5±0.1', '0.7±0.2'].map((t, c) =>
        token(t, [130, 250, 370][c], 95 + n * 16, 60)
      )
    ).flat(),
    token('Alpha', 50, 104),
    token('Beta', 50, 136)
  ],
  captions: [{ lines: ['Table 1: Synthetic grouped measurements.'], rect: [40, 165, 460, 175] }],
  rules: [
    ...[120, 240, 360].flatMap((x) => [
      [x, 73, x, 91],
      ...[93, 109, 125, 141].map((y) => [x, y, x, y + 16])
    ]),
    [40, 92, 460, 92],
    [40, 125, 460, 125]
  ]
})
it('keeps independent measurement records and the centered shared group stub', () => {
  const f = input(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(5)
  expect(
    r.cells
      .filter((c: { column: number }) => c.column === 0)
      .map((c: { row: number; rowSpan: number; text: string }) => [c.row, c.rowSpan, c.text])
  ).toEqual([
    [0, 1, 'Group'],
    [1, 2, 'Alpha'],
    [3, 2, 'Beta']
  ])
  expect(r.grid.slice(1).map((r: string[]) => r[1])).toEqual([
    'Train0',
    'Train1',
    'Train2',
    'Train3'
  ])
  expect(r.unassigned).toEqual([])
})
it('declines missing independent divider segments, gutter crossings and unrelated stubs', () => {
  const f = input()
  expect(
    recoverNativeSegmentedStubRecords(f.table, f.tokens, f.captions, f.rules.slice(1))
  ).toBeUndefined()
  expect(recoverNativeSegmentedStubRecords(f.table, f.tokens, [], f.rules)).toBeUndefined()
  f.tokens[8].rect[2] = 375
  expect(recoverNativeSegmentedStubRecords(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  const g = input()
  g.tokens.at(-1)!.baseline -= 15
  expect(recoverNativeSegmentedStubRecords(g.table, g.tokens, g.captions, g.rules)).toBeUndefined()
})
