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
    id: 'page-7-table-1',
    cropRect: [35, 70, 555, 300],
    structure: {
      objects: [
        ...[
          [0, 110],
          [112, 210],
          [215, 315],
          [320, 520]
        ].map(([a, b]) => ({ label: 'table column', score: 0.9, rect: [a, 10, b, 225] })),
        ...[
          [10, 22],
          [24, 38],
          [50, 95],
          [100, 150],
          [155, 200],
          [202, 225]
        ].map(([a, b]) => ({ label: 'table row', score: 0.9, rect: [0, a, 520, b] }))
      ]
    }
  },
  tokens: [
    token('Published result', 40, 80, 100),
    token('Dominant', 260, 80, 65),
    token('component', 335, 80, 60),
    token('interpretation', 420, 80, 120),
    token('continued', 260, 95, 65),
    ...[115, 175, 235].flatMap((y, n) => [
      token(`Synthetic result ${n}`, 40, y, 200),
      token('Summary', 260, y, 130),
      token('Interpretation of evidence', 420, y, 130),
      token('continues with evidence', 40, y + 15, 200),
      token('continuation', 260, y + 15, 90),
      token('and its documented limits', 420, y + 15, 130),
      token('with final details', 40, y + 30, 200),
      token('remain attached to this record.', 420, y + 30, 130),
      token('final qualification.', 420, y + 45, 110)
    ])
  ],
  captions: [{ lines: ['Table 1: Synthetic prose records.'], rect: [35, 45, 555, 60] }],
  rules: [
    [40, 75, 550, 75],
    [40, 110, 550, 110],
    [40, 298, 550, 298]
  ]
})
it('recovers complete prose lanes and keeps long tails under native paragraph starts', () => {
  const f = input(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(4)
  expect(r.grid[0]).toHaveLength(3)
  expect(r.grid[0][1]).toBe('Dominant component continued')
  expect(r.grid[3][2]).toContain('final qualification.')
  expect(r.unassigned).toEqual([])
})

it('declines a crossing lane or a missing closing frame', async () => {
  const { recoverNativeProseLaneRecords } = await import(
    pathToFileURL(
      resolve('resources/pdf-structure/literature-pdf-native-bounded-text-record-grid.mjs')
    ).href
  )
  const f = input()
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules.slice(0, 2))
  ).toBeUndefined()
  expect(
    recoverNativeProseLaneRecords(
      f.table,
      [...f.tokens, token('Crossing source field', 200, 130, 150)],
      f.captions,
      f.rules
    )
  ).toBeUndefined()
})
