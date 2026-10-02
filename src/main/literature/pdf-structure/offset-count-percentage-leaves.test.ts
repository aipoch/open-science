import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { recoverNativeHeaderGrid } = await import(
  pathToFileURL(
    resolve(
      process.env.PDF_HEADER_REPLAY_MODULE ??
        'resources/pdf-structure/literature-pdf-native-header-grid.mjs'
    )
  ).href
)
const { refineTable } = await import(
  pathToFileURL(
    resolve(
      process.env.PDF_HEADER_REFINE_REPLAY_MODULE ??
        'resources/pdf-structure/literature-pdf-table-refine.mjs'
    )
  ).href
)
const fixture = (): ReturnType<typeof JSON.parse> => {
  const tokens: Record<string, unknown>[] = []
  const token = (text: string, x: number, y: number, width: number): void => {
    tokens.push({
      text,
      rect: [x, y, x + width, y + 8],
      baseline: y + 8,
      height: 8,
      horizontal: true
    })
  }
  token('Compared sets', 120, 26, 74)
  token('Set A', 120, 41, 32)
  token('Set B', 260, 41, 32)
  token('N', 120, 56, 6)
  token('%', 234, 56, 7)
  token('N', 260, 56, 6)
  token('%', 382, 56, 7)
  token('Phase A', 30, 76, 40)
  token('Phase B', 30, 126, 40)
  for (const [label, y, values] of [
    ['Item A', 90, ['24', '42', '29', '46']],
    ['Item B', 108, ['33', '58', '34', '54']],
    ['Item C', 140, ['36', '63', '38', '60']],
    ['Item D', 158, ['21', '37', '25', '40']],
    ['All items', 176, ['57', '100', '63', '100']]
  ] as const) {
    token(label, 34, y, 48)
    values.forEach((value, c) => token(value, [128, 180, 268, 320][c], y, value.length * 5))
    if (label === 'Item A') token('(AX < 8)', 34, y + 9, 47)
  }
  const cuts = [20, 120, 175, 220, 260, 310, 400]
  const ys = [20, 38, 54, 70, 88, 107, 124, 138, 156, 174, 190]
  return {
    table: {
      id: 'anonymous-count-table',
      cropRect: [20, 20, 400, 194],
      structure: {
        objects: [
          ...cuts.slice(1).map((x, c) => ({
            label: 'table column',
            score: 0.99,
            rect: [cuts[c] - 20, 0, x - 20, 174]
          })),
          ...ys.slice(1).map((y, r) => ({
            label: 'table row',
            score: 0.99,
            rect: [0, ys[r] - 20, 380, y - 20]
          }))
        ]
      }
    },
    tokens,
    captions: [{ lines: ['Table 1 Compared sets'], rect: [20, 0, 170, 10] }],
    rules: [
      [30, 22, 390, 22],
      [120, 38, 390, 38],
      [120, 54, 242, 54],
      [260, 54.3, 390, 54.3],
      [30, 70, 390, 70],
      [30, 190, 390, 190]
    ]
  }
}
const recover = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  recoverNativeHeaderGrid(f.table, f.tokens, f.captions, f.rules)

it('recovers offset N/% labels from native cohort underlines and repeated body columns', () => {
  const f = fixture(),
    r = recover(f)
  expect(r?.columns).toHaveLength(5)
  expect(r.headerRows).toEqual([0, 1, 2])
  expect(r.spans).toContainEqual({ row: 0, column: 1, rowSpan: 1, colSpan: 4 })
  for (const column of [1, 3])
    expect(r.spans).toContainEqual({ row: 1, column, rowSpan: 1, colSpan: 2 })
  expect(r.ownedTokens.size).toBe(f.tokens.length)
})

it('applies five columns through refinement while retaining all native cells and wrapped labels', () => {
  const f = fixture(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[2]).toEqual(['', 'N', '%', 'N', '%'])
  expect(r.grid[4]).toEqual(['Item A (AX < 8)', '24', '42', '29', '46'])
  expect(r.grid.at(-1)).toEqual(['All items', '57', '100', '63', '100'])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    f.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
})

it.each([
  'no closing',
  'no group underline',
  'missing leaf',
  'shifted body',
  'foreign text',
  'one record',
  'outside group'
])('rejects %s without complete native ownership', (reason) => {
  const f = fixture()
  if (reason === 'no closing') f.rules = f.rules.filter((r: number[]) => r[1] !== 190)
  if (reason === 'no group underline') f.rules = f.rules.filter((r: number[]) => r[1] !== 54.3)
  if (reason === 'missing leaf')
    f.tokens = f.tokens.filter(
      (t: { text: string; rect: number[] }) => !(t.text === '%' && t.rect[0] === 382)
    )
  if (reason === 'shifted body')
    f.tokens.find((t: { text: string }) => t.text === '46').rect = [360, 90, 370, 98]
  if (reason === 'foreign text')
    f.tokens.push({
      text: 'Unrelated prose',
      rect: [150, 100, 240, 108],
      baseline: 108,
      height: 8,
      horizontal: true
    })
  if (reason === 'one record')
    f.tokens = f.tokens.filter((t: { rect: number[] }) => t.rect[1] < 100)
  if (reason === 'outside group')
    f.tokens.find((t: { text: string }) => t.text === 'Set B').rect = [250, 42, 292, 50]
  expect(recover(f)).toBeUndefined()
})
