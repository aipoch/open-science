import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/source-grids/ruled-pain-header.jsonl')
)
it('separates underlined parent headings from wrapped child labels inside one predicted row', () => {
  const x = structuredClone(fixture)
  const table = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(table.unassigned).toEqual([])
  for (const [text, column] of [
    ['VAS pain score at rest', 1],
    ['VAS pain score with movement', 4]
  ]) {
    expect(table.cells).toContainEqual(
      expect.objectContaining({ text, row: 0, column, colSpan: 3 })
    )
  }
  expect(table.grid).toContainEqual([
    '1 h',
    '0 (0–0)',
    '0 (0–0)',
    '0.002',
    '0 (0–1)',
    '0 (0–0)',
    '0.002'
  ])
})
it('does not infer parent groups without both native underlines', () => {
  const x = structuredClone(fixture)
  const table = refineTable(
    x.table,
    x.tokens,
    x.captions,
    [],
    x.rules.filter((r: number[]) => !(r[1] > 131 && r[1] < 133))
  )
  expect(table.repairs).not.toContain('ruled-parent-row-split')
})
