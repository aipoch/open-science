import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { recoverGradedCountGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-record-grid.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

const token = (
  text: string,
  x: number,
  y: number,
  width = text.length * 5
): {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
} => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const table = {
  cropRect: [0, 0, 300, 250],
  structure: {
    objects: [
      ...[0, 85, 130, 225].map((x, i, xs) => ({
        label: 'table column',
        rect: [x, 0, xs[i + 1] ?? 300, 250]
      })),
      ...Array.from({ length: 12 }, (_, r) => ({
        label: 'table row',
        rect: [0, r * 20, 300, r * 20 + 18]
      })),
      { label: 'table column header', rect: [0, 0, 300, 38] }
    ]
  }
}
const captions = [{ lines: ['Table 4'], rect: [100, -30, 200, -10] }]
const items = [
  token('DC', 160, 0),
  token('CMFVP', 240, 0),
  token('regimen', 160, 15),
  token('regimen', 240, 15)
]
for (let section = 0; section < 2; section++) {
  items.push(token(section ? 'Platelets' : 'WBC', 5, 40 + section * 100))
  for (let grade = 1; grade <= 4; grade++) {
    const y = 40 + section * 100 + grade * 20
    items.push(
      token('Degree', 10, y),
      token(String(grade), 48, y),
      token(String(grade + 2), 165, y),
      token('-', 245, y - 2)
    )
  }
}

it('recovers complete graded counts from shifted rows and a phantom stub column', () => {
  const result = refineTable(table, items, captions)
  expect(result.grid).toEqual([
    ['', 'DC regimen', 'CMFVP regimen'],
    ['WBC', '', ''],
    ...[1, 2, 3, 4].map((n) => [`Degree ${n}`, String(n + 2), '-']),
    ['Platelets', '', ''],
    ...[1, 2, 3, 4].map((n) => [`Degree ${n}`, String(n + 2), '-'])
  ])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('graded-count-grid-recovered')
})

it('does not recover incomplete counts, ambiguous gutters or tables without repeated treatment headings', () => {
  expect(recoverGradedCountGrid(table, items.slice(0, -1), captions)).toBeUndefined()
  expect(
    recoverGradedCountGrid(table, [...items, token('crossing', 185, 60, 60)], captions)
  ).toBeUndefined()
  expect(
    recoverGradedCountGrid(
      table,
      items.filter((i) => i.text !== 'regimen'),
      captions
    )
  ).toBeUndefined()
  expect(recoverGradedCountGrid(table, items, [])).toBeUndefined()
})

it('preserves suspect source characters instead of guessing corrected values', () => {
  const source = items.map((i) => (i.text === '3' && i.rect[0] === 165 ? { ...i, text: '1 1' } : i))
  const result = refineTable(table, [...source, token('.', 70, 40)], captions)
  expect(result.grid[1]).toEqual(['WBC .', '', ''])
  expect(result.grid[2]).toEqual(['Degree 1', '1 1', '-'])
  expect(result.unassigned).toEqual([])
})
