import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
function fixture(): ReturnType<typeof JSON.parse> {
  return readPdfFixture(
    'src/main/literature/pdf-structure/fixtures/source-grids/repeated-arm-timepoints.jsonl'
  )
}
it('groups repeated arms under their left-aligned timepoint headings without absorbing the difference column', () => {
  const x = fixture()
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  for (const [text, column] of [
    ['Baseline', 1],
    ['Six-month follow-up', 4]
  ]) {
    expect(t.cells.find((c: { text: string }) => c.text === text)).toMatchObject({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 3
    })
  }
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 5)
  ).toMatchObject({ text: 'Control (n = 78)', colSpan: 1 })
  expect(t.grid[3]).toEqual([
    'Time from randomisation to follow-up',
    '',
    '',
    '',
    '7.1 (1.6)',
    '7.1 (1.5)',
    '7.1 (1.5)'
  ])
  expect(t.grid.slice(2)).toEqual(x.expectedBody)
  expect(t.unassigned).toEqual([])
})
it.each([
  'different-arm',
  'missing-border',
  'offset-parent',
  'labelled-difference',
  'dividing-rule'
])('keeps model header ownership with %s evidence', (condition) => {
  const x = fixture()
  const parent = x.tokens.find((i: { text: string }) => i.text === 'Six-month follow-up')
  if (condition === 'different-arm')
    x.tokens.find(
      (i: { text: string; rect: number[] }) => i.text === 'Control (' && i.rect[0] > 800
    ).text = 'Other ('
  if (condition === 'missing-border') x.rules = []
  if (condition === 'offset-parent') {
    parent.rect[0] += 20
    parent.rect[2] += 20
  }
  if (condition === 'labelled-difference')
    x.tokens.push({
      ...parent,
      text: 'Difference',
      baseline: 201,
      height: 11.25,
      rect: [987, 190, 1040, 201]
    })
  if (condition === 'dividing-rule') x.rules.push([987, 164, 987, 185])
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.repairs).not.toContain('repeated-arm-parent-headers-recovered')
})
