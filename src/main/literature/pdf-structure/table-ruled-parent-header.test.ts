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

const moderatorFixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/source-grids/moderator-statistic-rows.jsonl')
)
it('uses token centers for repeated child labels whose font boxes cross the underline', () => {
  const x = structuredClone(moderatorFixture)
  const before = structuredClone(x)
  const table = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(table.grid.slice(0, 2)).toEqual([
    ['Potential moderatora Baseline level', 'CRPb', '', 'IL6b', '', 'TNFab', ''],
    ['', 'nc', 'TERd', 'nc', 'TERd', 'nc', 'TERd']
  ])
  for (const column of [1, 3, 5])
    expect(table.cells).toContainEqual(expect.objectContaining({ row: 0, column, colSpan: 2 }))
  expect(table.cells).toContainEqual(expect.objectContaining({ row: 0, column: 0, rowSpan: 2 }))
  for (const column of [1, 3, 5])
    expect(
      table.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === column)
        .textRuns
    ).toContainEqual(expect.objectContaining({ text: 'c', position: 'superscript' }))
  expect(table.issues).not.toContain('unresolved-spanning-cells')
  expect(x).toEqual(before)
})

it.each(['missing-rule', 'different-child', 'child-above-rule', 'missing-child'])(
  'preserves an uncertain underlined header with %s',
  (variant) => {
    const x = structuredClone(moderatorFixture)
    const child = x.tokens.find(
      (i: { text: string; rect: number[] }) => i.text === 'TER' && i.rect[0] > 700
    )
    if (variant === 'missing-rule')
      x.rules = x.rules.filter((r: number[]) => !(r[0] > 670 && r[1] > 176 && r[1] < 177))
    if (variant === 'different-child') child.text = 'Other'
    if (variant === 'missing-child') x.tokens = x.tokens.filter((i: unknown) => i !== child)
    if (variant === 'child-above-rule') {
      child.baseline -= 12
      child.rect[1] -= 12
      child.rect[3] -= 12
    }
    const table = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(table.repairs).not.toContain('ruled-parent-row-split')
  }
)
