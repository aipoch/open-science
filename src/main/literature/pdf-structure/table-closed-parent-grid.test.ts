import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/closed-parent-count-grid.jsonl'
    )
  )
const parse = (x: ReturnType<typeof load>): ReturnType<typeof refineTable> =>
  refineTable(x.table, x.tokens, x.captions, [], x.rules)
it('uses closed source faces to remove a false stub column and recover both parent headers', () => {
  const x = load(),
    t = parse(x)
  expect(t.grid).toEqual([
    ['', 'Interruption', '', 'Discontinuation', ''],
    ['', 'EF-guided (n=8)', 'GLS-guided (n=5)', 'EF-guided (n=5)', 'GLS-guided (n=9)'],
    ['Adverse events / serious adverse effects', '1', '0', '1', '2'],
    ['Left ventricular dysfunction', '1', '3', '1', '2'],
    ['Chemotherapy side effect', '3', '1', '1', '4'],
    ['Other reasons', '3', '1', '2', '1']
  ])
  for (const text of ['Interruption', 'Discontinuation'])
    expect(t.cells).toContainEqual(
      expect.objectContaining({ text, row: 0, rowSpan: 1, colSpan: 2 })
    )
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(load())
})
it.each(['broken-border', 'missing-value', 'extra-divider'])(
  'does not rebuild an ambiguous closed grid with %s',
  (condition) => {
    const x = load()
    if (condition === 'broken-border')
      x.rules = x.rules.filter(
        (r: number[]) => !(r[0] === r[2] && Math.abs(r[0] - 578.16) < 1 && r[1] > 595)
      )
    if (condition === 'missing-value')
      x.tokens = x.tokens.filter(
        (t: { rect: number[] }) => !(t.rect[0] > 600 && t.rect[1] > 590 && t.rect[1] < 625)
      )
    if (condition === 'extra-divider') x.rules.push([420, 270, 420, 290])
    expect(parse(x).repairs).not.toContain('closed-parent-grid-recovered')
  }
)
