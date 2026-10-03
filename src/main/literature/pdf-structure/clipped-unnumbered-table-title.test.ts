import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Token = { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean }
const token = (text: string, x: number, y: number, w: number): Token => ({
  text,
  rect: [x, y, x + w, y + 10],
  height: 10,
  baseline: y + 10,
  horizontal: true
})
const input = (): ReturnType<typeof JSON.parse> => ({
  table: {
    id: 'page-3-table-1',
    cropRect: [35, 70, 465, 195],
    structure: {
      objects: [
        ...[
          [0, 195],
          [200, 430]
        ].map(([a, b]) => ({ label: 'table column', score: 0.9, rect: [a, 9, b, 120] })),
        ...[
          [9, 24],
          [26, 42],
          [44, 64],
          [66, 86],
          [88, 110]
        ].map(([a, b]) => ({ label: 'table row', score: 0.9, rect: [0, a, 430, b] }))
      ]
    }
  },
  tokens: [
    token('Synthetic comparison heading', 100, 65, 300),
    token('Present argument', 40, 79, 110),
    token('Corresponding ingredient', 270, 79, 165),
    ...[100, 120, 140, 160].flatMap((y, n) => [
      token(`Statement ${n}`, 40, y, 150),
      token(`Matched proof ${n}`, 270, y, 165)
    ])
  ],
  rules: [
    [40, 80, 460, 80],
    [40, 95, 460, 95],
    [40, 185, 460, 185]
  ]
})
it('retains the whole unnumbered title above the intact table frame', () => {
  const f = input(),
    r = refineTable(f.table, f.tokens, [], [], f.rules)
  expect(r.cropRect[1]).toBeLessThanOrEqual(65)
  expect(r.cropRect[1]).toBeGreaterThanOrEqual(64)
  expect(r.grid.flat()).toContain('Present argument')
  expect(r.grid.flat()).not.toContain('Synthetic comparison heading')
})

it('does not extend the crop to an off-center prose line or an unframed comparison', async () => {
  const { recoverClippedUnnumberedTitleCrop } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
  )
  const f = input()
  expect(recoverClippedUnnumberedTitleCrop(f.table, f.tokens, f.rules.slice(0, 2))).toBeUndefined()
  f.tokens[0] = token('Ordinary prose before table', 35, 65, 300)
  expect(recoverClippedUnnumberedTitleCrop(f.table, f.tokens, f.rules)).toBeUndefined()
})
