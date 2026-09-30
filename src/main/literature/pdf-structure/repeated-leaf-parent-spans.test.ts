import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (n: number): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/repeated-leaf-columns-with-partial-parents.jsonl'
    )
  ).cases[n]
it.each([
  [0, 2, 4],
  [1, 3, 2],
  [2, 4, 2]
])('recovers all parent widths from repeated leaf groups %s', (n, width, count) => {
  const x = fixture(n),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  for (let i = 0; i < count; i++)
    expect(
      t.cells.find(
        (c: { row: number; column: number }) => c.row === 0 && c.column === 1 + i * width
      )
    ).toMatchObject({ colSpan: width, rowSpan: 1 })
  expect(
    t.cells.filter((c: { row: number; column: number }) => c.row === 1 && c.column > 0)
  ).toHaveLength(width * count)
})
it('keeps centered sample sizes together across the paired columns they describe', () => {
  const x = fixture(3),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid[2]).toEqual(['', 'n = 33', '', 'n = 17', '', 'n = 16', ''])
  for (const column of [1, 3, 5])
    expect(
      t.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === column)
    ).toMatchObject({ colSpan: 2 })
})
it('extends an unbranched parent through its empty intermediate header band', () => {
  const x = fixture(4),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.cells.find((c: { text: string }) => c.text === 'Aerobic Exercise')).toMatchObject({
    row: 0,
    column: 7,
    colSpan: 2,
    rowSpan: 2
  })
})
it('does not invent equal parent groups when the native leaves do not repeat', () => {
  const x = fixture(0)
  x.tokens.find((t: { text: string }) => t.text === 'All grade').text = 'Different endpoint'
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 2)
  ).toHaveLength(0)
})
