import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture('test/fixtures/source-grids/native-ruled-repeated-records.jsonl')
it('restores missing and merged native records under repeated ruled multi-column stubs', () => {
  const f = input(),
    before = structuredClone(f)
  const r = refineTable(f.table, f.pageItems, f.captions, [], f.rules)
  expect(r.grid.map((row: string[]) => row[3])).toEqual([
    'Model',
    'Method A',
    'Method B',
    'Method C',
    'Method A',
    'Method B',
    'Method C'
  ])
  expect(r.unassigned).toEqual([])
  for (const row of [1, 4])
    for (const column of [0, 1, 2]) {
      expect(
        r.cells.find((c: { row: number; column: number }) => c.row === row && c.column === column)
      ).toMatchObject({ rowSpan: 3, colSpan: 1 })
    }
  const source = (items: { pageNumber: number; index: number; text: string }[]): string[] =>
    items.map((i) => JSON.stringify(i)).sort()
  expect(
    source(
      r.cells.flatMap(
        (c: { sourceItems: { pageNumber: number; index: number; text: string }[] }) =>
          c.sourceItems ?? []
      )
    )
  ).toEqual(
    source(
      f.pageItems.map(
        (i: { sourceItem: { pageNumber: number; index: number; text: string } }) => i.sourceItem
      )
    )
  )
  expect(f).toEqual(before)
})

it.each(['missing-fences', 'extra-stub', 'different-sequence', 'foreign-row'])(
  'does not invent a ruled shared stub with %s',
  (failure) => {
    const f = input()
    if (failure === 'missing-fences') f.rules = []
    if (failure === 'extra-stub') {
      const token = structuredClone(
        f.pageItems.find((i: { text: string }) => i.text === 'Group Alpha')
      )
      token.text = 'Extra group'
      token.sourceItem = { pageNumber: 1, index: 999, text: token.text }
      f.pageItems.push(token)
    }
    if (failure === 'different-sequence') {
      const token = f.pageItems.find((i: { text: string }) => i.text === 'Method A')
      token.text = token.sourceItem.text = 'Different method'
    }
    if (failure === 'foreign-row') {
      f.pageItems.push({
        text: 'Foreign record',
        rect: [365, 700, 460, 715],
        baseline: 715,
        height: 15,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: 999, text: 'Foreign record' }
      })
      f.table.structure.objects.push({ label: 'table row', score: 1, rect: [17, 455, 715, 638] })
    }
    const r = refineTable(f.table, f.pageItems, f.captions, [], f.rules)
    expect(r.repairs).not.toContain('repeated-subrow-recovered')
  }
)
