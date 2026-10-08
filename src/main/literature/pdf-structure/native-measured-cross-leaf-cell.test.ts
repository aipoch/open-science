import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { proveNativeMeasuredCellSplits } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> => {
  const token = (text: string, rect: number[]): ReturnType<typeof JSON.parse> => ({
      text,
      rect,
      height: 10,
      baseline: rect[3],
      horizontal: true
    }),
    headers = ['Stub', 'Description', 'Value', 'Unit'].map((text, c) =>
      token(text, [c * 100 + 5, 20, c * 100 + 65, 30])
    ),
    merged = token('A literal description 10999.93', [105, 40, 260, 50]),
    cells = headers.map((i, c) => ({
      row: 0,
      column: c,
      rowSpan: 1,
      colSpan: 1,
      text: i.text,
      rect: [c * 100, 15, (c + 1) * 100, 35],
      sourceRects: [i.rect]
    }))
  cells.push({
    row: 1,
    column: 1,
    rowSpan: 1,
    colSpan: 2,
    text: merged.text,
    rect: [100, 38, 300, 53],
    sourceRects: [merged.rect]
  })
  const peers = [62, 74, 86].map((y) => token('12.34', [205, y - 10, 240, y]))
  peers.forEach((i, n) =>
    cells.push({
      row: n + 2,
      column: 2,
      rowSpan: 1,
      colSpan: 1,
      text: i.text,
      rect: [200, i.rect[1], 300, i.rect[3]],
      sourceRects: [i.rect]
    })
  )
  const text = merged.text.replace(/\s/g, ''),
    index = text.indexOf('10999.93')
  return {
    table: { grid: [headers.map((i) => i.text)], cells },
    items: [...headers, merged, ...peers],
    runs: [
      {
        ...merged,
        gaps: [{ index, left: 195, right: 205 }],
        glyphRuns: [...text].map(() => 1),
        literalGlyphs: [...text]
      }
    ]
  }
}
it('splits only the exact measured prose/scalar run while preserving unrelated unit/header metadata', () => {
  const f = fixture(),
    before = structuredClone(f),
    proof = proveNativeMeasuredCellSplits(f.table, f.items, f.runs)
  expect(proof).toHaveLength(1)
  expect(proof[0].parts.map((i: { text: string }) => i.text)).toEqual([
    'A literal description',
    '10999.93'
  ])
  expect(proof[0].row).toBe(1)
  expect(proof[0].column).toBe(1)
  expect(f).toEqual(before)
})
it.each([
  'no native gap',
  'missing peer',
  'different native ownership',
  'non-scalar tail',
  'crossed lane'
])('preserves the original merged cell without %s proof', (variant) => {
  const f = fixture()
  if (variant === 'no native gap') f.runs[0].gaps = []
  if (variant === 'missing peer') f.table.cells.pop()
  if (variant === 'different native ownership') f.table.cells[4].sourceRects[0] = [106, 40, 260, 50]
  if (variant === 'non-scalar tail') {
    f.items[4].text = 'A literal description unknown'
    f.table.cells[4].text = f.items[4].text
  }
  if (variant === 'crossed lane') f.runs[0].gaps[0].right = 195
  expect(proveNativeMeasuredCellSplits(f.table, f.items, f.runs)).toEqual([])
})
