import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))
const parse = (x: ReturnType<typeof load>): ReturnType<typeof refineTable> =>
  refineTable(x.table, x.tokens, x.captions, [], x.rules)
it.each([1, 2, 3, 4])(
  'recovers repeated arm/comparison records and shared outcomes in layout %s',
  (n) => {
    const x = load(`repeated-comparisons-${n}`),
      t = parse(x)
    expect(t.repairs).toContain('repeated-comparison-grid-recovered')
    expect(
      t.cells.filter((c: { rowSpan: number; column: number }) => c.column === 0 && c.rowSpan === 3)
        .length
    ).toBe([12, 3, 8, 5][n - 1])
    expect(t.unassigned).toEqual([])
    expect(t.grid[1][1]).toBe('Group')
    expect(x).toEqual(load(`repeated-comparisons-${n}`))
  }
)
it('keeps amounts with their native deviations and interval punctuation', () => {
  const t = parse(load('currency-deviations'))
  expect(t.grid.slice(1).map((r: string[]) => r[0])).toEqual([
    'Surgery',
    'Hospital',
    'Medical equipment',
    'Productivity loss',
    'Total'
  ])
  expect(t.grid[1][1]).toBe('€6080.92 (204.17)')
  expect(t.grid[2][3]).toBe('€−270.98 (−700,13–206,56)')
  expect(t.unassigned).toEqual([])
})
it('retains wrapped final stub markers inside a closed treatment grid', () => {
  const t = parse(load('closed-treatment-records'))
  expect(t.grid.at(-1)[0]).toBe('Maximal dose of beta-blocker achieved, %*†')
  expect(t.unassigned).toEqual([])
})
it('uses native follow-up underlines without including the independent baseline column', () => {
  const x = load('rotated-followup-headers'),
    t = parse(x)
  expect(t.cells).toContainEqual(
    expect.objectContaining({ text: 'Four-week follow-up', row: 0, column: 2, colSpan: 5 })
  )
  expect(t.cells).toContainEqual(
    expect.objectContaining({ text: 'Eight-week follow-up', row: 0, column: 7, colSpan: 5 })
  )
})
it('separates a ruled baseline parent from visit headers and keeps independent time columns', () => {
  const t = parse(load('assessment-schedule'))
  const parent = t.cells.find((c: { text: string }) => c.text === 'Baseline Assessment')
  expect(parent && [parent.row, parent.column, parent.rowSpan, parent.colSpan]).toEqual([
    0, 2, 1, 2
  ])
  expect(t.grid[1].slice(2, 4)).toEqual(['Enrollment Visit', 'Research Visit'])
})
it('associates an isolated centered table number with the larger prose title above the column headers', async () => {
  const { findCaptionCandidates } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
  )
  const x = load('centered-title-before-headers')
  const captions = findCaptionCandidates([x.page], new Map([[x.page.pageNumber, x.rules]]))
  expect(
    captions.some(
      (c: { lines: string[] }) =>
        c.lines.join(' ') ===
        'Table 3. Coping as a Moderator of Symptom Distress with Dependent Variables'
    )
  ).toBe(true)
})
it('preserves the source-closed category-wide P value without repeating it on each category', () => {
  const t = parse(load('closed-category-1'))
  expect(t.repairs).toContain('closed-record-grid-recovered')
  const p = t.cells.find((c: { text: string }) => c.text === '0.89')
  expect(p && [p.row, p.column, p.rowSpan, p.colSpan]).toEqual([3, 3, 6, 1])
  expect(t.grid.slice(4, 9).map((r: string[]) => r[3])).toEqual(['', '', '', '', ''])
  expect(t.grid.slice(4, 9).map((r: string[]) => r[0])).toEqual([
    'European',
    'African',
    'East Asian',
    'South Asian',
    'Other'
  ])
  expect(t.unassigned).toEqual([])
})
it.each(['no-caption', 'missing-arm', 'missing-value', 'extra-comparison-value'])(
  'rejects incomplete repeated comparison evidence: %s',
  async (condition) => {
    const { recoverRepeatedComparisonGrid } = await import(
      pathToFileURL(resolve('resources/pdf-structure/literature-pdf-wrapped-summary-grid.mjs')).href
    )
    const x = load('repeated-comparisons-2')
    if (condition === 'no-caption') x.captions = []
    else {
      const t = parse(x),
        c = t.cells.find(
          (c: { column: number; row: number }) =>
            c.column === (condition === 'missing-arm' ? 1 : 2) && c.row === 2
        )
      const token = c.sourceTokens[0]
      const index = x.tokens.findIndex(
        (i: { rect: number[]; text: string }) =>
          i.text === token.text && JSON.stringify(i.rect) === JSON.stringify(token.rect)
      )
      expect(index).toBeGreaterThanOrEqual(0)
      if (condition === 'extra-comparison-value') {
        const p = t.cells.find(
          (c: { row: number; column: number }) => c.row === 4 && c.column === 3
        ).sourceTokens[0]
        const clone = structuredClone(p)
        clone.horizontal = true
        clone.rect[0] = x.table.cropRect[2] - 20
        clone.rect[2] = x.table.cropRect[2] - 5
        x.tokens.push(clone)
      } else x.tokens.splice(index, 1)
    }
    expect(recoverRepeatedComparisonGrid(x.table, x.tokens, x.captions)).toBeUndefined()
  }
)
it.each(['no-caption', 'missing-deviation'])(
  'rejects an unsupported currency summary: %s',
  async (condition) => {
    const { recoverCurrencySummaryGrid } = await import(
      pathToFileURL(resolve('resources/pdf-structure/literature-pdf-wrapped-summary-grid.mjs')).href
    )
    const x = load('currency-deviations')
    if (condition === 'no-caption') x.captions = []
    else x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '204.17')
    expect(recoverCurrencySummaryGrid(x.table, x.tokens, x.captions)).toBeUndefined()
  }
)
it.each(['no-rule', 'partial-border'])(
  'does not infer closed category spans from %s',
  async (condition) => {
    const { recoverRuledHeaderGrid } = await import(
      pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-stub-grid.mjs')).href
    )
    const x = load('closed-category-1')
    if (condition === 'no-rule') x.rules = []
    else {
      const horizontal = x.rules
        .filter(
          (r: number[]) => r[1] === r[3] && r[1] > x.table.cropRect[1] && r[1] < x.table.cropRect[3]
        )
        .sort((a: number[], b: number[]) => a[1] - b[1])
      horizontal[0][2] -= 20
    }
    expect(recoverRuledHeaderGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
  }
)
it('retains the complete long treatment note once the final source border is recovered', async () => {
  const { associateTableNotes } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
  )
  const x = load('closed-treatment-note'),
    notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toContain('beta-blocker')
  expect(notes[0].text.length).toBeGreaterThan(500)
})
it('does not use a centered number as evidence when its supporting header rule is missing', async () => {
  const { findCaptionCandidates } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
  )
  const x = load('centered-title-before-headers')
  const captions = findCaptionCandidates([x.page], new Map())
  expect(
    captions.some((c: { lines: string[] }) => c.lines.join(' ').includes('Table 3. Coping'))
  ).toBe(false)
})
it('does not split the assessment header without its native parent underline', () => {
  const x = load('assessment-schedule')
  x.rules = []
  expect(parse(x).repairs).not.toContain('ruled-schedule-parent-split')
})
it('does not recover a closed grid by cutting off a retained final record', async () => {
  const { recoverRuledHeaderGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-stub-grid.mjs')).href
  )
  const x = load('closed-treatment-records')
  const bottom = Math.max(
    ...x.rules
      .filter((r: number[]) => r[1] === r[3] && r[1] <= x.table.cropRect[3] + 30)
      .map((r: number[]) => r[1])
  )
  x.rules = x.rules.filter((r: number[]) => r[1] !== bottom || r[3] !== bottom)
  expect(recoverRuledHeaderGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
it('includes the first treatment week under the native underline in a wide schedule', () => {
  const t = parse(load('treatment-week-header'))
  const parent = t.cells.find((c: { text: string }) => c.text === 'Treatment')
  expect(parent && [parent.row, parent.column, parent.rowSpan, parent.colSpan]).toEqual([
    0, 4, 1, 2
  ])
  expect(t.grid[1].slice(3, 7)).toEqual([
    'Post- randomisation',
    'wk 1',
    'wk 2 wk 3',
    'Weekly for 4 weeks post-RT'
  ])
})
