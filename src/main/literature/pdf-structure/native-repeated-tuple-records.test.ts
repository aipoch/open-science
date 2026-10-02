import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeRepeatedTuplePlan } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-repeated-tuple-grid.mjs'))
    .href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-repeated-tuple-cohorts-without-footer.jsonl'
    )
  )

it('restores every repeated tuple record without fabricating a closing stroke', () => {
  const x = fixture(),
    before = JSON.stringify(x),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(10)
  expect(r.grid[9].slice(1)).toEqual(['(4,4)', '(5.1,6.2)', '(5.1,6.2)', '(5.1,6.2)'])
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 2, rowSpan: 1, colSpan: 3, text: 'Combined values' })
  )
  for (const row of [2, 6])
    expect(r.cells).toContainEqual(
      expect.objectContaining({ row, column: 0, rowSpan: 4, colSpan: 1 })
    )
  expect(r.unassigned).toEqual([])
  expect(r.cropRect).toEqual(x.table.cropRect)
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((b: number[]) => JSON.stringify(b))
      .sort()
  ).toEqual(x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
  expect(JSON.stringify(x)).toBe(before)
})

it.each([
  'caption',
  'group divider',
  'missing record',
  'missing field',
  'changed sequence',
  'displaced label',
  'foreign text',
  'different font',
  'header crossing',
  'unequal sibling leaves'
])('declines incomplete repeated record proof: %s', (variant) => {
  const x = fixture()
  if (variant === 'caption') x.captions = []
  if (variant === 'group divider') x.rules.pop()
  if (variant === 'missing record')
    x.items = x.items.filter((i: { baseline: number }) => i.baseline !== 209)
  if (variant === 'missing field')
    x.items = x.items.filter(
      (i: { baseline: number; rect: number[] }) => !(i.baseline === 209 && i.rect[0] === 330)
    )
  if (variant === 'changed sequence')
    x.items.find(
      (i: { baseline: number; rect: number[] }) => i.baseline === 209 && i.rect[0] === 80
    ).text = '(9,9)'
  if (variant === 'displaced label')
    x.items.find((i: { text: string }) => i.text === 'Set B').rect = [8, 120, 51, 130]
  if (variant === 'foreign text')
    x.items.push({
      text: 'External paragraph',
      rect: [160, 141, 300, 151],
      height: 10,
      baseline: 151,
      horizontal: true
    })
  if (variant === 'different font')
    x.items.find(
      (i: { baseline: number; rect: number[] }) => i.baseline === 209 && i.rect[0] === 330
    ).height = 12
  if (variant === 'header crossing') x.items[0].rect = [8, 15, 400, 25]
  if (variant === 'unequal sibling leaves')
    x.items.find((i: { text: string }) => i.text === 'T = 2').text = 'Independent'
  expect(
    recoverNativeRepeatedTuplePlan(x.table, x.items, x.captions, x.rules),
    variant
  ).toBeUndefined()
})
