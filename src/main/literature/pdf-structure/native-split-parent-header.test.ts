import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

const item = (
  text: string,
  x: number,
  y: number,
  width = Math.max(5, text.length * 4)
): {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  font: string
} => ({
  text,
  rect: [x, y, x + width, y + 8],
  baseline: y + 8,
  height: 8,
  horizontal: true,
  font: 'Anonymous-Regular'
})

const table = (columns: number, rows: number[]): ReturnType<typeof JSON.parse> => ({
  id: 'anonymous-native-parent-header',
  page: 1,
  cropRect: [0, 0, columns * 100, 220],
  structure: {
    objects: [
      ...Array.from({ length: columns }, (_, column) => ({
        label: 'table column',
        score: 0.99,
        rect: [column * 100, 0, (column + 1) * 100, 220]
      })),
      ...rows.map((top, index) => ({
        label: index < 2 ? 'table column header' : 'table row',
        score: 0.99,
        rect: [0, top, columns * 100, top + 14]
      }))
    ]
  }
})

it('recovers split small-caps parent labels for a six-column table', () => {
  const tokens = [
    item('NAME', 5, 20),
    item('COUNT', 105, 20),
    item('LRMC', 205, 20),
    item('ScaledGD', 405, 20),
    item('V', 205, 5, 5),
    item('IDEO', 212, 5),
    item('F', 305, 5, 5),
    item('RAME', 312, 5),
    item('R', 405, 5, 5),
    item('UNTIME', 412, 5),
    item('(secs)', 470, 5),
    ...['Video 1', 'Video 2'].flatMap((name, index) => {
      const y = 70 + index * 18
      return [
        item(name, 5, y),
        item('100', 105, y),
        item('1.2', 205, y),
        item('2.3', 305, y),
        item('3.4', 405, y),
        item('4.5', 505, y)
      ]
    })
  ]
  const result = refineTable(
    table(6, [18, 40, 68, 86]),
    tokens,
    [{ page: 1, lines: ['Table 1: Anonymous video results.'], rect: [0, -20, 200, -10] }],
    [],
    []
  )
  expect(result.grid[0]).toEqual(['VIDEO', 'FRAME', 'RUNTIME (secs)', '', '', ''])
  expect(result.grid[1]).toEqual(['NAME', 'COUNT', 'LRMC', '', 'ScaledGD', ''])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('small-caps-header-text-recovered')
})

it('recovers a clipped three-group resolution header above runtime and loss leaves', () => {
  const tokens = [
    item('400', 105, 5),
    item('×', 130, 5, 5),
    item('400', 140, 5),
    item('1000', 305, 5),
    item('×', 350, 5, 5),
    item('1000', 360, 5),
    item('2000', 505, 5),
    item('×', 550, 5, 5),
    item('2000', 560, 5),
    item('ALGORITHM', 5, 42),
    item('RUNTIME', 105, 42),
    item('LOSS', 205, 42),
    item('RUNTIME', 305, 42),
    item('LOSS', 405, 42),
    item('RUNTIME', 505, 42),
    item('LOSS', 605, 42),
    ...['A', 'B'].flatMap((name, index) => {
      const y = 70 + index * 18
      return [
        item(name, 5, y),
        item('1 sec', 105, y),
        item('0.1', 205, y),
        item('2 sec', 305, y),
        item('0.2', 405, y),
        item('3 sec', 505, y),
        item('0.3', 605, y)
      ]
    })
  ]
  const result = refineTable(
    table(7, [42, 68, 86]),
    tokens,
    [{ page: 1, lines: ['Table 2: Anonymous runtime comparison.'], rect: [0, -20, 200, -10] }],
    [],
    []
  )
  expect(result.grid[0].slice(1)).toEqual(['400 × 400', '', '1000 × 1000', '', '2000 × 2000', ''])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('clipped-resolution-header-recovered')
})

it('recovers the criterion parent over inclusion and exclusion leaves', () => {
  const tokens = [
    item('Type of Creterion', 105, 5, 80),
    item('No', 5, 20),
    item('Inclusion', 105, 20),
    item('Exclusion', 205, 20),
    item('Description', 305, 20),
    item('CT1', 5, 42),
    item('yes', 105, 42),
    item('no', 205, 42),
    item('Anonymous description', 305, 42, 90)
  ]
  const result = refineTable(
    table(4, [18, 40, 68]),
    tokens,
    [{ page: 1, lines: ['Table 5. Screening criteria'], rect: [0, -20, 300, -10] }],
    [],
    []
  )
  expect(result.grid[0]).toEqual(['', 'Type of Creterion', '', ''])
  expect(result.grid[1]).toEqual(['No', 'Inclusion', 'Exclusion', 'Description'])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('source-criterion-parent-header-recovered')
})
