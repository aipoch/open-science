import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { removeEmptyOverlappingRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/empty-overlap-across-ruled-sections.jsonl'
    )
  )

it('removes phantom model rows across shared native section borders', () => {
  const x = fixture()
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(49)
  expect(r.grid.every((row: string[]) => row.some(Boolean))).toBe(true)
  expect(r.unassigned).toEqual([])
  expect(r.repairs.filter((r: string) => r === 'empty-overlapping-row-removed')).toHaveLength(5)
  expect(r.grid[22].slice(1)).toEqual(['66 (75.9)', '61 (70.9)', '.46'])
  expect(r.grid[24].slice(1)).toEqual(['', '', '.15'])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    x.tokens.map((t: { rect: number[] }) => t.rect).sort()
  )
})

it('retains every source token and surviving cell span when removing the ruled overlap', () => {
  const x = fixture().seam
  const source = x.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
  removeEmptyOverlappingRows(x)
  expect(x.rows).toHaveLength(2)
  expect(x.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects)).toEqual(source)
  expect(x.cells.find((c: { colSpan: number }) => c.colSpan === 3)).toMatchObject({
    row: 1,
    rowSpan: 1
  })
})

it.each([
  'missing-enclosure',
  'partial-enclosure',
  'extra-border',
  'unowned-token',
  'vertical-span'
])('preserves a ruled blank band with %s', (variant) => {
  const x = fixture().seam
  if (variant === 'missing-enclosure') x.rules = x.rules.filter((r: number[]) => r[1] > 434)
  if (variant === 'partial-enclosure')
    x.rules = x.rules.filter((r: number[]) => r[1] > 434 || r[0] > 56)
  if (variant === 'extra-border') x.rules.push([55.446, 448, 822.077, 448])
  if (variant === 'unowned-token')
    x.items.push({
      text: '*',
      rect: [200, 449, 204, 454],
      height: 5,
      baseline: 454,
      horizontal: true
    })
  if (variant === 'vertical-span') x.cells[0].rowSpan = 2
  const before = structuredClone(x)
  removeEmptyOverlappingRows(x)
  expect(x).toEqual(before)
})
