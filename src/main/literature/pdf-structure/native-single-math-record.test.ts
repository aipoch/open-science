import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeSingleMathRecordGrid } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-single-math-record-grid.mjs')
  ).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-single-math-record.jsonl'
    )
  )
it('keeps one complete interval field and two uniquely scripted scalar fields under three native headers', () => {
  const x = fixture(),
    g = recoverNativeSingleMathRecordGrid(x.table, x.tokens, x.captions, x.rules)
  expect(g?.columns).toHaveLength(3)
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(2)
  expect(r.grid[0]).toHaveLength(3)
  expect(r.grid[1][0]).toContain('x < V')
  expect(r.grid[1][1]).toBe('9+7−6')
  expect(r.grid[1][2]).toBe('2.64+0.28−0.19')
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((r: number[]) => JSON.stringify(r))
      .sort()
  ).toEqual(x.tokens.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})
it.each([
  'title',
  'competing title',
  'opening',
  'closing',
  'second body baseline',
  'missing sign',
  'detached script',
  'competing anchor',
  'foreign crossing',
  'nonfinite script',
  'ambiguous field'
])('rejects incomplete or ambiguous single mathematical records: %s', (variant) => {
  const x = fixture()
  if (variant === 'title') x.captions = []
  if (variant === 'competing title') x.captions.push({ ...x.captions[0] })
  if (variant === 'opening') x.rules.shift()
  if (variant === 'closing') x.rules.pop()
  if (variant === 'second body baseline')
    x.tokens.find((i: { text: string }) => i.text === '9').baseline += 3
  if (variant === 'missing sign')
    x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '+7')
  if (variant === 'detached script')
    x.tokens.find((i: { text: string }) => i.text === '+7').rect[0] += 2
  if (variant === 'competing anchor')
    x.tokens.push({ ...x.tokens.find((i: { text: string }) => i.text === '9') })
  if (variant === 'foreign crossing')
    x.tokens.push({
      text: 'Foreign',
      rect: [5, 40, 25, 50],
      height: 10,
      baseline: 50,
      horizontal: true
    })
  if (variant === 'nonfinite script')
    x.tokens.find((i: { text: string }) => i.text === '+7').baseline = NaN
  if (variant === 'ambiguous field')
    x.tokens.find((i: { text: string }) => i.text === '< y').rect[2] = 120
  expect(recoverNativeSingleMathRecordGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
