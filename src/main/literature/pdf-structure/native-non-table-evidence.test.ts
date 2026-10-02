import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
const item = (
  text: string,
  x: number,
  y: number,
  width: number
): { text: string; rect: number[]; height: number; horizontal: boolean; baseline: number } => ({
  text,
  rect: [x, y, x + width, y + 10],
  height: 10,
  horizontal: true,
  baseline: y + 10
})
const table = (
  grid: string[][]
): {
  grid: string[][]
  rows: { rect: number[] }[]
  cropRect: number[]
  cells: {
    text: string
    row: number
    column: number
    rowSpan: number
    colSpan: number
    rect: number[]
  }[]
  unassigned: string[]
  repairs: string[]
  issues: string[]
} => ({
  grid,
  rows: grid.map((_, i) => ({ rect: [50, 100 + i * 20, 550, 115 + i * 20] })),
  cropRect: [50, 90, 550, 200],
  cells: grid.flatMap((r, row) =>
    r.map((text, column) => ({
      text,
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [50 + column * 250, 100 + row * 20, 300 + column * 250, 115 + row * 20]
    }))
  ),
  unassigned: [],
  repairs: [],
  issues: []
})
it('rejects a centered display equation and its right-hand equation ordinal', () => {
  const t = table([['u = v + w', '(7.2)']])
  const tokens = [item('u = v + w', 210, 100, 90), item('(7.2)', 520, 100, 25)]
  expect(hasTableEvidence(t, undefined, tokens)).toBe(false)
  expect(hasTableEvidence(t, { lines: ['Table 4. Native formulas.'] }, tokens)).toBe(true)
})
it('rejects continuous source prose fragmented across model columns', () => {
  const t = table([
    ['This native paragraph', 'continues across the predicted cut.'],
    ['A second native line', 'also continues across the predicted cut.']
  ])
  const tokens = [
    item('This native paragraph continues across the predicted cut.', 60, 100, 460),
    item('A second native line also continues across the predicted cut.', 60, 120, 460)
  ]
  expect(hasTableEvidence(t, undefined, tokens)).toBe(false)
})
it('preserves independent numerical records and a genuine separated description table', () => {
  const t = table([
    ['Alpha', '2.7'],
    ['Beta', '3.8']
  ])
  expect(
    hasTableEvidence(t, undefined, [
      item('Alpha', 60, 100, 60),
      item('2.7', 350, 100, 20),
      item('Beta', 60, 120, 50),
      item('3.8', 350, 120, 20)
    ])
  ).toBe(true)
  const qualitative = table([
    ['Alpha native heading', 'An independent description.'],
    ['Beta native heading', 'A second independent description.']
  ])
  expect(
    hasTableEvidence(qualitative, undefined, [
      item('Alpha native heading', 60, 100, 180),
      item('An independent description.', 350, 100, 190),
      item('Beta native heading', 60, 120, 170),
      item('A second independent description.', 350, 120, 190)
    ])
  ).toBe(true)
})

it('rejects a single-column derivation underneath a caption reserved for the next page', () => {
  const t = table([
    ['A native paragraph begins with several ordinary words.'],
    ['The same paragraph continues across the entire detector.'],
    ['A third native line provides the following equations:'],
    ['u = 0, v = 0 (9)']
  ])
  t.cells.forEach((c) => (c.rect[2] = 550))
  const tokens = [
    item(t.grid[0][0], 60, 100, 460),
    item(t.grid[1][0], 60, 120, 460),
    item(t.grid[2][0], 60, 140, 430),
    item('u = 0, v = 0', 80, 160, 110),
    item('(9)', 520, 160, 25)
  ]
  const caption = { page: 1, lines: ['Table 4. Native descriptors.'], rect: [40, 135, 220, 145] }
  expect(hasTableEvidence(t, caption, tokens, [])).toBe(false)
  expect(
    hasTableEvidence(t, caption, tokens, [
      [50, 95, 550, 95],
      [50, 180, 550, 180]
    ])
  ).toBe(true)
  expect(hasTableEvidence(t, caption, tokens)).toBe(true)
})

it('rejects prose with a display equation when a coarse model crop overlaps the following caption', () => {
  const tokens = [
      item('A bounded derivation starts with several ordinary words.', 10, 20, 180),
      item('The next paragraph discusses additional ordinary variables.', 10, 35, 180),
      item('A final statement uses complete ordinary explanatory words.', 10, 50, 180),
      item('q = r + s = u', 20, 80, 90),
      item('(4)', 190, 80, 15)
    ],
    grid = tokens
      .slice(0, 3)
      .map((i) => [i.text])
      .concat([['q = r + s = u (4)']]),
    t = {
      ...table(grid),
      cropRect: [0, 10, 220, 120],
      cells: tokens
        .slice(0, 3)
        .map((i, row) => ({ row, column: 0, text: i.text, sourceRects: [i.rect] }))
        .concat([
          { row: 3, column: 0, text: grid[3][0], sourceRects: tokens.slice(3).map((i) => i.rect) }
        ])
    },
    caption = {
      lines: ['Table 7. Example native records.'],
      rect: [0, 110 / 1.5, 220 / 1.5, 120 / 1.5]
    }
  expect(hasTableEvidence(t, caption, tokens, [])).toBe(false)
  expect(
    hasTableEvidence(t, caption, tokens, [
      [0, 10, 220, 10],
      [0, 105, 220, 105]
    ])
  ).toBe(true)
  expect(hasTableEvidence({ ...t, cells: [] }, caption, tokens, [])).toBe(true)
  expect(hasTableEvidence(t, caption, tokens.slice(0, -1), [])).toBe(true)
  expect(hasTableEvidence(t, { ...caption, rect: [0, 0, 220 / 1.5, 8 / 1.5] }, tokens, [])).toBe(
    true
  )
  expect(
    hasTableEvidence({ ...t, grid: [['Label'], ['1'], ['2'], ['3']] }, caption, tokens, [])
  ).toBe(true)
})
