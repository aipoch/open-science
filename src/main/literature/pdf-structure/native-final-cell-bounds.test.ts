import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Item = { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }
type Cell = {
  row: number
  column: number
  rowSpan: number
  colSpan: number
  rect: number[]
  text: string
  sourceRects: number[][]
}
type Input = {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; rect: number[] }[] }
  }
  items: Item[]
  captions: unknown[]
  rules: number[][]
}
function fixture(name: string): Input {
  return readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
}
const {
  proveFirstNativeTitleBand,
  proveNativeClosingBeforeNextBand,
  proveNativeOuterColumnBounds,
  proveNativeOwnedColumnGutters,
  reconcileNativeFinalCellBounds
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-final-cell-bounds.mjs')).href
)
type NativeCell = Cell & { sourceTokens: Item[] }
type NativeView = {
  cells: NativeCell[]
  cropRect: number[]
  rows: { rect: number[] }[]
  columnCount: number
  unassigned: string[]
}
function view(kind: 'title' | 'columns'): { x: Input; v: NativeView } {
  const x = fixture(
    kind === 'title'
      ? 'native-independent-title-before-separate-next-band'
      : 'native-three-lane-source-gutter-outside-model-cut'
  )
  const r = refineTable(x.table, x.items, x.captions, [], x.rules)
  const v: NativeView = {
    cells: r.cells,
    cropRect: [...r.cropRect],
    rows: r.rows,
    columnCount: r.grid[0].length,
    unassigned: r.unassigned
  }
  if (kind === 'title') {
    v.cropRect[3] = 261
    const title = v.cells.find((c) => c.row === 0)!
    title.column = 0
    title.colSpan = 1
  } else {
    for (const c of v.cells) {
      if (c.column === 0) c.rect[0] = 458
      if (c.column === 0) c.rect[2] = 598.5908168777823
      if (c.column === 1) c.rect[0] = 598.5908168777823
    }
  }
  return { x, v }
}
it.each([
  'missing top',
  'vertical title divider',
  'foreign title glyph',
  'second title owner',
  'only two complete records'
])('rejects an independent title without complete native proof: %s', (variant) => {
  const { x, v } = view('title')
  if (variant === 'missing top') x.rules = x.rules.filter((r) => Math.abs(r[1] - 124.8855) > 0.001)
  if (variant === 'vertical title divider') x.rules.push([459, 124.8855, 459, 147.5565])
  if (variant === 'foreign title glyph')
    x.items.push({
      text: 'Other',
      rect: [250, 130, 280, 140],
      baseline: 140,
      height: 10,
      horizontal: true
    })
  if (variant === 'second title owner') v.cells.push({ ...v.cells[0] })
  if (variant === 'only two complete records') v.cells = v.cells.filter((c) => c.row < 4)
  expect(proveFirstNativeTitleBand(v, x.items, x.rules)).toBeUndefined()
})
it.each(['missing closing', 'competing closing', 'foreign gap ink', 'missing next closing'])(
  'rejects footer separation without two independent native bands: %s',
  (variant) => {
    const { x, v } = view('title')
    if (variant === 'missing closing')
      x.rules = x.rules.filter((r) => Math.abs(r[1] - 244.71) > 0.001)
    if (variant === 'competing closing') x.rules.push([241.551, 249, 676.4490102539062, 249])
    if (variant === 'foreign gap ink')
      x.items.push({
        text: 'Tail',
        rect: [250, 247, 280, 252],
        baseline: 252,
        height: 5,
        horizontal: true
      })
    if (variant === 'missing next closing')
      x.rules = x.rules.filter((r) => Math.abs(r[1] - 280.158) > 0.001)
    expect(proveNativeClosingBeforeNextBand(v, x.items, x.rules)).toBeUndefined()
  }
)
it.each(['missing closing', 'oversized crop', 'foreign frame glyph', 'duplicate source'])(
  'rejects outer bounds without complete native ownership: %s',
  (variant) => {
    const { x, v } = view('columns')
    if (variant === 'missing closing')
      x.rules = x.rules.filter((r) => Math.abs(r[1] - 734.9265) > 0.001)
    if (variant === 'oversized crop') v.cropRect[0] -= 40
    if (variant === 'foreign frame glyph')
      x.items.push({
        text: 'Other',
        rect: [452, 629, 470, 637],
        baseline: 637,
        height: 8,
        horizontal: true
      })
    if (variant === 'duplicate source') v.cells.push({ ...v.cells[0] })
    expect(proveNativeOuterColumnBounds(v, x.items, x.rules)).toBeUndefined()
  }
)
it.each([
  'missing top',
  'vertical gutter divider',
  'foreign gutter glyph',
  'duplicate source',
  'only two records',
  'inconsistent row cut',
  'overlapping glyphs'
])('rejects internal gutter recovery with ambiguous literal ownership: %s', (variant) => {
  const { x, v } = view('columns')
  for (const c of v.cells) if (c.column === 0) c.rect[0] = v.cropRect[0]
  if (variant === 'missing top') x.rules = x.rules.filter((r) => Math.abs(r[1] - 624.696) > 0.001)
  if (variant === 'vertical gutter divider') x.rules.push([585.3, 624.696, 585.3, 734.9265])
  if (variant === 'foreign gutter glyph')
    x.items.push({
      text: 'Other',
      rect: [583, 629, 587, 637],
      baseline: 637,
      height: 8,
      horizontal: true
    })
  if (variant === 'duplicate source') v.cells.push({ ...v.cells[0] })
  if (variant === 'only two records') {
    v.rows = v.rows.slice(0, 3)
    v.cells = v.cells.filter((c) => c.row < 3)
  }
  if (variant === 'inconsistent row cut')
    v.cells.find((c) => c.row === 1 && c.column === 1)!.rect[0] += 2
  if (variant === 'overlapping glyphs') {
    const c = v.cells.find((c) => c.row === 0 && c.column === 1)!,
      old = [...c.sourceRects[0]]
    const token = x.items.find((i) => i.rect.every((n, j) => n === old[j]))!
    token.rect[0] = 580
    c.sourceRects[0][0] = 580
    c.sourceTokens[0].rect[0] = 580
  }
  expect(proveNativeOwnedColumnGutters(v, x.items, x.rules)).toBeUndefined()
})
it('preserves actual crop crossings and unowned clipped items', () => {
  const { x, v } = view('columns')
  const result = reconcileNativeFinalCellBounds({
    table: v,
    cells: v.cells,
    rows: v.rows,
    columnRects: [
      [458, 623, 598.5908168777823, 746],
      [598.5908168777823, 623, 652.8492623642087, 746],
      [652.8492623642087, 623, 721, 746]
    ],
    tokens: x.items,
    rules: x.rules,
    unassigned: [],
    clipped: [
      { text: 'Unowned', rect: [449, 650, 470, 660] },
      { text: 'True crossing', rect: [719, 650, 725, 660] }
    ],
    repairs: []
  })
  expect(result.clipped.map((i: Item) => i.text)).toEqual(['Unowned', 'True crossing'])
})
it('keeps centered category blank slots while correcting complete native paired record bounds', () => {
  const { x, v } = view('columns')
  for (const row of [2, 3, 4]) {
    const c = v.cells.find((c) => c.row === row && c.column === 0)!
    x.items = x.items.filter((i) => !c.sourceRects.some((r) => r.every((n, k) => n === i.rect[k])))
    c.sourceRects = []
    c.sourceTokens = []
    c.text = ''
  }
  const p = proveNativeOuterColumnBounds(v, x.items, x.rules)
  expect(p).toBeDefined()
  expect(p.cells.map((c: NativeCell) => [c.rowSpan, c.colSpan])).toEqual(
    v.cells.map((c) => [c.rowSpan, c.colSpan])
  )
})
it('rejects native paired records whose complete value fields do not share a baseline', () => {
  const { x, v } = view('columns')
  const c = v.cells.find((c) => c.row === 2 && c.column === 2)!,
    rect = c.sourceRects[0]
  const token = x.items.find((i) => rect.every((n, k) => n === i.rect[k]))!
  token.baseline += 5
  c.sourceTokens.find((i) => rect.every((n, k) => n === i.rect[k]))!.baseline += 5
  expect(proveNativeOuterColumnBounds(v, x.items, x.rules)).toBeUndefined()
})
it('retains clipped evidence when final crop contains an owner with unproved column bounds', () => {
  const { x, v } = view('columns')
  const item = x.items.find((i) => i.text === 'Variant')!
  const r = reconcileNativeFinalCellBounds({
    table: v,
    cells: v.cells,
    rows: v.rows,
    columnRects: [
      [458, 623, 598.5908168777823, 746],
      [598.5908168777823, 623, 652.8492623642087, 746],
      [652.8492623642087, 623, 721, 746]
    ],
    tokens: x.items,
    rules: [],
    unassigned: [],
    clipped: [item],
    repairs: []
  })
  expect(r.clipped).toEqual([item])
})
it('retains aligned bottom notes as table-boundary diagnostics', () => {
  const { x, v } = view('columns')
  v.cropRect[3] = 800
  const repairs: string[] = []
  const r = reconcileNativeFinalCellBounds({
    table: v,
    cells: v.cells,
    rows: v.rows,
    columnRects: [
      [458, 623, 598.5908168777823, 746],
      [598.5908168777823, 623, 652.8492623642087, 746],
      [652.8492623642087, 623, 721, 746]
    ],
    tokens: x.items,
    rules: x.rules,
    unassigned: [],
    clipped: [
      { text: 'A paragraph continues below', rect: [480, 754, 600, 762] },
      { text: 'with explanatory context', rect: [480, 765, 600, 773] }
    ],
    repairs
  })
  expect(r.clipped).toHaveLength(2)
  expect(repairs).not.toContain('adjacent-prose-boundary-suppressed')
})
it('restores only the independent native title span and separates the next native band', () => {
  const x = fixture('native-independent-title-before-separate-next-band')
  const r = refineTable(x.table, x.items, x.captions, [], x.rules)
  const title = r.cells.find((c: Cell) => c.row === 0 && c.text)
  expect(title?.column).toBe(0)
  expect(title?.colSpan).toBe(3)
  expect(r.cropRect[3]).toBeCloseTo(245.21, 6)
  expect(r.grid.slice(-3).map((row: string[]) => row[0])).toEqual([
    'Mode A',
    'Mode B',
    'Mode C extended'
  ])
  expect(r.clipped).toEqual([])
  expect(r.unassigned).toEqual([])
  const source = x.items.filter((i: Item) => i.rect[1] > 124.8855 && i.rect[3] < 244.71)
  expect(
    r.cells
      .flatMap((c: Cell) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(source.map((i: Item) => JSON.stringify(i.rect)).sort())
})
it('reconciles qualified outer and inner column bounds without changing assigned source text', () => {
  const x = fixture('native-three-lane-source-gutter-outside-model-cut')
  const r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid.length).toBe(7)
  expect(r.grid[0]).toEqual(['Variant', 'Duration (ms)', 'Change'])
  expect(r.unassigned).toEqual([])
  expect(r.clipped).toEqual([])
  for (const c of r.cells as Cell[])
    for (const rect of c.sourceRects) {
      expect(rect[0]).toBeGreaterThanOrEqual(c.rect[0] - 0.002)
      expect(rect[2]).toBeLessThanOrEqual(c.rect[2] + 0.002)
    }
  expect(
    r.cells
      .flatMap((c: Cell) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(x.items.map((i: Item) => JSON.stringify(i.rect)).sort())
})
