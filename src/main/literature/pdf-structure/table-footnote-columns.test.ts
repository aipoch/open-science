import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

it('joins an unlabelled star-only column to its percentage under the same group rule', () => {
  const raw = {
    id: 'footnote-column',
    cropRect: [0, 0, 600, 150],
    structure: {
      objects: [
        ...[0, 200, 260, 320, 360, 420, 480, 540].map((x, i, a) => ({
          label: 'table column',
          rect: [x, 0, a[i + 1] ?? 600, 150]
        })),
        { label: 'table column header', rect: [0, 10, 600, 30] },
        ...Array.from({ length: 6 }, (_, i) => ({
          label: 'table row',
          rect: [0, 10 + i * 20, 600, 30 + i * 20]
        }))
      ]
    }
  }
  const token = (text: string, x: number, y: number): object => ({
    text,
    rect: [x, y, x + 20, y + 10],
    height: 10,
    baseline: y + 10,
    horizontal: true
  })
  const items = [
    token('n', 210, 15),
    token('%', 270, 15),
    token('n', 370, 15),
    token('%', 430, 15),
    token('n', 490, 15),
    token('%', 550, 15),
    ...Array.from({ length: 5 }, (_, i) => [
      token('Event', 10, 35 + i * 20),
      token('7', 210, 35 + i * 20),
      token('(29)', 270, 35 + i * 20),
      ...(i % 2 ? [token('*', 330, 35 + i * 20)] : []),
      token('1', 370, 35 + i * 20),
      token('(4)', 430, 35 + i * 20),
      token('6', 490, 35 + i * 20),
      token('(27)', 550, 35 + i * 20)
    ]).flat()
  ]
  const rules = [
    [200, 8, 352, 8],
    [360, 8, 470, 8],
    [480, 8, 600, 8]
  ]
  const result = refineTable(raw, items, [], [], rules)
  expect(result.grid[0]).toEqual(['', 'n', '%', 'n', '%', 'n', '%'])
  expect(result.grid[2][2]).toContain('*')
  expect(result.unassigned).toEqual([])
  expect(refineTable(raw, items, [], [], []).grid[0]).toHaveLength(8)
  expect(refineTable(raw, [...items, token('P', 330, 15)], [], [], rules).grid[0]).toHaveLength(8)
})
