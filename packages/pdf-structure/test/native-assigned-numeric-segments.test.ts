import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'
const { splitPdfNumericRuns, nativeWhitespaceGaps } = await import(
  pathToFileURL(resolve('resources/literature-pdf-symbol-text.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { refineMeasuredAssignedNumericSegments } = await import(
  pathToFileURL(resolve('resources/literature-pdf-source-segments.mjs')).href
)
type Origin = { pageNumber: number; index: number; text: string }
type Cell = {
  row: number
  column: number
  rowSpan: number
  colSpan: number
  text: string
  sourceRects: number[][]
  sourceTokens: Array<{ text: string; rect: number[]; sourceItem?: Origin }>
  sourceItems?: Origin[]
  sourceSegments?: Array<Origin & { start: number; end: number; rect: number[] }>
}
type Token = { text: string; rect: number[]; horizontal: boolean; sourceItem: Origin }
type Run = {
  text: string
  rect: number[]
  gaps: Array<{ left: number; right: number; index: number }>
}
function fixture(text = '12.5 12.5'): { table: { cells: Cell[] }; tokens: Token[]; runs: Run[] } {
  const sourceItem = { pageNumber: 1, index: 7, text },
    item = {
      str: text,
      dir: 'ltr',
      fontName: 'native',
      width: 44,
      height: 10,
      transform: [10, 0, 0, 10, 10, 50],
      sourceItem
    }
  const content = { items: [item] },
    operators = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [
        ['native', 10],
        [
          Array.from(text).map((unicode) => ({
            unicode,
            width: unicode === ' ' ? 400 : 500,
            isSpace: unicode === ' '
          }))
        ]
      ]
    }
  const viewport = {
    rotation: 0,
    scale: 1,
    transform: [1, 0, 0, -1, 0, 60],
    convertToViewportPoint: (x: number, y: number) => [x, 60 - y]
  }
  expect(splitPdfNumericRuns(content, operators).items).toEqual([item])
  const cells: Cell[] = [
    [10, 0, 32, 10],
    [32, 0, 54, 10]
  ].map((rect, column) => ({
    row: 2,
    column,
    rowSpan: 1,
    colSpan: 1,
    text: text.split(' ')[column],
    sourceRects: [rect],
    sourceTokens: [{ text: text.split(' ')[column], rect }],
    sourceItems: [sourceItem]
  }))
  return {
    table: { cells },
    tokens: [tableTextToken(item, viewport, 0)],
    runs: nativeWhitespaceGaps(content, operators, viewport)
  }
}
it('certifies complete textual leaves already cut at measured native glyph extents', () => {
  const { table, tokens, runs } = fixture('Plot Side')
  table.cells[0].sourceRects[0][2] = 30
  table.cells[1].sourceRects[0][0] = 34
  const before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table.cells.map((cell) => cell.sourceSegments)).toEqual([
    [{ pageNumber: 1, index: 7, text: 'Plot Side', start: 0, end: 4, rect: [10, 0, 30, 10] }],
    [{ pageNumber: 1, index: 7, text: 'Plot Side', start: 5, end: 9, rect: [34, 0, 54, 10] }]
  ])
  expect(
    table.cells.map((cell) => ({ ...cell, sourceItems: undefined, sourceSegments: undefined }))
  ).toEqual(
    before.cells.map((cell) => ({ ...cell, sourceItems: undefined, sourceSegments: undefined }))
  )
})
it.each([
  'estimated-clips',
  'missing-glyph',
  'overlap',
  'wrong-order',
  'missing-child',
  'different-row',
  'extra-origin',
  'wrong-grid',
  'unmeasured-gap'
])('does not certify textual leaf ownership without an exact native partition: %s', (variant) => {
  const { table, tokens, runs } = fixture('Plot Side')
  table.cells[0].sourceRects[0][2] = 30
  table.cells[1].sourceRects[0][0] = 34
  if (variant === 'estimated-clips') {
    table.cells[0].sourceRects[0][2] = 32
    table.cells[1].sourceRects[0][0] = 32
  }
  if (variant === 'missing-glyph') table.cells[0].sourceRects[0][2] = 25
  if (variant === 'overlap') table.cells[0].sourceRects[0][2] = 35
  if (variant === 'wrong-order') {
    table.cells[0].column = 1
    table.cells[1].column = 0
  }
  if (variant === 'missing-child') table.cells.pop()
  if (variant === 'different-row') table.cells[1].row++
  if (variant === 'extra-origin')
    table.cells[0].sourceItems?.push({ pageNumber: 1, index: 99, text: 'prefix' })
  if (variant === 'wrong-grid') Object.assign(table, { grid: [[], [], ['Side', 'Plot']] })
  if (variant === 'unmeasured-gap') runs[0].gaps.length = 0
  const before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table).toEqual(before)
})
it('only shrinks complete assigned numeric clips to actual native glyph extents', () => {
  const { table, tokens, runs } = fixture(),
    before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table.cells.map((cell) => cell.sourceRects)).toEqual([
    [[10, 0, 30, 10]],
    [[34, 0, 54, 10]]
  ])
  expect(table.cells.map((cell) => cell.sourceSegments?.map((s) => [s.start, s.end]))).toEqual([
    [[0, 4]],
    [[5, 9]]
  ])
  expect(table.cells.map(({ row, column, text }) => ({ row, column, text }))).toEqual(
    before.cells.map(({ row, column, text }) => ({ row, column, text }))
  )
  expect(table.cells.every((cell) => cell.sourceItems === undefined)).toBe(true)
})
it.each([
  'cut-through-glyph',
  'missing-child',
  'duplicate-owner',
  'different-row',
  'spanning',
  'nonadjacent-column',
  'wrong-parent',
  'wrong-token-owner',
  'conflicting-parent-text',
  'missing-measurement',
  'duplicate-measurement',
  'wrong-gap-index',
  'baseline-mismatch',
  'clip-outside-parent',
  'competing-region',
  'missing-token'
])('preserves the original assignment without unsafe refinement: %s', (variant) => {
  const { table, tokens, runs } = fixture()
  if (variant === 'cut-through-glyph') {
    table.cells[0].sourceRects[0][2] = 29
    table.cells[1].sourceRects[0][0] = 29
  }
  if (variant === 'missing-child') table.cells.pop()
  if (variant === 'duplicate-owner') table.cells.push(structuredClone(table.cells[0]))
  if (variant === 'different-row') table.cells[1].row++
  if (variant === 'spanning') table.cells[1].colSpan = 2
  if (variant === 'nonadjacent-column') table.cells[1].column++
  if (variant === 'wrong-parent')
    table.cells[1].sourceItems = [{ ...tokens[0].sourceItem, index: 99 }]
  if (variant === 'wrong-token-owner')
    table.cells[1].sourceTokens[0].sourceItem = { ...tokens[0].sourceItem, index: 99 }
  if (variant === 'conflicting-parent-text')
    table.cells[1].sourceItems = [{ ...tokens[0].sourceItem, text: '12.5 99.9' }]
  if (variant === 'missing-measurement') runs.length = 0
  if (variant === 'duplicate-measurement') runs.push(structuredClone(runs[0]))
  if (variant === 'wrong-gap-index') runs[0].gaps[0].index = 3
  if (variant === 'baseline-mismatch') runs[0].rect[1]++
  if (variant === 'clip-outside-parent') table.cells[0].sourceRects[0][0]--
  if (variant === 'competing-region')
    table.cells.push({
      ...structuredClone(table.cells[0]),
      sourceItems: [{ pageNumber: 1, index: 99, text: '12.5' }]
    })
  if (variant === 'missing-token') table.cells[0].sourceTokens = []
  const before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table).toEqual(before)
})
it('rejects a parent claimed by cells in different tables', () => {
  const { table, tokens, runs } = fixture(),
    joined = { parts: table.cells.map((cell) => ({ cells: [cell] })) },
    before = structuredClone(joined)
  refineMeasuredAssignedNumericSegments(joined, tokens, runs)
  expect(joined).toEqual(before)
})

