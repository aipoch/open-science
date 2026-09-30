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
      'src/main/literature/pdf-structure/fixtures/source-grids/underlined-comparisons-with-summary-subrows.jsonl'
    )
  )
it.each([0, 1, 2, 3])(
  'uses leaf underlines for parent spans and independent summary records: %s',
  (index) => {
    const x = fixture().cases[index]
    const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(r.grid).toHaveLength(index < 2 ? 20 : 5)
    expect(r.cells.filter((c: { colSpan: number }) => c.colSpan === 3)).toHaveLength(
      index % 2 ? 2 : 3
    )
    expect(r.unassigned).toEqual([])
    expect(r.clipped).toEqual([])
    if (index < 2) {
      expect(r.grid.filter((r: string[]) => r[0] === 'Mean')).toHaveLength(9)
      expect(r.grid[3][3]).toBe('')
    }
    if (index === 0) {
      expect(r.grid[6][1]).toBe('95.5 (85.7–99.9)')
      expect(r.grid[6][2]).toBe('97.5 (90.5–100)')
    }
    expect(
      r.cells
        .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((t) => t.text))
        .sort()
    ).toEqual(x.tokens.map((t: { text: string }) => t.text).sort())
  }
)

it.each([
  'missing-stroke',
  'different-header',
  'missing-mean',
  'populated-test-subrow',
  'duplicate-token'
])('declines unproven comparison subrows: %s', (variant) => {
  const x = fixture().cases[0]
  if (variant === 'missing-stroke')
    x.rules.splice(
      x.rules.findIndex((r: number[]) => r[1] > 110 && r[1] < 120),
      1
    )
  if (variant === 'different-header')
    x.tokens.find((i: { text: string }) => i.text === 'Treatment').text = 'Different'
  if (variant === 'missing-mean')
    x.tokens.splice(
      x.tokens.findIndex((i: { text: string }) => i.text === 'Mean'),
      1
    )
  if (variant === 'populated-test-subrow') {
    const t = structuredClone(x.tokens.find((i: { text: string }) => i.text === '0.318'))
    t.rect[1] += 16.5
    t.rect[3] += 16.5
    t.baseline += 16.5
    x.tokens.push(t)
  }
  if (variant === 'duplicate-token')
    x.tokens.push(x.tokens.find((i: { text: string }) => i.text === 'Mean'))
  expect(recoverRuledColumnGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
