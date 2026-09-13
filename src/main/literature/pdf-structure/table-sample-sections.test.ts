import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/source-grids/projected-sample-sections.jsonl')
)
it('keeps complete sample-size section titles across the data columns they overlap', () => {
  const x = structuredClone(fixture)
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  for (const text of ['Lapatinib plus capecitabine (n = 13)', 'Lapatinib plus topotecan (n = 9)']) {
    expect(
      t.grid.some((row: string[]) => row[0] === text && row.slice(1).every((v) => v === ''))
    ).toBe(true)
    expect(t.cells).toContainEqual(expect.objectContaining({ text, colSpan: 6, rowSpan: 1 }))
  }
  expect(t.grid).toContainEqual(['Diarrhea', '3 (23)', '4 (31)', '2 (23)', '1 (8)', '0'])
  expect(t.grid).toContainEqual(['Diarrhea', '2 (22)', '3 (33)', '3 (33)', '0', '0'])
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(fixture)
})
it.each(['missing-projection', 'incomplete-sample', 'detached-suffix'])(
  'retains the existing layout with %s evidence',
  (condition) => {
    const x = structuredClone(fixture)
    if (condition === 'missing-projection')
      x.table.structure.objects = x.table.structure.objects.filter(
        (o: { label: string }) => o.label !== 'table projected row header'
      )
    const suffix = x.tokens.find((i: { text: string }) => i.text === '13)')
    if (condition === 'incomplete-sample') suffix.text = '13'
    if (condition === 'detached-suffix') {
      suffix.rect[0] += 20
      suffix.rect[2] += 20
    }
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(
      t.cells.some(
        (c: { text: string; colSpan: number }) =>
          c.text.startsWith('Lapatinib plus capecitabine') && c.colSpan === 6
      )
    ).toBe(false)
  }
)