it.each(['signed-range', 'token-only-claim', 'duplicate-native'])(
  'rejects additional original-source ownership even away from the measured rect: %s',
  (variant) => {
    const { table, tokens, runs } = fixture()
    if (variant === 'duplicate-native') tokens.push(structuredClone(tokens[0]))
    else {
      const extra: Cell = {
        row: 7,
        column: 0,
        rowSpan: 1,
        colSpan: 1,
        text: '12.5',
        sourceRects: [[80, 30, 100, 40]],
        sourceTokens: [{ text: '12.5', rect: [80, 30, 100, 40] }]
      }
      if (variant === 'signed-range')
        extra.sourceSegments = [
          { ...tokens[0].sourceItem, start: 0, end: 4, rect: [80, 30, 100, 40] }
        ]
      else extra.sourceTokens[0].sourceItem = tokens[0].sourceItem
      table.cells.push(extra)
    }
    const before = structuredClone(table)
    refineMeasuredAssignedNumericSegments(table, tokens, runs)
    expect(table).toEqual(before)
  }
)

it('does not borrow a measurement from another native identity at the same geometry', () => {
  const { table, tokens, runs } = fixture()
  tokens.push({ ...structuredClone(tokens[0]), sourceItem: { ...tokens[0].sourceItem, index: 99 } })
  const before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table).toEqual(before)
})

