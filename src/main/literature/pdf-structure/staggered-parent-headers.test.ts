import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledHeaderBands } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/staggered-sibling-parent-underlines.jsonl'
    )
  )

it('recovers sibling parent headers with staggered native underlines', () => {
  const x = fixture()
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.unassigned).toEqual([])
  expect(r.grid).toHaveLength(24)
  expect(
    r.cells.find((c: { text: string }) => c.text === '% of Patients by Study Group')
  ).toMatchObject({
    row: 0,
    column: 1,
    colSpan: 4,
    rowSpan: 1
  })
  expect(r.cells.find((c: { text: string }) => c.text === 'P Exact Test*')).toMatchObject({
    row: 0,
    column: 5,
    colSpan: 2,
    rowSpan: 1
  })
  expect(r.grid[2]).toEqual(['Outcome 1', '2.7', '6.6', '5.7', '5.8', '.511', '.989'])
  expect(
    r.cells
      .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((t) => t.text))
      .sort()
  ).toEqual(x.tokens.map((t: { text: string }) => t.text).sort())
})

it.each(['crossed-glyph', 'missing-child', 'distant-underline', 'missing-underline'])(
  'does not recover a staggered parent from contradictory evidence: %s',
  (variant) => {
    const x = fixture()
    const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    const cells = r.cells
      .filter((c: { row: number }) => c.row === 2)
      .sort((a: { column: number }, b: { column: number }) => a.column - b.column)
    const cuts = [cells[0].rect[0], ...cells.map((c: { rect: number[] }) => c.rect[2])]
    let source = x.tokens.filter((i: { rect: number[] }) => i.rect[3] < 163)
    if (variant === 'crossed-glyph')
      source.find((i: { text: string }) => i.text === 'AA').rect[1] = 129
    if (variant === 'missing-child')
      source = source.filter(
        (i: { rect: number[] }) => i.rect[1] < 133 || i.rect[0] < cuts[3] || i.rect[2] > cuts[4]
      )
    if (variant === 'distant-underline')
      x.rules.find((r: number[]) => r[0] > 690)[1] = x.rules.find((r: number[]) => r[0] > 690)[3] =
        143
    if (variant === 'missing-underline')
      x.rules = x.rules.filter((r: number[]) => r[0] < 250 || r[0] > 650)
    const header = recoverRuledHeaderBands(source, cuts, x.rules, 102, 163.29904174804688)
    expect(
      header?.spans.some(
        (s: { column: number; colSpan: number }) => s.column === 1 && s.colSpan === 4
      ) ?? false
    ).toBe(false)
  }
)
