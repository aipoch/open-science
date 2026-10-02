import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeSharedPairRecordGrid } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-shared-pair-record-grid.mjs')
  ).href
)
type Source = { text: string; rect: number[]; baseline: number; height: number }
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-repeated-complete-record-pairs.jsonl'
    )
  )
it('recovers independent paired records and only explicitly shared native source lanes', () => {
  const f = fixture(),
    r = refineTable(f.table, f.items, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(9)
  expect(r.grid[0]).toHaveLength(9)
  expect(r.cells.filter((c: { rowSpan: number }) => c.rowSpan === 2)).toHaveLength(12)
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(f.items.map((i: Source) => JSON.stringify(i.rect)).sort())
})
it.each([
  'one pair',
  'missing shared field',
  'missing varying record',
  'ambiguous script',
  'independent baseline',
  'non-numeric parameter',
  'missing divider',
  'broken vertical',
  'different native endpoints',
  'caption',
  'crossing source',
  'crossing opening from outside',
  'crossing closing from outside'
])('does not invent shared scopes from missing proof: %s', (variant) => {
  const f = fixture()
  if (variant === 'one pair') f.items = f.items.filter((i: Source) => i.baseline < 160)
  if (variant === 'missing shared field')
    f.items.splice(
      f.items.findIndex((i: Source) => i.baseline === 135 && i.rect[0] === 115),
      1
    )
  if (variant === 'missing varying record')
    f.items = f.items.filter((i: Source) => !(i.baseline === 125 && i.rect[0] === 245))
  if (variant === 'ambiguous script') f.items.find((i: Source) => i.height === 7).baseline = 55
  if (variant === 'independent baseline')
    f.items.find((i: Source) => i.text === 'Set Alpha').baseline = 125
  if (variant === 'non-numeric parameter')
    f.items.find((i: Source) => i.rect[0] === 245 && i.height === 10 && i.baseline === 125).text =
      'Other'
  if (variant === 'missing divider') f.rules = f.rules.filter((r: number[]) => r[1] !== 30)
  if (variant === 'broken vertical')
    f.rules = f.rules.filter((r: number[]) => !(r[0] === r[2] && r[0] === 110 && r[3] === 90))
  if (variant === 'different native endpoints')
    f.rules.find((r: number[]) => r[1] === 190 && r[0] !== r[2])[2] += 3
  if (variant === 'caption') f.captions = []
  if (variant === 'crossing source')
    f.items.find((i: Source) => i.text === 'Set Alpha').rect[2] = 150
  if (variant === 'crossing opening from outside')
    f.items.push({
      text: 'Foreign',
      rect: [20, 6, 55, 11],
      height: 5,
      baseline: 9,
      horizontal: true
    })
  if (variant === 'crossing closing from outside')
    f.items.push({
      text: 'Foreign',
      rect: [20, 187, 55, 198],
      height: 11,
      baseline: 198,
      horizontal: true
    })
  expect(recoverNativeSharedPairRecordGrid(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})
