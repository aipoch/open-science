import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativePairedRecordGrid, recoverNativeGroupedFlagRecordGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-complete-record-grid.mjs'))
    .href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/' + name + '.jsonl')
  )
it('retains the complete middle paired record through the actual refiner', () => {
  const x = fixture('native-five-lane-uniform-paired-records'),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(4)
  expect(r.grid[2]).toEqual([
    '2.1',
    '2.976 → 2.921',
    '3.535 → 3.519',
    '2.021 → 2.028',
    '2.037 → 2.035'
  ])
  expect(r.unassigned).toEqual([])
})
it.each(['paired', 'grouped'])(
  'proves unique native input ownership and preserves crop for %s records',
  (kind) => {
    const x = fixture(
        kind === 'paired'
          ? 'native-five-lane-uniform-paired-records'
          : 'native-grouped-flags-with-radical-font-overhang'
      ),
      before = JSON.stringify(x),
      fn = kind === 'paired' ? recoverNativePairedRecordGrid : recoverNativeGroupedFlagRecordGrid,
      p = fn(x.table, x.items, x.captions, x.rules)
    expect(p?.ownedTokens.size).toBe(x.items.length)
    expect(p?.cropRect).toEqual(x.table.cropRect)
    expect(JSON.stringify(x)).toBe(before)
    const r = refineTable(x.table, x.items, x.captions, [], x.rules),
      rects = r.cells.flatMap((c: { sourceRects?: number[][] }) => c.sourceRects ?? [])
    expect(rects.map((b: number[]) => JSON.stringify(b)).sort()).toEqual(
      x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort()
    )
  }
)
it.each(['paired', 'grouped'])(
  'declines %s records without a unique caption or full native closure',
  (kind) => {
    const name =
        kind === 'paired'
          ? 'native-five-lane-uniform-paired-records'
          : 'native-grouped-flags-with-radical-font-overhang',
      fn = kind === 'paired' ? recoverNativePairedRecordGrid : recoverNativeGroupedFlagRecordGrid
    for (const variant of ['caption', 'closing', 'competing', 'column', 'foreign']) {
      const x = fixture(name)
      if (variant === 'caption') x.captions = []
      if (variant === 'closing') x.rules.pop()
      if (variant === 'competing') x.rules.push([...x.rules.at(-1)])
      if (variant === 'column')
        x.table.structure.objects = x.table.structure.objects
          .filter((o: { label: string }) => o.label !== 'table column')
          .concat(
            x.table.structure.objects
              .filter((o: { label: string }) => o.label === 'table column')
              .slice(1)
          )
      if (variant === 'foreign')
        x.items.push({
          text: 'Unrelated prose',
          rect: [
            x.table.cropRect[0] + 2,
            x.table.cropRect[1] + 35,
            x.table.cropRect[2] - 2,
            x.table.cropRect[1] + 45
          ],
          baseline: x.table.cropRect[1] + 45,
          height: 10,
          horizontal: true
        })
      expect(fn(x.table, x.items, x.captions, x.rules), variant).toBeUndefined()
    }
  }
)
it.each(['missing flag', 'missing bar', 'nonunique bar', 'irregular leading', 'crossing stub'])(
  'declines incomplete grouped proof with %s',
  (variant) => {
    const x = fixture('native-grouped-flags-with-radical-font-overhang')
    if (variant === 'missing flag')
      x.items.splice(
        x.items.findIndex((i: { text: string }) => i.text === '✓'),
        1
      )
    if (variant === 'missing bar') x.rules.splice(2, 1)
    if (variant === 'nonunique bar') x.rules.push([...x.rules[2]])
    if (variant === 'irregular leading')
      x.items.find((i: { text: string }) => i.text === 'Method Y').baseline += 4
    if (variant === 'crossing stub')
      x.items.find((i: { text: string }) => i.text === 'Group B').rect[1] = 280
    expect(
      recoverNativeGroupedFlagRecordGrid(x.table, x.items, x.captions, x.rules)
    ).toBeUndefined()
  }
)
it('retains all six leaf records and the native two shared groups', () => {
  const x = fixture('native-grouped-flags-with-radical-font-overhang'),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(7)
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 0, rowSpan: 4, colSpan: 1 })
  )
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 5, column: 0, rowSpan: 2, colSpan: 1 })
  )
  expect(r.grid[4].slice(1, 4)).toEqual(['Method X', '✓', '✓'])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects?: number[][] }) => c.sourceRects ?? [])).toHaveLength(
    x.items.length
  )
})
