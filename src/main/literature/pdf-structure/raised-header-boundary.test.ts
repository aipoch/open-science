import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/raised-header-marker-across-column-boundary.jsonl'
    )
  )

it('keeps a raised header marker with its source label across a predicted boundary', () => {
  const x = fixture(),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid[0][3]).toBe('Cohort Ba Meana ± SD')
  expect(t.grid[0][4]).toBe('US Dietary Guidelines per 1000 kcal')
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 3)?.textRuns
  ).toContainEqual({ text: 'a', position: 'superscript' })
})
it('does not move a marker across a native vertical divider', () => {
  const x = fixture(),
    anchor = x.tokens.find((t: { text: string }) => t.text === 'Cohort B'),
    cut = anchor.rect[2] + 0.04,
    rule = [cut, anchor.rect[1] - 5, cut, anchor.rect[3] + 5],
    t = refineTable(x.table, x.tokens, x.captions, [], [...x.rules, rule])
  expect(t.grid[0][3]).toBe('Cohort B Meana ± SD')
})
it('does not treat a same-baseline letter in the next column as a superscript', () => {
  const x = fixture(),
    anchor = x.tokens.find((t: { text: string }) => t.text === 'Cohort B'),
    marker = x.tokens.find(
      (t: { text: string; rect: number[] }) =>
        t.text === 'a' && Math.abs(t.rect[0] - anchor.rect[2]) < 1
    )
  marker.rect[1] += anchor.baseline - marker.baseline
  marker.rect[3] += anchor.baseline - marker.baseline
  marker.baseline = anchor.baseline
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid[0][3]).toBe('Cohort B Meana ± SD')
})
