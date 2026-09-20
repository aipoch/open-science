import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))
const refine = (x: ReturnType<typeof load>): ReturnType<typeof refineTable> =>
  refineTable(x.table, x.tokens, x.captions, [], x.rules)

it('retains the measure above its aligned confidence-interval heading', () => {
  const t = refine(load('wrapped-confidence-heading'))
  expect(t.grid[0][3]).toBe('Difference in proportion (95% CI)')
  expect(t.grid[1]).toEqual([
    'Overall seroma, n (%)',
    '34 (62)',
    '43 (75)',
    '+13.0% (−4% to +30%)',
    '0.140'
  ])
  expect(t.unassigned).toEqual([])
})
it.each(['wrapped-comparison-heading', 'wrapped-comparison-prefix'])(
  'retains the full comparison of the two native parent labels: %s',
  (name) => {
    const t = refine(load(name))
    expect(t.grid[0][7]).toBe('Intervention vs. Control')
    expect(t.unassigned).toEqual([])
  }
)
it('recovers a separately ruled statistic heading without consuming the first record', () => {
  const t = refine(load('ruled-increment-heading'))
  expect(t.grid[0]).toEqual(['', 'Increment in R2'])
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1).textRuns
  ).toEqual([
    { text: 'Increment in R', position: 'normal' },
    { text: '2', position: 'superscript' }
  ])
  expect(t.grid[1]).toEqual(['FACT-Fatigue', '0.01'])
  expect(t.grid.at(-1)).toEqual(['Mental component scale', '0.03'])
  expect(t.unassigned).toEqual([])
})
it.each(['misaligned', 'wrong-suffix', 'intervening-rule', 'missing-caption'])(
  'declines an unsupported confidence heading: %s',
  (kind) => {
    const x = load('wrapped-confidence-heading')
    if (kind === 'misaligned') {
      const i = x.tokens.find((i: { text: string }) => i.text === 'Difference in proportion')
      i.rect[0] += 5
      i.rect[2] += 5
    }
    if (kind === 'wrong-suffix')
      x.tokens.find((i: { text: string }) => i.text === '(95% CI)').text = 'Outcome'
    if (kind === 'intervening-rule') x.rules.push([590, 115, 740, 115])
    if (kind === 'missing-caption') x.captions = []
    expect(refine(x).repairs).not.toContain('clipped-wrapped-heading-recovered')
  }
)
it('does not infer a comparison from different parent labels', () => {
  const x = load('wrapped-comparison-heading')
  x.tokens.find((i: { text: string }) => i.text === 'Control').text = 'Placebo'
  expect(refine(x).repairs).not.toContain('clipped-wrapped-heading-recovered')
})
it.each(['missing-upper-rule', 'missing-lower-rule', 'foreign-text'])(
  'declines an unsupported isolated heading: %s',
  (kind) => {
    const x = load('ruled-increment-heading')
    if (kind === 'missing-upper-rule')
      x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 138.64485) > 1)
    if (kind === 'missing-lower-rule')
      x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 160.33755) > 1)
    if (kind === 'foreign-text')
      x.tokens.push({
        ...x.tokens.find((i: { text: string }) => i.text === 'Increment in'),
        text: 'Unrelated prose',
        rect: [230, 141, 420, 154]
      })
    expect(refine(x).repairs).not.toContain('ruled-isolated-heading-recovered')
  }
)
