import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { recoverSmallCompleteRecordGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-complete-record-grid.mjs'))
    .href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Token = { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-three-complete-records-with-nine-leaves.jsonl'
    )
  )
it('recovers exactly three complete native records and retains source stack order', () => {
  const x = fixture(),
    p = recoverSmallCompleteRecordGrid(x.table, x.items, x.captions, x.rules),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(p.rows).toHaveLength(4)
  expect(p.columns).toHaveLength(9)
  expect(p.ownedTokens.size).toBe(x.items.length)
  expect(r.grid).toHaveLength(4)
  expect(r.grid.some((row: string[]) => row.every((t) => !t.trim()))).toBe(false)
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    x.items.map((i: Token) => i.rect).sort()
  )
  expect(r.unassigned).toEqual([])
  expect(r.clipped).toEqual([])
})
it.each([
  'missing record',
  'missing leaf',
  'missing closing',
  'unequal leading',
  'overlapping records',
  'foreign edge ink',
  'missing title'
])('declines an incomplete native record proof: %s', (variant) => {
  const x = fixture(),
    crop = x.table.cropRect,
    ids = x.items
      .filter((i: Token) => /^\d{6,20}$/.test(i.text))
      .sort((a: Token, b: Token) => a.baseline - b.baseline)
  if (variant === 'missing record') x.items = x.items.filter((i: Token) => i !== ids[1])
  if (variant === 'missing leaf')
    x.table.structure.objects.splice(
      x.table.structure.objects.findIndex((o: { label: string }) => o.label === 'table column'),
      1
    )
  if (variant === 'missing closing') x.rules.pop()
  if (variant === 'unequal leading') ids[2].baseline += ids[2].height * 0.1
  if (variant === 'overlapping records') ids[2].baseline = ids[1].baseline + ids[1].height * 0.5
  if (variant === 'foreign edge ink')
    x.items.push({
      text: 'Outside prose',
      horizontal: true,
      height: 10,
      baseline: crop[1] + 50,
      rect: [crop[0] - 10, crop[1] + 40, crop[0] + 20, crop[1] + 50]
    })
  if (variant === 'missing title') x.captions = []
  expect(recoverSmallCompleteRecordGrid(x.table, x.items, x.captions, x.rules)).toBeUndefined()
})