it('does not overwrite pre-existing segments from a different original source', () => {
  const { table, tokens, runs } = fixture()
  table.cells[0].sourceSegments = [
    { pageNumber: 1, index: 99, text: '12.5', start: 0, end: 4, rect: [10, 0, 32, 10] }
  ]
  const before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table).toEqual(before)
})

type MixedCell = Cell & { rect: number[]; textRuns?: Array<{ text: string; position: string }> }
function mixedFixture(label = 'Tag'): {
  table: { grid: string[][]; cells: MixedCell[] }
  tokens: Token[]
  runs: Array<Run & { literalGlyphs: string[] }>
} {
  const text = `${label} 16 116`,
    origin = { pageNumber: 1, index: 0, text }
  const item = {
    str: text,
    dir: 'ltr',
    fontName: 'native',
    width: 48,
    height: 10,
    transform: [10, 0, 0, 10, 10, 20],
    sourceItem: origin
  }
  const viewport = {
    rotation: 0,
    scale: 1,
    transform: [1, 0, 0, -1, 0, 100],
    convertToViewportPoint: (x: number, y: number) => [x, 100 - y]
  }
  const operators = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [
      ['native', 10],
      [
        Array.from(text).map((unicode) => ({
          unicode,
          width: unicode === ' ' ? 400 : 500,
          isSpace: unicode === ' '
        }))
      ]
    ]
  }
  const tokens: Token[] = [tableTextToken(item, viewport, 0)]
  const domains = [
    [9, 27],
    [27, 41],
    [41, 59]
  ]
  const clips = [
    [10, 70, 27, 80],
    [27, 70, 41, 80],
    [41, 70, 58, 80]
  ]
  const cells: MixedCell[] = clips.map((rect, column) => ({
    row: 2,
    column,
    rowSpan: 1,
    colSpan: 1,
    text: text.split(' ')[column],
    rect: [domains[column][0], 69, domains[column][1], 81],
    sourceItems: [origin],
    sourceRects: [rect],
    sourceTokens: [{ text: text.split(' ')[column], rect }]
  }))
  const grid = [
    ['Set', 'N', 'M'],
    ['XYZ', '12', '12'],
    [label, '16', '116']
  ]
  for (const row of [0, 1])
    for (const column of [0, 1, 2]) {
      const value = grid[row][column],
        y = row * 20 + 30
      const rect = [domains[column][0] + 1, y, domains[column][0] + 1 + value.length * 4, y + 10]
      const sourceItem = { pageNumber: 1, index: 10 + row * 3 + column, text: value }
      tokens.push({ text: value, rect, horizontal: true, sourceItem })
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: value,
        rect: [domains[column][0], y - 1, domains[column][1], y + 11],
        sourceRects: [rect],
        sourceTokens: [{ text: value, rect }],
        sourceItems: [sourceItem]
      })
    }
  return {
    table: { grid, cells },
    tokens,
    runs: nativeWhitespaceGaps({ items: [item] }, operators, viewport)
  }
}
it('rebuilds every mixed leaf from full glyphs and independent native header and peer columns', () => {
  const { table, tokens, runs } = mixedFixture(),
    before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table.cells.slice(0, 3).map((c) => c.sourceSegments)).toEqual([
    [{ pageNumber: 1, index: 0, text: 'Tag 16 116', start: 0, end: 3, rect: [10, 70, 25, 80] }],
    [{ pageNumber: 1, index: 0, text: 'Tag 16 116', start: 4, end: 6, rect: [29, 70, 39, 80] }],
    [{ pageNumber: 1, index: 0, text: 'Tag 16 116', start: 7, end: 10, rect: [43, 70, 58, 80] }]
  ])
  expect(table.grid).toEqual(before.grid)
  expect(table.cells.slice(3)).toEqual(before.cells.slice(3))
  expect(table.cells.map((c) => [c.row, c.column, c.text, c.textRuns])).toEqual(
    before.cells.map((c) => [c.row, c.column, c.text, c.textRuns])
  )
})

