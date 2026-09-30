import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { removeEmptyOverlappingRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/displaced-empty-span-among-repeated-sections.jsonl'
    )
  )
it('moves a displaced empty model span back to its repeated section heading without losing source text', () => {
  const f = fixture(),
    before = structuredClone(f),
    repairs: string[] = []
  removeEmptyOverlappingRows({ ...f, repairs })
  expect(f.rows).toHaveLength(before.rows.length - 1)
  expect(f.cells.find((c: { text: string }) => c.text === 'Signal C (unit)')).toMatchObject({
    colSpan: 3,
    row: 6
  })
  expect(
    f.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(
    before.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  )
  expect(f.items).toEqual(before.items)
  expect(repairs).toEqual(['section-heading-span-reconciled', 'empty-overlapping-row-removed'])
})
it.each([
  'missing witnesses',
  'different child records',
  'independent value',
  'native rule',
  'blank spacer',
  'source row',
  'vertical span',
  'unowned text'
])('preserves a possible independent empty row with %s', (kind) => {
  const f = fixture(),
    empty = f.cells.find((c: { row: number }) => c.row === 7)
  if (kind === 'missing witnesses') f.cells.find((c: { row: number }) => c.row === 12).colSpan = 1
  if (kind === 'different child records')
    f.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 0).text =
      'Group C'
  if (kind === 'independent value') {
    const c = f.cells.find((c: { row: number; column: number }) => c.row === 6 && c.column === 1)
    c.text = '8'
    c.sourceRects = [[300, 365, 306, 378]]
  }
  if (kind === 'native rule') f.rules.push([76, 385, 638, 385])
  if (kind === 'blank spacer') {
    f.rows[7].rect[1] = 380
    f.rows[7].rect[3] = 388
  }
  if (kind === 'source row') f.rows[7].origin = 'source-text'
  if (kind === 'vertical span')
    f.cells.find((c: { row: number; column: number }) => c.row === 6 && c.column === 1).rowSpan = 2
  if (kind === 'unowned text')
    f.items.push({
      text: 'Independent',
      rect: [400, 381, 450, 390],
      baseline: 390,
      height: 9,
      horizontal: true
    })
  const before = structuredClone(f),
    repairs: string[] = []
  removeEmptyOverlappingRows({ ...f, repairs })
  expect(f).toEqual(before)
  expect(repairs).toEqual([])
  expect(empty.colSpan).toBe(3)
})
it.each([0.6, 1.8])('retains source evidence at scale %s', (scale) => {
  const f = fixture(),
    repairs: string[] = []
  for (const c of [...f.cells, ...f.rows]) c.rect = c.rect.map((v: number) => v * scale)
  for (const c of f.cells)
    c.sourceRects = c.sourceRects.map((r: number[]) => r.map((v) => v * scale))
  for (const i of f.items) {
    i.rect = i.rect.map((v: number) => v * scale)
    i.height *= scale
    i.baseline *= scale
  }
  removeEmptyOverlappingRows({ ...f, repairs })
  expect(f.cells.find((c: { text: string }) => c.text === 'Signal C (unit)')).toMatchObject({
    colSpan: 3
  })
  expect(repairs).toEqual(['section-heading-span-reconciled', 'empty-overlapping-row-removed'])
})
