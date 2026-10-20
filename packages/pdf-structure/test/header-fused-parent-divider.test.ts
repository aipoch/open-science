import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverRuledHeaderBands } = await import(
  pathToFileURL(resolve('resources/literature-pdf-source-records.mjs')).href
)
const { populateTableCellText } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href
)

function fixture(): {
  source: {
    text: string
    rect: number[]
    baseline: number
    height: number
    horizontal: boolean
    sourceItem: { pageNumber: number; index: number; text: string }
  }[]
  cuts: number[]
  rules: number[][]
} {
  const entries: [string, number, number, number][] = [
    ['Method', 5, 30, 27],
    ['Group A', 85, 130, 18],
    ['Group B', 220, 255, 18],
    ['Low Mid High', 44, 155, 42],
    ['Avg.', 170, 190, 42],
    ['First', 206, 225, 42],
    ['Last', 250, 270, 42]
  ]
  return {
    source: entries.map(([text, left, right, baseline], index) => ({
      text,
      rect: [left, baseline - 10, right, baseline],
      baseline,
      height: 10,
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text }
    })),
    cuts: [0, 40, 80, 120, 160, 200, 240, 280],
    rules: [
      [0, 0, 280, 0],
      [44, 25, 196, 25],
      [204, 25, 276, 25],
      [0, 50, 280, 50]
    ]
  }
}

it('does not turn a fused-child parent into a vertical span through its native divider', () => {
  const f = fixture()
  const before = structuredClone(f.source)
  const result = recoverRuledHeaderBands(f.source, f.cuts, f.rules, 0, 50)
  expect(result.rows).toHaveLength(2)
  expect(result.spans).not.toContainEqual({ row: 0, column: 2, rowSpan: 2, colSpan: 1 })
  expect(result.spans).toContainEqual({ row: 0, column: 0, rowSpan: 2, colSpan: 1 })
  expect(result.spans).toContainEqual({ row: 0, column: 5, rowSpan: 1, colSpan: 2 })
  expect(
    result.spans.some(
      (span: { column: number; colSpan: number }) => span.column === 1 && span.colSpan === 4
    )
  ).toBe(false)
  expect(f.source).toEqual(before)
  expect(f.source[3].sourceItem.text).toBe('Low Mid High')
})

it.each(['absent', 'neighbor', 'endpoint', 'padding', 'partial-ink'] as const)(
  'does not veto a vertical span for a %s divider',
  (kind) => {
    const f = fixture()
    f.rules.splice(1, 1)
    if (kind === 'neighbor') f.rules.push([44, 25, 75, 25])
    if (kind === 'endpoint') f.rules.push([44, 25, 80, 25])
    if (kind === 'padding') f.rules.push([44, 25, 83, 25])
    if (kind === 'partial-ink') f.rules.push([44, 25, 90, 25])
    const result = recoverRuledHeaderBands(f.source, f.cuts, f.rules, 0, 50)
    expect(result.spans).toContainEqual({ row: 0, column: 2, rowSpan: 2, colSpan: 1 })
  }
)

it('keeps an unmeasured fused child intact at the cell text entry point', () => {
  const f = fixture()
  const original = f.source[3]
  const items = [original]
  const before = structuredClone(original)
  const rows = [{ rect: [0, 0, 280, 25] }, { rect: [0, 25, 280, 50] }]
  const columnRects = f.cuts.slice(0, -1).map((left, index) => [left, 0, f.cuts[index + 1], 50])
  const cells = rows.flatMap((row, r) =>
    columnRects.map((rect, column) => ({
      row: r,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [rect[0], row.rect[1], rect[2], row.rect[3]],
      items: [],
      text: ''
    }))
  )
  const repairs: string[] = []
  const unassigned = populateTableCellText({
    cells,
    items,
    pageItems: items,
    rows,
    columnRects,
    headerRows: [0, 1],
    rules: f.rules,
    bottom: 50,
    issues: new Set(),
    repairs
  })
  expect(unassigned).toEqual(['Low Mid High'])
  expect(repairs).not.toContain('wide-source-run-split')
  expect(items).toEqual([before])
  expect(items[0]).toBe(original)
  expect(cells.every((cell) => !cell.text)).toBe(true)
})

function measuredHeaderFixture(): ReturnType<typeof JSON.parse> {
  const item = {
    text: 'Alpha Beta Gamma',
    rect: [5, 5, 115, 15],
    baseline: 15,
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: 0, text: 'Alpha Beta Gamma' }
  }
  const measuredRuns = [
    {
      ...structuredClone(item),
      literalGlyphs: [...'AlphaBetaGamma'],
      glyphRuns: Array(14).fill(1),
      gaps: [
        { left: 35, right: 45, index: 5 },
        { left: 75, right: 85, index: 9 }
      ]
    }
  ]
  const columnRects = [0, 40, 80].map((left) => [left, 0, left + 40, 20])
  return {
    items: [item],
    pageItems: [item],
    measuredRuns,
    cells: columnRects.map((rect, column) => ({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect,
      text: '',
      items: []
    })),
    columnRects,
    rows: [{ rect: [0, 0, 120, 20] }],
    headerRows: [0],
    rules: [],
    bottom: 20,
    issues: new Set(),
    repairs: []
  }
}

