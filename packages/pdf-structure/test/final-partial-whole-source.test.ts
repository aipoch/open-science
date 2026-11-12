import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousPartialWholeSources } = await import(
  pathToFileURL(resolve('test/fixtures/partial-whole-source.mjs')).href
)
const segments = await import(
  pathToFileURL(resolve('resources/literature-pdf-source-segments.mjs')).href
)
const withdraw = segments.withdrawUnprovedPartialWholeSources
const { splitNativeMeasuredFields } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-header-grid.mjs')).href
)

it.each([1, 4])(
  'withdraws every unproved competing whole owner in %i actual native literal groups',
  async (rows) => {
    const f = await anonymousPartialWholeSources({ rows })
    try {
      expect(f.fonts).toHaveLength(rows)
      segments.refineMeasuredAssignedNumericSegments(f.table, f.items, f.runs)
      segments.attachMeasuredTableSourceSegments(f.table, f.items)
      expect(f.table.cells.every((c) => c.sourceItems?.length === 1 && !c.sourceSegments)).toBe(
        true
      )
      const display = f.table.cells.map((c) => ({
          text: c.text,
          rect: c.rect,
          sourceRects: c.sourceRects
        })),
        source = JSON.stringify(f.items)
      withdraw(f.table, f.items)
      expect(f.table.cells.every((c) => c.sourceItems === undefined && !c.sourceSegments)).toBe(
        true
      )
      expect(
        f.table.cells.map((c) => ({ text: c.text, rect: c.rect, sourceRects: c.sourceRects }))
      ).toEqual(display)
      expect(f.table.unassigned.filter((s) => s === 'Amber Indigo')).toHaveLength(rows)
      expect(f.table.unassigned).toContain('existing remainder')
      expect(f.table.issues).toEqual(
        expect.arrayContaining([
          'existing-review',
          'unassigned-source-text',
          'native-table-structure-ambiguous'
        ])
      )
      expect(f.table.reviewCandidate).toBe(false)
      expect(JSON.stringify(f.items)).toBe(source)
      const once = JSON.stringify(f.table)
      segments.refineMeasuredAssignedNumericSegments(f.table, f.items, f.runs)
      segments.attachMeasuredTableSourceSegments(f.table, f.items)
      withdraw(f.table, f.items)
      expect(JSON.stringify(f.table)).toBe(once)
      expect(
        f.table.cells.every((c) =>
          c.sourceTokens.every(
            (t) =>
              !t.sourceItem &&
              !t.sourceToken &&
              !t.sourceSegment &&
              !t.sourceItems &&
              !t.sourceSegments
          )
        )
      ).toBe(true)
    } finally {
      await f.cleanup()
    }
  }
)

it.each([
  'whole-cell',
  'shared-full-annotation',
  'already-segmented',
  'math',
  'other-row',
  'other-table',
  'missing-native',
  'inconsistent-origin',
  'third-owner',
  'nonadjacent',
  'deep-carrier',
  'uncovered-literal'
])('leaves %s outside the narrow final withdrawal grammar', async (mode) => {
  const f = await anonymousPartialWholeSources()
  try {
    const font = f.fonts[0]
    let target = f.table,
      inventory = f.items
    if (mode === 'whole-cell')
      target.cells = [
        {
          ...target.cells[0],
          text: font.text,
          sourceRects: [[...font.rect]],
          sourceTokens: [font],
          colSpan: 2
        }
      ]
    if (mode === 'shared-full-annotation')
      for (const c of target.cells) {
        c.text = font.text
        c.sourceRects = [[...font.rect]]
      }
    if (mode === 'already-segmented')
      for (const c of target.cells) {
        c.sourceSegments = [
          {
            ...font.sourceItem,
            start: c.column ? 6 : 0,
            end: c.column ? 12 : 5,
            rect: c.sourceRects[0]
          }
        ]
        delete c.sourceItems
      }
    if (mode === 'math') target.cells[0].textRuns = [{ text: 'Amber', position: 'superscript' }]
    if (mode === 'other-row') target.cells[1].row = 1
    if (mode === 'other-table')
      target = { parts: target.cells.map((c) => ({ ...f.table, cells: [c] })) }
    if (mode === 'missing-native') inventory = []
    if (mode === 'inconsistent-origin')
      target.cells[1].sourceItems = [{ ...font.sourceItem, text: 'foreign text' }]
    if (mode === 'third-owner')
      target.cells.push({
        ...target.cells[0],
        row: 1,
        text: font.text,
        sourceRects: [[...font.rect]],
        sourceTokens: [font]
      })
    if (mode === 'nonadjacent') target.cells[1].column = 3
    if (mode === 'deep-carrier')
      target.cells[0].sourceTokens[0].sourceToken = { ...font, sourceToken: font }
    if (mode === 'uncovered-literal') target.cells[1].text = 'Other'
    const before = JSON.stringify(target)
    withdraw(target, inventory)
    expect(JSON.stringify(target)).toBe(before)
  } finally {
    await f.cleanup()
  }
})

it('preserves actual strict measured SourceSegments and their nonproportional glyph bounds', async () => {
  const f = await anonymousPartialWholeSources({ wideGap: true })
  try {
    expect(f.fonts).toHaveLength(1)
    const font = f.fonts[0],
      leaves = splitNativeMeasuredFields(font, f.runs, font.height)
    expect(leaves).toHaveLength(2)
    const ranges = segments.measuredSourceRanges(
        { str: font.text, sourceItem: font.sourceItem },
        leaves.map((l) => l.text)
      ),
      tokens = leaves.map((leaf, n) => ({
        ...leaf,
        sourceItem: undefined,
        sourceSegment: { ...ranges[n], rect: leaf.rect }
      }))
    f.table.cells = leaves.map((leaf, column) => ({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: leaf.text,
      rect: [...leaf.rect],
      sourceRects: [[...leaf.rect]],
      sourceTokens: [
        { text: leaf.text, rect: leaf.rect, baseline: leaf.baseline, height: leaf.height }
      ]
    }))
    segments.attachMeasuredTableSourceSegments(f.table, tokens)
    expect(f.table.cells.every((c) => c.sourceSegments?.length === 1 && !c.sourceItems)).toBe(true)
    const before = JSON.stringify(f.table)
    withdraw(f.table, f.items)
    expect(JSON.stringify(f.table)).toBe(before)
  } finally {
    await f.cleanup()
  }
})
