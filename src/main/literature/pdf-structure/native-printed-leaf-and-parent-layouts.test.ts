import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const {
  proveNativeClosedLeafHeader,
  proveNativeMeanIntervalParents,
  proveNativePrintedHeaderAtColumns
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const { repairNativeEmptyCellRectangles } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)
const examples = readPdfFixture(
  resolve(
    'src/main/literature/pdf-structure/fixtures/source-grids/native-printed-leaf-and-parent-layouts.jsonl'
  )
).cases
const fixture = (kind: string): ReturnType<typeof JSON.parse> =>
  structuredClone(examples.find((f: { kind: string }) => f.kind === kind))
const run = (f: ReturnType<typeof fixture>): ReturnType<typeof refineTable> =>
  refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)

it('separates three measured printed leaves while preserving the first real body record', () => {
  const f = fixture('printed-leaves'),
    before = structuredClone(f),
    r = run(f)
  expect(r.grid[0]).toEqual(['', 'Qhxwudo', 'Lpsolflw DO', 'Hasolflw DO'])
  expect(r.grid[1].slice(1)).toEqual(['337', '123', '542'])
  expect(r.grid).toHaveLength(8)
  expect(r.unassigned).toEqual([])
  expect(f).toEqual(before)
})

it('does not split a joined native title without its measured glyph gaps', () => {
  const f = fixture('printed-leaves'),
    r = run(f),
    columns = Array.from(
      { length: 4 },
      (_, column) =>
        r.cells.find(
          (c: { column: number; colSpan: number }) => c.column === column && c.colSpan === 1
        ).rect
    )
  expect(
    proveNativePrintedHeaderAtColumns(f.table, f.items, f.captions, f.rules, columns, [])
  ).toBeUndefined()
})

it('preserves printed parent names and source-proved two-field spans without inventing leaf names', () => {
  const f = fixture('interval-parents'),
    before = structuredClone(f),
    r = run(f)
  expect(
    r.cells
      .filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 2)
      .map((c: { column: number }) => c.column)
  ).toEqual([1, 3])
  expect(r.grid[1].slice(1)).toEqual(['0.359', '[0.359, 0.360]', '0.255', '[0.255, 0.255]'])
  expect(r.grid).toHaveLength(8)
  expect(f).toEqual(before)
  const title = f.items.find((i: { text: string }) => i.text === 'Dffxudfb')
  title.rect = title.rect.map((v: number, n: number) => (n % 2 === 0 ? v - 35 : v))
  expect(proveNativeMeanIntervalParents(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})

it('keeps all repeated native parent labels on their four printed sibling leaves', () => {
  const f = fixture('repeated-parents'),
    before = structuredClone(f),
    r = run(f)
  expect(
    r.cells
      .filter((c: { row: number; colSpan: number }) => c.row === 5 && c.colSpan === 4)
      .map((c: { column: number }) => c.column)
  ).toEqual([1, 5, 9])
  expect(r.grid).toHaveLength(10)
  expect(r.grid.every((row: string[]) => row.length === 13)).toBe(true)
  expect(r.unassigned).toEqual([])
  expect(f).toEqual(before)
})

it('proves six separately printed ordinal lanes from both complete native records', () => {
  const f = fixture('ordinal-lanes'),
    before = structuredClone(f),
    proof = proveNativeClosedLeafHeader(f.table, f.items, f.captions, f.rules, f.runs),
    r = run(f)
  expect(proof.columns).toHaveLength(6)
  expect(r.grid[0].slice(1)).toEqual(['12', '13', '14', '15', '16'])
  expect(r.grid[1].slice(1)).toEqual(['2', '7', '9', '19', '70'])
  expect(f).toEqual(before)
  f.items = f.items.filter((i: { text: string }) => i.text !== '70')
  expect(proveNativeClosedLeafHeader(f.table, f.items, f.captions, f.rules, f.runs)).toBeUndefined()
})

it('repairs an inverted empty slot using established faces without interpreting nearby formulas', () => {
  const cell = {
    row: 0,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    text: '',
    rect: [517.1538453325629, 180.1629, 515.02099584, 218.26331186294556],
    sourceTokens: [],
    sourceRects: []
  }
  const rows = [{ rect: [500, 180, 540, 219] }],
    columns = [
      [500, 180, 516, 219],
      [516, 180, 540, 219]
    ]
  expect(repairNativeEmptyCellRectangles([cell], rows, columns)).toBe(1)
  expect(cell.rect).toEqual([516, 180, 540, 219])
  const populated = { ...cell, text: 'formula', rect: [517, 180, 515, 219] }
  expect(repairNativeEmptyCellRectangles([populated], rows, columns)).toBe(0)
  expect(populated.rect).toEqual([517, 180, 515, 219])
  const valid = { ...cell, rect: [518, 181, 539, 218] }
  expect(repairNativeEmptyCellRectangles([valid], rows, columns)).toBe(0)
  expect(valid.rect).toEqual([518, 181, 539, 218])
})
