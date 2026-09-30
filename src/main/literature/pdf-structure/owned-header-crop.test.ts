import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { recoverOwnedTableCrop, tableCaptionCropTop } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-geometry.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/owned-headers-outside-detector-crop.jsonl'
    )
  )

it.each([0, 1])('includes recovered header glyphs and the native border: %s', (index) => {
  const { table, rules } = fixture().cases[index]
  const original = structuredClone(table)
  const crop = recoverOwnedTableCrop(table, rules)
  const source = table.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
  expect(crop[1]).toBeLessThan(Math.min(...source.map((r: number[]) => r[1])))
  expect(crop[2]).toBeGreaterThan(Math.max(...source.map((r: number[]) => r[2])))
  const top = tableCaptionCropTop({ ...table, cropRect: crop }, crop[1] - 10, rules)
  expect(top).toBeLessThan(Math.min(...source.map((r: number[]) => r[1])))
  expect(table).toEqual(original)
  expect(recoverOwnedTableCrop({ ...table, cropRect: crop }, rules)).toEqual(crop)
})

it.each(['unassigned', 'missing rule', 'short rule', 'distant rule', 'distant text'])(
  'keeps uncertain crop bounds: %s',
  (guard) => {
    const { table, rules } = fixture().cases[0]
    let evidence = rules
    if (guard === 'unassigned') table.unassigned = ['Uncertain']
    if (guard === 'missing rule') evidence = []
    if (guard === 'short rule') evidence = rules.map((r: number[]) => [r[0], r[1], r[0] + 40, r[3]])
    if (guard === 'distant rule')
      evidence = rules.map((r: number[]) => [r[0], r[1] + 100, r[2], r[3] + 100])
    if (guard === 'distant text') table.cells[2].sourceRects[0][2] += 200
    expect(recoverOwnedTableCrop(table, evidence)).toEqual(table.cropRect)
  }
)

it('keeps padding and rounded native borders within the source page', () => {
  const { table, rules } = fixture().cases[0]
  table.cropRect[1] -= 79
  table.cropRect[3] -= 79
  for (const cell of table.cells)
    for (const r of cell.sourceRects) {
      r[1] -= 79
      r[3] -= 79
    }
  for (const r of rules) {
    r[1] -= 79
    r[3] -= 79
  }
  const crop = recoverOwnedTableCrop(table, rules, [820, 1000])
  expect(crop[1]).toBe(0)
  expect(crop[2]).toBe(820)
})
