import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

const token = (text: string, x: number, baseline: number): object => ({
  text,
  rect: [x, baseline - 8, x + Math.max(8, text.length * 5), baseline],
  baseline,
  height: 8,
  horizontal: true
})

it('recovers a rotated continuation with a missing model column and interval tail', () => {
  const cropRect = [0, 0, 1200, 220]
  const rows = Array.from({ length: 8 }, (_, index) => {
    const y = 15 + index * 24
    return { label: 'table row', rect: [0, y - 8, 1200, y + 8], score: 1 }
  })
  const columns = [
    [0, 0, 45, 220],
    [45, 0, 90, 220],
    [90, 0, 175, 220],
    [175, 0, 275, 220],
    [275, 0, 325, 220],
    [325, 0, 410, 220],
    // The model misses the source column between x410 and x570.
    [570, 0, 650, 220],
    [640, 0, 715, 220],
    [730, 0, 785, 220],
    [795, 0, 875, 220],
    [875, 0, 955, 220],
    [955, 0, 1030, 220]
  ].map((rect) => ({ label: 'table column', rect, score: 1 }))
  const items = rows.flatMap((_, index) => {
    const y = 15 + index * 24
    return [
      token(`t${index % 3}`, 10, y),
      token('45', 55, y),
      token('12.0', 100, y),
      token('3.0', 185, y),
      token('44', 285, y),
      token('11.0', 335, y),
      token('2.5', 455, y),
      token('85', 735, y),
      token('4.5 (−1.0 to 10.0)', 800, y),
      token('0.033', 965, y)
    ]
  })
  const result = refineTable(
    {
      id: 'rotated-continuation-grid',
      readingRotation: 90,
      cropRect,
      structure: { objects: [...rows, ...columns] }
    },
    items
  )
  expect(result.grid[0]).toHaveLength(13)
  expect(result.grid[0][5]).toBe('11.0')
  expect(result.grid[0][6]).toBe('2.5')
  expect(result.grid[0][9]).toBe('85')
  expect(result.grid[0][10]).toBe('4.5 (−1.0 to 10.0)')
  expect(result.grid[0][12]).toBe('0.033')
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('rotated-continuation-column-recovered')
  expect(result.repairs).toContain('rotated-continuation-rows-recovered')
})
