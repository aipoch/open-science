import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverCompleteNativeLeafRecords } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-complete-record-grid.mjs')).href
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

const formattedHeaderInput = (): ReturnType<typeof JSON.parse> => {
  const tuples: (string | number)[][] = [
    ['Values', -7.311, 5.315, 31.911, 15.277, 9.963, 15.277],
    ['𝜂', 44.136, 5.315, 48.459, 15.277, 9.963, 15.277],
    ['4', 48.758, 9.256, 52.543, 16.827, 7.572, 16.827],
    ['(', 53.54, 5.315, 56.857, 15.277, 9.963, 15.277],
    ['𝜁', 57.804, 5.315, 62.865, 15.277, 9.963, 15.277],
    [')', 63.074, 5.315, 66.391, 15.277, 9.963, 15.277],
    [', for', 66.89, 5.315, 83.188, 15.277, 9.963, 15.277],
    ['𝜃', 85.749, 5.315, 91.657, 15.277, 9.963, 15.277],
    ['≤', 94.665, 5.315, 101.001, 15.277, 9.963, 15.277],
    ['𝜁 <', 104.319, 5.315, 118.685, 15.277, 9.963, 15.277],
    ['4', 121.455, 5.315, 126.436, 15.277, 9.963, 15.277],
    ['Bound', 148.234, 5.315, 169.435, 15.277, 9.963, 15.277],
    ['< 𝜁', 249.436, 5.315, 264.15, 15.277, 9.963, 15.277],
    ['Bound', 286.158, 5.315, 307.358, 15.277, 9.963, 15.277],
    ['3', 9.809, 23.494, 14.79, 33.456, 9.963, 33.456],
    ['3', 43.871, 23.494, 48.852, 33.456, 9.963, 33.456],
    ['3', 143.377, 23.494, 148.359, 33.456, 9.963, 33.456],
    ['3', 181.395, 23.494, 186.376, 33.456, 9.963, 33.456],
    ['4', 281.299, 23.494, 286.281, 33.456, 9.963, 33.456],
    ['4', 9.809, 35.947, 14.79, 45.909, 9.963, 45.909],
    ['3', 43.871, 35.947, 48.852, 45.909, 9.963, 45.909],
    ['53%', 151.178, 35.947, 169.439, 45.909, 9.963, 45.909],
    ['3', 181.395, 35.947, 186.376, 45.909, 9.963, 45.909],
    ['44%', 289.1, 35.947, 307.362, 45.909, 9.963, 45.909],
    ['5', 9.809, 48.4, 14.79, 58.362, 9.963, 58.362],
    ['.', 49.011, 48.4, 51.502, 58.362, 9.963, 58.362],
    ['365%', 146.193, 48.4, 169.436, 58.362, 9.963, 58.362],
    ['.', 186.532, 48.4, 189.023, 58.362, 9.963, 58.362],
    ['346%', 284.116, 48.4, 307.358, 58.362, 9.963, 58.362]
  ]
  return {
    table: {
      id: 'table',
      cropRect: [-13.333, 1.333, 315.333, 69.333],
      structure: {
        objects: [
          { label: 'table column', score: 0.9, rect: [136.593, 22.656, 188.493, 58.048] },
          { label: 'table row', score: 0.9, rect: [22.873, 34.35, 318.794, 46.877] },
          { label: 'table column', score: 0.9, rect: [22.639, 22.442, 48.771, 58.024] },
          { label: 'table row', score: 0.9, rect: [22.554, 22.599, 318.992, 34.211] },
          { label: 'table column', score: 0.9, rect: [188.555, 22.652, 262.9, 58.052] },
          { label: 'table column', score: 0.9, rect: [265.457, 22.897, 318.7, 57.552] },
          { label: 'table row', score: 0.9, rect: [22.497, 46.532, 318.789, 58.001] },
          { label: 'table column', score: 0.9, rect: [48.277, 22.954, 134.967, 57.961] }
        ]
      }
    },
    tokens: tuples.map(([text, ...v], index) => ({
      text,
      rect: v.slice(0, 4),
      height: v[4],
      baseline: v[5],
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text }
    })),
    captions: [
      { page: 1, lines: ['Table 1: Generated scalar records.'], rect: [50, -35, 100, -25] }
    ],
    rules: [
      [-7.311, 2.916, 307.36, 2.916],
      [-7.311, 21.259, 307.36, 21.259],
      [-7.311, 64.509, 307.36, 64.509]
    ]
  }
}

it.each([0, 0.8])(
  'keeps proved native leaf header spacing consistent with its script runs (gap +%s)',
  (extra) => {
    const f = formattedHeaderInput()
    if (extra)
      for (const item of f.tokens.slice(3, 11)) {
        item.rect[0] += extra
        item.rect[2] += extra
      }
    const originalSources = structuredClone(
      f.tokens.map((item: { sourceItem: object }) => item.sourceItem)
    )
    const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(r.repairs).toContain('native-closed-leaf-complete-records-recovered')
    const cell = r.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1)
    expect(cell.text).toBe(extra ? '𝜂4 (𝜁), for 𝜃 ≤ 𝜁 < 4' : '𝜂4(𝜁), for 𝜃 ≤ 𝜁 < 4')
    expect(cell.textRuns.map((run: { text: string }) => run.text).join('')).toBe(cell.text)
    expect(cell.textRuns.find((run: { position: string }) => run.position === 'subscript')).toEqual(
      { text: '4', position: 'subscript' }
    )
    expect(f.tokens.map((item: { sourceItem: object }) => item.sourceItem)).toEqual(originalSources)
  }
)
