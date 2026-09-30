import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledColumnGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-column-grid.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/wide-repeated-measures-with-overlapping-header-rules.jsonl'
    )
  )

it('recovers all visits and signs under more than twelve native leaf headers', () => {
  const x = fixture()
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.unassigned).toEqual([])
  expect(r.grid).toHaveLength(6)
  expect(r.grid.every((row: string[]) => row.length === 13)).toBe(true)
  expect(r.grid.slice(2).map((row: string[]) => row[0])).toEqual(['0', '6', '12', '24'])
  expect(r.grid[2].slice(1)).toEqual(Array(12).fill('d'))
  expect(r.grid[4][7]).toContain('−2.4%')
  expect(r.grid[5][1]).toContain('−5.3%')
  expect(r.grid[5][12]).toBe('<0.0002')
  expect(r.cells.filter((c: { colSpan: number }) => c.colSpan === 3)).toHaveLength(4)
  expect(
    r.cells
      .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((t) => t.text))
      .sort()
  ).toEqual(x.tokens.map((t: { text: string }) => t.text).sort())
})

it.each(['missing-stroke', 'shifted-stroke', 'missing-frame', 'crossing-value'])(
  'rejects ambiguous wide native columns: %s',
  (variant) => {
    const x = fixture()
    if (variant === 'missing-stroke')
      x.rules.splice(
        x.rules.findIndex((r: number[]) => r[1] > 270 && r[0] > 300),
        1
      )
    if (variant === 'shifted-stroke')
      x.rules.find((r: number[]) => r[1] > 270 && r[0] > 300)[0] += 8
    if (variant === 'missing-frame') x.rules = x.rules.filter((r: number[]) => r[1] < 349)
    if (variant === 'crossing-value')
      x.tokens.find((i: { text: string }) => i.text === '2.4%').rect[2] += 90
    expect(recoverRuledColumnGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
  }
)
