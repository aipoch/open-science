import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { repairWrappedTableRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
type Fixture = {
  rows: { rect: number[] }[]
  items: { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }[]
  columnRects: number[][]
  rules: number[][]
  right: number
  repairs: string[]
  groups: never[]
  captioned: boolean
  headers: never[]
}
function fixture(): Fixture {
  const columnRects = Array.from({ length: 9 }, (_, c) => [c * 100, 0, (c + 1) * 100, 120])
  const items = [] as {
      text: string
      rect: number[]
      baseline: number
      height: number
      horizontal: boolean
    }[],
    rows = [{ rect: [0, 0, 900, 15] }] as { rect: number[] }[]
  const add = (text: string, c: number, y: number): number =>
    items.push({
      text,
      rect: [c * 100 + 5, y, c * 100 + 90, y + 10],
      baseline: y + 10,
      height: 10,
      horizontal: true
    })
  add('P Value', 4, 0)
  add('P Value', 8, 0)
  for (let n = 0; n < 3; n++) {
    const y = 20 + n * 30
    add(`Group ${n + 1}`, 0, y)
    for (const [c, v] of [
      [1, '10 (50.0)'],
      [2, '4 (40.0)'],
      [3, '6 (60.0)'],
      [4, '…'],
      [5, '12 (60.0)'],
      [6, '5 (50.0)'],
      [7, '7 (70.0)'],
      [8, '…']
    ] as const)
      add(v, c, y)
    rows.push({ rect: [0, y, 900, y + 12] })
    for (const c of [2, 3, 6, 7]) add('[20.0, 70.0]', c, y + 15)
    if (n > 0) add('continued label', 0, y + 15)
    rows.push({ rect: [0, y + 13, 900, y + 27] })
  }
  return {
    rows,
    items,
    columnRects,
    rules: [] as number[][],
    right: 900,
    repairs: [] as string[],
    groups: [],
    captioned: true,
    headers: []
  }
}
it('owns a counted cohort record and its interval-only continuation even before a sparse record', () => {
  const f = fixture()
  repairWrappedTableRows(f)
  expect(f.rows).toHaveLength(4)
  expect(f.rows[3].rect[3]).toBeGreaterThanOrEqual(105)
})

it.each(['additive counts', 'P leaf roles', 'interval-only tail', 'native separation'])(
  'does not join interval tails without %s',
  (kind) => {
    const f = fixture()
    if (kind === 'additive counts')
      for (const i of f.items.filter((i) => i.text === '10 (50.0)')) i.text = '11 (50.0)'
    if (kind === 'P leaf roles') f.items.find((i) => i.text === 'P Value')!.text = 'Value'
    if (kind === 'interval-only tail')
      for (const i of f.items.filter((i) => i.text === '[20.0, 70.0]')) i.text = 'New category'
    if (kind === 'native separation')
      f.rules = [0, 1, 2].map((n) => [0, 33 + n * 30, 900, 33 + n * 30])
    repairWrappedTableRows(f)
    expect(f.repairs.filter((s) => s === 'wrapped-interval-record-recovered')).toEqual([])
  }
)