it('uses UTF-16 ranges while preserving measured Unicode glyph widths', () => {
  const { table, tokens, runs } = mixedFixture('𝑻ag')
  table.cells[0].textRuns = [{ text: '𝑻ag', position: 'normal' }]
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(
    table.cells.slice(0, 3).map((c) => c.sourceSegments?.map((s) => [s.start, s.end]))
  ).toEqual([[[0, 4]], [[5, 7]], [[8, 11]]])
  expect(table.cells[0].textRuns).toEqual([{ text: '𝑻ag', position: 'normal' }])
})
it.each([
  'missing-header',
  'missing-peer',
  'incomplete-peer',
  'wrong-peer-grid',
  'wrong-header-runs',
  'estimated-header',
  'wrong-peer-domain',
  'duplicate-header-owner',
  'duplicate-target-slot',
  'spanning-target-slot',
  'wrong-row',
  'wrong-column',
  'wrong-grid',
  'wrong-runs',
  'missing-glyph',
  'wrong-glyph',
  'wrong-gap-index',
  'duplicate-measurement',
  'missing-leaf',
  'wrong-cell-domain',
  'parent-segment-alias',
  'nested-parent-alias',
  'header-segment-alias',
  'peer-segment-alias',
  'conflicting-parent-carrier',
  'external-cell-alias',
  'external-part-alias',
  'competing-geometry',
  'partial-source-text'
])('does not rebuild mixed leaves without complete independent proof: %s', (variant) => {
  const { table, tokens, runs } = mixedFixture()
  const head = table.cells[3],
    peer = table.cells[6]
  if (variant === 'missing-header') table.cells = table.cells.filter((c) => c.row !== 0)
  if (variant === 'missing-peer') table.cells = table.cells.filter((c) => c.row !== 1)
  if (variant === 'incomplete-peer') table.cells.splice(7, 1)
  if (variant === 'wrong-peer-grid') table.grid[1][0] = 'WRONG'
  if (variant === 'wrong-header-runs') head.textRuns = [{ text: 'WRONG', position: 'normal' }]
  if (variant === 'estimated-header') {
    head.sourceRects = [head.sourceRects[0].map((v, i) => (i === 2 ? v + 1 : v))]
    head.sourceTokens[0].rect = [...head.sourceRects[0]]
  }
  if (variant === 'wrong-peer-domain') peer.rect[0]++
  if (variant === 'duplicate-header-owner') table.cells.push(structuredClone(head))
  if (variant === 'duplicate-target-slot')
    table.cells.push({ ...structuredClone(head), row: 2, column: 0 })
  if (variant === 'spanning-target-slot')
    table.cells.push({ ...structuredClone(head), row: 1, column: 0, rowSpan: 2 })
  if (variant === 'wrong-row') table.cells[1].row++
  if (variant === 'wrong-column') table.cells[1].column++
  if (variant === 'wrong-grid') table.grid[2][0] = 'WRONG'
  if (variant === 'wrong-runs') table.cells[0].textRuns = [{ text: 'WRONG', position: 'normal' }]
  if (variant === 'missing-glyph') runs[0].literalGlyphs.pop()
  if (variant === 'wrong-glyph') runs[0].literalGlyphs[0] = 'X'
  if (variant === 'wrong-gap-index') runs[0].gaps[0].index--
  if (variant === 'duplicate-measurement') runs.push(structuredClone(runs[0]))
  if (variant === 'missing-leaf') table.cells.splice(1, 1)
  if (variant === 'wrong-cell-domain') table.cells[1].rect[2] = 38
  if (
    variant === 'parent-segment-alias' ||
    variant === 'header-segment-alias' ||
    variant === 'peer-segment-alias'
  ) {
    const source =
      variant === 'header-segment-alias'
        ? head.sourceItems![0]
        : variant === 'peer-segment-alias'
          ? peer.sourceItems![0]
          : tokens[0].sourceItem
    tokens.push(
      Object.assign(
        { text: source.text, rect: [80, 80, 99, 90], horizontal: true },
        { sourceSegment: { ...source, start: 0, end: source.text.length, rect: [80, 80, 99, 90] } }
      ) as unknown as Token
    )
  }
  if (variant === 'nested-parent-alias')
    tokens.push(
      Object.assign(
        { text: 'Tag', rect: [80, 80, 99, 90], horizontal: true },
        {
          sourceToken: {
            sourceSegment: { ...tokens[0].sourceItem, start: 0, end: 3, rect: [80, 80, 99, 90] }
          }
        }
      ) as unknown as Token
    )
  if (variant === 'conflicting-parent-carrier')
    Object.assign(tokens[0], { sourceToken: { ...tokens[0].sourceItem, index: 99 } })
  if (variant === 'external-cell-alias' || variant === 'external-part-alias') {
    const extra = {
      ...structuredClone(head),
      row: 9,
      sourceItems: undefined,
      sourceSegments: [{ ...tokens[0].sourceItem, start: 0, end: 3, rect: [80, 80, 99, 90] }]
    }
    if (variant === 'external-part-alias') Object.assign(table, { parts: [{ cells: [extra] }] })
    else table.cells.push(extra)
  }
  if (variant === 'competing-geometry')
    table.cells.push({ ...structuredClone(head), row: 9, sourceRects: [[10, 70, 25, 80]] })
  if (variant === 'partial-source-text') table.cells[0].sourceTokens[0].text = 'Ta'
  const before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table).toEqual(before)
})
it('ignores an unrelated external source segment with a different identity', () => {
  const { table, tokens, runs } = mixedFixture()
  tokens.push(
    Object.assign(
      { text: 'X', rect: [80, 80, 99, 90], horizontal: true },
      {
        sourceSegment: {
          pageNumber: 1,
          index: 99,
          text: 'X',
          start: 0,
          end: 1,
          rect: [80, 80, 99, 90]
        }
      }
    ) as unknown as Token
  )
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table.cells.slice(0, 3).every((c) => c.sourceSegments?.length === 1)).toBe(true)
})

