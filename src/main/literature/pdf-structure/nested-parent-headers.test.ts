import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/nested-parent-with-paired-leaves.jsonl'
    )
  )

it('uses nested native underlines even when the model already owns every header token', () => {
  const x = fixture()
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.unassigned).toEqual([])
  expect(r.cells.find((c: { text: string }) => c.text === 'Treatment Group')).toMatchObject({
    row: 0,
    column: 1,
    colSpan: 8,
    rowSpan: 1
  })
  expect(
    r.cells.filter((c: { row: number; colSpan: number }) => c.row === 1 && c.colSpan === 2)
  ).toHaveLength(4)
  expect(r.grid[3]).toEqual([
    'Performed at baseline',
    '24',
    '5.1',
    '20',
    '4.2',
    '26',
    '5.4',
    '70',
    '4.9'
  ])
  expect(
    r.cells
      .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((t) => t.text))
      .sort()
  ).toEqual(x.tokens.map((t: { text: string }) => t.text).sort())
})

it.each(['missing-parent-rule', 'missing-child-rule', 'truncated-parent-rule'])(
  'preserves model ownership without a complete native hierarchy: %s',
  (variant) => {
    const x = fixture()
    if (variant === 'missing-parent-rule')
      x.rules = x.rules.filter((r: number[]) => r[1] < 128 || r[1] > 130)
    if (variant === 'missing-child-rule')
      x.rules = x.rules.filter((r: number[]) => r[1] < 161 || r[1] > 163 || r[0] < 760)
    if (variant === 'truncated-parent-rule')
      x.rules.find((r: number[]) => r[1] > 128 && r[1] < 130)[2] -= 65
    const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(r.cells.find((c: { text: string }) => c.text === 'Treatment Group')?.colSpan).not.toBe(8)
  }
)
