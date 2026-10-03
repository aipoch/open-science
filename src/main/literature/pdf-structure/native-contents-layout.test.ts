import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
type Token = { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean }
const item = (text: string, x: number, y: number, width: number): Token => ({
  text,
  rect: [x, y, x + width, y + 10],
  height: 10,
  baseline: y + 10,
  horizontal: true
})
const input = (): ReturnType<typeof JSON.parse> => {
  const titles = ['Introduction', 'Independent bounds', 'Boundary relations', 'Completion']
  const grid = titles.map((t, n) => [String(n + 1) + '.', t, String(n * 3 + 1)])
  return {
    table: {
      cropRect: [40, 80, 550, 210],
      grid,
      repairs: [],
      issues: [],
      unassigned: [],
      cells: grid.flatMap((row, r) =>
        row.map((text, c) => ({
          row: r,
          column: c,
          rowSpan: 1,
          colSpan: 1,
          text,
          rect: [[50, 90, 460][c], 110 + r * 20, [85, 450, 540][c], 120 + r * 20]
        }))
      )
    },
    tokens: [
      item('Contents', 245, 85, 70),
      ...grid.flatMap((row, r) =>
        row.map((t, c) => item(t, [50, 90, 500][c], 110 + r * 20, [15, 200, 15][c]))
      )
    ]
  }
}
it('rejects native section navigation even though its right lane has repeated scalars', () => {
  const { table, tokens } = input()
  expect(hasTableEvidence(table, undefined, tokens, [])).toBe(false)
})
it('keeps captioned and ruled directories, and ordinary independent record grids', () => {
  const { table, tokens } = input()
  expect(hasTableEvidence(table, { lines: ['Table 2. Records.'] }, tokens, [])).toBe(true)
  expect(hasTableEvidence(table, undefined, tokens, [[40, 80, 550, 80]])).toBe(true)
  tokens[0].text = 'Executable source'
  expect(hasTableEvidence(table, undefined, tokens, [])).toBe(true)
})
