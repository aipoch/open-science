import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const { splitPdfNumericRuns } = await import(
  pathToFileURL(resolve('resources/literature-pdf-symbol-text.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { attachMeasuredTableSourceSegments, refineMeasuredAssignedNumericSegments } = await import(
  pathToFileURL(resolve('resources/literature-pdf-source-segments.mjs')).href
)

type Origin = { pageNumber: number; index: number; text: string }
type Range = Origin & { start: number; end: number }
type Segment = Range & { rect: number[] }
type Glyph = { unicode: string; width: number; isSpace: boolean }
type NativeItem = {
  str: string
  dir: string
  fontName: string
  width: number
  height: number
  transform: number[]
  sourceItem?: Origin
  sourceSegment?: Range
}
type Token = { text: string; rect: number[]; sourceItem?: Origin; sourceSegment?: Segment }
type Cell = {
  row?: number
  column?: number
  text: string
  sourceRects: number[][]
  sourceTokens: Array<{ text: string; rect: number[] }>
  sourceItems?: Origin[]
  sourceSegments?: Segment[]
}
type Fixture = {
  content: { items: NativeItem[] }
  operators: { fnArray: number[]; argsArray: Array<Array<string | number | Glyph[]>> }
  viewport: {
    rotation: number
    scale: number
    transform: number[]
    convertToViewportPoint: (x: number, y: number) => number[]
  }
}
function fixture(text = '12.5 12.5'): Fixture {
  const glyphs = Array.from(text).map((unicode) => ({
    unicode,
    width: /\s/u.test(unicode) ? 1000 : 500,
    isSpace: /\s/u.test(unicode)
  }))
  const item = {
    str: text,
    dir: 'ltr',
    fontName: 'native',
    width: glyphs.reduce((n, g) => n + g.width / 100, 0),
    height: 10,
    transform: [10, 0, 0, 10, 10, 50],
    sourceItem: { pageNumber: 1, index: 7, text }
  }
  const content = { items: [item] },
    operators = { fnArray: [OPS.setFont, OPS.showText], argsArray: [['native', 10], [glyphs]] }
  const viewport = {
    rotation: 0,
    scale: 1,
    transform: [1, 0, 0, -1, 0, 60],
    convertToViewportPoint: (x: number, y: number) => [x, 60 - y]
  }
  return { content, operators, viewport }
}
function split(text?: string): Token[] {
  const { content, operators, viewport } = fixture(text)
  return splitPdfNumericRuns(content, operators).items.map((item: NativeItem) =>
    tableTextToken(item, viewport, 0)
  )
}
const cellsFor = (tokens: Token[]): Cell[] =>
  tokens.map((token, column) => ({
    row: 0,
    column,
    text: token.text,
    sourceRects: [token.rect],
    sourceTokens: [{ text: token.text, rect: token.rect }]
  }))

it('retains exact distinct UTF16 source ranges and measured whitespace gaps for repeated numeric values', () => {
  const tokens = split(),
    cells = cellsFor(tokens)
  expect(tokens).toHaveLength(2)
  expect(tokens.map((t) => t.sourceItem)).toEqual([undefined, undefined])
  attachMeasuredTableSourceSegments({ cells }, tokens)
  expect(cells.map((c) => c.sourceSegments)).toEqual([
    [{ pageNumber: 1, index: 7, text: '12.5 12.5', start: 0, end: 4, rect: [10, 0, 30, 10] }],
    [{ pageNumber: 1, index: 7, text: '12.5 12.5', start: 5, end: 9, rect: [40, 0, 60, 10] }]
  ])
})

it('keeps UTF16 offsets for astral glyphs and literal whitespace', () => {
  const { content, operators, viewport } = fixture('𝛼X  Beta')
  const rules = [0, 20, 40, 60].map((y) => [0, y, 100, y])
  for (const x of [0, 30, 80, 100]) rules.push([x, 0, x, 60])
  const tokens = splitPdfNumericRuns(content, operators, { viewport, rules }).items.map(
    (item: NativeItem) => tableTextToken(item, viewport, 0)
  )
  expect(tokens.map((t: Token) => t.text)).toEqual(['𝛼X', 'Beta'])
  expect(tokens.map((t: Token) => [t.sourceSegment!.start, t.sourceSegment!.end])).toEqual([
    [0, 3],
    [5, 9]
  ])
})

it.each([
  'origin-text-changed',
  'no-origin',
  'unmeasured-width',
  'ordinary-inline-space',
  'already-segmented'
])('does not sign unsupported native provenance: %s', (variant) => {
  const { content, operators } = fixture()
  const item = content.items[0]
  if (variant === 'origin-text-changed') item.sourceItem!.text = 'other source'
  if (variant === 'no-origin') delete item.sourceItem
  if (variant === 'unmeasured-width') item.width += 1
  if (variant === 'ordinary-inline-space') {
    ;(operators.argsArray[1][0] as Glyph[])[4].width = 200
    item.width -= 8
  }
  if (variant === 'already-segmented')
    item.sourceSegment = { pageNumber: 1, index: 7, text: item.str, start: 0, end: item.str.length }
  const result = splitPdfNumericRuns(content, operators).items
  expect(result.every((i: NativeItem) => !i.sourceSegment)).toBe(true)
})

it('covers a mixed cell with whole native sources while keeping separate parent ranges', () => {
  const tokens = split(),
    extra = {
      text: '*',
      rect: [62, 0, 67, 10],
      sourceItem: { pageNumber: 1, index: 8, text: '*' }
    },
    cells = cellsFor(tokens)
  tokens.push(extra)
  cells[1].sourceRects.push(extra.rect)
  cells[1].sourceTokens.push({ text: extra.text, rect: extra.rect })
  cells[1].text += ' *'
  attachMeasuredTableSourceSegments({ cells }, tokens)
  expect(cells[1].sourceSegments).toHaveLength(2)
  expect(cells[1].sourceSegments![1]).toEqual({
    ...extra.sourceItem,
    start: 0,
    end: 1,
    rect: extra.rect
  })
  expect(cells[1].sourceItems).toBeUndefined()
})

it.each([
  'duplicate-cell',
  'duplicate-native',
  'changed-text',
  'changed-rect',
  'unmatched-region',
  'inconsistent-parent',
  'whole-owner-elsewhere',
  'overlapping-range'
])('keeps ambiguous or incomplete cell ownership unsigned: %s', (variant) => {
  const tokens = split(),
    cells = cellsFor(tokens)
  if (variant === 'duplicate-cell') cells.push(structuredClone(cells[0]))
  if (variant === 'duplicate-native') tokens.push(structuredClone(tokens[0]))
  if (variant === 'changed-text') cells[0].sourceTokens[0].text = 'rewritten'
  if (variant === 'changed-rect') tokens[0].sourceSegment!.rect = [9, 0, 30, 10]
  if (variant === 'unmatched-region') {
    cells[0].sourceRects.push([70, 0, 75, 10])
    cells[0].sourceTokens.push({ text: '*', rect: [70, 0, 75, 10] })
  }
  if (variant === 'inconsistent-parent') tokens[1].sourceSegment!.text = 'XX.X 12.5'
  if (variant === 'whole-owner-elsewhere')
    cells.push({
      text: '12.5 12.5',
      sourceTokens: [],
      sourceItems: [{ pageNumber: 1, index: 7, text: '12.5 12.5' }],
      sourceRects: [[10, 20, 60, 30]]
    })
  if (variant === 'overlapping-range') {
    tokens[1].sourceSegment!.start = 0
    tokens[1].sourceSegment!.end = 4
  }
  attachMeasuredTableSourceSegments({ cells }, tokens)
  expect(cells[0].sourceSegments).toBeUndefined()
})

it('rejects a measured fragment copied across table parts', () => {
  const tokens = split(),
    cells = cellsFor(tokens),
    duplicate = structuredClone(cells[0])
  attachMeasuredTableSourceSegments(
    { parts: [{ cells }, { parts: [{ cells: [duplicate] }] }] },
    tokens
  )
  expect(cells[0].sourceSegments).toBeUndefined()
  expect(duplicate.sourceSegments).toBeUndefined()
})

it('sorts mixed source evidence by original source index without reordering source regions', () => {
  const tokens = split(),
    extra: Token = {
      text: '*',
      rect: [62, 0, 67, 10],
      sourceItem: { pageNumber: 1, index: 3, text: '*' }
    },
    cells = cellsFor(tokens)
  tokens.push(extra)
  cells[1].sourceRects.push(extra.rect)
  cells[1].sourceTokens.push({ text: extra.text, rect: extra.rect })
  const regions = structuredClone(cells[1].sourceRects)
  attachMeasuredTableSourceSegments({ cells }, tokens)
  expect(cells[1].sourceSegments?.map((s) => s.index)).toEqual([3, 7])
  expect(cells[1].sourceRects).toEqual(regions)
})

it.each(['cell', 'token', 'segment'])(
  'preserves conflicting pre-existing provenance: %s',
  (variant) => {
    const tokens = split(),
      cells = cellsFor(tokens),
      foreign = { pageNumber: 1, index: 99, text: '12.5' }
    if (variant === 'cell') cells[0].sourceItems = [foreign]
    if (variant === 'token') Object.assign(cells[0].sourceTokens[0], { sourceItem: foreign })
    if (variant === 'segment')
      Object.assign(cells[0].sourceTokens[0], {
        sourceSegment: { ...foreign, start: 0, end: 4, rect: [10, 0, 30, 10] }
      })
    const before = structuredClone(cells[0])
    attachMeasuredTableSourceSegments({ cells }, tokens)
    expect(cells[0]).toEqual(before)
  }
)

it('counts already-signed claims from other parts before signing a duplicate range', () => {
  const tokens = split(),
    cells = cellsFor(tokens),
    existing = {
      text: '12.5',
      sourceRects: [[10, 20, 30, 30]],
      sourceSegments: [{ ...tokens[0].sourceSegment! }]
    }
  attachMeasuredTableSourceSegments({ parts: [{ cells }, { cells: [existing] }] }, tokens)
  expect(cells[0].sourceSegments).toBeUndefined()
})

it('retains token-only competing provenance from an incomplete cell', () => {
  const tokens = split(),
    cells = cellsFor(tokens)
  const other = {
    text: '12.5',
    sourceRects: [[10, 20, 30, 30]],
    sourceTokens: [
      {
        text: '12.5',
        rect: [10, 20, 30, 30],
        sourceItem: { pageNumber: 1, index: 7, text: '12.5 12.5' }
      }
    ]
  }
  attachMeasuredTableSourceSegments({ parts: [{ cells }, { cells: [other] }] }, tokens)
  expect(cells[0].sourceSegments).toBeUndefined()
})

// Final assignment already owns these exact native leaves; only provenance may change.
function assignedMeasuredLeaves(
  text = 'Beta field Beta field',
  leaves = ['Beta field', 'Beta field'],
  gapIndexes = [4, 9, 13]
): {
  table: {
    grid: string[][]
    cells: Array<
      Cell & {
        row: number
        column: number
        rowSpan: number
        colSpan: number
        rect: number[]
        textRuns?: Array<{ text: string; position: string }>
      }
    >
  }
  tokens: Array<Token & { horizontal: boolean; height: number; baseline: number }>
  observations: Array<{
    text: string
    rect: number[]
    literalGlyphs: string[]
    glyphRuns: number[]
    gaps: Array<{ index: number; left: number; right: number }>
  }>
} {
  const origin = { pageNumber: 1, index: 7, text }
  return {
    table: {
      grid: [leaves.slice()],
      cells: leaves.map((text, column) => ({
        row: 0,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [10 + column * 55, 5, 65 + column * 55, 25],
        text,
        sourceItems: [{ ...origin }],
        sourceRects: [[10 + column * 55, 10, 55 + column * 55, 20]],
        sourceTokens: [{ text, rect: [10 + column * 55, 10, 55 + column * 55, 20] }]
      }))
    },
    tokens: [
      {
        text,
        sourceItem: origin,
        rect: [10, 10, 110, 20],
        horizontal: true,
        height: 10,
        baseline: 20
      }
    ],
    observations: [
      {
        text,
        rect: [10, 10, 110, 20],
        literalGlyphs: Array.from(text.replace(/\s/gu, '')),
        glyphRuns: Array(Array.from(text.replace(/\s/gu, '')).length).fill(1),
        gaps: [
          { index: gapIndexes[0], left: 30, right: 32 },
          { index: gapIndexes[1], left: 55, right: 65 },
          { index: gapIndexes[2], left: 85, right: 87 }
        ]
      }
    ]
  }
}

it.each([
  {
    text: 'Beta field Beta field',
    leaves: ['Beta field', 'Beta field'],
    gaps: [4, 9, 13],
    ranges: [
      [0, 10],
      [11, 21]
    ]
  },
  {
    text: '1e-2 (3e-4) 1e-2 (3e-4)',
    leaves: ['1e-2 (3e-4)', '1e-2 (3e-4)'],
    gaps: [4, 10, 14],
    ranges: [
      [0, 11],
      [12, 23]
    ]
  },
  {
    text: ' 😀Beta field Beta field  ',
    leaves: ['😀Beta field', 'Beta field'],
    gaps: [5, 10, 14],
    ranges: [
      [1, 13],
      [14, 24]
    ]
  }
])(
  'annotates complete measured leaves without changing text or geometry: $text',
  ({ text, leaves, gaps, ranges }) => {
    const f = assignedMeasuredLeaves(text, leaves, gaps),
      before = structuredClone(f)
    refineMeasuredAssignedNumericSegments(f.table, f.tokens, f.observations)
    expect(f.table.cells.map((c) => c.sourceSegments?.map((s) => [s.start, s.end]))).toEqual(
      ranges.map((r) => [r])
    )
    for (const [index, cell] of f.table.cells.entries()) {
      expect(cell.sourceItems).toBeUndefined()
      expect(cell.sourceSegments).toEqual([
        {
          pageNumber: 1,
          index: 7,
          text,
          start: ranges[index][0],
          end: ranges[index][1],
          rect: before.table.cells[index].sourceRects[0]
        }
      ])
      const actual = { ...cell },
        expected = { ...before.table.cells[index] }
      delete actual.sourceSegments
      delete expected.sourceItems
      expect(actual).toEqual(expected)
    }
    expect(f.tokens).toEqual(before.tokens)
    expect(f.observations).toEqual(before.observations)
    expect(f.table.grid).toEqual(before.table.grid)
  }
)

it.each([
  'missing-leaf',
  'wrong-last-rect',
  'wrong-grid',
  'wrong-rich-runs',
  'extra-owner',
  'deep-carrier',
  'wrong-glyph'
])('rejects incomplete measured parent evidence atomically: %s', (variant) => {
  const f = assignedMeasuredLeaves()
  if (variant === 'missing-leaf') f.table.cells.pop()
  if (variant === 'wrong-last-rect') f.table.cells[1].sourceRects[0][0] += 0.001
  if (variant === 'wrong-grid') f.table.grid[0][1] = 'other'
  if (variant === 'wrong-rich-runs')
    f.table.cells[1].textRuns = [{ text: 'other', position: 'normal' }]
  if (variant === 'extra-owner')
    f.table.cells.push({
      ...structuredClone(f.table.cells[0]),
      row: 5,
      sourceRects: [[200, 200, 245, 210]]
    })
  if (variant === 'deep-carrier')
    Object.assign(f.table.cells[1].sourceTokens[0], {
      sourceToken: { sourceToken: { sourceItem: { ...f.tokens[0].sourceItem } } }
    })
  if (variant === 'wrong-glyph') f.observations[0].literalGlyphs[0] = 'X'
  const before = structuredClone(f)
  refineMeasuredAssignedNumericSegments(f.table, f.tokens, f.observations)
  expect(f).toEqual(before)
})

it.each(['direct', 'nested', 'plural'])(
  'rejects a geometry-distant source alias: %s',
  (variant) => {
    const f = assignedMeasuredLeaves(),
      alias = {
        text: 'away',
        rect: [200, 200, 230, 210],
        horizontal: true,
        height: 10,
        baseline: 210
      }
    const origin = { ...f.tokens[0].sourceItem! }
    if (variant === 'direct') Object.assign(alias, { sourceItem: origin })
    if (variant === 'nested')
      Object.assign(alias, { sourceToken: { sourceSegment: { ...origin, start: 0, end: 4 } } })
    if (variant === 'plural') Object.assign(alias, { sourceItems: [origin] })
    f.tokens.push(alias)
    const before = structuredClone(f)
    refineMeasuredAssignedNumericSegments(f.table, f.tokens, f.observations)
    expect(f).toEqual(before)
  }
)

it('accepts an unrelated outside identity without changing it', () => {
  const f = assignedMeasuredLeaves(),
    outside = {
      text: 'away',
      rect: [200, 200, 230, 210],
      horizontal: true,
      height: 10,
      baseline: 210,
      sourceItem: { pageNumber: 1, index: 99, text: 'away' }
    }
  f.tokens.push(outside)
  const before = structuredClone(f.tokens)
  refineMeasuredAssignedNumericSegments(f.table, f.tokens, f.observations)
  expect(f.table.cells.every((c) => c.sourceSegments?.length === 1)).toBe(true)
  expect(f.tokens).toEqual(before)
})

function assignedSharedDescriptor(): ReturnType<typeof assignedMeasuredLeaves> {
  const f = assignedMeasuredLeaves()
  f.table.cells[0].rowSpan = 3
  f.table.cells[0].rect[3] = 65
  for (let row = 1; row < 3; row++) {
    const text = `Class${row}`,
      rect = [65, 10 + row * 20, 110, 20 + row * 20],
      sourceItem = { pageNumber: 1, index: 20 + row, text }
    f.tokens.push({ text, rect, sourceItem, horizontal: true, height: 10, baseline: rect[3] })
    f.table.grid.push(['', text])
    f.table.cells.push({
      row,
      column: 1,
      rowSpan: 1,
      colSpan: 1,
      text,
      rect: [65, 5 + row * 20, 120, 25 + row * 20],
      sourceItems: [{ ...sourceItem }],
      sourceRects: [[...rect]],
      sourceTokens: [{ text, rect: [...rect] }]
    })
  }
  return f
}

it('partitions a measured descriptor while preserving a complete existing shared-row owner', () => {
  const f = assignedSharedDescriptor(),
    before = structuredClone(f)
  refineMeasuredAssignedNumericSegments(f.table, f.tokens, f.observations)
  expect(
    f.table.cells.slice(0, 2).map((c) => c.sourceSegments?.map((s) => [s.start, s.end]))
  ).toEqual([[[0, 10]], [[11, 21]]])
  expect(f.table.cells[0].rowSpan).toBe(3)
  expect(f.table.cells.slice(2)).toEqual(before.table.cells.slice(2))
  expect(f.table.grid).toEqual(before.table.grid)
  expect(f.tokens).toEqual(before.tokens)
})

it('uses exact native peer baselines when model row edges cross font ascenders', () => {
  const f = assignedSharedDescriptor()
  f.table.cells[2].rect[1] = 32
  refineMeasuredAssignedNumericSegments(f.table, f.tokens, f.observations)
  expect(f.table.cells.slice(0, 2).every((c) => c.sourceSegments?.length === 1)).toBe(true)
})

it.each([
  'covered-slot-owner',
  'covered-grid-text',
  'missing-peer',
  'peer-source-alias',
  'peer-source-literal',
  'peer-carrier-alias',
  'peer-baseline-outside',
  'unknown-parent-ink',
  'peer-overlap',
  'span-outside-grid',
  'second-leaf-spans'
])(
  'does not transport a measured descriptor across an unproved shared-row assignment: %s',
  (variant) => {
    const f = assignedSharedDescriptor()
    if (variant === 'covered-slot-owner')
      f.table.cells.push({ ...structuredClone(f.table.cells[2]), column: 0 })
    if (variant === 'covered-grid-text') f.table.grid[1][0] = 'Other'
    if (variant === 'missing-peer') f.table.cells.splice(2, 1)
    if (variant === 'peer-source-alias') f.tokens.push(structuredClone(f.tokens[1]))
    if (variant === 'peer-source-literal') f.table.cells[2].sourceItems![0].text = 'Other'
    if (variant === 'peer-carrier-alias')
      Object.assign(f.table.cells[2].sourceTokens[0], { sourceItems: [f.tokens[0].sourceItem] })
    if (variant === 'peer-baseline-outside') f.table.cells[2].rect[3] = 39
    if (variant === 'unknown-parent-ink')
      f.tokens.push({
        text: 'Other',
        rect: [20, 30, 50, 40],
        horizontal: true,
        height: 10,
        baseline: 40
      })
    if (variant === 'peer-overlap') f.table.cells[2].sourceRects[0][1] = 19
    if (variant === 'span-outside-grid') f.table.cells[0].rowSpan = 4
    if (variant === 'second-leaf-spans') f.table.cells[1].rowSpan = 2
    const before = structuredClone(f)
    refineMeasuredAssignedNumericSegments(f.table, f.tokens, f.observations)
    expect(f).toEqual(before)
  }
)

it.each([false, true])(
  'preserves the existing numeric gap rule (extra internal gap: %s)',
  (extraGap) => {
    const f = assignedMeasuredLeaves('12.5 12.5', ['12.5', '12.5'])
    f.observations[0].gaps = [{ index: 4, left: 55, right: 65 }]
    if (extraGap) f.observations[0].gaps.unshift({ index: 2, left: 30, right: 31 })
    const before = structuredClone(f)
    refineMeasuredAssignedNumericSegments(f.table, f.tokens, f.observations)
    if (extraGap) expect(f).toEqual(before)
    else
      expect(f.table.cells.map((c) => c.sourceSegments?.map((s) => [s.start, s.end]))).toEqual([
        [[0, 4]],
        [[5, 9]]
      ])
  }
)