it('preserves an independently owned rich native header while rebuilding mixed leaves', () => {
  const { table, tokens, runs } = mixedFixture()
  const header = table.cells[4],
    base = tokens[2]
  base.text = 'n'
  base.sourceItem = { ...base.sourceItem, text: 'n' }
  base.rect = [28, 30, 32, 40]
  const sub = {
    text: 'e',
    rect: [32, 35, 35, 40],
    horizontal: true,
    sourceItem: { pageNumber: 1, index: 50, text: 'e' }
  }
  tokens.push(sub)
  header.text = 'ne'
  table.grid[0][1] = 'ne'
  header.sourceItems = [base.sourceItem, sub.sourceItem]
  header.sourceRects = [base.rect, sub.rect]
  header.sourceTokens = [
    { text: 'n', rect: base.rect },
    { text: 'e', rect: sub.rect }
  ]
  header.textRuns = [
    { text: 'n', position: 'normal' },
    { text: 'e', position: 'subscript' }
  ]
  const before = structuredClone(header)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table.cells.slice(0, 3).every((c) => c.sourceSegments?.length === 1)).toBe(true)
  expect(header).toEqual(before)
})
it.each([
  'overlapping-domains',
  'row-domain-mismatch',
  'vertical-order',
  'peer-geometry-competitor'
])('requires disjoint ordered row and column domains: %s', (variant) => {
  const { table, tokens, runs } = mixedFixture()
  if (variant === 'overlapping-domains')
    for (const c of table.cells.filter((c) => c.column === 1)) c.rect[0]--
  if (variant === 'row-domain-mismatch') table.cells[1].rect[1]--
  if (variant === 'vertical-order') {
    for (const c of table.cells.filter((c) => c.row === 1)) c.row = 3
    table.grid[3] = table.grid[1]
  }
  if (variant === 'peer-geometry-competitor')
    table.cells.push({
      ...structuredClone(table.cells[6]),
      row: 8,
      sourceItems: [{ pageNumber: 1, index: 77, text: 'XYZ' }]
    })
  const before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table).toEqual(before)
})

