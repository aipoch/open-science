import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { recoverNativeCoefficientRecordGrid } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-coefficient-record-grid.mjs')
  ).href
)
const { refineTable } = await import(
  pathToFileURL(
    resolve(
      process.env.PDF_COEFFICIENT_REFINE_MODULE ??
        'resources/pdf-structure/literature-pdf-table-refine.mjs'
    )
  ).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-uniform-five-value-records-with-raised-stars.jsonl'
    )
  )
const recover = (x: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  recoverNativeCoefficientRecordGrid(x.table, x.items, x.captions, x.rules)
it('restores measured records and suffix markers through the actual refiner', () => {
  const x = fixture(),
    result = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(result.grid).toHaveLength(10)
  expect(result.grid[6]).toEqual(['Panel B', '', '', '', '', ''])
  expect(result.grid[7]).toEqual(['Metric 5', '0.75**', '0.82', '0.89', '0.96', '0.16***'])
  expect(result.grid[8]).toEqual(['Metric 6', '0.88', '0.95', '0.15***', '0.22', '0.29'])
  expect(result.unassigned).toEqual([])
  expect(
    result.cells.flatMap((c: { sourceRects?: number[][] }) => c.sourceRects ?? [])
  ).toHaveLength(x.items.length)
})
it('proves each original source token once without changing crop or native glyphs', () => {
  const x = fixture(),
    before = JSON.stringify(x.items),
    p = recover(x)
  expect(p?.rows).toHaveLength(10)
  expect(p?.columns).toHaveLength(6)
  expect(p?.ownedTokens.size).toBe(x.items.length)
  expect(p?.scriptAnchors.size).toBe(3)
  expect(p?.cropRect).toEqual(x.table.cropRect)
  expect(p?.spans).toContainEqual({ row: 0, column: 2, rowSpan: 1, colSpan: 4 })
  expect(JSON.stringify(x.items)).toBe(before)
})
it.each([
  'no caption',
  'missing closing',
  'competing closing',
  'missing parent rule',
  'intervening rule',
  'missing numeric lane',
  'irregular baseline',
  'numeric wrapped tail',
  'different marker font',
  'nonadjacent marker',
  'ordinary body paragraph',
  'unindented measured stub',
  'unclosed full frame'
])('rejects similar input with %s', (variant) => {
  const x = fixture()
  if (variant === 'no caption') x.captions = []
  if (variant === 'missing closing') x.rules.pop()
  if (variant === 'competing closing') x.rules.push([20, 199, 590, 199])
  if (variant === 'missing parent rule') x.rules.splice(3, 1)
  if (variant === 'intervening rule') x.rules.push([20, 145, 590, 145])
  if (variant === 'missing numeric lane')
    x.items.splice(
      x.items.findIndex(
        (i: { text: string; baseline: number }) => i.text === '0.82' && i.baseline === 158
      ),
      1
    )
  if (variant === 'irregular baseline')
    for (const i of x.items.filter((i: { baseline: number }) => i.baseline === 174)) {
      i.baseline += 2
      i.rect[1] += 2
      i.rect[3] += 2
    }
  if (variant === 'numeric wrapped tail')
    x.items.find((i: { text: string }) => i.text === '0.82').text = '(0.82)'
  if (variant === 'different marker font')
    x.items.find((i: { text: string }) => i.text === '**').height = 4
  if (variant === 'nonadjacent marker') {
    const i = x.items.find((i: { text: string }) => i.text === '**')
    i.rect[0] += 5
    i.rect[2] += 5
  }
  if (variant === 'ordinary body paragraph')
    x.items.push({
      text: 'Unrelated independent prose.',
      rect: [22, 132, 470, 144],
      baseline: 144,
      height: 12,
      horizontal: true
    })
  if (variant === 'unindented measured stub') {
    const i = x.items.find((i: { text: string }) => i.text === 'Metric 5')
    i.rect[0] -= 12
    i.rect[2] -= 12
  }
  if (variant === 'unclosed full frame') x.rules.at(-1)[2] -= 20
  expect(recover(x)).toBeUndefined()
})