it('uses exact native header gaps while retaining the complete source owner', () => {
  const f = measuredHeaderFixture(),
    before = structuredClone(f.items)
  expect(populateTableCellText(f)).toEqual([])
  expect(f.cells.map((cell: { text: string }) => cell.text)).toEqual(['Alpha', 'Beta', 'Gamma'])
  expect(f.cells.map((cell: { sourceRects: number[][] }) => cell.sourceRects)).toEqual([
    [[5, 5, 35, 15]],
    [[45, 5, 75, 15]],
    [[85, 5, 115, 15]]
  ])
  expect(f.items).toEqual(before)
  for (const cell of f.cells) {
    expect(cell.sourceItems).toEqual([f.items[0].sourceItem])
  }
  expect(f.repairs).toContain('native-measured-header-run-split')
})

it.each([
  'absent',
  'duplicate-run',
  'baseline',
  'height',
  'rotated',
  'inside-glyph',
  'inside-word',
  'duplicate-gap',
  'crossed-gap',
  'nonfinite-gap',
  'competition',
  'duplicate-owner'
])('retains a complete fused header without %s native ownership proof', (kind) => {
  const f = measuredHeaderFixture(),
    run = f.measuredRuns[0]
  if (kind === 'absent') f.measuredRuns = []
  if (kind === 'duplicate-run') f.measuredRuns.push(structuredClone(run))
  if (kind === 'baseline') run.baseline++
  if (kind === 'height') run.height++
  if (kind === 'rotated') run.horizontal = false
  if (kind === 'inside-glyph') run.literalGlyphs = ['AlphaB', ...'etaGamma']
  if (kind === 'inside-word') run.gaps[0].index = 4
  if (kind === 'duplicate-gap') run.gaps.push({ ...run.gaps[0] })
  if (kind === 'crossed-gap') run.gaps[0].right = 81
  if (kind === 'nonfinite-gap') run.gaps[0].left = Number.NaN
  if (kind === 'competition') f.items.push({ ...f.items[0], text: 'Other', rect: [7, 6, 25, 14] })
  if (kind === 'duplicate-owner') f.cells.push(structuredClone(f.cells[0]))
  const before = structuredClone(f.items)
  expect(populateTableCellText(f)).toContain('Alpha Beta Gamma')
  expect(f.repairs).not.toContain('native-measured-header-run-split')
  expect(f.items).toEqual(before)
})

it('retains a complete multiword header in its fully containing existing cell', () => {
  const f = measuredHeaderFixture()
  f.measuredRuns = []
  f.cells = [{ ...f.cells[0], colSpan: 3, rect: [0, 0, 120, 20] }]
  expect(populateTableCellText(f)).toEqual([])
  expect(f.cells[0].text).toBe('Alpha Beta Gamma')
  expect(f.cells[0].sourceRects).toEqual([[5, 5, 115, 15]])
})

it('retains an existing parent span despite a competing partial leaf', () => {
  const f = measuredHeaderFixture()
  f.items[0].text = 'Parent title'
  f.items[0].rect = [30, 5, 79, 15]
  f.measuredRuns = []
  f.cells = [
    { ...f.cells[0], colSpan: 3, rect: [0, 0, 120, 20] },
    { ...f.cells[1], rect: [35, 0, 80, 20] }
  ]
  expect(populateTableCellText(f)).toEqual([])
  expect(f.cells[0].text).toBe('Parent title')
  expect(f.cells[1].text).toBe('')
})

it.each([false, true])(
  'requires a full native divider to reject a cross-column header (walls=%s)',
  (walls) => {
    const f = measuredHeaderFixture()
    f.items[0].text = 'Parent title'
    f.items[0].rect = [30, 5, 79, 15]
    f.measuredRuns = []
    if (walls)
      f.rules = [
        [0, 0, 120, 0],
        [0, 20, 120, 20],
        [0, 0, 0, 20],
        [120, 0, 120, 20],
        [40, 0, 40, 20]
      ]
    expect(populateTableCellText(f)).toEqual(walls ? ['Parent title'] : [])
    expect(f.cells[1].text).toBe(walls ? '' : 'Parent title')
    expect(f.repairs).not.toContain('wide-source-run-split')
  }
)

it.each([
  'complete',
  'enclosed-parent',
  'missing-wall',
  'partial-wall',
  'competing-face',
  'no-lower-divider',
  'baseline-endpoint'
])('requires a unique closed native parent face and lower divider: %s', (kind) => {
  const f = measuredHeaderFixture()
  f.items[0].text = 'Parent title'
  f.items[0].rect = [30, -1, 79, 15]
  f.items[0].height = 16
  f.measuredRuns = []
  f.rules = [
    [0, 0, 120, 0],
    [0, 20, 120, 20],
    [0, 40, 120, 40],
    [0, 0, 0, 40],
    [120, 0, 120, 40],
    [40, 20, 40, 40]
  ]
  if (kind === 'enclosed-parent') f.items[0].rect[1] = 5
  if (kind === 'missing-wall')
    f.rules = f.rules.filter((r: number[]) => r[0] !== r[2] || r[0] !== 0)
  if (kind === 'partial-wall') f.rules[3] = [0, 12, 0, 40]
  if (kind === 'competing-face') f.rules.push([60, 12, 60, 20])
  if (kind === 'no-lower-divider') f.rules.pop()
  if (kind === 'baseline-endpoint') {
    f.rules[3] = [0, 15, 0, 40]
    f.rules.push([40, 15, 40, 20])
  }
  expect(populateTableCellText(f)).toEqual(kind === 'complete' ? ['Parent title'] : [])
  expect(f.cells[1].text).toBe(kind === 'complete' ? '' : 'Parent title')
  expect(f.items[0].text).toBe('Parent title')
  expect(f.repairs).not.toContain('wide-source-run-split')
})
