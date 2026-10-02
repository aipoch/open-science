import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { removeEmptyOverlappingRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)

type Fixture = {
  rows: { rect: number[]; origin: string }[]
  cells: {
    row: number
    column: number
    rowSpan: number
    colSpan: number
    text: string
    rect: number[]
    sourceRects: number[][]
  }[]
  items: { rect: number[]; text: string }[]
  rules: number[][]
  repairs: string[]
}
function fixture(): Fixture {
  const rows = [0, 20, 28, 38, 56].map((y) => ({ rect: [0, y, 600, y + 20], origin: 'model' }))
  const values = [
    ['', 'Dose parameters', 'A', 'B', 'A', 'B'],
    ['Region A', 'Dmean', '<8 Gy', '<9 Gy', '<10 Gy', '<11 Gy'],
    ['', '', '', '', '', ''],
    ['', 'V5', '<40%', '<45%', '<50%', '<55%'],
    ['Region B', 'V20', '<20%', '<25%', '<30%', '<35%']
  ]
  const cells = values.flatMap((record, row) =>
    record.map((text, column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      text,
      rect: [column * 100, rows[row].rect[1], (column + 1) * 100, rows[row].rect[3]],
      sourceRects: text
        ? [
            [
              column * 100 + 5,
              row === 1 ? 22 : row === 3 ? 40 : rows[row].rect[1] + 2,
              column * 100 + 70,
              row === 1 ? 32 : row === 3 ? 50 : rows[row].rect[1] + 12
            ]
          ]
        : []
    }))
  )
  return {
    rows,
    cells,
    items: cells.flatMap((c) => c.sourceRects.map((rect) => ({ rect, text: c.text }))),
    rules: [] as number[][],
    repairs: [] as string[]
  }
}
it('removes a source-empty overlapping model band between native unit and threshold records', () => {
  const f = fixture()
  removeEmptyOverlappingRows(f)
  expect(f.rows).toHaveLength(4)
  expect(f.cells.filter((c) => c.text).map((c) => c.text)).toEqual(
    fixture()
      .cells.filter((c) => c.text)
      .map((c) => c.text)
  )
})
it.each(['header', 'metric', 'foreign glyph', 'rule', 'source gap'])(
  'preserves a unit overlap without %s proof',
  (reason) => {
    const f = fixture()
    if (reason === 'header') f.cells[1].text = 'Description'
    if (reason === 'metric') f.cells[7].text = 'Prose'
    if (reason === 'foreign glyph') f.items.push({ rect: [105, 33, 115, 37], text: '*' })
    if (reason === 'rule') f.rules.push([0, 36, 600, 36])
    if (reason === 'source gap')
      for (const c of f.cells.filter((c) => c.row === 3))
        for (const r of c.sourceRects) {
          r[1] += 10
          r[3] += 10
        }
    const before = structuredClone(f)
    removeEmptyOverlappingRows(f)
    expect(f).toEqual(before)
  }
)
