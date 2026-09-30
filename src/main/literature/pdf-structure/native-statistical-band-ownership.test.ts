import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { splitPdfNumericRuns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
it('separates projected headings from preceding complete statistical subrows', () => {
  const x = fixture('projected-sections-after-paired-summary-lines'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  for (const title of ['Section A', 'Section B']) {
    const row = t.grid.findIndex((r: string[]) => r[0] === title)
    expect(row).toBeGreaterThan(0)
    expect(t.grid[row].slice(1).every((s: string) => !s)).toBe(true)
    expect(t.grid[row - 1][0]).toBe('')
    expect(t.grid[row - 1].slice(1).every((s: string) => !!s)).toBe(true)
  }
  expect(t.unassigned).toEqual([])
})
it('keeps an overhanging interval upper bound with its adjacent lower bound', () => {
  const x = fixture('adjacent-intervals-with-overhanging-upper-bound')
  const original = x.numericRun.content.items[0]
  const parts = splitPdfNumericRuns(x.numericRun.content, x.numericRun.operators).items
  expect(parts.map((i: { str: string }) => i.str)).toEqual(['171.1)', '168.4 (164.9'])
  x.tokens = x.tokens.flatMap((i: { text: string; rect: number[] }) =>
    i.text !== original.str
      ? [i]
      : parts.map((part: { str: string; transform: number[]; width: number }) => {
          const left = i.rect[0] + (part.transform[4] - original.transform[4]) * 1.5
          return {
            ...i,
            text: part.str,
            rect: [left, i.rect[1], left + part.width * 1.5, i.rect[3]]
          }
        })
  )
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const row = t.grid.find((r: string[]) => r[0].startsWith('Measure,'))
  expect(row.slice(1)).toEqual(['165.8 (160.6–171.1)', '168.4 (164.9–171.8)'])
})
it('recovers a section with two overlapping detector owners', () => {
  const x = fixture('adjacent-intervals-with-overhanging-upper-bound'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const row = t.grid.findIndex((r: string[]) => r[0] === 'Section omitted')
  expect(row).toBeGreaterThan(0)
  expect(t.grid[row].slice(1)).toEqual(['', ''])
  expect(t.unassigned).not.toContain('Section omitted')
})
it('joins a hanging unit witnessed at the end of another measured label', () => {
  const x = fixture('adjacent-intervals-with-overhanging-upper-bound'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.some((r: string[]) => r[0] === 'Duration, mean (95% CI), months')).toBe(true)
  expect(t.grid.some((r: string[]) => r[0] === 'months')).toBe(false)
})
it('requires repeated section evidence before splitting a statistical band', () => {
  const x = fixture('projected-sections-after-paired-summary-lines')
  x.tokens = x.tokens.filter((i: { text: string }) => i.text !== 'Section B')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.grid
      .find((r: string[]) => r[0] === 'Section A')
      .slice(1)
      .some(Boolean)
  ).toBe(true)
})
it.each(['width', 'gutter'])(
  'preserves combined intervals when native %s evidence is insufficient',
  (variant) => {
    const x = fixture('adjacent-intervals-with-overhanging-upper-bound').numericRun
    if (variant === 'width') x.content.items[0].width += 10
    else {
      const run = x.operators.argsArray[1][0],
        n = run.indexOf(-560)
      run[n] = -200
      x.content.items[0].width -= ((560 - 200) / 1000) * x.content.items[0].height
    }
    expect(splitPdfNumericRuns(x.content, x.operators).items).toEqual(x.content.items)
  }
)
it('keeps an independent lowercase subgroup without the witnessed unit suffix', () => {
  const x = fixture('adjacent-intervals-with-overhanging-upper-bound')
  x.tokens = x.tokens.map((i: { text: string }) => ({
    ...i,
    text: i.text === 'Interval, mean (95% CI), months' ? 'Interval, mean (95% CI), days' : i.text
  }))
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.some((r: string[]) => r[0] === 'months')).toBe(true)
})
it.each([true, false])(
  'requires an in-table citation for an alphanumeric expansion: %s',
  async (cited) => {
    const { associateTableNotes } = await import(
      pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
    )
    const x = fixture('cited-alphanumeric-definition-below-closing-rule')
    if (!cited) x.page.lines[0].text = 'Other positive 3 (30) 1 (10)'
    expect(
      associateTableNotes(x.page, x.tables, x.rules)[0].map((n: { text: string }) => n.text)
    ).toEqual(cited ? ['RCP2, receptor binding protein 2.'] : [])
  }
)
