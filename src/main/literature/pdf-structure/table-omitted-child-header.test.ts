import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/source-grids/omitted-child-header.jsonl')
)
it('restores omitted repeated child headings and their ruled parent spans', () => {
  const x = structuredClone(fixture)
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid[0]).toEqual(['Years', 'PFS (%)', '', '', '', 'OS (%)', '', '', ''])
  expect(r.grid[1]).toEqual(['', 'NX', 'TX', 'χ2', 'P', 'NX', 'TX', 'χ2', 'P'])
  expect(r.grid[2]).toEqual([
    '1',
    '27.3',
    '23.8',
    '0.339',
    '0.56',
    '76.4',
    '52.7',
    '0.088',
    '0.766'
  ])
  expect(
    r.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 3).textRuns
  ).toContainEqual(expect.objectContaining({ text: '2', position: 'superscript' }))
  expect(r.unassigned).toEqual([])
  expect(r.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ row: 0, column: 1, colSpan: 4 }),
      expect.objectContaining({ row: 0, column: 5, colSpan: 4 })
    ])
  )
})
it.each(['missing-rule', 'different-children'])(
  'does not infer parent spans with %s',
  (condition) => {
    const x = structuredClone(fixture)
    if (condition === 'missing-rule')
      x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 321.483) > 1)
    else
      for (const t of x.tokens)
        if (t.text === 'NX' && t.rect[0] > 290 && t.rect[0] < 310 && t.rect[1] < 340)
          t.text = 'Other'
    const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(r.repairs).not.toContain('ruled-parent-row-split')
  }
)
