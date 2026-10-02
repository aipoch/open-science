import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverClosedCellGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-column-grid.mjs')).href
)
type Token = { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }
type Cell = { column: number; row: number; text: string; sourceRects: number[][] }
function fixture(): {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; score: number; rect: number[] }[] }
  }
  tokens: Token[]
  rules: number[][]
  captions: { page: number; lines: string[]; rect: number[] }[]
} {
  const tokens: Token[] = [],
    rules: number[][] = [],
    objects: { label: string; score: number; rect: number[] }[] = [],
    xs = [0, 70, 230, 275, 345, 455, 525],
    ys = [10, 42, 130, 218, 306, 394, 482]
  const add = (text: string, c: number, y: number, w = 45): void => {
    tokens.push({
      text,
      rect: [xs[c] + 5, y - 10, xs[c] + 5 + w, y],
      baseline: y,
      height: 10,
      horizontal: true
    })
  }
  for (const [c, s] of [
    'Symbol',
    'Definition',
    'Units',
    'Value or range',
    'Reference',
    'Value(s) used'
  ].entries())
    add(s, c, 19.5, Math.min(90, xs[c + 1] - xs[c] - 10))
  for (let r = 1; r < 6; r++) {
    const y = ys[r] + 15
    add('a' + r, 0, y, 15)
    add('Rate for measured process', 1, y, 140)
    add('including long final tail', 1, y + 18, 135)
    add('unit', 2, y, 25)
    add(String(50 + r), 3, y, 20)
    add('(Writer et al.,', 4, y, 90)
    add('2022)', 4, y + 18, 38)
    add(String(60 + r), 5, y, 20)
  }
  for (const yof of ys) rules.push([0, yof, 525, yof])
  for (let r = 0; r < ys.length - 1; r++) for (const x of xs) rules.push([x, ys[r], x, ys[r + 1]])
  for (const [c, x] of xs.slice(1).entries())
    objects.push({ label: 'table column', score: 1, rect: [xs[c], 10, x, 482] })
  objects.push(
    { label: 'table column header', score: 1, rect: [0, 10, 500, 65] },
    { label: 'table row', score: 1, rect: [0, 10, 500, 130] }
  )
  for (let r = 2; r < ys.length - 1; r++)
    objects.push({ label: 'table row', score: 1, rect: [0, ys[r], 500, ys[r + 1] - 22] })
  return {
    table: {
      id: 'synthetic-closed-definition-grid',
      cropRect: [0, 0, 500, 480],
      structure: { objects }
    },
    tokens,
    rules,
    captions: []
  }
}
it('restores complete closed definitions and keeps multiline reference years within their native cell', () => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(6)
  expect(r.grid[0]).toEqual([
    'Symbol',
    'Definition',
    'Units',
    'Value or range',
    'Reference',
    'Value(s) used'
  ])
  expect(
    r.cells
      .filter((c: Cell) => c.column === 1 && c.row > 0)
      .every((c: Cell) => c.text.endsWith('including long final tail'))
  ).toBe(true)
  expect(r.grid[1][4]).toBe('(Writer et al., 2022)')
  expect(r.unassigned).toEqual([])
  expect(r.cropRect[2]).toBeGreaterThanOrEqual(525)
  expect(r.cells.flatMap((c: Cell) => c.sourceRects)).toHaveLength(x.tokens.length)
})
it('preserves headerless closed technical continuation faces as body records', () => {
  const x = fixture()
  x.tokens = x.tokens.filter((i) => i.baseline > 42)
  x.rules = x.rules.filter((r) => r[1] >= 42)
  x.table.cropRect[1] = 42
  const proof = recoverClosedCellGrid(x.table, x.tokens, [], x.rules)
  expect(proof?.repair).toBe('native-body-records-recovered')
  expect(proof?.rows).toHaveLength(5)
  expect(proof?.headerRows).toEqual([])
  expect(proof?.ownedTokens.size).toBe(x.tokens.length)
})
it('ends a proven closed narrative crop at its native footer before independent page ink', () => {
  const x = fixture()
  x.table.cropRect[3] = 502
  x.tokens.push({ ...x.tokens[0], text: '27', rect: [240, 501, 250, 511], baseline: 511 })
  const r = refineTable(x.table, x.tokens, [], [], x.rules)
  expect(r.cropRect[3]).toBe(482.5)
  expect(r.clipped).toEqual([])
  expect(r.cells.flatMap((c: Cell) => c.sourceRects)).toHaveLength(x.tokens.length - 1)
})
it('rejects a headerless closed box without repeated complete technical fields', () => {
  const x = fixture()
  x.tokens = x.tokens.filter((i) => i.baseline > 42 && i.text !== '2022)')
  x.rules = x.rules.filter((r) => r[1] >= 42)
  x.table.cropRect[1] = 42
  expect(recoverClosedCellGrid(x.table, x.tokens, [], x.rules)?.repair).not.toBe(
    'native-body-records-recovered'
  )
})
it.each([
  'open-side',
  'missing-divider',
  'header-mismatch',
  'large-font-overhang',
  'crossing-ink',
  'crossing-outer-frame',
  'foreign-top'
])('requires a complete closed definition matrix: %s', (mode) => {
  const x = fixture()
  if (mode === 'open-side') x.rules = x.rules.filter((r) => !(r[0] === 525 && r[2] === 525))
  if (mode === 'missing-divider') x.rules = x.rules.filter((r) => !(r[1] === 218 && r[3] === 218))
  if (mode === 'header-mismatch') x.tokens[1].text = 'Free prose'
  if (mode === 'large-font-overhang') {
    x.tokens[0].rect[1] -= 1
    x.tokens[0].rect[3] -= 1
    x.tokens[0].baseline -= 1
  }
  if (mode === 'crossing-ink')
    x.tokens.push({ ...x.tokens[0], text: 'crossing', rect: [200, 147, 250, 157], baseline: 157 })
  if (mode === 'crossing-outer-frame')
    x.tokens.push({ ...x.tokens[0], text: 'crossing', rect: [-5, 147, 25, 157], baseline: 157 })
  if (mode === 'foreign-top')
    x.tokens.push({ ...x.tokens[0], text: 'External prose', rect: [5, 0, 110, 8], baseline: 8 })
  expect(recoverClosedCellGrid(x.table, x.tokens, x.captions, x.rules)?.repair).not.toBe(
    'native-body-records-recovered'
  )
})
