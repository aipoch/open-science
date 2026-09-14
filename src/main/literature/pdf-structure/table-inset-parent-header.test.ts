import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/inset-underlined-parent.jsonl')
  )
const parse = (x: ReturnType<typeof load>): ReturnType<typeof refineTable> =>
  refineTable(x.table, x.tokens, x.captions, [], x.rules)
it('uses the underlined child text to recover an inset parent without absorbing the first child', () => {
  const x = load(),
    t = parse(x)
  expect(t.cells).toContainEqual(
    expect.objectContaining({ text: 'Groups', row: 0, column: 1, colSpan: 3, rowSpan: 1 })
  )
  expect(t.grid[1].slice(1, 4)).toEqual([
    'All women (n=67) Mean (SD)',
    'Spiritual therapy (n=30) Mean (SD)',
    'Control (n=37) Mean (SD)'
  ])
  expect(t.grid[2]).toEqual(['Age (years)', '43.19(8.89)', '43.46(7.81)', '42.97(9.77)', '0.82*'])
  const withoutUnderline = load()
  withoutUnderline.rules = withoutUnderline.rules.filter(
    (r: number[]) => Math.abs(r[1] - 142.344) > 0.1
  )
  const baseline = parse(withoutUnderline).grid
  expect(t.grid.slice(2)).toEqual(
    baseline.slice(baseline.findIndex((row: string[]) => row[0] === 'Age (years)'))
  )
  expect(t.unassigned).toEqual([])
})
it.each(['no-underline', 'other-parent', 'short-underline'])(
  'does not infer a parent range from contradictory source evidence: %s',
  (kind) => {
    const x = load()
    const rule = x.rules.find((r: number[]) => Math.abs(r[1] - 142.344) < 0.1)
    if (kind === 'no-underline') x.rules = x.rules.filter((r: number[]) => r !== rule)
    if (kind === 'short-underline') rule[2] -= 80
    if (kind === 'other-parent') {
      const label = x.tokens.find((i: { text: string }) => i.text === 'Groups')
      x.tokens.push({
        ...label,
        text: 'Independent',
        rect: [435, label.rect[1], 495, label.rect[3]]
      })
    }
    expect(parse(x).cells).not.toContainEqual(
      expect.objectContaining({ text: 'Groups', row: 0, column: 1, colSpan: 3 })
    )
  }
)
