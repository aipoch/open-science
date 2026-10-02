import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativePairedParentRecordGrid } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-paired-parent-record-grid.mjs')
  ).href
)
type Source = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
}
type Fixture = {
  table: ReturnType<typeof JSON.parse>
  items: Source[]
  captions: ReturnType<typeof JSON.parse>[]
  rules: number[][]
}
function fixture(): Fixture {
  const items: Source[] = [],
    add = (text: string, x: number, y: number, width: number): void => {
      items.push({
        text,
        rect: [x, y - 10, x + width, y],
        baseline: y,
        height: 10,
        horizontal: true
      })
    }
  for (const offset of [0, 240]) {
    add(offset ? 'Panel Beta' : 'Panel Alpha', 94 + offset, 23, 101)
    add('(', 196 + offset, 23, 6)
    add('h', 202 + offset, 23, 8)
    add(offset ? '=2)' : '=1)', 214 + offset, 23, 28)
    for (let k = 0; k < 4; k++) {
      add('v', 80 + offset + k * 44, 36, 6)
      add(`=${k + 2}`, 89 + offset + k * 44, 36, 16)
    }
    add('Center', 10 + offset, 56, 35)
    add('Spread', 10 + offset, 100, 35)
    for (const [n, y] of [69, 82, 113, 126].entries()) {
      add(n % 2 ? 'Fit B' : 'Fit A', 10 + offset, y, 50)
      for (let k = 0; k < 4; k++) add(`0.${n + 2}${k + 2}`, 85 + offset + k * 44, y, 22)
    }
  }
  const crop = [0, 5, 485, 140],
    objects: ReturnType<typeof JSON.parse>[] = []
  const cuts = [0, 72, 128, 172, 216, 253, 312, 368, 412, 456, 485]
  for (let k = 0; k < 10; k++)
    objects.push({ label: 'table column', score: 0.99, rect: [cuts[k], 22, cuts[k + 1], 126] })
  for (const [n, y] of [42, 60, 75, 90, 106, 120, 135].entries())
    objects.push({
      label: 'table row',
      score: 0.99,
      rect: [0, n ? [42, 60, 75, 90, 106, 120][n - 1] : 22, 485, y]
    })
  objects.push({ label: 'table column header', score: 0.99, rect: [0, 22, 485, 42] })
  return {
    table: { id: 'anonymous-paired-parents', cropRect: crop, structure: { objects } },
    items,
    captions: [{ page: 1, lines: ['Table 1: Paired scalar summaries.'], rect: [0, -15, 485, -5] }],
    rules: [
      [0, 10, 485, 10],
      [0, 42, 485, 42]
    ]
  }
}
it('recovers two complete native parent bands without changing independent paired body records', () => {
  const f = fixture(),
    r = refineTable(f.table, f.items, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(8)
  expect(r.grid[0]).toHaveLength(10)
  expect(r.cells.filter((c: { colSpan: number }) => c.colSpan === 4)).toHaveLength(2)
  expect(r.unassigned).toEqual([])
  expect(
    r.grid.slice(2).filter((row: string[]) => row.slice(1, 5).every((s) => /^0\.\d+$/.test(s)))
  ).toHaveLength(4)
  expect(
    r.cells.filter((c: { row: number; colSpan: number }) => c.row > 1 && c.colSpan > 1)
  ).toEqual([])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((r: number[]) => JSON.stringify(r))
      .sort()
  ).toEqual(f.items.map((i) => JSON.stringify(i.rect)).sort())
})
it.each([
  'missing value',
  'one measured pair',
  'different leaf',
  'parent crosses stub',
  'short parent',
  'missing opening',
  'different rule endpoints',
  'foreign opening',
  'foreign tail',
  'foreign divider',
  'different baseline',
  'nonfinite source',
  'source overlap',
  'missing caption'
])('rejects insufficient or conflicting native proof: %s', (variant) => {
  const f = fixture()
  if (variant === 'missing value')
    f.items.splice(
      f.items.findIndex((i) => i.text === '0.22'),
      1
    )
  if (variant === 'one measured pair') f.items = f.items.filter((i) => i.baseline < 100)
  if (variant === 'different leaf')
    f.items.find((i) => i.text === '=5' && i.rect[0] > 400)!.text = '=7'
  if (variant === 'parent crosses stub') f.items.find((i) => i.text === 'Panel Alpha')!.rect[0] = 40
  if (variant === 'short parent')
    f.items = f.items.filter(
      (i) => i.baseline !== 23 || i.rect[0] > 240 || i.text === 'Panel Alpha'
    )
  if (variant === 'missing opening') f.rules.shift()
  if (variant === 'different rule endpoints') f.rules[1][2] -= 2
  if (variant === 'foreign opening')
    f.items.push({
      text: 'Foreign',
      rect: [150, 8, 180, 15],
      baseline: 9,
      height: 7,
      horizontal: true
    })
  if (variant === 'foreign tail')
    f.items.push({
      text: 'Foreign',
      rect: [150, 125, 180, 136],
      baseline: 136,
      height: 11,
      horizontal: true
    })
  if (variant === 'foreign divider')
    f.items.push({
      text: 'Foreign',
      rect: [150, 40, 180, 47],
      baseline: 47,
      height: 7,
      horizontal: true
    })
  if (variant === 'different baseline') f.items.find((i) => i.text === '0.22')!.baseline += 3
  if (variant === 'nonfinite source') f.items[0].rect[0] = NaN
  if (variant === 'source overlap') f.items.find((i) => i.text === '0.22')!.rect[2] = 145
  if (variant === 'missing caption') f.captions = []
  expect(recoverNativePairedParentRecordGrid(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})
