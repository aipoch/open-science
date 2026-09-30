import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
it('separates centered parents using original border segments and repeated children', () => {
  const x = fixture('segmented-parent-borders-with-continuous-underline')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.cells
      .filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan > 1)
      .map((c: { column: number; colSpan: number }) => [c.column, c.colSpan])
  ).toEqual([
    [1, 3],
    [4, 3]
  ])
  expect(t.unassigned).toEqual([])
})
it.each([
  ['wrapped-stub-with-complementary-probability', 11],
  ['hanging-unit-below-complete-measurement', 17]
])('keeps a single wrapped measurement together: %s', (name, count) => {
  const x = fixture(name as string),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toHaveLength(count as number)
  expect(t.unassigned).toEqual([])
})
it('keeps independently hanging eligibility paragraphs and separate final exclusions', () => {
  const x = fixture('independent-eligibility-lists-with-hanging-paragraphs')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.cells.filter((c: { column: number; text: string }) => c.column === 1 && c.text).length
  ).toBe(15)
  expect(
    t.cells.filter((c: { column: number; rowSpan: number }) => c.column === 0 && c.rowSpan > 1)
      .length
  ).toBe(3)
  expect(t.unassigned).toEqual([])
  const compact = (s: string): string[] => [...s.replace(/\s/g, '')].sort()
  expect(compact(t.grid.flat().join(''))).toEqual(
    compact(x.tokens.map((i: { text: string }) => i.text).join(''))
  )
})
it('keeps the trial flowchart below preceding full-width prose', async () => {
  const { associateFigures } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
  )
  const { findCaptionCandidates } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
  )
  const x = fixture('trial-flowchart-below-multiline-prose')
  const result = associateFigures(x.page, findCaptionCandidates([x.page]), [], x.rules)
  expect(result).toHaveLength(1)
  expect(result[0].rect[1]).toBeGreaterThan(280)
  expect(result[0].rect[3]).toBeGreaterThan(700)
})
it('retains a complete side-caption frame when neighboring prose only touches its corridor', async () => {
  const { associateFigures } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
  )
  const x = fixture('side-legend-frame-with-floating-neighbor-edge')
  const result = associateFigures(x.page, x.captions, [], x.rules)
  expect(result).toHaveLength(1)
  expect(result[0].rect[1]).toBeLessThan(130)
  expect(result[0].rect[1]).toBeGreaterThan(100)
  expect(result[0].rect[3]).toBeGreaterThan(750)
})
it('finds the centered graphical abstract beside an unrelated vertical manuscript watermark', async () => {
  const { associateGraphicalAbstract } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
  )
  const x = fixture('centered-abstract-with-description-and-vertical-watermark')
  const result = associateGraphicalAbstract(x.page)
  expect(result?.caption.lines).toHaveLength(6)
  expect(result?.rect[1]).toBeGreaterThan(270)
  expect(result?.rect[3]).toBeLessThan(440)
})
it('recovers the clipped parent row of a ruled continuation without splitting wrapped parents', () => {
  const x = fixture('clipped-continuation-with-underlined-parent-headings')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.cropRect[1]).toBeLessThan(x.table.cropRect[1] - 20)
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 2)
  ).toHaveLength(2)
  expect(t.grid[0][2]).toContain('Label 4')
})
it('keeps the separated summary qualifier inside its wide native section label', () => {
  const x = fixture('wide-section-with-separated-summary-qualifier')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const cell = t.cells.find((c: { text: string }) => c.text.startsWith('Measured concentration'))
  expect(cell.text).toContain('Mean ± SD')
  expect(cell.colSpan).toBe(t.grid[0].length)
})
it('separates a heading from its first count record using independently owned indented peers', () => {
  const x = fixture('indented-count-section-merged-with-first-record')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid[2]).toEqual(['Section label', ''])
  expect(t.grid[3][1]).toBe('22')
  expect(t.unassigned).toEqual([])
  const compact = (s: string): string[] => [...s.replace(/\s/g, '')].sort()
  expect(compact(t.grid.flat().join(''))).toEqual(
    compact(x.tokens.map((i: { text: string }) => i.text).join(''))
  )
})
it('recovers omitted metric parents from native borders and repeated group identifiers', () => {
  const x = fixture('repeated-metric-parents-above-native-child-border')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid[0][1]).toBe('Observations')
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 3)
  ).toHaveLength(4)
  expect(t.unassigned).toEqual([])
})
it('keeps wrapped sample parents together over independently underlined count and percentage leaves', () => {
  const x = fixture('wrapped-sample-parents-above-count-percentage-leaves')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 2)
  ).toHaveLength(2)
  expect(t.grid[0][1]).toContain('n = 22)')
  expect(t.unassigned).toEqual([])
})
it('recovers the stub column independently from repeated paired native summaries', () => {
  const x = fixture('paired-summaries-with-missing-stub-column')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid[0]).toHaveLength(3)
  expect(t.cells.filter((c: { colSpan: number }) => c.colSpan === 3)).toHaveLength(3)
  expect(t.unassigned).toEqual([])
  const compact = (s: string): string[] => [...s.replace(/\s/g, '')].sort()
  expect(compact(t.grid.flat().join(''))).toEqual(
    compact(x.tokens.map((i: { text: string }) => i.text).join(''))
  )
})
it('separates independently indented count records whose native font boxes slightly overlap', () => {
  const x = fixture('count-section-with-touching-font-ascent-boxes')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const row = t.grid.findIndex((r: string[]) => r[0] === 'Section label')
  expect(row).toBeGreaterThan(0)
  expect(t.grid[row].slice(1)).toEqual(['', ''])
  expect(t.grid[row + 1].slice(1)).toEqual(['22 (22)', '22 (22)'])
  expect(t.unassigned).toEqual([])
})
