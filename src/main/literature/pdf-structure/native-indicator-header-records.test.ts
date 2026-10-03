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
const input = (): ReturnType<typeof JSON.parse> => {
  const heading = token('State Search Train', 230, 80, 225)
  return {
    table: {
      id: 'page-3-table-1',
      cropRect: [35, 70, 465, 190],
      structure: {
        objects: [
          ...[
            [0, 185],
            [187, 235],
            [240, 300],
            [305, 430]
          ].map(([a, b]) => ({ label: 'table column', score: 0.9, rect: [a, 10, b, 115] })),
          ...[
            [10, 22],
            [40, 53],
            [55, 68],
            [70, 83],
            [85, 110]
          ].map(([a, b]) => ({ label: 'table row', score: 0.9, rect: [0, a, 430, b] })),
          { label: 'table spanning cell', score: 0.9, rect: [187, 10, 430, 22] }
        ]
      }
    },
    tokens: [
      token('Method', 40, 80, 45),
      heading,
      token('rollback', 320, 94, 45),
      ...[112, 130, 148, 166].flatMap((y, n) => [
        token(`Synthetic method ${n}`, 40, y, 175),
        token('✓', [240, 330, 430, 240][n], y, 10)
      ])
    ],
    rules: [
      [40, 75, 460, 75],
      [40, 107, 460, 107],
      [40, 185, 460, 185]
    ],
    captions: [{ lines: ['Table 1: Synthetic indicator matrix.'], rect: [35, 45, 465, 60] }],
    observed: [
      {
        text: heading.text,
        rect: heading.rect,
        glyphRuns: Array(16).fill(1),
        gaps: [
          { index: 5, left: 265, right: 320 },
          { index: 11, left: 360, right: 420 }
        ]
      }
    ]
  }
}
it('splits native measured leaf headings and includes every independently printed indicator record', () => {
  const f = input(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.observed)
  expect(r.grid[0]).toEqual(['Method', 'State', 'Search rollback', 'Train'])
  expect(r.grid).toHaveLength(5)
  expect(r.unassigned).toEqual([])
})

it('requires independent native measured headings and indicator-only records', async () => {
  const { recoverNativeIndicatorRecordPlan } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-complete-record-grid.mjs'))
      .href
  )
  const f = input()
  expect(
    recoverNativeIndicatorRecordPlan(f.table, f.tokens, f.captions, f.rules, [])
  ).toBeUndefined()
  expect(
    recoverNativeIndicatorRecordPlan(
      f.table,
      [...f.tokens, token('Independent prose', 230, 130, 150)],
      f.captions,
      f.rules,
      f.observed
    )
  ).toBeUndefined()
})
