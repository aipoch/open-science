import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeOrdinalWrappedRecordGrid } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-bounded-text-record-grid.mjs')
  ).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-ordinal-wrapped-records.jsonl'
    )
  )
it('repairs native tail ownership even when the model already has the correct row count', () => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(5)
  expect(r.grid[2][1]).toContain('Native name tail')
  expect(r.grid[2][2]).toContain('Native value tail')
  expect(r.grid[3][1]).not.toContain('tail')
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((r: number[]) => JSON.stringify(r))
      .sort()
  ).toEqual(x.tokens.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})
it.each([
  'caption',
  'closing',
  'competing rule',
  'different leading',
  'nonconsecutive anchors',
  'missing value',
  'gutter crossing',
  'foreign source',
  'foreign font',
  'new stub tail'
])('retains existing output without complete ordinal/tail proof: %s', (variant) => {
  const x = fixture()
  if (variant === 'caption') x.captions = []
  if (variant === 'closing') x.rules.pop()
  if (variant === 'competing rule') x.rules.push([10, 140, 330, 140])
  if (variant === 'different leading')
    x.tokens.find((i: { text: string }) => i.text === 'Native name tail').baseline += 3
  if (variant === 'nonconsecutive anchors')
    x.tokens.find((i: { text: string }) => i.text === '2').text = '7'
  if (variant === 'missing value')
    x.tokens = x.tokens.filter((i: { text: string }) => i.text !== 'Literal B')
  if (variant === 'gutter crossing')
    x.tokens.find((i: { text: string }) => i.text === 'Native name tail').rect[2] = 190
  if (variant === 'foreign source')
    x.tokens.push({
      text: 'Foreign',
      rect: [5, 70, 25, 80],
      height: 10,
      baseline: 80,
      horizontal: true
    })
  if (variant === 'foreign font')
    x.tokens.find((i: { text: string }) => i.text === 'Native value tail').height = 12
  if (variant === 'new stub tail')
    x.tokens.push({ text: '4', rect: [20, 68, 26, 78], height: 10, baseline: 78, horizontal: true })
  expect(
    recoverNativeOrdinalWrappedRecordGrid(x.table, x.tokens, x.captions, x.rules)
  ).toBeUndefined()
})
