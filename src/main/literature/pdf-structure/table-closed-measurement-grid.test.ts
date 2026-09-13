import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/closed-measurement-grid.jsonl')
  )
const parse = (x: ReturnType<typeof load>): ReturnType<typeof refineTable> =>
  refineTable(x.table, x.tokens, x.captions, [], x.rules)
it('recovers closed measurement parents and shared stubs while preserving values and empty P cells', () => {
  const x = load(),
    t = parse(x)
  expect(t.grid[0]).toEqual(['', '', 'EF-Guided', '', '', 'GLS guided', '', '', '', ''])
  expect(t.grid[1]).toEqual([
    '',
    '',
    'N',
    'LV function',
    'P*',
    'N',
    'LV function',
    'P*',
    'Difference (95% CI)',
    'p'
  ])
  expect(t.grid.slice(2).map((r: string[]) => r.slice(1))).toEqual(
    x.previousGrid.slice(1).map((r: string[]) => r.slice(1))
  )
  for (const text of ['Core-lab 3D-EF, %', 'Core-lab GLS, %'])
    expect(t.cells).toContainEqual(expect.objectContaining({ text, rowSpan: 3, colSpan: 1 }))
  for (const text of ['EF-Guided', 'GLS guided'])
    expect(t.cells).toContainEqual(expect.objectContaining({ text, rowSpan: 1, colSpan: 3 }))
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(load())
})
it.each(['broken-border', 'missing-count', 'different-children', 'merged-values'])(
  'rejects ambiguous measurement faces with %s',
  (condition) => {
    const x = load()
    if (condition === 'broken-border')
      x.rules = x.rules.filter((r: number[]) => !(r[0] === r[2] && r[0] > 1140 && r[1] > 420))
    if (condition === 'missing-count')
      x.tokens = x.tokens.filter((t: { text: string }) => t.text !== '153')
    if (condition === 'different-children')
      x.tokens.find(
        (t: { text: string; rect: number[] }) => t.text === 'N' && t.rect[0] > 600
      ).text = 'Population'
    if (condition === 'merged-values')
      x.rules = x.rules.filter(
        (r: number[]) => !(r[1] === r[3] && Math.abs(r[1] - 273.24) < 1 && r[0] > 370 && r[2] < 540)
      )
    expect(parse(x).repairs).not.toContain('closed-parent-grid-recovered')
  }
)