it.each([0, 1])('rejects unassigned native ink inside independent witness row %s', (row) => {
  const { table, tokens, runs } = mixedFixture()
  tokens.push({
    text: 'Other',
    rect: [12, 31 + row * 20, 23, 39 + row * 20],
    horizontal: true,
    sourceItem: { pageNumber: 1, index: 99, text: 'Other' }
  })
  const before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  expect(table).toEqual(before)
})

it.each([
  'complete',
  'missing-owner',
  'partial-source',
  'duplicate-owner',
  'same-row',
  'overlapping-ink',
  'segment-alias'
])('distinguishes adjacent-row native ownership from witness model padding: %s', (variant) => {
  const { table, tokens, runs } = mixedFixture()
  for (const c of table.cells.filter((c) => c.row === 2)) c.row = 3
  table.grid[3] = table.grid[2]
  table.grid[2] = ['Pad', '', '']
  const sourceItem = { pageNumber: 1, index: 99, text: 'Pad' },
    rect = [10, 60, 22, 68]
  tokens.push({ text: 'Pad', rect: [...rect], horizontal: true, sourceItem })
  const adjacent: MixedCell = {
    row: 2,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: 'Pad',
    rect: [9, 60, 27, 69],
    sourceItems: [sourceItem],
    sourceRects: [[...rect]],
    sourceTokens: [{ text: 'Pad', rect: [...rect] }]
  }
  table.cells.push(adjacent)
  if (variant === 'missing-owner') table.cells.pop()
  if (variant === 'partial-source') adjacent.sourceRects[0][2]--
  if (variant === 'duplicate-owner') table.cells.push(structuredClone(adjacent))
  if (variant === 'same-row') adjacent.row = 1
  if (variant === 'overlapping-ink') {
    tokens.at(-1)!.rect[1] = 59
    adjacent.sourceRects[0][1] = 59
    adjacent.sourceTokens[0].rect[1] = 59
  }
  if (variant === 'segment-alias')
    tokens.push(
      Object.assign(
        { text: 'P', rect: [80, 80, 90, 90], horizontal: true },
        { sourceSegment: { ...sourceItem, start: 0, end: 1, rect: [80, 80, 90, 90] } }
      ) as unknown as Token
    )
  const before = structuredClone(table)
  refineMeasuredAssignedNumericSegments(table, tokens, runs)
  if (variant === 'complete')
    expect(table.cells.slice(0, 3).every((c) => c.sourceSegments?.length === 1)).toBe(true)
  else expect(table).toEqual(before)
})
